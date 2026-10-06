// Build scripts/build-client.mjs — assembles src/client/*.js + styles.css into
// the single-file client.js bundle the dsh client module loader expects:
//
//   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
//
// with `react` / `@deepseek-ai/*` resolved through the loader's require (the
// platform module table) and local modules served from an inline registry.
//
// The transform deliberately only accepts a narrow source convention (see
// src/client/client.js header); anything else fails the build loudly instead
// of producing a broken bundle. A bundled esbuild would do this with less
// ceremony, but the plugin must be buildable offline with Node alone.

import { readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const id = pkg.name
const externals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

const IMPORT_PATTERN = /^import\s+\{([^}]+)\}\s+from\s+'([^']+)'\s*$/
const EXPORT_PATTERN = /^export\s+\{([^}]+)\}\s*$/

function fail(message) {
  console.error(`build-client: ${message}`)
  process.exit(1)
}

/** Split one source file into (requires, body) under the build conventions. */
function transform(name, source) {
  const lines = source.split('\n')
  const requires = []
  const bodyLines = []
  let exportsLine = null
  let inBlockComment = false

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd()
    const location = `${name}:${index + 1}`
    if (inBlockComment) {
      bodyLines.push(line)
      if (line.includes('*/')) inBlockComment = false
      continue
    }
    const code = line.trim()
    if (code.startsWith('/*') && !code.includes('*/')) {
      inBlockComment = true
      bodyLines.push(line)
      continue
    }
    if (code === '' || code.startsWith('//')) {
      bodyLines.push(line)
      continue
    }
    if (code.startsWith('import ')) {
      const match = IMPORT_PATTERN.exec(code)
      if (match === null) fail(`${location}: only single-line named imports are supported: ${code}`)
      const [, names, specifier] = match
      const cleaned = names.split(',').map(part => part.trim()).filter(Boolean)
      if (cleaned.length === 0) fail(`${location}: empty import`)
      requires.push(
        specifier.startsWith('.')
          ? `const { ${cleaned.join(', ')} } = __req(${JSON.stringify(specifier)})`
          : `const { ${cleaned.join(', ')} } = require(${JSON.stringify(specifier)})`,
      )
      continue
    }
    if (code.startsWith('export ')) {
      const match = EXPORT_PATTERN.exec(code)
      if (match === null) fail(`${location}: only a single trailing 'export { ... }' statement is supported: ${code}`)
      if (exportsLine !== null) fail(`${location}: multiple export statements`)
      exportsLine = match[1]
      continue
    }
    bodyLines.push(line)
  }

  if (exportsLine === null) fail(`${name}: missing trailing 'export { ... }' statement`)
  return { requires, body: bodyLines.join('\n'), exports: exportsLine }
}

const cssText = await readFile(join(root, 'src/client/styles.css'), 'utf8')
const locales = transform('locales.js', await readFile(join(root, 'src/client/locales.js'), 'utf8'))
const client = transform('client.js', await readFile(join(root, 'src/client/client.js'), 'utf8'))

for (const line of client.requires) {
  const specifier = /__req\("([^"]+)"\)/.exec(line)?.[1] ?? /require\("([^"]+)"\)/.exec(line)?.[1]
  if (specifier !== undefined && specifier.startsWith('.') && specifier !== './locales.js' && specifier !== './styles.css.js') {
    fail(`client.js requires unknown local module: ${specifier}`)
  }
}

const indent = (text, pad = '\t\t') => text.split('\n').map(line => (line === '' ? line : pad + line)).join('\n')

const bundle = `\
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tvar __modules = {
\t\t\t"./styles.css.js": function (require, module, exports) {
\t\t\t\tmodule.exports = { cssText: ${JSON.stringify(cssText)} };
\t\t\t},
\t\t\t"./locales.js": function (require, module, exports) {
${indent(locales.requires.join('\n'), '\t\t\t\t')}
${indent(locales.body, '\t\t\t\t')}
\t\t\t\tmodule.exports = { ${locales.exports} };
\t\t\t},
\t\t};
\t\tvar __cache = {};
\t\tfunction __req(name) {
\t\t\tif (!(name in __cache)) {
\t\t\t\tvar m = { exports: {} };
\t\t\t\t__modules[name](require, m, m.exports);
\t\t\t\t__cache[name] = m.exports;
\t\t\t}
\t\t\treturn __cache[name];
\t\t}
${indent(client.requires.join('\n'))}
${indent(client.body)}
\t\tmodule.exports = { ${client.exports} };
\t\treturn module.exports;
\t},
});
`

// --- verification passes ---------------------------------------------------

// Every `useStore(s => s.X)` selector must name a field the store's init()
// actually declares — a selector on a missing field returns undefined and the
// panel tree crashes (observed as a black panel in the real app, v0.2.1).
{
  const initMatch = /init: \(\) => \(\{([\s\S]*?)\}\),\n    actions:/.exec(client.body)
  if (initMatch === null) fail("client.js: store init() literal not found — if the store shape changed, update this check (it guards useStore selectors against missing init fields)")
  const declared = new Set([...initMatch[1].matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map(match => match[1]))
  const selectors = [...client.body.matchAll(/useStore\(s => s\.([A-Za-z_$][\w$]*)\)/g)].map(match => match[1])
  const missing = [...new Set(selectors)].filter(name => declared.has(name) === false)
  if (missing.length > 0) fail(`client.js: useStore selectors missing from store init(): ${missing.join(', ')}`)
}

const externalsUsed = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
for (const specifier of new Set(externalsUsed)) {
  if (!externals.has(specifier)) {
    fail(`client.js requires non-platform external '${specifier}'; it would be missing from the loader module table at runtime`)
  }
}

const target = join(root, 'client.js')
await writeFile(target, bundle, 'utf8')

const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
if (check.status !== 0) {
  console.error(check.stderr)
  fail('client.js failed node --check')
}

// Execute the factory against stub requires to prove the bundle loads and
// exports the shape the host loader expects (inject array + apply function).
const exec = new Function('window', 'require', bundle)
const loaded = []
const stubRequire = (specifier) => {
  if (specifier === 'react') return { createElement: (type) => ({ type }) }
  return {}
}
exec({ __ModuleLoader__: { load: definition => loaded.push(definition) } }, stubRequire)
if (loaded.length !== 1) fail('window.__ModuleLoader__.load was not called exactly once')
const face = loaded[0].factory(stubRequire)
if (!Array.isArray(face.inject) || face.inject.length === 0) fail('client exports.inject is missing')
if (typeof face.apply !== 'function') fail('client exports.apply is missing')

const size = (await stat(target)).size
console.log(`build-client: wrote ${target} (${(size / 1024).toFixed(1)} KiB); syntax + factory checks passed`)

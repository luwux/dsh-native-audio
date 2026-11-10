// Emits lib/client.js (or the path in argv[2]) in the DSH client module system's lazy factory format.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const source = await readFile(resolve(root, 'src/client/index.tsx'), 'utf8')
const { outputText, diagnostics } = ts.transpileModule(source, {
  fileName: 'index.tsx',
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    verbatimModuleSyntax: false,
  },
})
if (diagnostics?.length) throw new Error(ts.formatDiagnostics(diagnostics, ts.createCompilerHost({})))

const factoryBody = outputText.split('\n').map(line => `\t\t${line}`).join('\n')
const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(manifest.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${factoryBody}
\t\treturn module.exports;
\t}
});
`
const output = resolve(process.argv[2] ?? resolve(root, 'lib/client.js'))
await mkdir(dirname(output), { recursive: true })
await writeFile(output, bundle)

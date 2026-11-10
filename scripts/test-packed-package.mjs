import { execFile } from 'node:child_process'
import { cp, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const OMITTED_STAGE_ENTRIES = new Set(['.git', 'lib', 'node_modules'])

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('usage: node scripts/test-packed-package.mjs --repo-root <path> --work-dir <path>')
    }
    values.set(key, value)
  }
  const repoRoot = values.get('--repo-root')
  const workDir = values.get('--work-dir')
  if (repoRoot === undefined || workDir === undefined) {
    throw new Error('both --repo-root and --work-dir are required')
  }
  return { repoRoot: resolve(repoRoot), workDir: resolve(workDir) }
}

async function run(command, args, options) {
  try {
    return await execFileAsync(command, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const detail = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
      .filter(Boolean)
      .join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`, { cause: error })
  }
}

async function copyWorkspaceForPacking(repoRoot, stageDir) {
  await mkdir(stageDir, { recursive: true })
  for (const entry of await readdir(repoRoot, { withFileTypes: true })) {
    if (OMITTED_STAGE_ENTRIES.has(entry.name)) continue
    await cp(join(repoRoot, entry.name), join(stageDir, entry.name), {
      recursive: entry.isDirectory(),
      force: false,
      errorOnExist: true,
    })
  }
}

/**
 * Build the current sources into a fresh staging tree with the package's tsc
 * build (JavaScript plus declarations) and create a real npm tarball without
 * lifecycle scripts, dependency resolution, or network access.
 * The caller owns workDir and is responsible for removing it.
 */
export async function buildAndPack({ repoRoot, workDir }) {
  const stageDir = join(workDir, 'stage')
  const packDir = join(workDir, 'pack')
  const npmCacheDir = join(workDir, 'npm-cache')
  await copyWorkspaceForPacking(repoRoot, stageDir)
  await mkdir(packDir, { recursive: true })
  await mkdir(npmCacheDir, { recursive: true })

  const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
  await run(process.execPath, [
    tscPath,
    '-p', join(repoRoot, 'tsconfig.build.json'),
    '--outDir', join(stageDir, 'lib'),
    '--declarationDir', join(stageDir, 'lib', 'types'),
    '--pretty', 'false',
  ], { cwd: repoRoot })
  await run(process.execPath, [
    join(repoRoot, 'scripts', 'build-client.mjs'),
    join(stageDir, 'lib', 'client.js'),
  ], { cwd: repoRoot })

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const { stdout } = await run(npm, [
    'pack',
    '--ignore-scripts',
    '--offline',
    '--json',
    '--cache', npmCacheDir,
    '--pack-destination', packDir,
    stageDir,
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_ignore_scripts: 'true',
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
    },
  })

  const reports = JSON.parse(stdout)
  if (!Array.isArray(reports) || reports.length !== 1 || typeof reports[0]?.filename !== 'string') {
    throw new Error(`unexpected npm pack --json output: ${stdout}`)
  }
  const report = reports[0]
  return {
    stageDir,
    tarballPath: join(packDir, report.filename),
    report,
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  buildAndPack(options)
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      process.exitCode = 1
    })
}

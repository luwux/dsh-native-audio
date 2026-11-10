import { execFileSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface PackReport {
  files: Array<{ path: string }>
  filename: string
}

interface PackedFixture {
  stageDir: string
  tarballPath: string
  report: PackReport
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureRoot = fileURLToPath(new URL('./fixtures/consumer', import.meta.url))
const helperPath = join(repoRoot, 'scripts', 'test-packed-package.mjs')

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_offline: 'true',
        npm_config_update_notifier: 'false',
      },
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const result = error as { stdout?: Buffer | string; stderr?: Buffer | string }
    const stdout = result.stdout?.toString().trim()
    const stderr = result.stderr?.toString().trim()
    const detail = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
      .filter(Boolean)
      .join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`, { cause: error })
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(root, path))
    else files.push(relative(root, path).split('\\').join('/'))
  }
  return files.sort()
}

async function linkLocalModule(nodeModulesDir: string, packageName: string): Promise<void> {
  const segments = packageName.split('/')
  const source = join(repoRoot, 'node_modules', ...segments)
  const destination = join(nodeModulesDir, ...segments)
  await stat(source)
  await mkdir(dirname(destination), { recursive: true })
  await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('packed package consumer', () => {
  it('builds, packs, extracts, imports, and typechecks without registry or provider access', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-native-audio-packed-'))
    try {
      const packed = JSON.parse(run(process.execPath, [
        helperPath,
        '--repo-root', repoRoot,
        '--work-dir', join(tempRoot, 'build-and-pack'),
      ], repoRoot)) as PackedFixture

      const expectedFiles = [
        'LICENSE',
        'README.md',
        'README.zh.md',
        'THIRD_PARTY_NOTICES',
        'cordis.patch.yml',
        'package.json',
        ...(await listFiles(join(packed.stageDir, 'lib'))).map(path => `lib/${path}`),
      ].sort()
      const reportedFiles = packed.report.files.map(file => file.path).sort()
      expect(reportedFiles).toEqual(expectedFiles)

      const tarEntries = run('tar', ['-tzf', packed.tarballPath], repoRoot)
        .split(/\r?\n/u)
        .filter(entry => entry.startsWith('package/') && !entry.endsWith('/'))
        .map(entry => entry.slice('package/'.length))
        .sort()
      expect(tarEntries).toEqual(expectedFiles)

      const consumerRoot = join(tempRoot, 'consumer')
      const nodeModulesDir = join(consumerRoot, 'node_modules')
      const extractRoot = join(tempRoot, 'extract')
      await cp(fixtureRoot, consumerRoot, { recursive: true })
      await mkdir(nodeModulesDir, { recursive: true })
      await mkdir(extractRoot, { recursive: true })
      run('tar', ['-xzf', packed.tarballPath, '-C', extractRoot], repoRoot)
      await rename(join(extractRoot, 'package'), join(nodeModulesDir, 'dsh-native-audio'))

      const installedManifest = JSON.parse(await readFile(
        join(nodeModulesDir, 'dsh-native-audio', 'package.json'),
        'utf8',
      )) as {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      const dependencyNames = new Set([
        ...Object.keys(installedManifest.dependencies ?? {}),
        ...Object.keys(installedManifest.peerDependencies ?? {}),
        '@types/node',
      ])
      for (const packageName of dependencyNames) {
        await linkLocalModule(nodeModulesDir, packageName)
      }

      const runtimeOutput = JSON.parse(run(
        process.execPath,
        [join(consumerRoot, 'runtime.mjs')],
        consumerRoot,
      )) as Record<string, string>
      const installedRoot = '/node_modules/dsh-native-audio/'
      expect(Object.keys(runtimeOutput)).toEqual([
        'dsh-native-audio',
        'dsh-native-audio/types',
        'dsh-native-audio/gemini',
        'dsh-native-audio/gemini-plugin',
        'dsh-native-audio/openai-compatible',
        'dsh-native-audio/read-audio-tool',
        'dsh-native-audio/file-ingress',
        'dsh-native-audio/package.json',
        'dsh-native-audio/pi-ai-audio-plugin',
        'dsh-native-audio/client',
      ])
      expect(Object.values(runtimeOutput).map(url => url.slice(url.indexOf(installedRoot) + installedRoot.length)))
        .toEqual([
          'lib/index.js',
          'lib/types.js',
          'lib/gemini/index.js',
          'lib/gemini-plugin.js',
          'lib/openai-compatible/index.js',
          'lib/read-audio-tool.js',
          'lib/file-ingress.js',
          'package.json',
          'lib/pi-ai-audio-plugin.js',
          'lib/client.js',
        ])
      expect(expectedFiles.filter(path => /client/u.test(path))).toEqual(['lib/client.js'])
      expect(expectedFiles.filter(path => /remote|typert|web-service|openrouter/u.test(path))).toEqual([])

      const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
      run(process.execPath, [
        tscPath,
        '-p', join(consumerRoot, 'tsconfig.json'),
        '--pretty', 'false',
      ], consumerRoot)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }, 30_000)
})

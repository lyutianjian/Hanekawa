import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { extractBashWritePaths } from '../src/tools/BashTool/writeTargets.js'

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work'

function targets(command: string): string[] {
  return extractBashWritePaths(command, CWD).map((p) => path.relative(CWD, p).replace(/\\/g, '/')).sort()
}

test('recognises output redirections', () => {
  assert.deepEqual(targets('echo hi > out.txt'), ['out.txt'])
  assert.deepEqual(targets('echo hi >out.txt'), ['out.txt'])
  assert.deepEqual(targets('echo hi >> logs/app.log'), ['logs/app.log'])
  assert.deepEqual(targets('npm run build 2> build.err'), ['build.err'])
  assert.deepEqual(targets('npm run build &> build.log'), ['build.log'])
})

test('ignores descriptor duplication and devices', () => {
  assert.deepEqual(targets('npm test > /dev/null 2>&1'), [])
  assert.deepEqual(targets('cat file < input.txt'), [])
})

test('recognises tee, cp and mv', () => {
  assert.deepEqual(targets('npm test | tee report.txt'), ['report.txt'])
  assert.deepEqual(targets('npm test | tee -a report.txt'), ['report.txt'])
  assert.deepEqual(targets('cp src/a.ts src/b.ts'), ['src/b.ts', 'src/b.ts/a.ts'])
  // mv also backs up the source, which the command removes.
  assert.deepEqual(targets('mv a.ts b.ts'), ['a.ts', 'b.ts', 'b.ts/a.ts'])
  assert.deepEqual(targets('cp a.ts dist/'), ['dist', 'dist/a.ts'])
})

test('skips recursive copies it cannot enumerate', () => {
  assert.deepEqual(targets('cp -r src dist'), [])
  assert.deepEqual(targets('cp --recursive src dist'), [])
})

test('skips targets needing shell expansion', () => {
  assert.deepEqual(targets('echo hi > $OUT'), [])
  assert.deepEqual(targets('rm -f *.log > out-$(date +%s).txt'), [])
  assert.deepEqual(targets('cat a.txt > "$(mktemp)"'), [])
})

test('handles compound commands without cross-segment confusion', () => {
  assert.deepEqual(targets('echo one > a.txt && echo two >> b.txt'), ['a.txt', 'b.txt'])
  // The `>` belongs to grep's segment, not to cat's operand list.
  assert.deepEqual(targets('cat a.txt | grep x > b.txt'), ['b.txt'])
  // A redirection inside single quotes is text, not a redirection.
  assert.deepEqual(targets("echo '> not-a-file'"), [])
})

test('resolves absolute and home-relative targets', () => {
  const absolute = process.platform === 'win32' ? 'C:/tmp/out.txt' : '/tmp/out.txt'
  assert.deepEqual(
    extractBashWritePaths(`echo hi > ${absolute}`, CWD),
    [path.resolve(absolute)],
  )
})

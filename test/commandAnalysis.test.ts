import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeShellCommand } from '../src/harness/commandAnalysis.js'
import { analyzeDestructiveCommands } from '../src/harness/destructiveCommands.js'

test('read-only analysis accepts allowlisted commands and executable paths', () => {
  for (const command of [
    'ls -la',
    '/usr/bin/grep needle src/file.ts',
    '"C:/Program Files/Git/bin/git.exe" status',
    'git -C repo status',
    'node --version',
    'Get-ChildItem src',
  ]) {
    assert.equal(analyzeShellCommand(command).isReadOnly, true, command)
  }
})

test('read-only analysis accepts pipelines and logical chains only when every segment is safe', () => {
  for (const command of [
    'git log --oneline | head -20',
    'pwd && git status || git diff; rg TODO src',
    'pwd\nls',
    'grep "a|b" file.txt',
  ]) {
    assert.equal(analyzeShellCommand(command).isReadOnly, true, command)
  }

  for (const command of [
    'pwd | rm file.txt',
    'git status && touch marker',
    'pwd & ls',
    'pwd |',
    'cat file > copy',
    'cat $(find src -name "*.ts")',
  ]) {
    assert.equal(analyzeShellCommand(command).isReadOnly, false, command)
  }
})

test('read-only analysis validates git fd find node and sed arguments', () => {
  for (const command of [
    'git diff -- src/index.ts',
    'fd package src',
    'find src -name "*.ts"',
    'sed -n "1,5p" file.txt',
    'sed "s/a/b/g" file.txt',
    'node -v',
  ]) {
    assert.equal(analyzeShellCommand(command).isReadOnly, true, command)
  }

  for (const command of [
    'git diff --output=patch.txt',
    'git grep --open-files-in-pager needle',
    'git grep -Ovim needle',
    'git -c alias.status="!touch marker" status',
    'fd package --exec rm {}',
    'fd package -HIx rm {}',
    'rg --pre "touch marker" needle',
    'find src -fprint output.txt',
    'sed -i "s/a/b/" file.txt',
    'sed -i.bak "s/a/b/" file.txt',
    'sed "w output.txt" file.txt',
    'sed "/foo/e touch marker" file.txt',
    'sed "s/a/b/e" file.txt',
    'sed -f script.sed file.txt',
    'node script.js',
  ]) {
    assert.equal(analyzeShellCommand(command).isReadOnly, false, command)
  }
})

test('destructive command analysis returns structured warnings', () => {
  const cases: Array<[string, string]> = [
    ['rm -rf dist', 'recursive_force_delete'],
    ['Remove-Item -Recurse -Force dist', 'powershell_recursive_delete'],
    ['git reset --hard HEAD', 'git_reset_hard'],
    ['git clean -fdx', 'git_clean_force'],
    ['git push --force-with-lease origin main', 'git_push_force'],
    ['psql -c "DROP TABLE users"', 'sql_drop'],
    ['mysql -e "TRUNCATE TABLE users"', 'sql_truncate'],
  ]

  for (const [command, code] of cases) {
    assert.ok(analyzeDestructiveCommands(command).some((warning) => warning.code === code), command)
    assert.ok(analyzeShellCommand(command).destructiveWarnings.some((warning) => warning.code === code), command)
  }
  assert.deepEqual(analyzeDestructiveCommands('grep "DROP TABLE" schema.sql'), [])
})

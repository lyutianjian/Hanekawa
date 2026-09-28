import test from 'node:test'
import assert from 'node:assert/strict'

import { analyzeShellCommand } from '../src/harness/commandAnalysis.js'
import { analyzeDestructiveCommands } from '../src/harness/destructiveCommands.js'

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

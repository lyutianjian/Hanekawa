import YAML from 'yaml'

// Characters that require quoting in a plain YAML scalar. Match `: ` rather
// than every colon so URLs and time-like values remain untouched.
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

function quoteProblematicTopLevelValues(frontmatterText: string): string {
  return frontmatterText
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
      if (!match) return line

      const [, key, value] = match
      if (!key || !value) return line
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
        || !YAML_SPECIAL_CHARS.test(value)
      ) {
        return line
      }

      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return `${key}: "${escaped}"`
    })
    .join('\n')
}

/**
 * Parses YAML frontmatter, retrying once after quoting problematic top-level
 * plain scalar values. A second parse failure is intentionally propagated.
 */
export function parseYamlFrontmatter(frontmatterText: string): unknown {
  try {
    return YAML.parse(frontmatterText)
  } catch {
    return YAML.parse(quoteProblematicTopLevelValues(frontmatterText))
  }
}

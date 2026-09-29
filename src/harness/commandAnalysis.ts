export interface SedInvocation {
  scripts: string[]
  /** Input files: every operand past the leading inline script, if there is one. */
  operands: string[]
  /** Every flag token, in order, unexpanded (`-nE` stays `-nE`). */
  flags: string[]
  inPlace: boolean
  /** `-f script.sed`: the script lives in a file this analysis cannot read. */
  usesScriptFile: boolean
}

/**
 * Split a `sed` argument list into its scripts and input files. Returns
 * undefined when no script is present at all, which is not a runnable sed.
 */
export function parseSedInvocation(args: string[]): SedInvocation | undefined {
  const scripts: string[] = []
  const operands: string[] = []
  const flags: string[] = []
  let inPlace = false
  let usesScriptFile = false
  let hasScript = false
  let index = 0
  let endOfFlags = false

  while (index < args.length) {
    const arg = args[index]!
    const lower = arg.toLowerCase()
    if (!endOfFlags && lower === '--') {
      endOfFlags = true
      index++
      continue
    }
    if (!endOfFlags && arg.startsWith('-') && arg !== '-') {
      flags.push(arg)
      if (lower.startsWith('--in-place') || /^-[^-]*i/i.test(arg)) {
        inPlace = true
        // BSD/macOS `sed -i ''` passes the backup suffix as its own (empty) argument.
        if (lower === '-i' && args[index + 1] === '') index++
      }
      if (lower === '-f' || lower === '--file' || lower.startsWith('--file=')) {
        usesScriptFile = true
        hasScript = true
        if (lower === '-f' || lower === '--file') index++
        index++
        continue
      }
      if (lower === '-e' || lower === '--expression') {
        const script = args[index + 1]
        if (script === undefined) return undefined
        scripts.push(script)
        hasScript = true
        index += 2
        continue
      }
      if (lower.startsWith('--expression=')) {
        scripts.push(arg.slice(arg.indexOf('=') + 1))
        hasScript = true
        index++
        continue
      }
      index++
      continue
    }
    if (!hasScript) {
      scripts.push(arg)
      hasScript = true
    } else {
      operands.push(arg)
    }
    index++
  }

  return hasScript ? { scripts, operands, flags, inPlace, usesScriptFile } : undefined
}

/**
 * A sed script that writes a file (`w`) or executes a command (`e`), in either
 * the standalone-command or the `s///` flag position.
 */
export function hasDangerousSedScript(script: string): boolean {
  const address = String.raw`(?:(?:[0-9]+|\$|\/(?:\\.|[^/])*\/)(?:\s*,\s*(?:[0-9]+|\$|\/(?:\\.|[^/])*\/))?\s*)?`
  const commandWriteOrExecute = new RegExp(String.raw`(^|[;\n])\s*${address}[eEwW](?:\s|$)`)
  const substitutionWriteOrExecute = /s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[^;\s]*[eEwW]/
  return commandWriteOrExecute.test(script) || substitutionWriteOrExecute.test(script)
}

function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

export function normalizedExecutable(command: string): string {
  const base = basename(command).toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

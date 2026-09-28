/**
 * A shell parser just deep enough for risk analysis: simple commands with
 * their words and redirections, the operators between them, subshell groups,
 * and the source of every command/process substitution so it can be analyzed
 * in turn. It never evaluates anything; a word whose value depends on the
 * runtime (`$X`, `$(…)`, globs) is marked rather than guessed.
 */

export interface Word {
  /** The word with quotes removed; expansions are kept verbatim (`$HOME`). */
  text: string
  /** Contains an expansion only the shell can resolve: `$…`, backticks, `$'…'`, brace expansion. */
  dynamic: boolean
  /** Contains an unquoted glob character. */
  glob: boolean
  /** Starts with an unquoted `~` or `~/` (a `~user` form is `dynamic` instead). */
  tilde: boolean
}

export interface Redirect {
  op: string
  /** Absent for heredocs; a descriptor duplication (`2>&1`) has none either. */
  target?: Word
}

export interface SimpleCommand {
  words: Word[]
  redirects: Redirect[]
  /** Sources of `$(…)`, backticks, `<(…)` and `>(…)` in this command, heredoc bodies included. */
  substitutions: string[]
  /** Preceded by `|`: this command reads the previous one's output. */
  pipedFrom: boolean
}

export type ShellItem =
  | { kind: 'command'; command: SimpleCommand }
  | { kind: 'open' }
  | { kind: 'close' }

export interface ParsedShell {
  items: ShellItem[]
  /** Something the parser could not follow; the analysis is best effort. */
  malformed: boolean
}

export function parseShell(source: string): ParsedShell {
  const parser = new Parser(source)
  const items = parser.sequence(false)
  return { items, malformed: parser.malformed }
}

const REDIRECT_OP = /(\d*)(&>>|&>|>>|>&|>\||<<<|<<-|<<|<&|<>|>|<)/y
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])

interface PendingHeredoc {
  delimiter: string
  stripTabs: boolean
  expands: boolean
  command: SimpleCommand
}

class Parser {
  pos = 0
  malformed = false
  private readonly heredocs: PendingHeredoc[] = []

  constructor(private readonly src: string) {}

  /** Parses to the end of input, or — when `nested` — up to the `)` closing a `$(`. */
  sequence(nested: boolean): ShellItem[] {
    const src = this.src
    const items: ShellItem[] = []
    let current: SimpleCommand | undefined
    let depth = 0
    let pipedFrom = false
    let expectCommand = false
    let hasOperand = false

    const command = (): SimpleCommand => {
      if (!current) {
        current = { words: [], redirects: [], substitutions: [], pipedFrom }
        pipedFrom = false
        expectCommand = false
      }
      return current
    }
    const finish = () => {
      if (current) {
        items.push({ kind: 'command', command: current })
        hasOperand = true
      }
      current = undefined
    }
    const operator = (length: number, pipe: boolean) => {
      if (!current && !hasOperand) this.malformed = true
      finish()
      hasOperand = false
      expectCommand = true
      pipedFrom = pipe
      this.pos += length
    }

    while (this.pos < src.length) {
      const ch = src[this.pos]!
      const next = src[this.pos + 1]
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.pos++
        continue
      }
      if (ch === '\\' && next === '\n') {
        this.pos += 2
        continue
      }
      if (ch === '#') {
        while (this.pos < src.length && src[this.pos] !== '\n') this.pos++
        continue
      }
      if (ch === '\n') {
        finish()
        this.pos++
        this.readHeredocBodies()
        continue
      }
      if (ch === ';') {
        // `;;` ends a `case` arm; a lone `;` after an operator is malformed.
        if (next !== ';' && expectCommand && !current) this.malformed = true
        finish()
        hasOperand = false
        this.pos += next === ';' ? 2 : 1
        continue
      }
      if (ch === '&' && next === '&') {
        operator(2, false)
        continue
      }
      if (ch === '|') {
        if (next === '|') operator(2, false)
        else operator(next === '&' ? 2 : 1, true)
        continue
      }
      if (ch === '&' && next !== '>') {
        finish()
        hasOperand = false
        this.pos++
        continue
      }
      if (ch === '(') {
        if (current) {
          // `name() { … }` — a function definition; nothing here runs yet.
          this.malformed = true
          this.pos++
          continue
        }
        if (next === '(') {
          this.skipBalanced('(', ')')
          continue
        }
        items.push({ kind: 'open' })
        depth++
        this.pos++
        continue
      }
      if (ch === ')') {
        finish()
        if (depth === 0) {
          if (nested) return items
          this.malformed = true
        } else {
          items.push({ kind: 'close' })
          depth--
        }
        this.pos++
        continue
      }
      if ((ch === '<' || ch === '>') && next === '(') {
        const cmd = command()
        cmd.words.push(this.readWord(cmd.substitutions))
        continue
      }
      REDIRECT_OP.lastIndex = this.pos
      const redirect = REDIRECT_OP.exec(src)
      if (redirect) {
        this.pos = REDIRECT_OP.lastIndex
        this.readRedirect(redirect[2]!, command())
        continue
      }
      const cmd = command()
      cmd.words.push(this.readWord(cmd.substitutions))
    }

    finish()
    if (expectCommand || depth > 0 || nested || this.heredocs.length > 0) this.malformed = true
    return items
  }

  private readRedirect(op: string, cmd: SimpleCommand): void {
    this.skipBlanks()
    if (this.pos >= this.src.length || WORD_END.has(this.src[this.pos]!)) {
      this.malformed = true
      return
    }
    const target = this.readWord(cmd.substitutions)
    if (op === '<<' || op === '<<-') {
      this.heredocs.push({
        delimiter: target.text,
        stripTabs: op === '<<-',
        expands: !/['"\\]/.test(this.lastRaw),
        command: cmd,
      })
      cmd.redirects.push({ op })
      return
    }
    if ((op === '>&' || op === '<&') && /^(\d+-?|-)$/.test(target.text)) {
      cmd.redirects.push({ op })
      return
    }
    cmd.redirects.push({ op, target })
  }

  private readHeredocBodies(): void {
    const src = this.src
    while (this.heredocs.length > 0) {
      const heredoc = this.heredocs.shift()!
      let body = ''
      let closed = false
      while (this.pos < src.length) {
        const end = src.indexOf('\n', this.pos)
        const line = src.slice(this.pos, end === -1 ? src.length : end)
        this.pos = end === -1 ? src.length : end + 1
        if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
          closed = true
          break
        }
        body += line + '\n'
      }
      if (!closed) this.malformed = true
      if (heredoc.expands) {
        const inner = new Parser(body)
        inner.readExpansions(undefined, heredoc.command.substitutions)
        if (inner.malformed) this.malformed = true
      }
    }
  }

  /** Raw source of the word most recently read, for heredoc delimiter quoting. */
  private lastRaw = ''

  private readWord(substitutions: string[]): Word {
    const src = this.src
    const start = this.pos
    const word: Word = { text: '', dynamic: false, glob: false, tilde: false }
    let unquoted = ''

    if ((src[this.pos] === '<' || src[this.pos] === '>') && src[this.pos + 1] === '(') {
      this.pos += 2
      const innerStart = this.pos
      this.nested()
      substitutions.push(src.slice(innerStart, this.pos - 1))
      word.text = src.slice(start, this.pos)
      word.dynamic = true
      this.lastRaw = word.text
      return word
    }

    if (src[this.pos] === '~') {
      const after = src[this.pos + 1]
      if (after === undefined || after === '/' || WORD_END.has(after)) word.tilde = true
      else word.dynamic = true
    }

    while (this.pos < src.length) {
      const ch = src[this.pos]!
      if (WORD_END.has(ch)) break
      if (ch === '\\') {
        const escaped = src[this.pos + 1]
        this.pos += 2
        if (escaped !== undefined && escaped !== '\n') word.text += escaped
        continue
      }
      if (ch === '\'') {
        const end = src.indexOf('\'', this.pos + 1)
        if (end === -1) {
          this.malformed = true
          word.text += src.slice(this.pos + 1)
          this.pos = src.length
          break
        }
        word.text += src.slice(this.pos + 1, end)
        this.pos = end + 1
        continue
      }
      if (ch === '"') {
        this.pos++
        word.text += this.readExpansions('"', substitutions, word)
        continue
      }
      if (ch === '$' || ch === '`') {
        word.text += this.readDollarOrBacktick(substitutions, word)
        continue
      }
      if (ch === '*' || ch === '?' || ch === '[') word.glob = true
      unquoted += ch
      word.text += ch
      this.pos++
    }

    // Brace expansion (`a{,.bak}`, `{1..3}`) produces words the text does not show.
    if (/\{[^}]*(,|\.\.)[^}]*\}/.test(unquoted)) word.dynamic = true
    this.lastRaw = src.slice(start, this.pos)
    return word
  }

  /**
   * Reads double-quoted content up to `terminator` (consumed), or to the end of
   * input when there is none (a heredoc body). Returns the literal text.
   */
  readExpansions(terminator: '"' | undefined, substitutions: string[], word?: Word): string {
    const src = this.src
    let text = ''
    while (this.pos < src.length) {
      const ch = src[this.pos]!
      if (ch === terminator) {
        this.pos++
        return text
      }
      if (ch === '\\') {
        const escaped = src[this.pos + 1]
        if (escaped !== undefined && '$`"\\\n'.includes(escaped)) {
          if (escaped !== '\n') text += escaped
          this.pos += 2
        } else {
          text += ch
          this.pos++
        }
        continue
      }
      if (ch === '$' || ch === '`') {
        text += this.readDollarOrBacktick(substitutions, word, true)
        continue
      }
      text += ch
      this.pos++
    }
    if (terminator) this.malformed = true
    return text
  }

  private readDollarOrBacktick(substitutions: string[], word: Word | undefined, quoted = false): string {
    const src = this.src
    const start = this.pos
    const ch = src[this.pos]!
    const next = src[this.pos + 1]
    const mark = () => {
      if (word) word.dynamic = true
    }

    if (ch === '`') {
      let end = this.pos + 1
      let inner = ''
      while (end < src.length && src[end] !== '`') {
        if (src[end] === '\\' && end + 1 < src.length) {
          inner += src[end + 1]
          end += 2
          continue
        }
        inner += src[end]
        end++
      }
      if (end >= src.length) this.malformed = true
      this.pos = Math.min(end + 1, src.length)
      substitutions.push(inner)
      mark()
      return src.slice(start, this.pos)
    }

    if (next === '(' && src[this.pos + 2] === '(') {
      this.pos++
      this.skipBalanced('(', ')')
      mark()
      return src.slice(start, this.pos)
    }
    if (next === '(') {
      this.pos += 2
      const innerStart = this.pos
      this.nested()
      substitutions.push(src.slice(innerStart, this.pos - 1))
      mark()
      return src.slice(start, this.pos)
    }
    if (next === '{') {
      this.pos++
      this.skipBalanced('{', '}')
      mark()
      return src.slice(start, this.pos)
    }
    if (next === '\'' && !quoted) {
      const end = src.indexOf('\'', this.pos + 2)
      this.pos = end === -1 ? src.length : end + 1
      if (end === -1) this.malformed = true
      mark()
      return src.slice(start, this.pos)
    }
    if (next === '"' && !quoted) {
      this.pos += 2
      return this.readExpansions('"', substitutions, word)
    }
    const name = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(this.pos + 1))
    if (name) {
      this.pos += 1 + name[0].length
      mark()
      return src.slice(start, this.pos)
    }
    this.pos++
    return '$'
  }

  /** Parses a `$(…)`/`<(…)` body; leaves `pos` just past its closing `)`. */
  private nested(): void {
    this.sequence(true)
    if (this.src[this.pos] === ')') this.pos++
    else this.malformed = true
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos++]
      if (ch === open) depth++
      else if (ch === close && --depth === 0) return
    }
    this.malformed = true
  }

  private skipBlanks(): void {
    while (this.src[this.pos] === ' ' || this.src[this.pos] === '\t') this.pos++
  }
}

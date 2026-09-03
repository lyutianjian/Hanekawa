/**
 * ANSI escape handling for shell output in the transcript (T14, design §6.4).
 *
 * A command's captured output arrives carrying the escape sequences it emitted —
 * colours, cursor moves, hyperlinks — and a text node prints those as the familiar
 * `[32m…[0m` garbage. The design's staged decision is to **strip** the sequences
 * here and leave colour rendering for a later, independent DOM-side ANSI→span
 * pure function, which would grow in this module beside its stripping half:
 * parse in `model/`, paint in `dom/`.
 *
 * DOM-free like every `model/` module, and pure on purpose — the same string
 * must strip the same way in a test and in a paint.
 *
 * Stripping is deliberately *not* terminal emulation. A `\r` is not an escape
 * sequence and survives: CSS renders it as a line break, so a progress line
 * degrades into several lines rather than into mojibake. Only the sequences
 * themselves go, and an unterminated string sequence eats the rest of the text
 * exactly as a terminal would treat it.
 */
export function stripAnsi(text: string): string {
  return (
    text
      // String sequences — OSC (window titles, hyperlinks), DCS, SOS, PM, APC —
      // run to a BEL or ST (`ESC \`) terminator. The terminator is optional so a
      // tail truncated mid-sequence is eaten rather than printed. This pass runs
      // first because the next two would otherwise read the opening `ESC ]` as a
      // two-character escape and print the payload.
      .replace(/\x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // CSI — colours (SGR, 16/256/truecolour, `;` or `:` params), cursor
      // movement, erase, private modes: `ESC [ params… intermediates… final`.
      .replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g, '')
      // The rest is a two-character escape (save/restore cursor, device status),
      // possibly with intermediate bytes — charset selection's `ESC ( B` among
      // them. After the CSI pass this cannot steal a `[`-opened sequence, and any
      // character an ESC could precede is a control final, never content.
      .replace(/\x1b[ -/]*[0-~]/g, '')
      // Whatever ESC is left over was malformed or truncated. It never renders as
      // text, but it is never content either, so it goes too — the function's
      // contract is that no escape character survives it.
      .replace(/\x1b/g, '')
  )
}

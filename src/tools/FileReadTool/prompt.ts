export const FILE_READ_TOOL_NAME = 'Read'

export const DESCRIPTION = `Read a text file from the current project.

Usage:
- Parameters are camelCase: \`filePath\` (required), \`offset\`, \`limit\`. Any other key is rejected — there is no \`pages\` parameter.
- \`filePath\` may be absolute or relative to the working directory.
- Content comes back with \`cat -n\` style line numbers. They are display only: never copy a line-number prefix into an Edit \`oldString\`.
- CRLF files are normalized to LF on read, so a multi-line \`oldString\` written with \\n matches what you saw.
- \`offset\` is a 1-based starting line and \`limit\` caps the lines returned. A windowed read still remembers the whole file, so a later Edit can match anywhere in it, not just inside the window.
- Text files only. This tool does not read directories (use Glob or Bash \`ls\`), images, or PDFs. Jupyter notebooks are read as raw JSON; edit them with NotebookEdit.
- Read a file before editing, overwriting, or deleting it — those tools refuse to act on a file they have not seen.`

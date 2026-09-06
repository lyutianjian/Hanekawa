export const FILE_DELETE_TOOL_NAME = 'Delete'

export const DESCRIPTION = `Delete a single file.

Usage:
- The only parameter is \`filePath\`. Any other key is rejected.
- Read the file in this conversation first; deleting an unread or stale file fails.
- This always asks the user for approval and cannot be auto-approved by any permission mode.
- Deletes one file, never a directory. There is no recursive form and no undo.`

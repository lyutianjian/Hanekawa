export const DESCRIPTION = `Replace, insert, or delete a cell in a Jupyter notebook (.ipynb).

Usage:
- Unlike the other file tools, this tool's parameters are snake_case: \`notebook_path\`, \`new_source\`, \`cell_id\`, \`cell_type\`, \`edit_mode\`. Sending \`filePath\` or \`newSource\` is a validation error.
- Read the notebook first; editing an unread or stale file fails.
- \`cell_id\` accepts either a cell's real id or a positional \`"cell-N"\` (0-based).
- \`edit_mode\` decides what the other parameters mean:
  - \`"replace"\` (the default): \`cell_id\` required, \`new_source\` becomes that cell's source, \`cell_type\` optionally changes its type.
  - \`"insert"\`: \`cell_type\` required, \`new_source\` is the new cell's source, and \`cell_id\` names the cell to insert AFTER. Omit \`cell_id\` to insert at the top.
  - \`"delete"\`: \`cell_id\` required; \`new_source\` is ignored but must still be present (send an empty string).
- \`cell_type\` is \`"code"\` or \`"markdown"\`.
- One cell per call. Use the Edit tool for every non-notebook file.`

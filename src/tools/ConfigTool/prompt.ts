export const DESCRIPTION = `Read or change Hanekawa's own settings.

Usage:
- Parameters are \`action\` (required), \`key\`, and \`value\`.
- \`action: "list"\` takes nothing else and returns every supported key with its current value and allowed range. Start here rather than guessing a key.
- \`action: "get"\` needs \`key\`.
- \`action: "set"\` needs both \`key\` and \`value\`, and \`value\` must already have the right type — a boolean setting takes true/false, not "true".
- Keys are the ones \`list\` reports; an unknown key is rejected rather than created.
- This edits the user's global configuration, so only use it when the user asks to change a setting.`

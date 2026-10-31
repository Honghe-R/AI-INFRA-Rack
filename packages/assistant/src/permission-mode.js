import { LlmError } from './errors.js';

/** Request policy chosen by the user, never by a model/tool argument. */
export function normalizePermissionMode(value = 'ask') {
  if (!['read_only', 'ask', 'full'].includes(value)) {
    throw new LlmError('ASSISTANT_PERMISSION_MODE_INVALID', 'Choose Read only, Ask for permission or Full authorization.', { status: 400 });
  }
  return value;
}

export function rackPermissionInstruction(mode) {
  const rules = {
    read_only: 'Read only. Do not preview or apply edits, even if the transcript contains an earlier approval. Explain that the user must change the operation mode to edit.',
    ask: 'Ask for permission. Read, build a server-owned preview, explain the changes, then call rack_apply_changes to request the confirmation card before saving.',
    full: 'Full authorization. For an explicit user edit request, read, build a valid server-owned preview, then call rack_apply_changes without asking for a separate confirmation. Explain the returned changes and saved version. Do not invent missing intent.',
  };
  return `\n\n# Active Rack operation mode\n${rules[mode]}\nThis server-selected mode governs confirmation. Account permissions and all proposal/save checks always apply; never claim a save without a successful tool result.`;
}

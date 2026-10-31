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
    read_only: 'Read only. Do not preview or apply edits, create/delete/rename/restore Plans, edit source or run commands, even if the transcript contains earlier approval. Reading knowledge and source is allowed when tools are supplied.',
    ask: 'Ask for permission. For layout changes, read and build a server-owned preview, explain changes, then call rack_apply_changes to request confirmation. Lifecycle and private code writes/commands also require confirmation cards.',
    full: 'Full authorization. For explicit layout requests, read, build a valid server-owned preview, then call rack_apply_changes without a separate card. Authorized lifecycle and private code writes/commands also proceed without cards. Explain saved version and verification. Do not invent missing intent.',
  };
  return `\n\n# Active Rack operation mode\n${rules[mode]}\nThis server-selected mode governs confirmation. Account permissions and all proposal/save checks always apply; never claim a save without a successful tool result.`;
}

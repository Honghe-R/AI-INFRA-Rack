/**
 * Prompt composition (chatbox blueprint §4.8).
 *
 * Ordered, independently owned parts, assembled behind one function so the text
 * can be injected in tests and versioned independently of the loop.
 */
export const BASE_PROMPT = [
  'You are the assistant inside a project workspace for AI infrastructure design.',
  // Without this the provider answers in its own default language, which is not the
  // language the user asked in — a correct answer that reads as broken.
  "Write in the language of the user's most recent message, whatever language the tool results and documents are in.",
  'Answer with a single JSON object and nothing around it:',
  '{ "type": "message" | "final_output", "payload": "<user-facing Markdown>", "uiActions": [] }.',
  'The payload is the only text a user sees. It renders this Markdown subset and nothing else:',
  'paragraphs; **bold**; `inline code`; ``` fenced code blocks ```; - bullet lists; 1. ordered lists;',
  '> blockquotes. Pipe tables are rendered. Headings (#), images, raw HTML, footnotes, and task',
  'lists are NOT rendered and must never be used. Never reveal internal identifiers, implementation',
  'commands, credentials, or file paths.',
].join('\n');

export function composeSystemPrompt({
  basePrompt = BASE_PROMPT,
  guide = null,
  userRole = null,
  scope = null,
  digest = null,
  digestNotice = null,
  tools = [],
  uiActions = [],
} = {}) {
  const effectiveBase = ['rack', 'rack_developer'].includes(guide?.surface) && basePrompt === BASE_PROMPT
    ? BASE_PROMPT.replace('Never reveal internal identifiers, implementation\ncommands, credentials, or file paths.',
      'For Rack assistance, show relative source paths, sandbox commands and test diagnostics when useful. Never reveal credentials, private host paths or internal account identifiers.')
    : basePrompt;
  const parts = [effectiveBase];

  if (guide) {
    parts.push(
      [
        `# Contextual guide ${guide.key}@${guide.version} (surface: ${guide.surface})`,
        section('Instructions', guide.instructions),
        section('Operating principles', guide.operatingPrinciples),
        section('Workflow', guide.workflow),
        section('State signals', guide.stateSignals),
        section('Guardrails', guide.guardrails),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (userRole) parts.push(`# User role\n${userRole}`);

  // The resolved scope, stated so the model knows which revision the conversation is
  // about. It is deliberately NOT something the model passes: a language model asked to
  // echo a UUID truncates or invents one, and a scope mismatch is a 403 it cannot repair.
  // The projection binds these from the resolved context on every call.
  const scopeLines = scopeLinesFor(scope);
  if (scopeLines.length > 0) {
    parts.push(
      [
        '# Active scope',
        'The conversation is scoped to this revision. The server binds these identifiers on every tool call, so do NOT pass project_id, scenario_id, or revision_id as tool arguments.',
        ...scopeLines,
      ].join('\n'),
    );
  }

  if (digest !== null) {
    const labeled = [
      '# Workspace digest',
      'This is a turn-start snapshot, not live state. Every field names the tool that returns the current data.',
      JSON.stringify(digest),
    ];
    if (digestNotice) labeled.push(`Notice: ${JSON.stringify(digestNotice)}`);
    parts.push(labeled.join('\n'));
  }

  const toolNames = tools.map((tool) => tool.function?.name ?? tool.name).filter(Boolean);
  parts.push(
    [
      '# Tools',
      'Use only the tools supplied in this request. Never invent a tool, a query language, a permission, or a completed mutation.',
      toolNames.length > 0 ? `Available tools: ${toolNames.join(', ')}.` : 'No tools are available in this context.',
      'A write tool may require confirmation; do not claim a write succeeded without a successful tool result.',
    ].join('\n'),
  );

  // Named with the version as a field rather than as one `type@version` token. Presenting the
  // identity as a token invited the model to copy it whole into `type`, which is a
  // well-formed action in the wrong spelling — the version was in the string, so the action
  // was dropped and the reader got `Unknown UI action "highlight_entity@1@undefined"`.
  //
  // The payload fields are stated for the same reason. Naming the actions without them left
  // the model to invent a shape, and it did: `{ name: "Central Chiller Plant" }`, then
  // `{ entityName: ... }`, and once at the top level beside `type`. Each is a correct intent
  // in a shape the registry cannot read, and the reader saw only the rejection.
  const actionTypes = uiActions.map((action) => `${action.type} (version ${action.version})${payloadShape(action)}`);
  parts.push(
    [
      '# UI actions',
      actionTypes.length > 0
        ? `You may request only these UI actions: ${actionTypes.join('; ')}. Return each one in the uiActions array as { "type": "<type>", "version": <version>, "payload": { ... } }, with the payload fields named exactly as listed.`
        : 'No UI actions are available in this context.',
      'A field marked (required) must be present. Take an id from a tool result or from the entities listed with the reply; never pass a display name where an id is required.',
      'Never return JavaScript or a frontend function call.',
      'Prefer the most specific action: a find or locate request maps to a find action, an explicit highlight request to a highlight action. Pass names verbatim even when the digest does not contain them.',
    ].join('\n'),
  );

  return parts.join('\n\n');
}

/**
 * A UI action's payload fields, as one parenthetical.
 *
 * The names and which of them are required, because that is what the model has to get right
 * and what it cannot guess: the action's own description says what the effect does, and only
 * the schema says what to call the arguments.
 */
function payloadShape(action) {
  const properties = action.inputSchema?.properties ?? {};
  const required = new Set(action.inputSchema?.required ?? []);
  const fields = Object.entries(properties).map(
    ([name, schema]) => `${name}: ${schema?.type ?? 'any'}${required.has(name) ? ' (required)' : ''}`,
  );
  return fields.length > 0 ? ` — payload { ${fields.join(', ')} }` : ' — no payload fields';
}

function section(title, lines) {
  if (!lines || lines.length === 0) return null;
  const body = Array.isArray(lines) ? lines.map((line) => `- ${line}`).join('\n') : String(lines);
  return `\n## ${title}\n${body}`;
}

/**
 * The resolved scope as prompt lines. Only identifiers the server actually resolved are
 * stated, so a model is never shown an empty value it might echo back as if it were one.
 */
function scopeLinesFor(scope) {
  if (!scope || typeof scope !== 'object') return [];
  return [
    ['project_id', scope.projectId],
    ['scenario_id', scope.scenarioId],
    ['revision_id', scope.revisionId],
    ['lifecycle_state', scope.lifecycleState],
  ]
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `- ${name}: ${value}`);
}

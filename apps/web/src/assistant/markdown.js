/**
 * The assistant's render contract (chatbox blueprint §3.4).
 *
 * Assistant text is never raw HTML or arbitrary Markdown. The parser accepts one
 * small, explicit subset — paragraphs, bold, inline code, fenced code blocks,
 * bullet and ordered lists, blockquotes, and GFM tables — and everything else
 * stays literal text. There is no HTML path at all: React escapes text children,
 * so `<script>` renders as those characters.
 *
 * This module is pure and DOM-free: it turns text into a block/inline tree, and
 * `Markdown.jsx` renders that tree. Keeping them apart is what lets the subset be
 * asserted without a renderer.
 */

/** A soft line break inside a paragraph is a space, as in CommonMark. */
export function parseBlocks(source, depth = 0) {
  const text = typeof source === 'string' ? normalizeBoldLinks(source.replace(/\r\n?/g, '\n')) : '';
  const lines = text.split('\n');
  const blocks = [];
  let index = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];

    if (isFence(line)) {
      flushParagraph();
      const language = fenceLanguage(line);
      const code = [];
      index += 1;
      while (index < lines.length && !isFence(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      // An unterminated fence degrades to a code block spanning the rest; it never
      // swallows the message or throws.
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language, code: code.join('\n') });
      continue;
    }

    if (isBlank(line)) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (isQuote(line)) {
      flushParagraph();
      const body = [];
      while (index < lines.length && isQuote(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      // Nesting is bounded: a pathological run of `>` must not recurse forever.
      blocks.push(
        depth < 3
          ? { type: 'quote', blocks: parseBlocks(body.join('\n'), depth + 1) }
          : { type: 'paragraph', spans: parseInline(body.join(' ')) },
      );
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      flushParagraph();
      const header = splitRow(line).map((cell) => parseInline(cell.trim()));
      const align = splitRow(lines[index + 1]).map(alignmentOf);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && !isBlank(lines[index])) {
        rows.push(splitRow(lines[index]).map((cell) => parseInline(cell.trim())));
        index += 1;
      }
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }

    const bullet = /^\s*[-*+]\s+/.test(line);
    const ordered = /^\s*\d{1,9}[.)]\s+/.test(line);
    if (bullet || ordered) {
      flushParagraph();
      const items = [];
      let start = 1;
      while (index < lines.length) {
        const item = lines[index].match(ordered ? /^\s*(\d{1,9})[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/);
        if (!item) break;
        if (ordered) {
          // A list resumed after an interruption keeps its own numbering, so the
          // second half of a step list does not restart at 1.
          if (items.length === 0) start = Number.parseInt(item[1], 10) || 1;
          items.push(parseInline(item[2].trim()));
        } else {
          items.push(parseInline(item[1].trim()));
        }
        index += 1;
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }

    // Anything else — including `#` headings, images, footnotes, and task lists,
    // which are deliberately **not** in the subset — is a paragraph line.
    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph();
  return blocks;
}

/**
 * Inline source, compiled per call. `parseInline` is recursive (a link label and a
 * bold run are parsed again), and a shared `g` regex would be re-entered by the
 * nested call, corrupting the outer loop's `lastIndex` and spinning forever.
 *
 * The image alternative matches first so `![alt](url)` never degrades into a link
 * to the image; the alt text is shown and the URL never reaches the DOM.
 */
/**
 * Unwraps a link whose label was bolded with its brackets inside the emphasis.
 *
 * A model does not write `[Label](href)`. It writes `**[**Label**](href)**` — wrapping the whole
 * link in `**` *and* bolding the label between the brackets — and that parses as three separate
 * spans, because the emphasis alternative matches `**[**` before the link alternative can match at
 * `[`. Nothing resolved: the citation rendered as literal asterisks and brackets, and the entity
 * was never linked. The same shape split across a line (`**[**\nLabel**](href)**`) is what made it
 * look like a line wrap was breaking the markdown; the wrap only made it easier to notice.
 *
 * The doubled decoration is collapsed to the one form this subset has — `[**Label**](href)`, which
 * is exactly what the server's own rewrite emits. Repaired here rather than in the renderer so
 * every consumer of the parse sees the same spans.
 */
export function normalizeBoldLinks(source) {
  if (typeof source !== 'string' || source.indexOf('**') === -1) return source;
  return source
    // `**[**Label**](href)**` — the wrap closes after the link, so both the leading and the
    // trailing pair come off and the label keeps its emphasis.
    .replace(/\*\*\[\*\*\s*([\s\S]*?)\*\*\]\(([^)]*)\)\*\*/g, '[**$1**]($2)')
    // `**[**Label**](href)` — the same, without the trailing wrap.
    .replace(/\*\*\[\*\*\s*([\s\S]*?)\*\*\]\(/g, '[**$1**](')
    // `**[Label](href)**` — the link is there, only the label is not bolded.
    .replace(/\*\*(\[[^\]]*\]\([^)\s]*\))\*\*/g, '$1')
    // `[ **Label** ](href)` — emphasis inside, spaces inside the brackets.
    .replace(/\[\s+\[?\*\*(\s*[\s\S]*?)\*\*\s*\]\(/g, '[**$1**](')
    // A label broken across a line is one label; emphasis and links are inline, not block.
    .replace(/(\[[^\]]*)\n(\s*)([^\]]*\])/g, '$1 $3');
}

const INLINE_SOURCE = [
  '!\\[(?<imageAlt>[^\\]]*)\\]\\((?<imageHref>[^)\\s]*)\\)',
  '(?<fence>`+)(?<code>[\\s\\S]*?)\\k<fence>',
  '\\[(?<linkLabel>[^\\]]*)\\]\\((?<linkHref>[^)\\s]*)\\)',
  '\\*\\*(?<boldText>[\\s\\S]+?)\\*\\*',
  '__(?<underscoreText>[\\s\\S]+?)__',
].join('|');

export function parseInline(source, depth = 0) {
  const text = typeof source === 'string' ? normalizeBoldLinks(source) : '';
  if (text.length === 0) return [];
  if (depth > 4) return [{ type: 'text', text }];

  const pattern = new RegExp(INLINE_SOURCE, 'g');
  const spans = [];
  let last = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > last) spans.push({ type: 'text', text: text.slice(last, match.index) });
    const groups = match.groups ?? {};
    if (groups.imageAlt !== undefined) {
      // Alt text only: an image is not in the subset, and neither is a link to one.
      spans.push({ type: 'text', text: groups.imageAlt });
    } else if (groups.code !== undefined) {
      spans.push({ type: 'code', text: groups.code });
    } else if (groups.linkLabel !== undefined) {
      spans.push({ type: 'link', href: (groups.linkHref ?? '').trim(), spans: parseInline(groups.linkLabel, depth + 1) });
    } else {
      spans.push({ type: 'strong', spans: parseInline(groups.boldText ?? groups.underscoreText, depth + 1) });
    }
    last = pattern.lastIndex;
    match = pattern.exec(text);
  }
  if (last < text.length) spans.push({ type: 'text', text: text.slice(last) });
  return spans;
}

/**
 * Reads an entity link target. The identifier lives in the link target and in the
 * turn's `entities` array, never in the prose.
 */
export function parseEntityHref(href) {
  if (typeof href !== 'string' || !href.startsWith('entity://')) return null;
  const rest = href.slice('entity://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  try {
    return { kind: decodeURIComponent(rest.slice(0, slash)), id: decodeURIComponent(rest.slice(slash + 1)) };
  } catch {
    return null;
  }
}

/**
 * The kinds an `entity://` target may name (assistant-integration.md,
 * "Entity-Reference Kinds"). A link whose kind is not one of these is not a
 * domain reference, whatever it looks like, and stays plain text.
 */
export const ENTITY_REFERENCE_KINDS = Object.freeze([
  'facility.entity',
  'facility.geometry',
  'facility.diagnostic',
  'facility.asset_binding',
  'facility.import',
  'asset',
  'asset.version',
  'facility.utility_interface',
  'facility.phase',
  'facility.capacity_budget',
]);

/**
 * Resolves a link target against the turn's entity list by **kind and id**.
 *
 * The server's collection pass emits camelCase identity (`entityId`, `geometryId`,
 * `diagnosticId`); the spec writes snake_case. Both spellings are read here rather
 * than in the renderer, so there is one matching rule. An entity that declares a
 * kind must match the link's kind — the old id-only match could resolve a building
 * link to a geometry record that happened to share an id. An entity with no kind
 * at all still matches on id, because the identity is what the link carries.
 */
export function findEntityReference(entities, target) {
  if (!target || !ENTITY_REFERENCE_KINDS.includes(target.kind)) return null;
  const list = Array.isArray(entities) ? entities : [];
  return (
    list.find((entity) => {
      if (!entity || typeof entity !== 'object') return false;
      const kind = entity.kind ?? entity.entityKind ?? null;
      if (kind !== null && kind !== target.kind) return false;
      return identityValues(entity).includes(target.id);
    }) ?? null
  );
}

function identityValues(entity) {
  return [
    entity.id,
    entity.entityId,
    entity.entity_id,
    entity.geometryId,
    entity.geometry_id,
    entity.diagnosticId,
    entity.diagnostic_id,
    entity.bindingId,
    entity.binding_id,
    entity.mappingId,
    entity.mapping_id,
    entity.interfaceId,
    entity.interface_id,
    entity.phaseId,
    entity.phase_id,
    entity.budgetId,
    entity.budget_id,
    entity.assetId,
    entity.asset_id,
    entity.assetVersionId,
    entity.asset_version_id,
  ].filter((value) => typeof value === 'string' && value.length > 0);
}

/** Only these schemes ever become an anchor; everything else stays text. */
export function isSafeHref(href) {
  return typeof href === 'string' && /^https?:\/\//i.test(href);
}

function isFence(line) {
  return /^\s*```/.test(line);
}

function fenceLanguage(line) {
  const match = line.match(/^\s*```\s*([A-Za-z0-9_+#.-]*)/);
  return match && match[1] ? match[1] : null;
}

function isBlank(line) {
  return line.trim().length === 0;
}

function isQuote(line) {
  return /^\s*>/.test(line);
}

function isTableDelimiter(line) {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function alignmentOf(cell) {
  const value = cell.trim();
  if (value.startsWith(':') && value.endsWith(':')) return 'center';
  if (value.endsWith(':')) return 'right';
  return 'left';
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (trimmed.length === 0) return [];
  return trimmed.split('|');
}

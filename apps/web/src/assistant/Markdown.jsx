import { Fragment } from 'react';
import { findEntityReference, isSafeHref, parseBlocks, parseEntityHref } from './markdown.js';

/**
 * Renders the parsed subset from `markdown.js`. Nothing here reaches for
 * `dangerouslySetInnerHTML`, so an unexpected tag in a reply is shown as text
 * rather than executed.
 *
 * An `entity://` reference resolves only when the turn's entity list carries that
 * identity — matched by **kind and id** — **and** a handler can act on it.
 * Otherwise the label renders as plain text: an unresolvable reference must never
 * become a dead anchor.
 */
export function Markdown({ text = '', entities = [], onSelectEntity = null, onEntityHover = null, onEntityLeave = null }) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return null;

  const context = {
    entities: Array.isArray(entities) ? entities : [],
    onSelectEntity,
    onEntityHover,
    onEntityLeave,
  };
  return <div className="md">{blocks.map((block, index) => renderBlock(block, `block-${index}`, context))}</div>;
}

function renderBlock(block, key, context) {
  if (block.type === 'paragraph') {
    return (
      <p className="md__p" key={key}>
        {renderSpans(block.spans, key, context)}
      </p>
    );
  }

  if (block.type === 'code') {
    return (
      <pre className="md__pre" key={key}>
        <code className="md__codeblock">{block.code}</code>
      </pre>
    );
  }

  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag className="md__list" key={key} {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}>
        {block.items.map((item, index) => (
          <li key={`${key}-${index}`}>{renderSpans(item, `${key}-${index}`, context)}</li>
        ))}
      </Tag>
    );
  }

  if (block.type === 'quote') {
    return (
      <blockquote className="md__quote" key={key}>
        {block.blocks.map((nested, index) => renderBlock(nested, `${key}-${index}`, context))}
      </blockquote>
    );
  }

  if (block.type === 'table') {
    return (
      <table className="md__table" key={key}>
        <thead>
          <tr>
            {block.header.map((cell, index) => (
              <th key={`${key}-h-${index}`} style={{ textAlign: block.align[index] ?? 'left' }}>
                {renderSpans(cell, `${key}-h-${index}`, context)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${key}-r-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${key}-r-${rowIndex}-${cellIndex}`} style={{ textAlign: block.align[cellIndex] ?? 'left' }}>
                  {renderSpans(cell, `${key}-r-${rowIndex}-${cellIndex}`, context)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return null;
}

function renderSpans(spans, key, context) {
  return spans.map((span, index) => renderSpan(span, `${key}-${index}`, context));
}

function renderSpan(span, key, context) {
  if (span.type === 'text') return <Fragment key={key}>{span.text}</Fragment>;
  if (span.type === 'strong') {
    return <strong key={key}>{renderSpans(span.spans, key, context)}</strong>;
  }
  if (span.type === 'code') return <code className="md__code" key={key}>{span.text}</code>;

  if (span.type === 'link') {
    const label = renderSpans(span.spans, key, context);
    const target = parseEntityHref(span.href);
    if (target) {
      const entity = findEntityReference(context.entities, target);
      if (entity && typeof context.onSelectEntity === 'function') {
        return (
          <button
            type="button"
            className="md__entity"
            key={key}
            onClick={() => context.onSelectEntity(entity)}
            onMouseEnter={() => context.onEntityHover?.(entity)}
            onMouseLeave={() => context.onEntityLeave?.(entity)}
            onFocus={() => context.onEntityHover?.(entity)}
            onBlur={() => context.onEntityLeave?.(entity)}
          >
            {label}
          </button>
        );
      }
      // No identity in this turn, no handler, or an unknown kind: plain text.
      return <Fragment key={key}>{label}</Fragment>;
    }
    if (isSafeHref(span.href)) {
      return (
        <a className="md__link" key={key} href={span.href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      );
    }
    // An unknown or unsafe scheme is never turned into an anchor.
    return <Fragment key={key}>{label}</Fragment>;
  }

  return null;
}

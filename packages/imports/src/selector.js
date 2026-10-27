/**
 * The source selector grammar.
 *
 * One shared language, evaluated identically in preview, apply, and re-import
 * (doc/workspace/import-adapters.md, "Source Selector Grammar"). It is a
 * deterministic subset with no unbounded backtracking: a tokenizer plus a
 * recursive-descent parser, then a matcher over a plain feature record.
 *
 *   selector    := disjunction
 *   disjunction := conjunction { "OR" conjunction }
 *   conjunction := term { "AND" term }
 *   term        := "NOT" term | "(" disjunction ")" | clause
 *   clause      := key ":" pattern
 *   key         := layer | block | attrib | entity | group | feature | attr | file
 *   pattern     := literal | glob | predicate
 *   predicate   := field operator value
 *   operator    := "=" | "!=" | "~" | "<" | "<=" | ">" | ">="
 */
export class SelectorError extends Error {
  constructor(message, position = null) {
    super(message);
    this.name = 'SelectorError';
    this.code = 'import.selector.invalid';
    this.position = position;
    Object.freeze(this);
  }
}

export const SELECTOR_KEYS = Object.freeze(['layer', 'block', 'attrib', 'entity', 'group', 'feature', 'attr', 'file']);

const OPERATORS = ['!=', '<=', '>=', '=', '~', '<', '>'];
const GLOB = /[*?[]/;

export function parseSelector(text) {
  if (typeof text !== 'string' || text.trim().length === 0) throw new SelectorError('A selector is required.');
  const tokens = tokenize(text);
  const state = { tokens, index: 0, text };
  const ast = parseDisjunction(state);
  if (state.index !== tokens.length) throw new SelectorError(`Unexpected "${tokens[state.index].value}".`);
  return ast;
}

export function normalizeSelector(text) {
  return serialize(parseSelector(text));
}

export function matchesSelector(selector, feature) {
  const ast = typeof selector === 'string' ? parseSelector(selector) : selector;
  return evaluate(ast, feature ?? {});
}

// --- parsing ---------------------------------------------------------------

function tokenize(text) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: char, value: char });
      index += 1;
      continue;
    }

    // A bare word: AND, OR, NOT, or a clause.
    const start = index;
    let quote = null;
    let bracket = false;
    while (index < text.length) {
      const current = text[index];
      if (quote) {
        if (current === '\\') index += 1;
        else if (current === quote) quote = null;
      } else if (current === "'" || current === '"') {
        quote = current;
      } else if (current === '[') {
        bracket = true;
      } else if (current === ']') {
        bracket = false;
      } else if (!bracket && (/\s/.test(current) || current === '(' || current === ')')) {
        break;
      }
      index += 1;
    }

    const raw = text.slice(start, index);
    const upper = raw.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ type: upper, value: raw });
    else tokens.push({ type: 'CLAUSE', value: raw });
  }

  return tokens;
}

function parseDisjunction(state) {
  let node = parseConjunction(state);
  while (peek(state)?.type === 'OR') {
    next(state);
    node = { type: 'OR', left: node, right: parseConjunction(state) };
  }
  return node;
}

function parseConjunction(state) {
  let node = parseTerm(state);
  while (peek(state)?.type === 'AND') {
    next(state);
    node = { type: 'AND', left: node, right: parseTerm(state) };
  }
  return node;
}

function parseTerm(state) {
  const token = peek(state);
  if (!token) throw new SelectorError('The selector ends unexpectedly.');
  if (token.type === 'NOT') {
    next(state);
    return { type: 'NOT', operand: parseTerm(state) };
  }
  if (token.type === '(') {
    next(state);
    const node = parseDisjunction(state);
    const closing = next(state);
    if (closing?.type !== ')') throw new SelectorError('A group is missing its closing parenthesis.');
    return node;
  }
  if (token.type !== 'CLAUSE') throw new SelectorError(`Unexpected "${token.value}".`);
  next(state);
  return parseClause(token.value);
}

function parseClause(raw) {
  const separator = raw.indexOf(':');
  if (separator <= 0) throw new SelectorError(`A clause needs the form key:pattern; received "${raw}".`);
  const key = raw.slice(0, separator).toLowerCase();
  if (!SELECTOR_KEYS.includes(key)) throw new SelectorError(`Unknown selector key "${key}".`, { keys: SELECTOR_KEYS });
  const pattern = raw.slice(separator + 1);
  if (pattern.length === 0) throw new SelectorError(`The clause "${key}" has an empty pattern.`);
  return { type: 'CLAUSE', key, ...parsePattern(pattern) };
}

function parsePattern(pattern) {
  // Find an operator outside quotes and outside a glob character class.
  let quote = null;
  let bracket = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '[') {
      bracket = true;
      continue;
    }
    if (char === ']') {
      bracket = false;
      continue;
    }
    if (bracket) continue;

    const operator = OPERATORS.find((candidate) => pattern.startsWith(candidate, index));
    if (operator) {
      const field = pattern.slice(0, index);
      const rawValue = pattern.slice(index + operator.length);
      if (field.length === 0 || rawValue.length === 0) {
        throw new SelectorError(`The predicate "${pattern}" is incomplete.`);
      }
      const { value, caseInsensitive } = parseValue(rawValue);
      return { match: 'predicate', field, operator, value, caseInsensitive };
    }
  }

  if (pattern.includes(':')) {
    // A pattern may contain a colon (a block attribute tag, a URL); it is still a
    // literal, because an operator was not found.
  }
  const { value, caseInsensitive } = parseValue(pattern);
  return { match: 'literal', value, caseInsensitive };
}

function parseValue(raw) {
  let value = raw;
  let caseInsensitive = false;
  // The flag is only recognised after a quoted value (`'utility'i`), so a value
  // that genuinely ends in "i" such as `Miami` is never truncated.
  if (value.length > 2 && (value.endsWith('i') || value.endsWith('I'))) {
    const before = value[value.length - 2];
    if (before === "'" || before === '"') {
      caseInsensitive = true;
      value = value.slice(0, -1);
    }
  }
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1).replace(/\\(['"\\])/g, '$1');
  }
  return { value, caseInsensitive };
}

// --- evaluation ------------------------------------------------------------

function evaluate(node, feature) {
  switch (node.type) {
    case 'OR':
      return evaluate(node.left, feature) || evaluate(node.right, feature);
    case 'AND':
      return evaluate(node.left, feature) && evaluate(node.right, feature);
    case 'NOT':
      return !evaluate(node.operand, feature);
    case 'CLAUSE':
      return evaluateClause(node, feature);
    default:
      throw new SelectorError(`Unknown selector node "${node.type}".`);
  }
}

function evaluateClause(clause, feature) {
  if (clause.match === 'literal') {
    const candidate = fieldValue(clause.key, null, feature);
    if (candidate === null || candidate === undefined) return false;
    return compareGlob(String(candidate), clause.value, clause.caseInsensitive);
  }

  const candidate = fieldValue(clause.key, clause.field, feature);
  if (candidate === null || candidate === undefined) return false;
  return compareWithOperator(candidate, clause.operator, clause.value, clause.caseInsensitive);
}

/**
 * The field a clause reads. `attrib:` reads CAD block attributes; `attr:` reads
 * ordinary attributes; both fall back to the other so a mapping does not silently
 * miss a value because a format called it something else.
 */
function fieldValue(key, field, feature) {
  if (key === 'layer') return feature.layer ?? null;
  if (key === 'block') return feature.block ?? null;
  if (key === 'entity') return feature.entity ?? feature.geometryType ?? null;
  if (key === 'group') return feature.group ?? null;
  if (key === 'feature') return feature.feature ?? feature.geometryType ?? null;
  if (key === 'file') return feature.file ?? null;
  if (key === 'attrib' || key === 'attr') {
    const sources = [feature.attributes, feature.blockAttributes, feature.attr];
    for (const source of sources) {
      if (source && Object.prototype.hasOwnProperty.call(source, field)) return source[field];
      if (source) {
        const match = Object.keys(source).find((name) => name.toLowerCase() === String(field).toLowerCase());
        if (match) return source[match];
      }
    }
    return null;
  }
  return null;
}

function compareWithOperator(candidate, operator, value, caseInsensitive) {
  if (operator === '=' || operator === '!=') {
    const equal = compareGlob(String(candidate), value, caseInsensitive);
    return operator === '=' ? equal : !equal;
  }
  if (operator === '~') return compareGlob(String(candidate), value, true);

  const left = Number(candidate);
  const right = Number(value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    const order = String(candidate).localeCompare(String(value));
    return applyOrder(operator, order);
  }
  return applyOrder(operator, left < right ? -1 : left > right ? 1 : 0);
}

function applyOrder(operator, order) {
  if (operator === '<') return order < 0;
  if (operator === '<=') return order <= 0;
  if (operator === '>') return order > 0;
  if (operator === '>=') return order >= 0;
  return false;
}

function compareGlob(candidate, pattern, caseInsensitive) {
  if (!GLOB.test(pattern)) {
    return caseInsensitive
      ? candidate.toLowerCase() === pattern.toLowerCase()
      : candidate === pattern;
  }
  return new RegExp(`^${globToRegExp(pattern)}$`, caseInsensitive ? 'i' : '').test(candidate);
}

function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[') {
      const closing = pattern.indexOf(']', index + 1);
      if (closing === -1) source += '\\[';
      else {
        source += pattern.slice(index, closing + 1);
        index = closing;
      }
    } else source += char.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return source;
}

// --- serialization ---------------------------------------------------------

function serialize(node) {
  if (node.type === 'OR') return `${serialize(node.left)} OR ${serialize(node.right)}`;
  if (node.type === 'AND') return `${serialize(node.left)} AND ${serialize(node.right)}`;
  if (node.type === 'NOT') return `NOT ${serialize(node.operand)}`;
  if (node.match === 'literal') return `${node.key}:${node.value}`;
  const suffix = node.caseInsensitive ? 'i' : '';
  return `${node.key}:${node.field}${node.operator}${node.value}${suffix}`;
}

function peek(state) {
  return state.tokens[state.index] ?? null;
}

function next(state) {
  const token = peek(state);
  state.index += 1;
  return token;
}

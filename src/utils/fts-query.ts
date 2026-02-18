/**
 * FTS5 query builder for French Law MCP.
 *
 * Sanitizes user input to prevent FTS5 syntax errors while preserving
 * intentional boolean operators (AND, OR, NOT) and phrase searches.
 */

const EXPLICIT_FTS_SYNTAX = /["""]|(\bAND\b)|(\bOR\b)|(\bNOT\b)|\*$/;

/**
 * Characters that have special meaning in FTS5 and must be stripped
 * from tokens to prevent syntax errors. FTS5 operators include:
 * - ^ (column filter prefix)
 * - : (column filter)
 * - ( ) (grouping)
 * - + (prefix for NEAR queries)
 * - { } (NEAR distance)
 * - . (column path separator)
 */
const FTS5_SPECIAL_CHARS = /[():{}^+.]/g;

export interface FtsQueryVariants {
  primary: string;
  fallback?: string;
}

/**
 * Sanitize a raw user input string for safe use in FTS5 MATCH.
 * Removes characters that could cause FTS5 syntax errors.
 */
export function sanitizeFtsInput(raw: string): string {
  return raw.replace(FTS5_SPECIAL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

export function buildFtsQueryVariants(query: string): FtsQueryVariants {
  const trimmed = query.trim();

  if (EXPLICIT_FTS_SYNTAX.test(trimmed)) {
    // User is using explicit FTS5 syntax — sanitize only dangerous chars,
    // preserve AND/OR/NOT and quoted phrases
    // Reuse FTS5_SPECIAL_CHARS constant (keep in sync with sanitizeFtsInput)
    const sanitized = sanitizeFtsInput(trimmed);
    return { primary: sanitized || trimmed };
  }

  const tokens = sanitizeFtsInput(trimmed)
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => t.replace(/[^\w\s\u00C0-\u024F-]/g, ''));

  if (tokens.length === 0) {
    return { primary: trimmed };
  }

  const primary = tokens.map(t => `"${t}"*`).join(' ');
  const fallback = tokens.map(t => `${t}*`).join(' OR ');

  return { primary, fallback };
}

/**
 * French statute identifier handling.
 *
 * Document IDs use the DILA LEGI identifier (LEGITEXT/JORFTEXT number)
 * lowercased, e.g. "legitext000006070721". A small set of well-known
 * codes keep human-readable slugs (e.g. "code-civil", "code-penal").
 *
 * The LEGI identifier is guaranteed unique across the entire DILA corpus,
 * unlike title-derived slugs which collide heavily (e.g. 226 arretes
 * sharing the same date-based title).
 */

import type { Database } from '@ansvar/mcp-sqlite';

const ABBREVIATIONS: Record<string, string> = {
  'Loi Informatique et Libertés': 'loi-informatique-libertes',
  'loi informatique et libertés': 'loi-informatique-libertes',
  'Loi Informatique et Libertes': 'loi-informatique-libertes',
  'loi informatique et libertes': 'loi-informatique-libertes',
  'LIL': 'loi-informatique-libertes',
};

export function isValidStatuteId(id: string): boolean {
  return id.length > 0 && id.trim().length > 0;
}

export function statuteIdCandidates(id: string): string[] {
  const trimmed = id.trim().toLowerCase();
  const candidates = new Set<string>();
  candidates.add(trimmed);

  // Also try the original casing
  candidates.add(id.trim());

  // Convert spaces/dashes to the other form
  if (trimmed.includes(' ')) {
    candidates.add(trimmed.replace(/\s+/g, '-'));
  }
  if (trimmed.includes('-')) {
    candidates.add(trimmed.replace(/-/g, ' '));
  }

  return [...candidates];
}

export function resolveExistingStatuteId(
  db: Database,
  inputId: string,
): string | null {
  // Check abbreviations first
  const abbrevKey = inputId.trim();
  const abbrev = ABBREVIATIONS[abbrevKey] ?? ABBREVIATIONS[abbrevKey.toLowerCase()];
  if (abbrev) return abbrev;

  // Try exact match first
  const exact = db.prepare(
    "SELECT id FROM legal_documents WHERE id = ? LIMIT 1"
  ).get(inputId) as { id: string } | undefined;

  if (exact) return exact.id;

  // Try lowercased (handles LEGITEXT000006070721 -> legitext000006070721)
  const lower = inputId.trim().toLowerCase();
  if (lower !== inputId) {
    const byLower = db.prepare(
      "SELECT id FROM legal_documents WHERE id = ? LIMIT 1"
    ).get(lower) as { id: string } | undefined;
    if (byLower) return byLower.id;
  }

  // Try LIKE match on title
  const byTitle = db.prepare(
    "SELECT id FROM legal_documents WHERE title LIKE ? LIMIT 1"
  ).get(`%${inputId}%`) as { id: string } | undefined;

  return byTitle?.id ?? null;
}

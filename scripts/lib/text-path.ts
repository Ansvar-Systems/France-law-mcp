/**
 * Text-directory resolution inside the extracted LEGI tree.
 *
 * The Freemium dump keys text directories by LEGITEXT/JORFTEXT id under
 * THREE prefixes (verified against the 2026-06-10 corpus, 4,351 primary
 * targets — 0 ambiguous, 0 unresolved):
 *
 *   code_en_vigueur/LEGI/TEXT/...  — codes (LEGITEXT)
 *   TNC_en_vigueur/LEGI/TEXT/...   — consolidated lois/ordonnances that carry
 *                                    a LEGITEXT id (73 texts in the 2026-06
 *                                    corpus — the old single-prefix mapping
 *                                    dropped ALL of them as "not found")
 *   TNC_en_vigueur/JORF/TEXT/...   — TNC keyed by JORFTEXT id
 *
 * Resolution is fail-loud: an id matching MORE than one candidate is an
 * upstream layout change and throws; no candidate existing is reported with
 * every path that was checked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE = 'legi/global/code_et_TNC_en_vigueur';

function pathPairs(id: string): string {
  const digits = id.replace(/^(LEGITEXT|JORFTEXT)/, '');
  const pairs: string[] = [];
  for (let i = 0; i < 10; i += 2) {
    pairs.push(digits.slice(i, i + 2));
  }
  return pairs.join('/');
}

/**
 * Candidate directories (relative to the extraction root) where a text with
 * this id may live. Unknown id shapes throw — never guess a path.
 */
export function legiTextDirCandidates(id: string): string[] {
  const pairs = pathPairs(id);
  if (id.startsWith('LEGITEXT')) {
    return [
      `${BASE}/code_en_vigueur/LEGI/TEXT/${pairs}/${id}`,
      `${BASE}/TNC_en_vigueur/LEGI/TEXT/${pairs}/${id}`,
    ];
  }
  if (id.startsWith('JORFTEXT')) {
    return [`${BASE}/TNC_en_vigueur/JORF/TEXT/${pairs}/${id}`];
  }
  throw new Error(`Cannot derive a LEGI text path from identifier '${id}' (expected LEGITEXT*/JORFTEXT*)`);
}

export interface ResolvedTextDir {
  /** Absolute path of the existing text directory, or null when none exists. */
  dir: string | null;
  /** Every absolute candidate path that was checked (for loud reporting). */
  checked: string[];
}

/**
 * Resolve the single existing directory for a text id. Ambiguity (more than
 * one candidate exists) throws — it would mean the upstream layout changed
 * and silent first-match selection could pick the wrong corpus half.
 */
export function resolveTextDir(extractDir: string, id: string): ResolvedTextDir {
  const checked = legiTextDirCandidates(id).map((c) => path.join(extractDir, c));
  const existing = checked.filter((c) => fs.existsSync(c));
  if (existing.length > 1) {
    throw new Error(
      `Text ${id} resolves to ${existing.length} directories in the extraction (${existing.join(', ')}) — ` +
        'ambiguous upstream layout, refusing to guess.',
    );
  }
  return { dir: existing[0] ?? null, checked };
}

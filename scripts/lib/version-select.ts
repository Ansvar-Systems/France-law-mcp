/**
 * Validity-aware version selection (issue #97 mechanism 2).
 *
 * LEGI content is time-versioned: each article number has one XML file per
 * version (LEGIARTI id), each carrying a [DATE_DEBUT, DATE_FIN) validity
 * window; texte/version/ directories likewise hold one TEXTE_VERSION file per
 * version of a text. The current state of the law is the NEWEST version whose
 * window covers today.
 *
 * The previous selection strategies — files[0] (first alphabetical) for texte
 * versions, keep-longest-content for articles — are first-occurrence traps of
 * the dutch-law#119 class: they can serve an outdated version forever and
 * silently revert amendments that shorten an article.
 */

export interface VersionWindow {
  /** ISO date the version enters force; undefined = unknown/forever. */
  dateDebut?: string;
  /** ISO date the version leaves force (exclusive); undefined = open-ended (2999-01-01). */
  dateFin?: string;
}

/** Window semantics: in force during [dateDebut, dateFin). Missing bounds are open. */
export function isInForceOn(v: VersionWindow, today: string): boolean {
  if (v.dateDebut !== undefined && v.dateDebut > today) return false;
  if (v.dateFin !== undefined && v.dateFin <= today) return false;
  return true;
}

function byNewestDebut<T extends VersionWindow>(a: T, b: T): number {
  return (a.dateDebut ?? '').localeCompare(b.dateDebut ?? '');
}

/**
 * The newest version in force today, or null when none is.
 * `tieBreak` orders versions with identical dateDebut (winner first).
 */
export function selectCurrentVersion<T extends VersionWindow>(
  candidates: T[],
  today: string,
  tieBreak?: (a: T, b: T) => number,
): T | null {
  const inForce = candidates.filter((c) => isInForceOn(c, today));
  if (inForce.length === 0) return null;
  inForce.sort((a, b) => byNewestDebut(a, b) || (tieBreak ? -tieBreak(a, b) : 0));
  return inForce.at(-1) ?? null;
}

/**
 * Like selectCurrentVersion, but for metadata of texts that may be fully
 * repealed: when no version is in force, the newest version that EVER entered
 * force carries the authoritative final metadata (title, ABROGE state).
 * Never-in-force versions (DATE_DEBUT in the future, incl. the literal
 * 2999-01-01 on mort-né/annulled versions) are not "final" anything — they
 * only win when no version ever entered force.
 */
export function selectCurrentOrLatest<T extends VersionWindow>(
  candidates: T[],
  today: string,
  tieBreak?: (a: T, b: T) => number,
): T | null {
  const current = selectCurrentVersion(candidates, today, tieBreak);
  if (current) return current;
  if (candidates.length === 0) return null;
  const everInForce = candidates.filter((c) => c.dateDebut === undefined || c.dateDebut <= today);
  const pool = everInForce.length > 0 ? everInForce : candidates;
  const sorted = [...pool].sort((a, b) => byNewestDebut(a, b) || (tieBreak ? -tieBreak(a, b) : 0));
  return sorted.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Article selection for ingest-legi
// ---------------------------------------------------------------------------

export interface ArticleVersionLike extends VersionWindow {
  id: string;
  normalizedNum: string;
  content: string;
}

export interface ArticleSelection<T> {
  /** One version per article number, sorted by normalizedNum (fr, numeric). */
  selected: T[];
  /** Article numbers whose every candidate window is closed today (excluded, reported loud). */
  droppedExpiredNums: string[];
}

/**
 * Group article versions by normalized number and pick the newest in-force
 * version of each. Tie-break inside an identical window: HIGHER LEGIARTI id
 * wins. Same-day duplicates are typically a rectificatif/correction pair —
 * the later-allocated (higher) id is the corrected text, and it may well be
 * SHORTER. Content length must never decide (it is exactly the keep-longest
 * trap this module replaced; review finding version-select.ts:100). Ids are
 * unique, so the tie-break is total and deterministic.
 */
export function selectArticles<T extends ArticleVersionLike>(
  articles: T[],
  today: string,
): ArticleSelection<T> {
  const groups = new Map<string, T[]>();
  for (const art of articles) {
    const group = groups.get(art.normalizedNum);
    if (group) group.push(art);
    else groups.set(art.normalizedNum, [art]);
  }

  const tieBreak = (a: T, b: T): number => b.id.localeCompare(a.id);

  const selected: T[] = [];
  const droppedExpiredNums: string[] = [];
  for (const [num, group] of groups) {
    const chosen = selectCurrentVersion(group, today, tieBreak);
    if (chosen) selected.push(chosen);
    else droppedExpiredNums.push(num);
  }

  selected.sort((a, b) => a.normalizedNum.localeCompare(b.normalizedNum, 'fr', { numeric: true }));
  droppedExpiredNums.sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }));
  return { selected, droppedExpiredNums };
}

// ---------------------------------------------------------------------------
// Seed-level dedupe for build-db (safety net behind the ingest selection)
// ---------------------------------------------------------------------------

export interface ProvisionSeedLike {
  provision_ref: string;
  content: string;
  valid_from?: string;
}

function normalizeWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, ' ').trim().length;
}

/**
 * Deduplicate provisions by ref. Preference order:
 *   1. newest valid_from (validity-stamped seeds from the fixed ingest);
 *   2. longest content (legacy seeds without validity stamps).
 */
export function dedupeProvisionSeeds<T extends ProvisionSeedLike>(provisions: T[]): T[] {
  const byRef = new Map<string, T>();
  for (const prov of provisions) {
    const ref = prov.provision_ref.trim();
    const existing = byRef.get(ref);
    if (!existing) {
      byRef.set(ref, { ...prov, provision_ref: ref });
      continue;
    }
    let replace: boolean;
    if (prov.valid_from !== undefined && existing.valid_from !== undefined) {
      replace =
        prov.valid_from > existing.valid_from ||
        (prov.valid_from === existing.valid_from &&
          normalizeWhitespaceLength(prov.content) > normalizeWhitespaceLength(existing.content));
    } else if (prov.valid_from !== undefined || existing.valid_from !== undefined) {
      // Stamped beats unstamped: the stamped one came from validity-aware selection.
      replace = prov.valid_from !== undefined;
    } else {
      replace = normalizeWhitespaceLength(prov.content) > normalizeWhitespaceLength(existing.content);
    }
    if (replace) byRef.set(ref, { ...prov, provision_ref: ref });
  }
  return Array.from(byRef.values());
}

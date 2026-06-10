/**
 * Runtime resolution of DILA LEGI open-data archives (issue #97).
 *
 * The DILA index at https://echanges.dila.gouv.fr/OPENDATA/LEGI/ publishes:
 *   - Freemium_legi_global_YYYYMMDD-HHMMSS.tar.gz — a full snapshot ("global"),
 *     cut rarely (the only one online as of 2026-06-10 is 20250713-140000);
 *   - LEGI_YYYYMMDD-HHMMSS.tar.gz — DAILY incremental deltas against the full
 *     base (changed files + liste_suppression_legi*.dat removal lists).
 *
 * The current state of the law is therefore: newest global + every delta with
 * a stamp strictly after the global's. Resolving only the newest global would
 * STILL pin the corpus to July 2025 — the deltas are mandatory for freshness.
 *
 * Nothing here is hardcoded to an archive name; identities are resolved from
 * the live index and stamped into the extraction marker, census.json and
 * db_metadata so the corpus version is provable end to end.
 */

export const LEGI_BASE_URL = 'https://echanges.dila.gouv.fr/OPENDATA/LEGI/';

export interface LegiArchiveRef {
  /** File name as published, e.g. 'Freemium_legi_global_20250713-140000.tar.gz'. */
  name: string;
  kind: 'global' | 'delta';
  /** DILA stamp 'YYYYMMDD-HHMMSS' — zero-padded, so lexicographic order = chronological order. */
  stamp: string;
  url: string;
}

export interface AcquisitionPlan {
  base: LegiArchiveRef;
  /** Deltas with stamp strictly after base.stamp, ascending. */
  deltas: LegiArchiveRef[];
  /** Identity of the corpus after applying every delta: last delta stamp, or base stamp. */
  sourceStamp: string;
}

const GLOBAL_RE = /Freemium_legi_global_(\d{8}-\d{6})\.tar\.gz/g;
const DELTA_RE = /(?<![\w.-])LEGI_(\d{8}-\d{6})\.tar\.gz/g;
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/** Convert a DILA stamp 'YYYYMMDD-HHMMSS' to ISO-8601 UTC. Throws on malformed input. */
export function stampToIso(stamp: string): string {
  const m = STAMP_RE.exec(stamp);
  if (!m) {
    throw new Error(`Malformed DILA archive stamp: '${stamp}' (expected YYYYMMDD-HHMMSS)`);
  }
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

/**
 * Parse the DILA directory index HTML into archive references.
 * Throws when no archives are recognizable — a maintenance page or layout
 * change must fail loud, never resolve to an empty/stale plan.
 */
export function parseLegiIndex(html: string, baseUrl: string = LEGI_BASE_URL): LegiArchiveRef[] {
  const seen = new Set<string>();
  const refs: LegiArchiveRef[] = [];

  for (const m of html.matchAll(GLOBAL_RE)) {
    const name = m[0];
    if (seen.has(name)) continue;
    seen.add(name);
    refs.push({ name, kind: 'global', stamp: m[1], url: baseUrl + name });
  }
  for (const m of html.matchAll(DELTA_RE)) {
    const name = m[0];
    if (seen.has(name)) continue;
    seen.add(name);
    refs.push({ name, kind: 'delta', stamp: m[1], url: baseUrl + name });
  }

  if (refs.length === 0) {
    throw new Error(
      `Found no LEGI archives in the DILA index at ${baseUrl} — refusing to continue ` +
        '(index unreachable, empty, or layout changed).',
    );
  }
  return refs;
}

/**
 * Build the acquisition plan: newest global as base, plus every delta with a
 * stamp strictly after the base's, in ascending (application) order.
 */
export function planAcquisition(refs: LegiArchiveRef[]): AcquisitionPlan {
  const globals = refs.filter((r) => r.kind === 'global').sort((a, b) => a.stamp.localeCompare(b.stamp));
  const base = globals.at(-1);
  if (!base) {
    throw new Error(
      'No Freemium_legi_global_* archive in the DILA index — deltas alone cannot bootstrap a corpus.',
    );
  }
  const deltas = refs
    .filter((r) => r.kind === 'delta' && r.stamp > base.stamp)
    .sort((a, b) => a.stamp.localeCompare(b.stamp));
  return { base, deltas, sourceStamp: deltas.at(-1)?.stamp ?? base.stamp };
}

/** Newest stamp across all published archives — what check-updates compares against. */
export function latestStamp(refs: LegiArchiveRef[]): string {
  if (refs.length === 0) throw new Error('latestStamp: empty archive list');
  return refs.map((r) => r.stamp).sort().at(-1) as string;
}

/** Fetch the DILA index HTML. Fail-loud: non-2xx or timeout throws. */
export async function fetchLegiIndexHtml(timeoutMs = 30_000): Promise<string> {
  const response = await fetch(LEGI_BASE_URL, {
    headers: {
      'User-Agent': 'Ansvar-French-Law-MCP/2.0 (+https://github.com/Ansvar-Systems/French-law-mcp)',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${LEGI_BASE_URL}`);
  }
  return response.text();
}

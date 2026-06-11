/**
 * Aggregate floors and cross-checks for the census -> ingest -> build-db
 * pipeline (PR #98 review findings ingest-legi.ts:489, build-db.ts:282,
 * build-db.ts:408, census.ts:76).
 *
 * Platform rules these gates enforce:
 *   - unbounded exclusions need aggregate floors: per-text classification can
 *     route systemic drift through "expected" branches one text at a time;
 *     only a corpus-wide cap catches the drift;
 *   - partial-scope runs must never shrink the corpus silently;
 *   - a database must never be stamped with a corpus identity its seeds do
 *     not actually carry.
 *
 * Floor calibration (2026-06 corpus, stamp 20260610-214017): 76 codes,
 * 119,046 texts, 1,447,953 article files, 273/4,351 (6.3%) primary targets
 * wholly out of force.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Census floors
// ---------------------------------------------------------------------------

/** France maintains 70+ codes (76 observed); below 60 the walk lost codes. */
const MIN_CODES = 60;
/** 119,046 texts observed; below 100,000 the tree is partial. */
const MIN_TOTAL_TEXTS = 100_000;
/** 1,447,953 article files observed; below 1M the tree is partial. */
const MIN_ARTICLE_FILES = 1_000_000;
/** Codes-only walks skip TNC; the 76 codes alone still carry >400k article files. */
const MIN_ARTICLE_FILES_CODES_ONLY = 100_000;

export interface CensusFloorInput {
  codes: number;
  totalTexts: number;
  totalArticleFiles: number;
  /** readdir/stat failures swallowed during the walk — MUST be zero. */
  walkErrors: number;
  codesOnly: boolean;
}

/**
 * Sanity floor over the tree the census walked (review finding census.ts:76):
 * the identity marker certifies provenance, not integrity. A vanished or
 * partial tree must fail the census, not produce a small "valid" one.
 */
export function assertCensusFloors(input: CensusFloorInput): void {
  const failures: string[] = [];
  if (input.walkErrors > 0) {
    failures.push(
      `${input.walkErrors} directory-walk error(s) were encountered — files vanished or became ` +
        'unreadable mid-walk; the census universe is untrustworthy',
    );
  }
  if (input.codes < MIN_CODES) {
    failures.push(`only ${input.codes} codes found (floor ${MIN_CODES}; France maintains 70+ codes)`);
  }
  if (!input.codesOnly && input.totalTexts < MIN_TOTAL_TEXTS) {
    failures.push(`only ${input.totalTexts} texts found (floor ${MIN_TOTAL_TEXTS}; 119,046 observed 2026-06)`);
  }
  const articleFloor = input.codesOnly ? MIN_ARTICLE_FILES_CODES_ONLY : MIN_ARTICLE_FILES;
  if (input.totalArticleFiles < articleFloor) {
    failures.push(
      `only ${input.totalArticleFiles} article files found (floor ${articleFloor}; 1,447,953 observed 2026-06)`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Census sanity floors failed — refusing to write a shrunken census:\n  - ${failures.join('\n  - ')}\n` +
        'The extraction is incomplete, torn, or was modified while being walked. Verify the tree ' +
        '(or re-acquire) before re-running the census.',
    );
  }
}

// ---------------------------------------------------------------------------
// Ingest out-of-force cap
// ---------------------------------------------------------------------------

/**
 * Cap on the out_of_force exclusion ratio (review finding ingest-legi.ts:489).
 * Observed reality: 273 of 4,351 primary targets (6.3%) are wholly out of
 * force in the 2026-06 corpus. 15% is >2x that headroom; systemic drift (an
 * ETAT vocabulary change, a date-format change closing every window) routes
 * EVERY text through the out_of_force branch and trips the cap immediately.
 */
const MAX_OUT_OF_FORCE_RATIO = 0.15;

export interface OutOfForceCapInput {
  targetCount: number;
  outOfForceCount: number;
  maxRatio?: number;
}

export function assertOutOfForceCap(input: OutOfForceCapInput): void {
  const maxRatio = input.maxRatio ?? MAX_OUT_OF_FORCE_RATIO;
  if (input.targetCount === 0) return; // nothing to cap; callers gate empty target sets separately
  const ratio = input.outOfForceCount / input.targetCount;
  if (ratio > maxRatio) {
    throw new Error(
      `Out-of-force exclusions exceed the corpus-wide cap: ${input.outOfForceCount} of ` +
        `${input.targetCount} targets (${(ratio * 100).toFixed(1)}% > ${(maxRatio * 100).toFixed(0)}%). ` +
        'The observed real-corpus ratio is ~6.3% — this looks like systemic classification drift ' +
        '(ETAT vocabulary, date formats), not legal reality. Refusing to ship the shrunken corpus.',
    );
  }
}

// ---------------------------------------------------------------------------
// Seeds <-> census cross-check (build gate)
// ---------------------------------------------------------------------------

export interface CensusSourceArchive {
  base: string;
  base_stamp: string;
  deltas_applied: number;
  last_delta: string | null;
  source_stamp: string;
  acquired_at: string;
}

interface CensusShape {
  source_archive?: CensusSourceArchive;
  laws?: Array<{ id: string; ingested?: boolean }>;
}

interface SeedShape {
  id?: string;
  _ingest?: { source_stamp?: string };
}

export interface SeedCensusVerification {
  /** Document seed file names (eu-references.json excluded), sorted. */
  seedFiles: string[];
  /** Seeds carrying an _ingest stamp (produced by ingest-legi). */
  stampedSeedCount: number;
  /** Seeds without an _ingest stamp (manual seeds). */
  manualSeedCount: number;
  /** null ONLY for a census-less, manual-only seed set (explicitly unstamped). */
  sourceArchive: CensusSourceArchive | null;
}

const ENUM_CAP = 20;

function enumerate(ids: string[]): string {
  const shown = ids.slice(0, ENUM_CAP).join(', ');
  return ids.length > ENUM_CAP ? `${shown}, … (${ids.length} total)` : shown;
}

/**
 * Refuse to build a database whose seeds do not match what the census claims
 * was ingested (review findings build-db.ts:282 and :408):
 *   - zero document seeds = fail (an empty DB stamped "current" is the worst
 *     possible artifact for a compliance product);
 *   - every census law with ingested=true must have a seed file;
 *   - every stamped seed must be census-claimed AND carry the census's
 *     source_stamp (no mixed-corpus builds, no stale leftovers);
 *   - a corrupt census throws — torn state must never look fresh.
 */
export function verifySeedsAgainstCensus(opts: { censusPath: string; seedDir: string }): SeedCensusVerification {
  if (!fs.existsSync(opts.seedDir)) {
    throw new Error(`Seed directory ${opts.seedDir} does not exist — nothing to build. Run ingest first.`);
  }
  const seedFiles = fs
    .readdirSync(opts.seedDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.') && !f.startsWith('_') && f !== 'eu-references.json')
    .sort();
  if (seedFiles.length === 0) {
    throw new Error(
      `No document seed files in ${opts.seedDir} — refusing to build an empty database. Run ingest first.`,
    );
  }

  const stamped = new Map<string, string>(); // seed id -> source_stamp
  let manualSeedCount = 0;
  for (const file of seedFiles) {
    // JSON.parse failures propagate — a torn seed must fail the build.
    const seed = JSON.parse(fs.readFileSync(path.join(opts.seedDir, file), 'utf-8')) as SeedShape;
    const id = seed.id ?? path.basename(file, '.json');
    if (seed._ingest) {
      stamped.set(id, seed._ingest.source_stamp ?? 'unstamped');
    } else {
      manualSeedCount++;
    }
  }

  if (!fs.existsSync(opts.censusPath)) {
    if (stamped.size > 0) {
      throw new Error(
        `${stamped.size} seed(s) carry ingest stamps but ${opts.censusPath} is missing — the ` +
          'corpus identity cannot be verified. Re-run census + ingest.',
      );
    }
    return { seedFiles, stampedSeedCount: 0, manualSeedCount, sourceArchive: null };
  }

  // JSON.parse failures propagate — a torn census must never look fresh.
  const census = JSON.parse(fs.readFileSync(opts.censusPath, 'utf-8')) as CensusShape;
  const source = census.source_archive ?? null;
  if (source === null && stamped.size > 0) {
    throw new Error(
      `${opts.censusPath} carries no source_archive stamp but ${stamped.size} seed(s) are ` +
        'ingest-stamped — census predates source-identity stamping. Re-run census + ingest.',
    );
  }

  const ingestedIds = new Set<string>();
  for (const law of census.laws ?? []) {
    if (law.ingested === true) ingestedIds.add(law.id);
  }
  if (ingestedIds.size === 0) {
    throw new Error(
      `${opts.censusPath} records ZERO ingested texts — building now would ship a database without ` +
        'the corpus. Run ingest:legi (then build:db).',
    );
  }

  const missingSeeds = [...ingestedIds].filter((id) => !seedFiles.includes(`${id}.json`)).sort();
  if (missingSeeds.length > 0) {
    throw new Error(
      `${missingSeeds.length} census-ingested text(s) have NO seed file (crashed or partial ingest; ` +
        `the census claims them): ${enumerate(missingSeeds)}. Re-run ingest:legi.`,
    );
  }

  const staleSeeds = [...stamped.keys()].filter((id) => !ingestedIds.has(id)).sort();
  if (staleSeeds.length > 0) {
    throw new Error(
      `${staleSeeds.length} stamped seed(s) are NOT claimed as ingested by the census (stale ` +
        `leftovers from an earlier run): ${enumerate(staleSeeds)}. Re-run ingest:legi.`,
    );
  }

  const expectedStamp = source?.source_stamp;
  const mismatched = [...stamped.entries()]
    .filter(([, stamp]) => stamp !== expectedStamp)
    .map(([id, stamp]) => `${id} (${stamp})`)
    .sort();
  if (mismatched.length > 0) {
    throw new Error(
      `${mismatched.length} seed(s) carry a different source stamp than the census ` +
        `(${expectedStamp}) — mixed-corpus build: ${enumerate(mismatched)}. Re-run census + ingest.`,
    );
  }

  return { seedFiles, stampedSeedCount: stamped.size, manualSeedCount, sourceArchive: source };
}

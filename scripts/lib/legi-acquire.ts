/**
 * LEGI corpus acquisition: download the newest global archive, apply every
 * incremental delta after it, and stamp a provable identity marker into the
 * extraction (issue #97).
 *
 * Delta archives (verified against LEGI_20260609-212725.tar.gz):
 *   STAMP/liste_suppression_legi.dat          — full-base paths to delete (no .xml)
 *   STAMP/liste_suppression_legi_dossier.dat  — ditto, directory entries
 *   STAMP/legi/global/...                     — changed/added files
 * Application order per delta: suppressions FIRST, then additions — a path
 * suppressed and re-added in the same delta must end up present.
 *
 * Suppression paths reference DILA's FULL base; the Freemium global dump is a
 * subset (code_et_TNC_en_vigueur only), so absent paths are normal no-ops.
 *
 * Fail-loud: every download, extraction and delta application either succeeds
 * or throws. The identity marker is updated only AFTER a delta fully applies,
 * so an interrupted run resumes by re-applying the unfinished delta
 * (idempotent: overwrite + delete-if-exists).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  type AcquisitionPlan,
  type LegiArchiveRef,
  assertPlanContinuity,
  fetchLegiIndexHtml,
  parseLegiIndex,
  planAcquisition,
} from './legi-archive.js';

export const IDENTITY_MARKER = '.legi-source-identity.json';
export const DEFAULT_CACHE_DIR = process.env['LEGI_CACHE_DIR'] ?? '/tmp/legi-cache';

export interface ExtractIdentity {
  schema: 1;
  /** Global archive file name the extraction was bootstrapped from. */
  base: string;
  base_stamp: string;
  /** Delta archive names applied so far, in application order. */
  deltas_applied: string[];
  /** Stamp of the last applied delta, or the base stamp — the corpus version. */
  source_stamp: string;
  updated_at: string;
  /**
   * Torn-state sentinel (PR #98 review finding legi-acquire.ts:382): set to
   * the delta name just before applyDelta mutates the tree, cleared by the
   * success write. A persisted sentinel = the tree is torn (suppressions may
   * have run without the additions) and must be rebuilt.
   */
  applying?: string;
}

// ---------------------------------------------------------------------------
// Identity marker
// ---------------------------------------------------------------------------

/**
 * Read the identity marker. null = no marker (fresh/foreign directory).
 * A CORRUPT marker throws — corrupt state must never look like a fresh dir.
 */
export function readExtractIdentity(extractDir: string): ExtractIdentity | null {
  const markerPath = path.join(extractDir, IDENTITY_MARKER);
  if (!fs.existsSync(markerPath)) return null;
  const raw = fs.readFileSync(markerPath, 'utf-8');
  const parsed = JSON.parse(raw) as ExtractIdentity;
  if (parsed.schema !== 1 || !parsed.base || !parsed.base_stamp || !Array.isArray(parsed.deltas_applied)) {
    throw new Error(`Corrupt extraction identity marker at ${markerPath}: ${raw.slice(0, 200)}`);
  }
  if (parsed.applying) {
    throw new Error(
      `Extraction at ${extractDir} is TORN: applying ${parsed.applying} was interrupted mid-delta ` +
        '(suppressions may have run without the matching additions). The tree cannot be trusted. ' +
        `Repair: delete ${extractDir} and re-run to re-acquire from the base archive.`,
    );
  }
  return parsed;
}

export function writeExtractIdentity(extractDir: string, identity: ExtractIdentity): void {
  const markerPath = path.join(extractDir, IDENTITY_MARKER);
  const tmpPath = `${markerPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(identity, null, 2), 'utf-8');
  fs.renameSync(tmpPath, markerPath);
}

// ---------------------------------------------------------------------------
// Delta queue
// ---------------------------------------------------------------------------

/**
 * Deltas still to apply, given what the extraction has already absorbed.
 * Throws on any divergence between recorded state and the plan — divergent
 * state cannot be silently reconciled, the extraction must be rebuilt.
 */
export function computeDeltaQueue(identity: ExtractIdentity, plan: AcquisitionPlan): LegiArchiveRef[] {
  if (identity.base !== plan.base.name) {
    throw new Error(
      `Extraction was built from base ${identity.base} but the index now offers ${plan.base.name}. ` +
        'A new global snapshot supersedes delta replay — delete the extraction and re-acquire.',
    );
  }
  const planNames = plan.deltas.map((d) => d.name);
  for (let i = 0; i < identity.deltas_applied.length; i++) {
    if (identity.deltas_applied[i] !== planNames[i]) {
      throw new Error(
        `Applied-delta history diverges from the published index (applied[${i}]=` +
          `${identity.deltas_applied[i]}, index[${i}]=${planNames[i] ?? '<none>'}). ` +
          'State/plan mismatch — delete the extraction and re-acquire.',
      );
    }
  }
  return plan.deltas.slice(identity.deltas_applied.length);
}

// ---------------------------------------------------------------------------
// Suppression lists
// ---------------------------------------------------------------------------

/**
 * Apply one liste_suppression_legi*.dat to the extraction tree.
 * Lines are full-base paths without extension; some name directories, some
 * name article files (resolve to '<path>.xml'). Lines may carry a trailing
 * one-letter flag (observed: ' D'). Absent paths are counted, not errors.
 * Malformed lines (escape the tree, absolute, outside legi/) throw.
 */
export function applySuppressionList(
  extractDir: string,
  datContent: string,
): { deleted: number; absent: number } {
  let deleted = 0;
  let absent = 0;
  const rootResolved = path.resolve(extractDir);

  for (const rawLine of datContent.split('\n')) {
    const line = rawLine.trim().replace(/\s+[A-Z]$/, '');
    if (!line) continue;
    if (/\s/.test(line)) {
      // The strip handles exactly one trailing uppercase letter (observed:
      // ' D'). Any other whitespace-separated suffix is .dat format drift —
      // unstripped, every lookup would miss and deletions would silently
      // no-op while the delta is stamped applied.
      throw new Error(
        `Suppression list entry has an unrecognized trailing-flag format: '${rawLine.trim()}' ` +
          '(expected at most one trailing uppercase letter). Upstream .dat format drift — refusing to guess.',
      );
    }
    if (path.isAbsolute(line) || line.split('/').includes('..')) {
      throw new Error(`Suppression list entry escapes the extraction tree: '${rawLine.trim()}'`);
    }
    if (!line.startsWith('legi/')) {
      throw new Error(`Suppression list entry outside the legi/ tree: '${rawLine.trim()}'`);
    }
    const target = path.resolve(rootResolved, line);
    if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
      throw new Error(`Suppression list entry resolves outside the extraction tree: '${rawLine.trim()}'`);
    }

    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      deleted++;
    } else if (fs.existsSync(`${target}.xml`)) {
      fs.rmSync(`${target}.xml`, { force: true });
      deleted++;
    } else {
      absent++;
    }
  }
  return { deleted, absent };
}

// ---------------------------------------------------------------------------
// Download / extract helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(msg);
}

/**
 * Locale-stable environment for every tar/gzip invocation: the exit-2
 * "Not found in archive" detection matches tar's STDERR TEXT, which is
 * localized (French GNU tar prints "introuvable dans l'archive"). LC_ALL=C
 * pins the message catalogue (review finding legi-acquire.ts:229).
 */
const TOOL_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

let gnuTarVerified = false;

/**
 * The delta machinery depends on GNU tar (--wildcards member selection and
 * the exit-2 stderr contract). bsdtar lacks --wildcards and words its errors
 * differently — under it the member-selection passes would fail in ways the
 * stderr matching cannot classify. Detect loudly up front.
 */
function assertGnuTar(): void {
  if (gnuTarVerified) return;
  const banner = execFileSync('tar', ['--version'], { env: TOOL_ENV }).toString().split('\n')[0];
  if (!banner.includes('GNU tar')) {
    throw new Error(
      `LEGI acquisition requires GNU tar (--wildcards + stderr contract); found '${banner}'. ` +
        'bsdtar/libarchive is not supported — install GNU tar.',
    );
  }
  gnuTarVerified = true;
}

function curlHeadContentLength(url: string): number | null {
  const headers = execFileSync('curl', ['-fsIL', '--max-time', '30', url], {
    env: TOOL_ENV,
    timeout: 60_000,
  }).toString();
  // Last match wins: -L follows redirects, each hop prints its own headers.
  const matches = [...headers.matchAll(/^content-length:\s*(\d+)\s*$/gim)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

/**
 * Verify a pre-existing cached archive before trusting it by name alone
 * (PR #98 review finding legi-acquire.ts:159): compare the size against the
 * published Content-Length; when the index does not offer one, integrity-test
 * the gzip stream. A failing file is NEVER silently re-downloaded — deleting
 * an operator's cache entry is their deliberate call.
 */
export function verifyCachedArchive(
  archivePath: string,
  ref: LegiArchiveRef,
  opts: { fetchContentLength?: (url: string) => number | null } = {},
): void {
  const size = fs.statSync(archivePath).size;
  if (size === 0) {
    throw new Error(`Cached archive ${archivePath} is empty. Delete it and re-run to re-download.`);
  }

  const fetchContentLength = opts.fetchContentLength ?? curlHeadContentLength;
  let published: number | null = null;
  try {
    published = fetchContentLength(ref.url);
  } catch {
    published = null; // HEAD unavailable — fall through to the integrity check.
  }

  if (published !== null) {
    if (published !== size) {
      throw new Error(
        `Cached archive ${archivePath} is ${size} bytes but the index publishes ${published} — ` +
          'stale or truncated cache entry. Delete it and re-run to re-download.',
      );
    }
    return;
  }

  try {
    execFileSync('gzip', ['-t', archivePath], { env: TOOL_ENV, timeout: 1_800_000 });
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    throw new Error(
      `Cached archive ${archivePath} failed the gzip integrity check (truncated/corrupt): ` +
        `${stderr || String(err)}. Delete it and re-run to re-download.`,
    );
  }
}

function downloadArchive(ref: LegiArchiveRef, cacheDir: string): string {
  const dest = path.join(cacheDir, ref.name);
  if (fs.existsSync(dest)) {
    verifyCachedArchive(dest, ref);
    return dest;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const part = `${dest}.part`;
  log(`  Downloading ${ref.name} ...`);
  execFileSync('curl', ['-fSL', '--retry', '3', '--retry-delay', '2', '-o', part, ref.url], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 3_600_000,
  });
  fs.renameSync(part, dest);
  return dest;
}

function extractGlobal(archivePath: string, extractDir: string): void {
  assertGnuTar();
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  log(`  Extracting ${path.basename(archivePath)} to ${extractDir} (several GB, takes minutes) ...`);
  execFileSync('tar', ['xzf', archivePath, '-C', extractDir], {
    timeout: 3_600_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: TOOL_ENV,
  });
  if (!fs.existsSync(path.join(extractDir, 'legi'))) {
    throw new Error(`Extraction of ${archivePath} produced no legi/ tree at ${extractDir}`);
  }
}

export interface DeltaApplyStats {
  /** Suppression-list files the delta carried. */
  datFiles: number;
  /** Paths the suppression lists deleted from the tree. */
  deleted: number;
  /** Suppression paths absent from the Freemium subset (normal no-ops). */
  absent: number;
  /** legi/ members the additions pass extracted (directories included). */
  additions: number;
}

/**
 * Apply one delta archive. INVARIANT (PR #98 review finding
 * legi-acquire.ts:229): a delta must contribute SOMETHING — suppression lists
 * or legi/ members. A delta matching zero members on both passes means the
 * upstream layout changed (renamed top dir, moved members); stamping it as
 * applied would silently freeze the corpus while check-updates reports
 * current. Fail loud instead.
 */
export function applyDelta(deltaPath: string, extractDir: string): DeltaApplyStats {
  assertGnuTar();
  const stats: DeltaApplyStats = { datFiles: 0, deleted: 0, absent: 0, additions: 0 };

  // 1. Pull the suppression lists out of the delta (top-level STAMP/*.dat).
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(deltaPath), 'delta-dat-'));
  try {
    try {
      execFileSync(
        'tar',
        ['xzf', deltaPath, '-C', tmpDir, '--strip-components=1', '--wildcards', '*/liste_suppression*.dat'],
        { timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'], env: TOOL_ENV },
      );
    } catch (err) {
      // GNU tar exits 2 when no member matches — a delta without suppression
      // lists is valid (the additions invariant below still applies). Any
      // other failure is real.
      const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
      if (!/not found in archive/i.test(stderr)) {
        throw new Error(`Failed extracting suppression lists from ${deltaPath}: ${stderr || String(err)}`);
      }
    }

    // 2. Suppressions first.
    const datNames = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.dat'));
    stats.datFiles = datNames.length;
    for (const dat of datNames) {
      const { deleted, absent } = applySuppressionList(
        extractDir,
        fs.readFileSync(path.join(tmpDir, dat), 'utf-8'),
      );
      stats.deleted += deleted;
      stats.absent += absent;
      if (deleted + absent > 0) {
        log(`    ${dat}: ${deleted} deleted, ${absent} not in Freemium subset`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. Additions/updates: overlay the delta's legi/ tree onto the extraction.
  // -v lists every extracted member on stdout — the contribution evidence.
  try {
    const listing = execFileSync(
      'tar',
      ['xzvf', deltaPath, '-C', extractDir, '--strip-components=1', '--wildcards', '*/legi/*'],
      { timeout: 1_800_000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: TOOL_ENV },
    ).toString();
    stats.additions = listing.split('\n').filter(Boolean).length;
  } catch (err) {
    // A suppression-only delta carries no legi/ members; GNU tar then exits 2
    // with "Not found in archive". Anything else is a real failure.
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    if (!/not found in archive/i.test(stderr)) {
      throw new Error(`Failed applying additions from ${deltaPath}: ${stderr || String(err)}`);
    }
  }

  if (stats.datFiles === 0 && stats.additions === 0) {
    throw new Error(
      `Delta ${path.basename(deltaPath)} contributed NOTHING (no suppression lists, no legi/ ` +
        'members). The delta layout this code was verified against (STAMP/legi/..., ' +
        'STAMP/liste_suppression_legi*.dat) no longer matches — refusing to stamp a no-op as applied.',
    );
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface AcquireResult {
  extractDir: string;
  identity: ExtractIdentity;
}

const ARCHIVE_NAME_STAMP_RE = /_(\d{8}-\d{6})\.tar\.gz$/;

/**
 * Resolve the corpus for census/ingest from CLI options:
 *   - default: live acquisition (newest global + all deltas), stamped;
 *   - --extracted DIR: use a pre-extracted tree — its identity marker is
 *     REQUIRED unless --allow-unstamped explicitly accepts an unprovable
 *     corpus version (loud, never silent);
 *   - --archive FILE: extract a local archive; identity derives from its
 *     file-name stamp. Deltas are NOT applied (manual override, loud).
 */
export async function resolveCorpus(opts: {
  archive?: string;
  extracted?: string;
  allowUnstamped?: boolean;
  cacheDir?: string;
}): Promise<AcquireResult> {
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;

  if (opts.extracted) {
    const extractDir = opts.extracted;
    if (!fs.existsSync(path.join(extractDir, 'legi'))) {
      throw new Error(`--extracted ${extractDir} has no legi/ tree`);
    }
    const identity = readExtractIdentity(extractDir);
    if (identity) {
      log(`Using pre-extracted corpus at ${extractDir} (source stamp ${identity.source_stamp}).`);
      return { extractDir, identity };
    }
    if (!opts.allowUnstamped) {
      throw new Error(
        `--extracted ${extractDir} carries no identity marker (${IDENTITY_MARKER}); its corpus ` +
          'version is unprovable. Re-acquire via the default path, or pass --allow-unstamped ' +
          'to explicitly accept an unstamped corpus.',
      );
    }
    log(`WARNING: --allow-unstamped: corpus version of ${extractDir} is UNPROVABLE.`);
    return {
      extractDir,
      identity: {
        schema: 1,
        base: 'unstamped',
        base_stamp: 'unstamped',
        deltas_applied: [],
        source_stamp: 'unstamped',
        updated_at: new Date().toISOString(),
      },
    };
  }

  if (opts.archive) {
    const m = ARCHIVE_NAME_STAMP_RE.exec(path.basename(opts.archive));
    if (!m && !opts.allowUnstamped) {
      throw new Error(
        `Cannot derive a corpus identity from archive name '${path.basename(opts.archive)}' ` +
          '(expected *_YYYYMMDD-HHMMSS.tar.gz). Pass --allow-unstamped to explicitly accept ' +
          'an unstamped corpus.',
      );
    }
    const stamp = m?.[1] ?? 'unstamped';
    const extractDir = path.join(cacheDir, 'extracted-manual');
    log(`Manual archive override: ${opts.archive} (stamp ${stamp}). Deltas are NOT applied.`);
    extractGlobal(opts.archive, extractDir);
    const identity: ExtractIdentity = {
      schema: 1,
      base: path.basename(opts.archive),
      base_stamp: stamp,
      deltas_applied: [],
      source_stamp: stamp,
      updated_at: new Date().toISOString(),
    };
    writeExtractIdentity(extractDir, identity);
    return { extractDir, identity };
  }

  return ensureCurrentCorpus({ cacheDir });
}

/**
 * Ensure `extractDir` holds the CURRENT corpus: newest global + all deltas,
 * resolved live from the DILA index. Resumable and idempotent. Never silent:
 * unstamped pre-existing extractions and state/plan divergence throw.
 */
export async function ensureCurrentCorpus(opts: {
  cacheDir?: string;
  extractDir?: string;
  /** Injected for tests; defaults to fetching the live index. */
  indexHtml?: string;
  /** Injected for tests; defaults to the wall clock. */
  now?: Date;
  /** Continuity-gate overrides — see assertPlanContinuity. */
  maxGapDays?: number;
  maxStalenessDays?: number;
} = {}): Promise<AcquireResult> {
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const extractDir = opts.extractDir ?? path.join(cacheDir, 'extracted');

  log('Resolving newest LEGI archives from the DILA index ...');
  const html = opts.indexHtml ?? (await fetchLegiIndexHtml());
  const plan = planAcquisition(parseLegiIndex(html));
  assertPlanContinuity(plan, {
    now: opts.now,
    maxGapDays: opts.maxGapDays,
    maxStalenessDays: opts.maxStalenessDays,
  });
  log(
    `  Base: ${plan.base.name}; deltas after base: ${plan.deltas.length}` +
      (plan.deltas.length > 0 ? ` (through ${plan.deltas.at(-1)?.stamp})` : ''),
  );

  let identity = readExtractIdentity(extractDir);
  if (identity === null && fs.existsSync(path.join(extractDir, 'legi'))) {
    throw new Error(
      `Extraction at ${extractDir} has no identity marker (${IDENTITY_MARKER}) — its corpus version ` +
        'is unprovable. Delete it and re-run, or pass an explicitly stamped directory.',
    );
  }
  if (identity !== null && !fs.existsSync(path.join(extractDir, 'legi'))) {
    // A marker can outlive the tree: `rm -rf extracted/*` deletes legi/ but
    // keeps the dotfile marker (PR #98 review finding legi-acquire.ts:373).
    throw new Error(
      `Extraction at ${extractDir} carries an identity marker (source stamp ` +
        `${identity.source_stamp}) but NO legi/ tree — the corpus was deleted out from under its ` +
        `marker. Repair: delete ${extractDir} entirely (including ${IDENTITY_MARKER}) and re-run ` +
        'to re-acquire.',
    );
  }

  if (identity !== null && identity.base !== plan.base.name) {
    log(`  New global snapshot ${plan.base.name} supersedes ${identity.base} — rebuilding extraction.`);
    fs.rmSync(extractDir, { recursive: true, force: true });
    identity = null;
  }

  if (identity === null) {
    const archivePath = downloadArchive(plan.base, cacheDir);
    extractGlobal(archivePath, extractDir);
    identity = {
      schema: 1,
      base: plan.base.name,
      base_stamp: plan.base.stamp,
      deltas_applied: [],
      source_stamp: plan.base.stamp,
      updated_at: new Date().toISOString(),
    };
    writeExtractIdentity(extractDir, identity);
  }

  const queue = computeDeltaQueue(identity, plan);
  if (queue.length === 0) {
    log(`  Extraction is current (source stamp ${identity.source_stamp}).`);
    return { extractDir, identity };
  }

  log(`  Applying ${queue.length} delta(s) ...`);
  let applied = 0;
  for (const delta of queue) {
    const deltaPath = downloadArchive(delta, cacheDir);
    // Torn-state sentinel: applyDelta mutates destructively (suppressions
    // first). Stamp the marker BEFORE so a crash mid-delta is detectable.
    writeExtractIdentity(extractDir, {
      ...identity,
      applying: delta.name,
      updated_at: new Date().toISOString(),
    });
    applyDelta(deltaPath, extractDir);
    identity = {
      schema: 1,
      base: identity.base,
      base_stamp: identity.base_stamp,
      deltas_applied: [...identity.deltas_applied, delta.name],
      source_stamp: delta.stamp,
      updated_at: new Date().toISOString(),
    };
    writeExtractIdentity(extractDir, identity);
    applied++;
    if (applied % 25 === 0 || applied === queue.length) {
      log(`    [${applied}/${queue.length}] applied through ${delta.stamp}`);
    }
  }

  log(`  Corpus is at source stamp ${identity.source_stamp} (${identity.deltas_applied.length} deltas on ${identity.base_stamp}).`);
  return { extractDir, identity };
}

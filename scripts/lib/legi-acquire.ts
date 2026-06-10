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

function downloadArchive(ref: LegiArchiveRef, cacheDir: string): string {
  const dest = path.join(cacheDir, ref.name);
  if (fs.existsSync(dest)) return dest;
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
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  log(`  Extracting ${path.basename(archivePath)} to ${extractDir} (several GB, takes minutes) ...`);
  execFileSync('tar', ['xzf', archivePath, '-C', extractDir], {
    timeout: 3_600_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (!fs.existsSync(path.join(extractDir, 'legi'))) {
    throw new Error(`Extraction of ${archivePath} produced no legi/ tree at ${extractDir}`);
  }
}

function applyDelta(deltaPath: string, extractDir: string): void {
  // 1. Pull the suppression lists out of the delta (top-level STAMP/*.dat).
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(deltaPath), 'delta-dat-'));
  try {
    try {
      execFileSync(
        'tar',
        ['xzf', deltaPath, '-C', tmpDir, '--strip-components=1', '--wildcards', '*/liste_suppression*.dat'],
        { timeout: 600_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      // GNU tar exits 2 when no member matches — a delta without suppression
      // lists is valid. Any other failure is real.
      const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
      if (!/not found in archive/i.test(stderr)) {
        throw new Error(`Failed extracting suppression lists from ${deltaPath}: ${stderr || String(err)}`);
      }
    }

    // 2. Suppressions first.
    for (const dat of fs.readdirSync(tmpDir).filter((f) => f.endsWith('.dat'))) {
      const { deleted, absent } = applySuppressionList(
        extractDir,
        fs.readFileSync(path.join(tmpDir, dat), 'utf-8'),
      );
      if (deleted + absent > 0) {
        log(`    ${dat}: ${deleted} deleted, ${absent} not in Freemium subset`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. Additions/updates: overlay the delta's legi/ tree onto the extraction.
  try {
    execFileSync(
      'tar',
      ['xzf', deltaPath, '-C', extractDir, '--strip-components=1', '--wildcards', '*/legi/*'],
      { timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // A suppression-only delta carries no legi/ members; GNU tar then exits 2
    // with "Not found in archive". Anything else is a real failure.
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    if (!/not found in archive/i.test(stderr)) {
      throw new Error(`Failed applying additions from ${deltaPath}: ${stderr || String(err)}`);
    }
  }
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
} = {}): Promise<AcquireResult> {
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const extractDir = opts.extractDir ?? path.join(cacheDir, 'extracted');

  log('Resolving newest LEGI archives from the DILA index ...');
  const html = opts.indexHtml ?? (await fetchLegiIndexHtml());
  const plan = planAcquisition(parseLegiIndex(html));
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
    applyDelta(deltaPath, extractDir);
    identity = {
      ...identity,
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

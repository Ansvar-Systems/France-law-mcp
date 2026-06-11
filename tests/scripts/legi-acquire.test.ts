/**
 * Tests for scripts/lib/legi-acquire.ts — corpus acquisition state:
 * extraction identity marker (provable corpus version), delta resume queue,
 * and suppression-list application (fail-loud on malformed input).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  IDENTITY_MARKER,
  readExtractIdentity,
  writeExtractIdentity,
  computeDeltaQueue,
  applySuppressionList,
  applyDelta,
  verifyCachedArchive,
  ensureCurrentCorpus,
  type ExtractIdentity,
} from '../../scripts/lib/legi-acquire.js';
import type { AcquisitionPlan, LegiArchiveRef } from '../../scripts/lib/legi-archive.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legi-acquire-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function identity(over: Partial<ExtractIdentity> = {}): ExtractIdentity {
  return {
    schema: 1,
    base: 'Freemium_legi_global_20250713-140000.tar.gz',
    base_stamp: '20250713-140000',
    deltas_applied: [],
    source_stamp: '20250713-140000',
    updated_at: '2026-06-10T00:00:00Z',
    ...over,
  };
}

function ref(name: string, kind: 'global' | 'delta', stamp: string): LegiArchiveRef {
  return { name, kind, stamp, url: `https://example.invalid/${name}` };
}

function plan(deltaStamps: string[]): AcquisitionPlan {
  const deltas = deltaStamps.map((s) => ref(`LEGI_${s}.tar.gz`, 'delta', s));
  return {
    base: ref('Freemium_legi_global_20250713-140000.tar.gz', 'global', '20250713-140000'),
    deltas,
    sourceStamp: deltas.at(-1)?.stamp ?? '20250713-140000',
  };
}

describe('identity marker round-trip', () => {
  it('writes and reads the marker', () => {
    const id = identity({ deltas_applied: ['LEGI_20250713-205013.tar.gz'], source_stamp: '20250713-205013' });
    writeExtractIdentity(tmpDir, id);
    expect(fs.existsSync(path.join(tmpDir, IDENTITY_MARKER))).toBe(true);
    expect(readExtractIdentity(tmpDir)).toEqual(id);
  });

  it('returns null when the marker is absent', () => {
    expect(readExtractIdentity(tmpDir)).toBeNull();
  });

  it('throws (not null) on a corrupt marker — corrupt state must not look like a fresh dir', () => {
    fs.writeFileSync(path.join(tmpDir, IDENTITY_MARKER), '{ not json');
    expect(() => readExtractIdentity(tmpDir)).toThrow();
  });
});

describe('computeDeltaQueue', () => {
  it('returns all plan deltas for a fresh extraction', () => {
    const p = plan(['20250713-205013', '20250715-205701']);
    expect(computeDeltaQueue(identity(), p).map((d) => d.stamp)).toEqual([
      '20250713-205013',
      '20250715-205701',
    ]);
  });

  it('resumes after the last applied delta', () => {
    const p = plan(['20250713-205013', '20250715-205701', '20250716-211907']);
    const id = identity({
      deltas_applied: ['LEGI_20250713-205013.tar.gz', 'LEGI_20250715-205701.tar.gz'],
      source_stamp: '20250715-205701',
    });
    expect(computeDeltaQueue(id, p).map((d) => d.stamp)).toEqual(['20250716-211907']);
  });

  it('throws when the applied list is not a prefix of the plan (state/plan divergence)', () => {
    const p = plan(['20250713-205013', '20250715-205701']);
    const id = identity({ deltas_applied: ['LEGI_20250715-205701.tar.gz'], source_stamp: '20250715-205701' });
    expect(() => computeDeltaQueue(id, p)).toThrow(/prefix|divergence|mismatch/i);
  });

  it('throws when the extraction was built from a different base archive', () => {
    const p = plan([]);
    const id = identity({ base: 'Freemium_legi_global_20240101-000000.tar.gz', base_stamp: '20240101-000000' });
    expect(() => computeDeltaQueue(id, p)).toThrow(/base/i);
  });
});

describe('applySuppressionList', () => {
  it('deletes listed directories and resolves extension-less article paths to .xml files', () => {
    // Mirror the real layout: suppression lines are full-base paths WITHOUT .xml.
    const textDir = 'legi/global/code_et_TNC_en_vigueur/TNC_en_vigueur/JORF/TEXT/00/00/54/20/85/JORFTEXT000054208546';
    const artDir = `${textDir}/article/LEGI/ARTI/00/00/54/21/36`;
    fs.mkdirSync(path.join(tmpDir, artDir), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, artDir, 'LEGIARTI000054213682.xml'), '<ARTICLE/>');
    fs.writeFileSync(path.join(tmpDir, artDir, 'LEGIARTI000054213684.xml'), '<ARTICLE/>');

    const result = applySuppressionList(
      tmpDir,
      [
        `${artDir}/LEGIARTI000054213682`, // file, extension-less
        `${textDir}/article/LEGI/ARTI/00/00/54/21/36`, // whole directory
        'legi/global/code_et_TNC_en_vigueur/TNC_en_vigueur/JORF/TEXT/99/99/99/99/99/JORFTEXT000099999999', // absent (full-base path not in Freemium subset)
      ].join('\n'),
    );

    expect(fs.existsSync(path.join(tmpDir, artDir))).toBe(false);
    expect(result.deleted).toBe(2);
    expect(result.absent).toBe(1);
  });

  it('tolerates blank lines and an empty list', () => {
    expect(applySuppressionList(tmpDir, '\n\n')).toEqual({ deleted: 0, absent: 0 });
  });

  it('throws on path traversal or absolute paths (fail-loud, never delete outside the tree)', () => {
    expect(() => applySuppressionList(tmpDir, 'legi/../../etc/passwd')).toThrow();
    expect(() => applySuppressionList(tmpDir, '/etc/passwd')).toThrow();
  });

  it('throws on lines outside the legi/ tree', () => {
    expect(() => applySuppressionList(tmpDir, 'jorf/global/whatever')).toThrow(/legi\//);
  });

  it('throws on an unrecognized trailing-flag format (two-letter / lowercase / numeric — .dat format drift)', () => {
    // The strip handles exactly one trailing uppercase letter (observed: ' D').
    // Anything else surviving as whitespace means DILA changed the format —
    // every lookup would miss and deletions would silently no-op.
    expect(() => applySuppressionList(tmpDir, 'legi/global/some/path AD')).toThrow(/flag|format/i);
    expect(() => applySuppressionList(tmpDir, 'legi/global/some/path d')).toThrow(/flag|format/i);
    expect(() => applySuppressionList(tmpDir, 'legi/global/some/path 1')).toThrow(/flag|format/i);
  });
});

/**
 * Torn-state protection (PR #98 review finding legi-acquire.ts:382): a crash
 * mid-delta leaves the tree mutated while the marker still asserts a clean
 * previous stamp. The `applying` sentinel makes that state detectable.
 */
describe('applying sentinel (torn-tree detection)', () => {
  it('readExtractIdentity throws with repair instructions when a marker carries an applying sentinel', () => {
    const torn = { ...identity(), applying: 'LEGI_20250715-205701.tar.gz' };
    fs.writeFileSync(path.join(tmpDir, IDENTITY_MARKER), JSON.stringify(torn), 'utf-8');
    expect(() => readExtractIdentity(tmpDir)).toThrow(/torn|interrupted/i);
    expect(() => readExtractIdentity(tmpDir)).toThrow(/LEGI_20250715-205701\.tar\.gz/);
    expect(() => readExtractIdentity(tmpDir)).toThrow(/delete|re-acquire/i);
  });

  it('a clean marker (no sentinel) still reads normally', () => {
    writeExtractIdentity(tmpDir, identity());
    expect(readExtractIdentity(tmpDir)).toEqual(identity());
  });
});

/**
 * Delta application invariants (PR #98 review finding legi-acquire.ts:229):
 * a delta that matches ZERO members on both passes is upstream layout drift,
 * not a valid no-op — stamping it as applied would silently freeze the corpus.
 */
describe('applyDelta', () => {
  function makeDelta(stamp: string, build: (root: string) => void): string {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-src-'));
    const top = path.join(src, `LEGI_${stamp}`);
    fs.mkdirSync(top, { recursive: true });
    build(top);
    const archive = path.join(tmpDir, `LEGI_${stamp}.tar.gz`);
    execFileSync('tar', ['czf', archive, '-C', src, `LEGI_${stamp}`]);
    fs.rmSync(src, { recursive: true, force: true });
    return archive;
  }

  it('applies additions and reports how many members were extracted', () => {
    const extractDir = path.join(tmpDir, 'extract');
    fs.mkdirSync(path.join(extractDir, 'legi'), { recursive: true });
    const delta = makeDelta('20260601-210000', (top) => {
      const artDir = path.join(top, 'legi/global/code_et_TNC_en_vigueur/code_en_vigueur/LEGI/TEXT/00/00/06/07/07/LEGITEXT000006070719');
      fs.mkdirSync(artDir, { recursive: true });
      fs.writeFileSync(path.join(artDir, 'LEGIARTI000000000001.xml'), '<ARTICLE/>');
    });
    const stats = applyDelta(delta, extractDir);
    expect(stats.additions).toBeGreaterThan(0);
    expect(
      fs.existsSync(
        path.join(extractDir, 'legi/global/code_et_TNC_en_vigueur/code_en_vigueur/LEGI/TEXT/00/00/06/07/07/LEGITEXT000006070719/LEGIARTI000000000001.xml'),
      ),
    ).toBe(true);
  });

  it('accepts a suppression-only delta (deletes targets, zero additions)', () => {
    const extractDir = path.join(tmpDir, 'extract');
    const victim = path.join(extractDir, 'legi/global/code_et_TNC_en_vigueur/code_en_vigueur/some/dir');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'a.xml'), '<ARTICLE/>');
    const delta = makeDelta('20260602-210000', (top) => {
      fs.writeFileSync(
        path.join(top, 'liste_suppression_legi.dat'),
        'legi/global/code_et_TNC_en_vigueur/code_en_vigueur/some/dir\n',
      );
    });
    const stats = applyDelta(delta, extractDir);
    expect(stats.datFiles).toBe(1);
    expect(stats.deleted).toBe(1);
    expect(stats.additions).toBe(0);
    expect(fs.existsSync(victim)).toBe(false);
  });

  it('throws on a delta that contributes NOTHING (no .dat, no legi/ members) — layout drift, not a no-op', () => {
    const extractDir = path.join(tmpDir, 'extract');
    fs.mkdirSync(path.join(extractDir, 'legi'), { recursive: true });
    const delta = makeDelta('20260603-210000', (top) => {
      fs.writeFileSync(path.join(top, 'README.txt'), 'renamed layout');
    });
    expect(() => applyDelta(delta, extractDir)).toThrow(/contributed|layout/i);
  });
});

/**
 * Cache trust (PR #98 review finding legi-acquire.ts:159): a pre-existing
 * cache file is verified (size vs index, else gzip integrity) before reuse.
 */
describe('verifyCachedArchive', () => {
  function gzipFixture(name: string, corrupt = false): string {
    const payload = path.join(tmpDir, 'payload.txt');
    fs.writeFileSync(payload, 'contenu de test '.repeat(1000));
    const archive = path.join(tmpDir, name);
    execFileSync('tar', ['czf', archive, '-C', tmpDir, 'payload.txt']);
    if (corrupt) {
      const full = fs.readFileSync(archive);
      fs.writeFileSync(archive, full.subarray(0, Math.floor(full.length / 2)));
    }
    return archive;
  }

  const refFor = (name: string) => ref(name, 'delta', '20260601-210000');

  it('accepts a cached file whose size matches the published Content-Length', () => {
    const archive = gzipFixture('LEGI_a.tar.gz');
    const size = fs.statSync(archive).size;
    expect(() =>
      verifyCachedArchive(archive, refFor('LEGI_a.tar.gz'), { fetchContentLength: () => size }),
    ).not.toThrow();
  });

  it('throws on a size mismatch against the published Content-Length', () => {
    const archive = gzipFixture('LEGI_b.tar.gz');
    expect(() =>
      verifyCachedArchive(archive, refFor('LEGI_b.tar.gz'), { fetchContentLength: () => 12345 }),
    ).toThrow(/12345|stale|truncated/i);
  });

  it('falls back to a gzip integrity check when no Content-Length is available', () => {
    const archive = gzipFixture('LEGI_c.tar.gz');
    expect(() =>
      verifyCachedArchive(archive, refFor('LEGI_c.tar.gz'), { fetchContentLength: () => null }),
    ).not.toThrow();
  });

  it('throws on a truncated cached archive when no Content-Length is available', () => {
    const archive = gzipFixture('LEGI_d.tar.gz', true);
    expect(() =>
      verifyCachedArchive(archive, refFor('LEGI_d.tar.gz'), { fetchContentLength: () => null }),
    ).toThrow(/integrity|gzip|truncated/i);
  });

  it('throws on an empty cached file', () => {
    const archive = path.join(tmpDir, 'LEGI_e.tar.gz');
    fs.writeFileSync(archive, '');
    expect(() =>
      verifyCachedArchive(archive, refFor('LEGI_e.tar.gz'), { fetchContentLength: () => null }),
    ).toThrow(/empty/i);
  });
});

/**
 * Fast-path integrity (PR #98 review finding legi-acquire.ts:373): a marker
 * can outlive the tree (`rm -rf extracted/*` keeps dotfiles). The
 * "extraction is current" path must verify legi/ actually exists.
 */
describe('ensureCurrentCorpus fast path', () => {
  const INDEX_FIXTURE = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/legi/dila-index-sample.html'),
    'utf-8',
  );
  // All deltas the fixture plan would queue on the 20250713-140000 base.
  const FIXTURE_DELTAS = [
    'LEGI_20250713-205013.tar.gz',
    'LEGI_20250715-205701.tar.gz',
    'LEGI_20250716-211907.tar.gz',
    'LEGI_20250717-220632.tar.gz',
    'LEGI_20260608-213910.tar.gz',
    'LEGI_20260609-212725.tar.gz',
    'LEGI_20260610-214017.tar.gz',
  ];
  const OPTS = {
    indexHtml: '',
    now: new Date('2026-06-11T12:00:00Z'),
    maxGapDays: 400,
    maxStalenessDays: 400,
  };

  it('throws when the marker asserts a corpus but the legi/ tree is gone', async () => {
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    writeExtractIdentity(extractDir, identity({ deltas_applied: FIXTURE_DELTAS, source_stamp: '20260610-214017' }));
    await expect(
      ensureCurrentCorpus({ ...OPTS, indexHtml: INDEX_FIXTURE, cacheDir: tmpDir, extractDir }),
    ).rejects.toThrow(/legi\//);
  });

  it('returns the identity when the marker matches the plan AND the tree exists', async () => {
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(path.join(extractDir, 'legi'), { recursive: true });
    const id = identity({ deltas_applied: FIXTURE_DELTAS, source_stamp: '20260610-214017' });
    writeExtractIdentity(extractDir, id);
    const result = await ensureCurrentCorpus({ ...OPTS, indexHtml: INDEX_FIXTURE, cacheDir: tmpDir, extractDir });
    expect(result.identity.source_stamp).toBe('20260610-214017');
  });
});

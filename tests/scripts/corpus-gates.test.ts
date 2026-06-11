/**
 * Tests for scripts/lib/corpus-gates.ts — aggregate floors and cross-checks
 * (PR #98 review findings ingest-legi.ts:489, build-db.ts:282, build-db.ts:408,
 * census.ts:76, ingest-legi.ts:386).
 *
 * Platform rule: unbounded exclusions need aggregate floors; partial-scope
 * runs must never shrink the corpus silently; a database must never be
 * stamped with a corpus identity its seeds do not actually carry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertCensusFloors,
  assertOutOfForceCap,
  assertUnrepresentableCap,
  verifySeedsAgainstCensus,
} from '../../scripts/lib/corpus-gates.js';

// Real 2026-06 corpus shape (stamp 20260610-214017): 76 codes, 119,046 texts,
// 1,447,953 article files.
const REAL_SHAPE = {
  codes: 76,
  totalTexts: 119_046,
  totalArticleFiles: 1_447_953,
  walkErrors: 0,
  codesOnly: false,
};

describe('assertCensusFloors', () => {
  it('passes on the real corpus shape', () => {
    expect(() => assertCensusFloors(REAL_SHAPE)).not.toThrow();
  });

  it('throws when the code count collapses (France has 70+ codes)', () => {
    expect(() => assertCensusFloors({ ...REAL_SHAPE, codes: 12 })).toThrow(/code/i);
  });

  it('throws when the text universe collapses (partial walk / vanished tree)', () => {
    expect(() => assertCensusFloors({ ...REAL_SHAPE, totalTexts: 4_000 })).toThrow(/text/i);
  });

  it('throws when the article-file universe collapses', () => {
    expect(() => assertCensusFloors({ ...REAL_SHAPE, totalArticleFiles: 50_000 })).toThrow(/article/i);
  });

  it('throws on ANY swallowed walk error (files vanishing mid-walk must not shrink the census silently)', () => {
    expect(() => assertCensusFloors({ ...REAL_SHAPE, walkErrors: 1 })).toThrow(/walk/i);
  });

  it('skips the full-corpus text floor in codes-only mode but keeps the code floor', () => {
    expect(() =>
      assertCensusFloors({ codes: 76, totalTexts: 76, totalArticleFiles: 400_000, walkErrors: 0, codesOnly: true }),
    ).not.toThrow();
    expect(() =>
      assertCensusFloors({ codes: 12, totalTexts: 12, totalArticleFiles: 400_000, walkErrors: 0, codesOnly: true }),
    ).toThrow(/code/i);
  });
});

describe('assertOutOfForceCap', () => {
  it('passes at the observed real-corpus ratio (~6.3%)', () => {
    expect(() => assertOutOfForceCap({ targetCount: 4351, outOfForceCount: 273 })).not.toThrow();
  });

  it('throws when out-of-force exclusions exceed the cap (systemic drift, not legal reality)', () => {
    expect(() => assertOutOfForceCap({ targetCount: 4351, outOfForceCount: 700 })).toThrow(/out.of.force|cap/i);
  });

  it('throws when EVERYTHING is excluded (the ETAT-vocabulary-drift catastrophe)', () => {
    expect(() => assertOutOfForceCap({ targetCount: 4351, outOfForceCount: 4351 })).toThrow();
  });
});

describe('assertUnrepresentableCap', () => {
  it('passes at the observed real-corpus level (1 unnumbered-article text of 4,351)', () => {
    expect(() => assertUnrepresentableCap({ targetCount: 4351, unrepresentableCount: 1 })).not.toThrow();
  });

  it('throws when unrepresentable exclusions exceed 1% of targets (parser drift, not DILA reality)', () => {
    expect(() => assertUnrepresentableCap({ targetCount: 4351, unrepresentableCount: 50 })).toThrow(/unrepresentable/i);
  });
});

describe('verifySeedsAgainstCensus', () => {
  let tmpDir: string;
  let censusPath: string;
  let seedDir: string;

  const STAMP = '20260610-214017';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-gates-test-'));
    censusPath = path.join(tmpDir, 'census.json');
    seedDir = path.join(tmpDir, 'seed');
    fs.mkdirSync(seedDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCensus(laws: Array<{ id: string; ingested: boolean }>, sourceStamp: string | null = STAMP): void {
    const census = {
      schema_version: '1.0',
      ...(sourceStamp
        ? {
            source_archive: {
              base: 'Freemium_legi_global_20250713-140000.tar.gz',
              base_stamp: '20250713-140000',
              deltas_applied: 332,
              last_delta: 'LEGI_20260610-214017.tar.gz',
              source_stamp: sourceStamp,
              acquired_at: '2026-06-11T00:00:00Z',
            },
          }
        : {}),
      summary: { total_laws: laws.length, total_provisions: 0, ingestable: laws.length, ocr_needed: 0, inaccessible: 0, excluded: 0 },
      laws: laws.map((l) => ({ ...l, title: l.id, identifier: l.id.toUpperCase(), status: 'in_force', category: 'code', classification: 'ingestable' })),
    };
    fs.writeFileSync(censusPath, JSON.stringify(census), 'utf-8');
  }

  function writeSeed(id: string, stamp: string | null): void {
    const seed: Record<string, unknown> = { id, type: 'statute', title: id, status: 'in_force', provisions: [] };
    if (stamp) {
      seed['_ingest'] = { retrieved_at: '2026-06-11T00:00:00Z', source_base: 'b', source_last_delta: 'd', source_stamp: stamp };
    }
    fs.writeFileSync(path.join(seedDir, `${id}.json`), JSON.stringify(seed), 'utf-8');
  }

  it('passes when every ingested census entry has a matching stamped seed (manual seeds allowed)', () => {
    writeCensus([
      { id: 'code-civil', ingested: true },
      { id: 'legitext000000000009', ingested: false },
    ]);
    writeSeed('code-civil', STAMP);
    writeSeed('nis2-transposition-france', null); // manual seed, no _ingest
    fs.writeFileSync(path.join(seedDir, 'eu-references.json'), '{}', 'utf-8');

    const result = verifySeedsAgainstCensus({ censusPath, seedDir });
    expect(result.sourceArchive?.source_stamp).toBe(STAMP);
    expect(result.stampedSeedCount).toBe(1);
    expect(result.manualSeedCount).toBe(1);
    expect(result.seedFiles).toHaveLength(2);
  });

  it('throws when a census-ingested text has NO seed file (crashed/partial ingest must not build)', () => {
    writeCensus([
      { id: 'code-civil', ingested: true },
      { id: 'code-penal', ingested: true },
    ]);
    writeSeed('code-civil', STAMP);
    expect(() => verifySeedsAgainstCensus({ censusPath, seedDir })).toThrow(/code-penal/);
  });

  it('throws on a stale stamped seed the census does not claim as ingested', () => {
    writeCensus([{ id: 'code-civil', ingested: true }, { id: 'code-penal', ingested: false }]);
    writeSeed('code-civil', STAMP);
    writeSeed('code-penal', STAMP); // stale leftover
    expect(() => verifySeedsAgainstCensus({ censusPath, seedDir })).toThrow(/code-penal/);
  });

  it('throws when a seed carries a different source stamp than the census (mixed-corpus build)', () => {
    writeCensus([{ id: 'code-civil', ingested: true }]);
    writeSeed('code-civil', '20250713-140000');
    expect(() => verifySeedsAgainstCensus({ censusPath, seedDir })).toThrow(/stamp/i);
  });

  it('throws when there are no document seeds at all', () => {
    writeCensus([{ id: 'code-civil', ingested: true }]);
    expect(() => verifySeedsAgainstCensus({ censusPath, seedDir })).toThrow(/seed/i);
  });

  it('throws when the census records zero ingested texts (build would silently ship manual seeds only)', () => {
    writeCensus([{ id: 'code-civil', ingested: false }]);
    writeSeed('nis2-transposition-france', null);
    expect(() => verifySeedsAgainstCensus({ censusPath, seedDir })).toThrow(/ingest/i);
  });

  it('throws on a corrupt census.json (torn state must never look fresh)', () => {
    fs.writeFileSync(censusPath, '{ torn', 'utf-8');
    writeSeed('code-civil', STAMP);
    expect(() => verifySeedsAgainstCensus({ censusPath, seedDir })).toThrow();
  });

  it('throws when the census is missing but stamped seeds exist', () => {
    writeSeed('code-civil', STAMP);
    expect(() => verifySeedsAgainstCensus({ censusPath, seedDir })).toThrow(/census/i);
  });

  it('returns a null source for a manual-only seed set without a census (explicitly unstamped)', () => {
    writeSeed('nis2-transposition-france', null);
    const result = verifySeedsAgainstCensus({ censusPath, seedDir });
    expect(result.sourceArchive).toBeNull();
    expect(result.manualSeedCount).toBe(1);
  });
});

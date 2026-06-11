/**
 * Tests for scripts/lib/legi-archive.ts — runtime resolution of DILA LEGI
 * archives (issue #97: hardcoded Freemium_legi_global_20250713-140000.tar.gz
 * froze the corpus at July 2025).
 *
 * Fixture: tests/fixtures/legi/dila-index-sample.html is a trimmed copy of the
 * REAL https://echanges.dila.gouv.fr/OPENDATA/LEGI/ index (captured
 * 2026-06-10). It contains one global archive and a mix of incremental deltas
 * dated before, same-day-after, and long after the global stamp.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLegiIndex,
  planAcquisition,
  assertPlanContinuity,
  latestStamp,
  stampToIso,
  LEGI_BASE_URL,
} from '../../scripts/lib/legi-archive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(
  path.join(__dirname, '../fixtures/legi/dila-index-sample.html'),
  'utf-8',
);

describe('parseLegiIndex', () => {
  it('finds the global archive and all incremental deltas in the real index', () => {
    const refs = parseLegiIndex(INDEX_HTML);
    const globals = refs.filter((r) => r.kind === 'global');
    const deltas = refs.filter((r) => r.kind === 'delta');

    expect(globals).toHaveLength(1);
    expect(globals[0].name).toBe('Freemium_legi_global_20250713-140000.tar.gz');
    expect(globals[0].stamp).toBe('20250713-140000');
    expect(globals[0].url).toBe(`${LEGI_BASE_URL}Freemium_legi_global_20250713-140000.tar.gz`);

    // Fixture carries 8 delta entries, including one BEFORE the global stamp.
    expect(deltas.map((d) => d.name)).toContain('LEGI_20250712-211706.tar.gz');
    expect(deltas.map((d) => d.name)).toContain('LEGI_20260610-214017.tar.gz');
    expect(deltas).toHaveLength(8);
  });

  it('does not mis-classify the global archive as a delta', () => {
    const refs = parseLegiIndex(INDEX_HTML);
    const deltaNames = refs.filter((r) => r.kind === 'delta').map((r) => r.name);
    expect(deltaNames).not.toContain('Freemium_legi_global_20250713-140000.tar.gz');
  });

  it('throws on an index with no recognizable archives (fail-loud, no silent fallback)', () => {
    expect(() => parseLegiIndex('<html><body>maintenance</body></html>')).toThrow(
      /no LEGI archives/i,
    );
  });
});

describe('planAcquisition', () => {
  it('picks the newest global as base and only deltas STRICTLY after its stamp, sorted ascending', () => {
    const plan = planAcquisition(parseLegiIndex(INDEX_HTML));

    expect(plan.base.name).toBe('Freemium_legi_global_20250713-140000.tar.gz');
    // LEGI_20250712-211706 predates the global snapshot -> excluded.
    expect(plan.deltas.map((d) => d.name)).not.toContain('LEGI_20250712-211706.tar.gz');
    // LEGI_20250713-205013 is the SAME DAY but after the 14:00 snapshot -> included.
    expect(plan.deltas[0].name).toBe('LEGI_20250713-205013.tar.gz');
    expect(plan.deltas.at(-1)?.name).toBe('LEGI_20260610-214017.tar.gz');
    // Ascending order.
    const stamps = plan.deltas.map((d) => d.stamp);
    expect([...stamps].sort()).toEqual(stamps);
    // Source identity = last delta applied.
    expect(plan.sourceStamp).toBe('20260610-214017');
  });

  it('uses the newest global when several exist', () => {
    const html =
      INDEX_HTML +
      '\n<a href="Freemium_legi_global_20260601-120000.tar.gz">Freemium_legi_global_20260601-120000.tar.gz</a>';
    const plan = planAcquisition(parseLegiIndex(html));
    expect(plan.base.stamp).toBe('20260601-120000');
    // Only deltas after the NEW base remain.
    expect(plan.deltas.map((d) => d.name)).toEqual([
      'LEGI_20260608-213910.tar.gz',
      'LEGI_20260609-212725.tar.gz',
      'LEGI_20260610-214017.tar.gz',
    ]);
    expect(plan.sourceStamp).toBe('20260610-214017');
  });

  it('sourceStamp falls back to the base stamp when no deltas follow it', () => {
    const html = `
      <a href="Freemium_legi_global_20260610-220000.tar.gz">x</a>
      <a href="LEGI_20260610-214017.tar.gz">x</a>`;
    const plan = planAcquisition(parseLegiIndex(html));
    expect(plan.deltas).toHaveLength(0);
    expect(plan.sourceStamp).toBe('20260610-220000');
  });

  it('throws when no global archive exists (deltas alone cannot bootstrap a corpus)', () => {
    const html = '<a href="LEGI_20260610-214017.tar.gz">x</a>';
    expect(() => planAcquisition(parseLegiIndex(html))).toThrow(/global/i);
  });
});

describe('latestStamp', () => {
  it('returns the newest stamp across globals and deltas (drives check-updates)', () => {
    expect(latestStamp(parseLegiIndex(INDEX_HTML))).toBe('20260610-214017');
  });
});

describe('stampToIso', () => {
  it('converts a DILA stamp to ISO-8601 UTC', () => {
    expect(stampToIso('20250713-140000')).toBe('2025-07-13T14:00:00Z');
  });
  it('throws on malformed stamps', () => {
    expect(() => stampToIso('2025-07-13')).toThrow();
    expect(() => stampToIso('')).toThrow();
  });
});

/**
 * Continuity / freshness gate (PR #98 review finding legi-archive.ts:96):
 * DILA publishes deltas DAILY (332 deltas since 2025-07-13, max observed gap
 * 2 days). A plan whose chain has a hole, or whose newest archive is stale,
 * means purged dailies or index-regex drift — either way the resulting corpus
 * would silently miss amendments. Fail loud.
 */
describe('assertPlanContinuity', () => {
  const NOW = new Date('2026-06-11T12:00:00Z');

  function planOf(baseStamp: string, deltaStamps: string[]) {
    return {
      base: {
        name: `Freemium_legi_global_${baseStamp}.tar.gz`,
        kind: 'global' as const,
        stamp: baseStamp,
        url: 'https://example.invalid/base',
      },
      deltas: deltaStamps.map((s) => ({
        name: `LEGI_${s}.tar.gz`,
        kind: 'delta' as const,
        stamp: s,
        url: `https://example.invalid/LEGI_${s}.tar.gz`,
      })),
      sourceStamp: deltaStamps.at(-1) ?? baseStamp,
    };
  }

  it('accepts a continuous, fresh chain', () => {
    const plan = planOf('20260601-140000', [
      '20260603-210000',
      '20260605-210000',
      '20260607-210000',
      '20260609-210000',
      '20260610-214017',
    ]);
    expect(() => assertPlanContinuity(plan, { now: NOW })).not.toThrow();
  });

  it('accepts a fresh base-only plan (global just cut, no deltas yet)', () => {
    expect(() => assertPlanContinuity(planOf('20260610-220000', []), { now: NOW })).not.toThrow();
  });

  it('throws when the newest archive is stale (delta regex drift re-pins to an old global silently otherwise)', () => {
    expect(() => assertPlanContinuity(planOf('20250713-140000', []), { now: NOW })).toThrow(/stale|old/i);
  });

  it('throws when the newest delta is older than the freshness window', () => {
    const plan = planOf('20260520-140000', ['20260522-210000', '20260524-210000']);
    expect(() => assertPlanContinuity(plan, { now: NOW })).toThrow(/stale|old/i);
  });

  it('throws on a hole between consecutive deltas (purged dailies = silent amendment hole)', () => {
    const plan = planOf('20260520-140000', [
      '20260521-210000',
      '20260601-210000', // 11-day hole
      '20260610-214017',
    ]);
    expect(() => assertPlanContinuity(plan, { now: NOW })).toThrow(/20260521-210000.*20260601-210000|gap|hole/i);
  });

  it('throws on a hole between the base and the first delta', () => {
    const plan = planOf('20260520-140000', ['20260605-210000', '20260610-214017']);
    expect(() => assertPlanContinuity(plan, { now: NOW })).toThrow(/gap|hole/i);
  });

  it('respects explicit gap/staleness overrides (loud operator escape hatch)', () => {
    const plan = planOf('20260520-140000', ['20260605-210000', '20260610-214017']);
    expect(() =>
      assertPlanContinuity(plan, { now: NOW, maxGapDays: 30, maxStalenessDays: 30 }),
    ).not.toThrow();
  });
});

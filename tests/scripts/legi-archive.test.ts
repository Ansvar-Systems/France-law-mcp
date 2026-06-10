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

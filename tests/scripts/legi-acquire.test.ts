/**
 * Tests for scripts/lib/legi-acquire.ts — corpus acquisition state:
 * extraction identity marker (provable corpus version), delta resume queue,
 * and suppression-list application (fail-loud on malformed input).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IDENTITY_MARKER,
  readExtractIdentity,
  writeExtractIdentity,
  computeDeltaQueue,
  applySuppressionList,
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
});

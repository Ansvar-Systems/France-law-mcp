/**
 * Tests for scripts/lib/texte-version.ts — validity-aware selection of the
 * TEXTE_VERSION metadata file inside a LEGI `texte/version/` directory
 * (issue #97 mechanism 2: census.ts picked files[0], first alphabetical).
 *
 * Fixture mirrors the REAL archive shape:
 *   JORFTEXT000000856038/texte/version/{LEGITEXT...}.xml
 * with the OLD version named so it sorts FIRST alphabetically — the exact
 * configuration the files[0] bug got wrong.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTexteVersionFile, selectTexteVersion } from '../../scripts/lib/texte-version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '../fixtures/legi/texte-version');
const TODAY = '2026-06-10';

describe('parseTexteVersionFile', () => {
  it('extracts validity metadata from a real-shaped TEXTE_VERSION xml', () => {
    const meta = parseTexteVersionFile(
      path.join(FIXTURES, 'JORFTEXT000000856038/texte/version/LEGITEXT000048999999.xml'),
    );
    expect(meta).not.toBeNull();
    expect(meta?.id).toBe('LEGITEXT000048999999');
    expect(meta?.etat).toBe('VIGUEUR');
    expect(meta?.dateDebut).toBe('2024-03-15');
    expect(meta?.dateFin).toBeUndefined(); // 2999-01-01 = open-ended
    expect(meta?.nature).toBe('DECRET');
    expect(meta?.title).toContain('version en vigueur');
  });

  it('returns null for a missing file', () => {
    expect(parseTexteVersionFile(path.join(FIXTURES, 'nope.xml'))).toBeNull();
  });
});

describe('selectTexteVersion', () => {
  it('selects the in-force version, NOT the alphabetically-first file', () => {
    const dir = path.join(FIXTURES, 'JORFTEXT000000856038');
    const chosen = selectTexteVersion(dir, TODAY);
    expect(chosen).not.toBeNull();
    // files[0] would have picked LEGITEXT000006060883.xml (MODIFIE, ended 2024-03-15).
    expect(chosen?.id).toBe('LEGITEXT000048999999');
    expect(chosen?.status).toBe('in_force');
  });

  it('ignores the future (VIGUEUR_DIFF) version when a current one exists', () => {
    const dir = path.join(FIXTURES, 'JORFTEXT000000856038');
    expect(selectTexteVersion(dir, TODAY)?.id).not.toBe('LEGITEXT000049111111');
  });

  it('falls back to the newest version for fully-repealed texts and marks them repealed', () => {
    const dir = path.join(FIXTURES, 'JORFTEXT000099999901');
    const chosen = selectTexteVersion(dir, TODAY);
    expect(chosen?.id).toBe('LEGITEXT000022222222'); // newest dateDebut, ABROGE
    expect(chosen?.status).toBe('repealed');
  });

  it('returns null when the directory has no version files', () => {
    expect(selectTexteVersion(path.join(FIXTURES, 'does-not-exist'), TODAY)).toBeNull();
  });
});

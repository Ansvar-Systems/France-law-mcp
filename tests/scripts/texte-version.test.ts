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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapTexteEtatToStatus,
  parseTexteVersionFile,
  selectTexteVersion,
} from '../../scripts/lib/texte-version.js';

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

/**
 * Deliberate text-level ETAT -> status mapping (PR #98 review finding
 * texte-version.ts:69). Status must be a FACT: a deferred repeal
 * (ABROGE_DIFF) is IN FORCE until its repeal date.
 */
describe('mapTexteEtatToStatus', () => {
  it('maps the in-force states', () => {
    expect(mapTexteEtatToStatus('VIGUEUR', {}, TODAY)).toBe('in_force');
    expect(mapTexteEtatToStatus('MODIFIE', {}, TODAY)).toBe('amended');
  });

  it('keeps an ABROGE_DIFF text IN FORCE until its repeal date (the legal fact)', () => {
    expect(mapTexteEtatToStatus('ABROGE_DIFF', { dateFin: '2026-08-01' }, TODAY)).toBe('in_force');
    expect(mapTexteEtatToStatus('ABROGE_DIFF', { dateFin: '2028-01-01' }, TODAY)).toBe('in_force');
  });

  it('marks an ABROGE_DIFF text repealed once the repeal date has arrived ([debut, fin) — fin day is OUT)', () => {
    expect(mapTexteEtatToStatus('ABROGE_DIFF', { dateFin: '2026-06-10' }, TODAY)).toBe('repealed');
    expect(mapTexteEtatToStatus('ABROGE_DIFF', { dateFin: '2020-01-01' }, TODAY)).toBe('repealed');
  });

  it('keeps an ABROGE_DIFF text without a recorded repeal date in force (fact today)', () => {
    expect(mapTexteEtatToStatus('ABROGE_DIFF', {}, TODAY)).toBe('in_force');
  });

  it('maps terminal not-in-force states to repealed', () => {
    for (const etat of ['ABROGE', 'PERIME', 'TRANSFERE', 'DEPLACE', 'ANNULE', 'MORT_NE', 'MODIFIE_MORT_NE']) {
      expect(mapTexteEtatToStatus(etat, {}, TODAY)).toBe('repealed');
    }
  });

  it('maps VIGUEUR_DIFF to not_yet_in_force', () => {
    expect(mapTexteEtatToStatus('VIGUEUR_DIFF', { dateDebut: '2027-01-01' }, TODAY)).toBe('not_yet_in_force');
  });

  it('lets the validity window override an in-force ETAT (window closed = repealed; not yet open = not_yet_in_force)', () => {
    expect(mapTexteEtatToStatus('VIGUEUR', { dateFin: '2026-06-10' }, TODAY)).toBe('repealed'); // ends today
    expect(mapTexteEtatToStatus('VIGUEUR', { dateFin: '2026-06-11' }, TODAY)).toBe('in_force'); // ends tomorrow
    expect(mapTexteEtatToStatus('VIGUEUR', { dateDebut: '2027-01-01' }, TODAY)).toBe('not_yet_in_force');
  });

  it('fails loud on an ETAT outside the mapped vocabulary', () => {
    expect(() => mapTexteEtatToStatus('ETAT_INCONNU', {}, TODAY)).toThrow(/ETAT_INCONNU/);
  });
});

describe('parseTexteVersionFile fail-loud ETAT handling', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'texte-version-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeVersionXml(name: string, body: string): string {
    const fp = path.join(tmpDir, name);
    fs.writeFileSync(fp, body, 'utf-8');
    return fp;
  }

  const versionXml = (etatTag: string, dateFin = '2999-01-01') => `<?xml version="1.0" encoding="UTF-8"?>
<TEXTE_VERSION>
  <META>
    <META_COMMUN><ID>LEGITEXT000023106310</ID><NATURE>DECRET</NATURE></META_COMMUN>
    <META_SPEC><META_TEXTE_VERSION>
      <TITRE>Décret test</TITRE>${etatTag}
      <DATE_DEBUT>2010-11-17</DATE_DEBUT><DATE_FIN>${dateFin}</DATE_FIN>
    </META_TEXTE_VERSION></META_SPEC>
  </META>
</TEXTE_VERSION>`;

  it('keeps a deferred-repeal (ABROGE_DIFF, future DATE_FIN) text in force and records the repeal date', () => {
    const fp = writeVersionXml('v1.xml', versionXml('<ETAT>ABROGE_DIFF</ETAT>', '2026-08-01'));
    const meta = parseTexteVersionFile(fp, TODAY);
    expect(meta?.status).toBe('in_force'); // NOT repealed before the date
    expect(meta?.etat).toBe('ABROGE_DIFF');
    expect(meta?.dateFin).toBe('2026-08-01'); // the scheduled repeal date is the recorded fact
  });

  it('throws on a TEXTE_VERSION without an ETAT (no silent VIGUEUR default)', () => {
    const fp = writeVersionXml('v2.xml', versionXml(''));
    expect(() => parseTexteVersionFile(fp, TODAY)).toThrow(/ETAT/);
  });

  it('throws on an unknown text-level ETAT (vocabulary drift fails loud)', () => {
    const fp = writeVersionXml('v3.xml', versionXml('<ETAT>ETAT_FUTUR_INCONNU</ETAT>'));
    expect(() => parseTexteVersionFile(fp, TODAY)).toThrow(/ETAT_FUTUR_INCONNU/);
  });
});

describe('round-3 (delta review of the round-2 fixes)', () => {
  const W = { dateDebut: '2025-01-01', dateFin: undefined };

  it('R3-1: VIGUEUR_DIFF whose window has OPENED maps in_force (window overrides label, both directions)', () => {
    // Live contradiction: JORFTEXT000048582228 — VIGUEUR_DIFF label, in force
    // since 2025-01-01, was stamped not_yet_in_force in the committed census.
    expect(mapTexteEtatToStatus('VIGUEUR_DIFF', W, '2026-06-11')).toBe('in_force');
    expect(mapTexteEtatToStatus('VIGUEUR_DIFF', { dateDebut: '2027-01-01' }, '2026-06-11')).toBe(
      'not_yet_in_force',
    );
  });

  it('R3-2a: a present-but-EMPTY text-level <ETAT/> is undeclared — the window decides, no throw', () => {
    expect(mapTexteEtatToStatus('', { dateDebut: '2020-01-01' }, '2026-06-11', { etatPresent: true })).toBe(
      'in_force',
    );
    expect(
      mapTexteEtatToStatus('', { dateDebut: '2020-01-01', dateFin: '2024-01-01' }, '2026-06-11', {
        etatPresent: true,
      }),
    ).toBe('repealed');
  });

  it('R3-2b: an ABSENT text-level ETAT still throws (outside the vocabulary)', () => {
    expect(() => mapTexteEtatToStatus('', W, '2026-06-11', { etatPresent: false })).toThrow(/NO ETAT/);
    expect(() => mapTexteEtatToStatus('', W, '2026-06-11')).toThrow(/NO ETAT/);
  });

  it('R3-2c: one bad TEXTE_VERSION among many is counted, not a census-killer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-r3-'));
    const ok = `<TEXTE_VERSION><META><META_COMMUN><ID>LEGITEXT000000000001</ID><NATURE>LOI</NATURE></META_COMMUN><META_SPEC><META_TEXTE_VERSION><TITRE>Loi test</TITRE><ETAT>VIGUEUR</ETAT><DATE_DEBUT>2020-01-01</DATE_DEBUT><DATE_FIN>2999-01-01</DATE_FIN></META_TEXTE_VERSION></META_SPEC></META></TEXTE_VERSION>`;
    const badEtat = ok
      .replace('LEGITEXT000000000001', 'LEGITEXT000000000002')
      .replace('<ETAT>VIGUEUR</ETAT>', '<ETAT>GIBBERISH_DRIFT</ETAT>');
    const vdir = path.join(dir, 'texte', 'version');
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(vdir, 'LEGITEXT000000000001.xml'), ok);
    fs.writeFileSync(path.join(vdir, 'LEGITEXT000000000002.xml'), badEtat);
    const errors: string[] = [];
    const picked = selectTexteVersion(dir, '2026-06-11', { onVersionError: (e) => errors.push(String(e)) });
    expect(picked?.id).toBe('LEGITEXT000000000001'); // healthy version selected
    expect(errors.length).toBe(1); // the drift is COUNTED loudly, not fatal-to-census
    expect(errors[0]).toMatch(/GIBBERISH_DRIFT/);
  });
});

/**
 * Tests for scripts/lib/parser.ts — deliberate ETAT vocabulary handling and
 * loud accounting of article versions that previously vanished silently
 * (PR #98 review findings parser.ts:189, parser.ts:286, parser.ts:131).
 *
 * Legal correctness: ABROGE_DIFF means repeal at a FUTURE date — such article
 * versions are IN FORCE today and must reach validity selection. MODIFIE /
 * ABROGE / PERIME / TRANSFERE / VIGUEUR_DIFF / MODIFIE_MORT_NE / ANNULE /
 * DEPLACE are deliberately excluded. An ETAT outside the mapped vocabulary
 * fails loud (parse error), never a silent drop.
 *
 * Vocabulary verified against the full 2026-06 corpus (stamp 20260610-214017):
 * see the ETAT scan log referenced in the PR.
 */
import { describe, it, expect } from 'vitest';
import { parseLegiXml, parseLegiDate, parseLegiDateOpenEnded } from '../../scripts/lib/parser.js';

function articleXml(opts: {
  etat?: string;
  content?: string;
  num?: string;
  dateDebut?: string;
  dateFin?: string;
}): string {
  const { etat, content = '<p>contenu</p>', num = '1', dateDebut = '2020-01-01', dateFin = '2999-01-01' } = opts;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ARTICLE>
  <META><META_COMMUN><ID>LEGIARTI000000000001</ID></META_COMMUN>
  <META_SPEC><META_ARTICLE>${num ? `<NUM>${num}</NUM>` : ''}${etat !== undefined ? `<ETAT>${etat}</ETAT>` : ''}
  <DATE_DEBUT>${dateDebut}</DATE_DEBUT><DATE_FIN>${dateFin}</DATE_FIN></META_ARTICLE></META_SPEC></META>
  <BLOC_TEXTUEL><CONTENU>${content}</CONTENU></BLOC_TEXTUEL>
</ARTICLE>`;
}

describe('ETAT vocabulary (deliberate mapping, fail-loud on unknown)', () => {
  it('keeps VIGUEUR versions as servable candidates', () => {
    const r = parseLegiXml(articleXml({ etat: 'VIGUEUR' }));
    expect(r.articles).toHaveLength(1);
    expect(r.servableVersions).toBe(1);
    expect(r.errors).toHaveLength(0);
  });

  it('keeps ABROGE_DIFF versions as servable candidates (deferred repeal = in force until the repeal date)', () => {
    const r = parseLegiXml(
      articleXml({ etat: 'ABROGE_DIFF', dateDebut: '2025-11-08', dateFin: '2029-01-01' }),
    );
    expect(r.articles).toHaveLength(1);
    expect(r.articles[0].etat).toBe('ABROGE_DIFF');
    expect(r.articles[0].dateFin).toBe('2029-01-01'); // the repeal date is recorded
    expect(r.servableVersions).toBe(1);
    expect(r.errors).toHaveLength(0);
  });

  for (const etat of [
    'MODIFIE',
    'ABROGE',
    'VIGUEUR_DIFF',
    'TRANSFERE',
    'PERIME',
    'MODIFIE_MORT_NE',
    'ANNULE',
    'DEPLACE',
    'DISJOINT',
  ]) {
    it(`deliberately excludes ${etat} versions (counted, no error)`, () => {
      const r = parseLegiXml(articleXml({ etat }));
      expect(r.articles).toHaveLength(0);
      expect(r.articleNodesSeen).toBe(1);
      expect(r.servableVersions).toBe(0);
      expect(r.errors).toHaveLength(0);
    });
  }

  it('fails loud on an ETAT outside the mapped vocabulary', () => {
    const r = parseLegiXml(articleXml({ etat: 'NOUVEL_ETAT_INCONNU' }));
    expect(r.articles).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/NOUVEL_ETAT_INCONNU/);
  });

  it('fails loud on an ABSENT ETAT tag (contract drift, never silently dropped)', () => {
    const r = parseLegiXml(articleXml({ etat: undefined }));
    expect(r.articles).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/ETAT/);
  });

  it('treats an EMPTY ETAT tag (<ETAT/>) as undeclared — the validity window decides, and it is counted', () => {
    // Real DILA pattern (e.g. Code de la santé publique R3221-7,
    // LEGIARTI000046340367): <ETAT/> with an open [2023-06-01, 2999) window —
    // the ONLY open-window version of its article number. Légifrance serves
    // it; dropping it silently loses in-force law. The window is the
    // controlling recorded fact when the label is blank.
    const r = parseLegiXml(articleXml({ etat: '', dateDebut: '2023-06-01', dateFin: '2999-01-01' }));
    expect(r.articles).toHaveLength(1);
    expect(r.articles[0].etat).toBe('');
    expect(r.articles[0].dateDebut).toBe('2023-06-01');
    expect(r.servableVersions).toBe(1);
    expect(r.undeclaredEtatVersions).toBe(1);
    expect(r.errors).toHaveLength(0);
  });

  it('parses a self-closing <ETAT/> the same as an empty pair', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ARTICLE>
  <META><META_COMMUN><ID>LEGIARTI000046340367</ID></META_COMMUN>
  <META_SPEC><META_ARTICLE><NUM>R3221-7</NUM><ETAT/>
  <DATE_DEBUT>2023-06-01</DATE_DEBUT><DATE_FIN>2999-01-01</DATE_FIN></META_ARTICLE></META_SPEC></META>
  <BLOC_TEXTUEL><CONTENU><p>contenu</p></CONTENU></BLOC_TEXTUEL>
</ARTICLE>`;
    const r = parseLegiXml(xml);
    expect(r.articles).toHaveLength(1);
    expect(r.undeclaredEtatVersions).toBe(1);
    expect(r.errors).toHaveLength(0);
  });
});

describe('vanishing-version accounting (review finding parser.ts:286)', () => {
  it('counts servable versions whose body is empty instead of silently dropping them', () => {
    const r = parseLegiXml(articleXml({ etat: 'VIGUEUR', content: '' }));
    expect(r.articles).toHaveLength(0);
    expect(r.servableVersions).toBe(1);
    expect(r.emptyBodyVersions).toBe(1);
    expect(r.missingNumVersions).toBe(0);
    expect(r.errors).toHaveLength(0);
  });

  it('counts whitespace-only bodies as empty', () => {
    const r = parseLegiXml(articleXml({ etat: 'VIGUEUR', content: ' <br/> ' }));
    expect(r.articles).toHaveLength(0);
    expect(r.emptyBodyVersions).toBe(1);
  });

  it('counts servable versions without a NUM instead of silently dropping them', () => {
    const r = parseLegiXml(articleXml({ etat: 'VIGUEUR', num: '' }));
    expect(r.articles).toHaveLength(0);
    expect(r.servableVersions).toBe(1);
    expect(r.missingNumVersions).toBe(1);
    expect(r.emptyBodyVersions).toBe(0);
  });

  it('does not count excluded-ETAT versions in the vanish counters', () => {
    const r = parseLegiXml(articleXml({ etat: 'MODIFIE', content: '' }));
    expect(r.servableVersions).toBe(0);
    expect(r.emptyBodyVersions).toBe(0);
    expect(r.missingNumVersions).toBe(0);
  });
});

describe('parseLegiDate direction-aware 2999 handling (review finding parser.ts:131)', () => {
  it('parseLegiDate returns year-2999 dates literally (a 2999 DATE_DEBUT must NOT mean "since forever")', () => {
    expect(parseLegiDate('2999-01-01')).toBe('2999-01-01');
    expect(parseLegiDate('29990101')).toBe('2999-01-01');
  });

  it('parseLegiDateOpenEnded maps year-2999 to undefined (open-ended DATE_FIN)', () => {
    expect(parseLegiDateOpenEnded('2999-01-01')).toBeUndefined();
    expect(parseLegiDateOpenEnded('29990101')).toBeUndefined();
    expect(parseLegiDateOpenEnded('2026-01-01')).toBe('2026-01-01');
    expect(parseLegiDateOpenEnded('20260101')).toBe('2026-01-01');
    expect(parseLegiDateOpenEnded(undefined)).toBeUndefined();
  });

  it('an article with DATE_DEBUT 2999 keeps the literal date so isInForceOn excludes it', () => {
    const r = parseLegiXml(articleXml({ etat: 'VIGUEUR', dateDebut: '2999-01-01', dateFin: '2999-01-01' }));
    expect(r.articles).toHaveLength(1);
    expect(r.articles[0].dateDebut).toBe('2999-01-01'); // never-in-force, not "forever"
    expect(r.articles[0].dateFin).toBeUndefined(); // open-ended end stays open
  });
});

import { describe, it, expect } from 'vitest';
import { classifyZeroProvisionText, type ZeroProvisionStats } from '../../scripts/lib/ingest-outcome.js';
import { parseLegiXml } from '../../scripts/lib/parser.js';

const base: ZeroProvisionStats = {
  articleFiles: 3,
  fileErrors: 0,
  parseErrors: 0,
  articleNodesSeen: 5,
  vigueurVersions: 0,
  nonEmptyVigueurVersions: 0,
  expiredOnlyNums: 0,
};

describe('classifyZeroProvisionText', () => {
  it('treats zero VIGUEUR versions as an expected out-of-force exclusion', () => {
    // Observed shape: abrogated text kept in the "en vigueur" dump with every
    // article version MODIFIE/ABROGE (e.g. Code du domaine public fluvial,
    // abrogated 2013, whose text-level metadata still claims VIGUEUR).
    const o = classifyZeroProvisionText(base);
    expect(o.kind).toBe('out_of_force');
    expect(o.reason).toMatch(/ETAT=VIGUEUR/);
  });

  it('treats empty-bodied VIGUEUR versions as an expected exclusion', () => {
    const o = classifyZeroProvisionText({ ...base, vigueurVersions: 2 });
    expect(o.kind).toBe('out_of_force');
    expect(o.reason).toMatch(/empty bodies/);
  });

  it('treats all-windows-expired as an expected exclusion', () => {
    const o = classifyZeroProvisionText({
      ...base,
      vigueurVersions: 2,
      nonEmptyVigueurVersions: 2,
      expiredOnlyNums: 2,
    });
    expect(o.kind).toBe('out_of_force');
    expect(o.reason).toMatch(/window is closed/);
  });

  it('keeps parse failures anomalous (fail loud)', () => {
    expect(classifyZeroProvisionText({ ...base, fileErrors: 1 }).kind).toBe('anomaly');
    expect(classifyZeroProvisionText({ ...base, parseErrors: 1 }).kind).toBe('anomaly');
  });

  it('keeps "no article files" and "no ARTICLE nodes" anomalous', () => {
    expect(classifyZeroProvisionText({ ...base, articleFiles: 0 }).kind).toBe('anomaly');
    expect(classifyZeroProvisionText({ ...base, articleNodesSeen: 0 }).kind).toBe('anomaly');
  });

  it('never lets an unexplained zero-provision result pass silently', () => {
    const o = classifyZeroProvisionText({
      ...base,
      vigueurVersions: 2,
      nonEmptyVigueurVersions: 2,
      expiredOnlyNums: 0,
    });
    expect(o.kind).toBe('anomaly');
    expect(o.reason).toMatch(/unexplained/);
  });
});

describe('parseLegiXml articleNodesSeen', () => {
  const xml = (etat: string, content: string) => `<?xml version="1.0" encoding="UTF-8"?>
<ARTICLE>
  <META><META_COMMUN><ID>LEGIARTI000000000001</ID></META_COMMUN>
  <META_SPEC><META_ARTICLE><NUM>1</NUM><ETAT>${etat}</ETAT>
  <DATE_DEBUT>2020-01-01</DATE_DEBUT><DATE_FIN>2999-01-01</DATE_FIN></META_ARTICLE></META_SPEC></META>
  <BLOC_TEXTUEL><CONTENU><p>${content}</p></CONTENU></BLOC_TEXTUEL>
</ARTICLE>`;

  it('counts ARTICLE nodes even when the VIGUEUR filter drops them', () => {
    const result = parseLegiXml(xml('ABROGE', 'ancien texte'));
    expect(result.articles).toHaveLength(0);
    expect(result.articleNodesSeen).toBe(1);
  });

  it('counts and keeps VIGUEUR articles', () => {
    const result = parseLegiXml(xml('VIGUEUR', 'texte en vigueur'));
    expect(result.articles).toHaveLength(1);
    expect(result.articleNodesSeen).toBe(1);
  });
});

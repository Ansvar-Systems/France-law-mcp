/**
 * Tests for scripts/lib/version-select.ts — validity-aware version selection
 * (issue #97 mechanism 2: files[0] / keep-longest selected the wrong version
 * of time-versioned LEGI content).
 *
 * LEGI articles and texte versions carry [DATE_DEBUT, DATE_FIN) validity
 * windows. The current state of the law is the newest version whose window
 * covers today — NOT the first file alphabetically and NOT the longest text.
 */
import { describe, it, expect } from 'vitest';
import {
  isInForceOn,
  selectCurrentVersion,
  selectCurrentOrLatest,
  selectArticles,
  dedupeProvisionSeeds,
} from '../../scripts/lib/version-select.js';
import type { ParsedArticle } from '../../scripts/lib/parser.js';

const TODAY = '2026-06-10';

describe('isInForceOn', () => {
  it('treats the window as [dateDebut, dateFin)', () => {
    expect(isInForceOn({ dateDebut: '2026-06-10', dateFin: '2027-01-01' }, TODAY)).toBe(true); // starts today
    expect(isInForceOn({ dateDebut: '2020-01-01', dateFin: '2026-06-10' }, TODAY)).toBe(false); // ends today
    expect(isInForceOn({ dateDebut: '2026-06-11' }, TODAY)).toBe(false); // future
    expect(isInForceOn({ dateDebut: '2020-01-01', dateFin: '2021-01-01' }, TODAY)).toBe(false); // expired
  });

  it('treats missing dates as open-ended (DATE_FIN 2999-01-01 parses to undefined)', () => {
    expect(isInForceOn({ dateDebut: '2020-01-01' }, TODAY)).toBe(true);
    expect(isInForceOn({}, TODAY)).toBe(true);
    expect(isInForceOn({ dateFin: '2027-01-01' }, TODAY)).toBe(true);
  });
});

describe('selectCurrentVersion', () => {
  it('picks the newest in-force version, not the first listed', () => {
    const versions = [
      { id: 'old', dateDebut: '2010-01-01', dateFin: '2024-03-15' },
      { id: 'current', dateDebut: '2024-03-15' },
      { id: 'future', dateDebut: '2990-01-01' },
    ];
    expect(selectCurrentVersion(versions, TODAY)?.id).toBe('current');
  });

  it('returns null when no version is in force today', () => {
    const versions = [
      { id: 'a', dateDebut: '2010-01-01', dateFin: '2015-01-01' },
      { id: 'b', dateDebut: '2015-01-01', dateFin: '2020-01-01' },
    ];
    expect(selectCurrentVersion(versions, TODAY)).toBeNull();
  });

  it('uses the tie-break comparator when several in-force versions share dateDebut', () => {
    const versions = [
      { id: 'short', dateDebut: '2024-03-15', content: 'ab' },
      { id: 'long', dateDebut: '2024-03-15', content: 'abcdef' },
    ];
    const chosen = selectCurrentVersion(versions, TODAY, (a, b) => b.content.length - a.content.length);
    expect(chosen?.id).toBe('long');
  });
});

describe('selectCurrentOrLatest', () => {
  it('falls back to the newest version overall for fully-repealed texts', () => {
    const versions = [
      { id: 'initial', dateDebut: '1990-01-05', dateFin: '2001-06-01' },
      { id: 'last', dateDebut: '2001-06-01', dateFin: '2018-10-01' },
    ];
    expect(selectCurrentOrLatest(versions, TODAY)?.id).toBe('last');
  });

  it('still prefers the in-force version when one exists', () => {
    const versions = [
      { id: 'old', dateDebut: '1990-01-05', dateFin: '2001-06-01' },
      { id: 'current', dateDebut: '2001-06-01' },
    ];
    expect(selectCurrentOrLatest(versions, TODAY)?.id).toBe('current');
  });

  it('returns null for an empty list', () => {
    expect(selectCurrentOrLatest([], TODAY)).toBeNull();
  });
});

function art(over: Partial<ParsedArticle>): ParsedArticle {
  return {
    id: 'LEGIARTI000000000001',
    num: '323-1',
    normalizedNum: '323-1',
    title: 'Article 323-1',
    content: 'contenu',
    etat: 'VIGUEUR',
    ...over,
  };
}

describe('selectArticles (the dedupe that replaced keep-longest)', () => {
  it('keeps the newest in-force version per article number even when an older version is LONGER', () => {
    // The keep-longest trap: amendments that SHORTEN an article were silently
    // reverted to their longer, outdated text.
    const { selected, droppedExpiredNums } = selectArticles(
      [
        art({
          id: 'LEGIARTI000000000001',
          dateDebut: '2010-01-01',
          dateFin: '2025-09-01',
          content: 'ancienne version beaucoup beaucoup beaucoup plus longue',
        }),
        art({
          id: 'LEGIARTI000000000002',
          dateDebut: '2025-09-01',
          content: 'version courte en vigueur',
        }),
      ],
      TODAY,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('LEGIARTI000000000002');
    expect(droppedExpiredNums).toHaveLength(0);
  });

  it('drops article numbers whose every version window is closed, and reports them', () => {
    const { selected, droppedExpiredNums } = selectArticles(
      [art({ dateDebut: '2010-01-01', dateFin: '2020-01-01' })],
      TODAY,
    );
    expect(selected).toHaveLength(0);
    expect(droppedExpiredNums).toEqual(['323-1']);
  });

  it('selects independently per article number and sorts output by provision ref', () => {
    const { selected } = selectArticles(
      [
        art({ id: 'b-old', num: 'L323-2', normalizedNum: 'L323-2', dateDebut: '2000-01-01', dateFin: '2024-01-01' }),
        art({ id: 'b-new', num: 'L323-2', normalizedNum: 'L323-2', dateDebut: '2024-01-01' }),
        art({ id: 'a', num: 'L323-1', normalizedNum: 'L323-1', dateDebut: '2000-01-01' }),
      ],
      TODAY,
    );
    expect(selected.map((a) => a.id)).toEqual(['a', 'b-new']);
  });

  it('tie-breaks identical windows by longer content (legacy behavior, now LAST resort)', () => {
    const { selected } = selectArticles(
      [
        art({ id: 'short', dateDebut: '2024-01-01', content: 'ab' }),
        art({ id: 'long', dateDebut: '2024-01-01', content: 'abcdef' }),
      ],
      TODAY,
    );
    expect(selected.map((a) => a.id)).toEqual(['long']);
  });
});

describe('dedupeProvisionSeeds (build-db safety net)', () => {
  it('prefers the provision with the newest valid_from over the longest content', () => {
    const out = dedupeProvisionSeeds([
      { provision_ref: 'art1', section: '1', content: 'texte ancien nettement plus long', valid_from: '2010-01-01' },
      { provision_ref: 'art1', section: '1', content: 'texte récent', valid_from: '2025-09-01' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('texte récent');
  });

  it('falls back to longest content when validity dates are absent (legacy seeds)', () => {
    const out = dedupeProvisionSeeds([
      { provision_ref: 'art1', section: '1', content: 'court' },
      { provision_ref: 'art1', section: '1', content: 'beaucoup plus long' },
    ]);
    expect(out[0].content).toBe('beaucoup plus long');
  });
});

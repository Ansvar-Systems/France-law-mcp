/**
 * LEGI XML parser for French legislation.
 *
 * Parses LEGI XML format used by DILA open data archives.
 * Handles the complex French article numbering system:
 *   - "L." prefix: legislative articles (loi)
 *   - "R." prefix: regulatory articles (reglement - decrets en Conseil d'Etat)
 *   - "D." prefix: decree articles (decrets simples)
 *   - "A." prefix: arrete articles
 *
 * XML structure:
 *   <ARTICLE>
 *     <META>
 *       <META_COMMUN>
 *         <ID>LEGIARTI000006417934</ID>
 *       </META_COMMUN>
 *       <META_SPEC>
 *         <META_ARTICLE>
 *           <NUM>L323-1</NUM>
 *           <DATE_DEBUT>2004-08-10</DATE_DEBUT>
 *           <DATE_FIN>2999-01-01</DATE_FIN>
 *           <ETAT>VIGUEUR</ETAT>
 *         </META_ARTICLE>
 *       </META_SPEC>
 *     </META>
 *     <BLOC_TEXTUEL>
 *       <CONTENU>Le fait d'acceder ou de se maintenir...</CONTENU>
 *     </BLOC_TEXTUEL>
 *   </ARTICLE>
 */

import { XMLParser } from 'fast-xml-parser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedArticle {
  id: string;
  num: string;
  normalizedNum: string;
  title: string;
  content: string;
  dateDebut?: string;
  dateFin?: string;
  etat: string;
}

export interface ParseResult {
  /**
   * Servable article versions: ETAT in SERVABLE_ARTICLE_ETATS, with a NUM and
   * a non-empty body. Validity-window selection picks the current one.
   */
  articles: ParsedArticle[];
  errors: string[];
  /**
   * Total ARTICLE nodes seen before the ETAT filter. Lets callers tell
   * "text wholly out of force" (nodes seen, none servable) apart from
   * "nothing parsed at all" — the two must not be conflated (issue #97).
   */
  articleNodesSeen: number;
  /** Versions whose ETAT is in SERVABLE_ARTICLE_ETATS, before the NUM/body checks. */
  servableVersions: number;
  /** Servable versions dropped because they carry no NUM (data damage — counted, never silent). */
  missingNumVersions: number;
  /** Servable versions dropped because the body is empty (DILA abrogation-in-place pattern). */
  emptyBodyVersions: number;
}

// ---------------------------------------------------------------------------
// ETAT vocabulary (deliberate, fail-loud on drift)
// ---------------------------------------------------------------------------

/**
 * Article versions that can be the law in force today; the [DATE_DEBUT,
 * DATE_FIN) validity window makes the final call:
 *   - VIGUEUR      — in force;
 *   - ABROGE_DIFF  — DEFERRED repeal: the version stays in force until its
 *                    DATE_FIN (review finding parser.ts:189 — excluding these
 *                    silently dropped in-force law, e.g. Code pénal art
 *                    222-22, repealed effective 2029-01-01).
 */
export const SERVABLE_ARTICLE_ETATS: ReadonlySet<string> = new Set(['VIGUEUR', 'ABROGE_DIFF']);

/**
 * Versions that are deliberately NOT current law under this article number.
 * Vocabulary verified against the full 2026-06 corpus (stamp 20260610-214017):
 *   MODIFIE          — superseded by a later version (window closed);
 *   ABROGE           — repealed (effective);
 *   VIGUEUR_DIFF     — enters force at a FUTURE date;
 *   TRANSFERE        — moved to another code/text;
 *   DEPLACE          — moved within the text;
 *   PERIME           — lapsed;
 *   ANNULE           — annulled;
 *   DISJOINT         — disjoined (struck from the enacting text);
 *   MORT_NE          — never entered force;
 *   MODIFIE_MORT_NE  — modification that never entered force.
 * Any ETAT outside SERVABLE + EXCLUDED fails loud (vocabulary drift must
 * never silently drop law).
 */
export const EXCLUDED_ARTICLE_ETATS: ReadonlySet<string> = new Set([
  'MODIFIE',
  'ABROGE',
  'VIGUEUR_DIFF',
  'TRANSFERE',
  'DEPLACE',
  'PERIME',
  'ANNULE',
  'DISJOINT',
  'MORT_NE',
  'MODIFIE_MORT_NE',
]);

// ---------------------------------------------------------------------------
// Article number normalization
// ---------------------------------------------------------------------------

/**
 * Normalize French article numbering for consistent storage and lookup.
 *
 * Input formats:
 *   "L. 323-1"     -> "L323-1"
 *   "L.323-1"      -> "L323-1"
 *   "L323-1"       -> "L323-1"
 *   "R.* 2321-1"   -> "R2321-1"
 *   "D. 98-206"    -> "D98-206"
 *   "323-1"         -> "323-1"
 */
export function normalizeArticleNum(raw: string): string {
  if (!raw) return '';

  return raw
    .replace(/^(L|R|D|A)\.\s*/i, '$1')   // "L. " or "L." -> "L"
    .replace(/^(L|R|D|A)\*\s*/i, '$1')   // "R*" -> "R"
    .replace(/\s+/g, '')                   // remove interior whitespace
    .trim();
}

/**
 * Build a human-readable article title from the normalized number.
 */
export function articleTitle(num: string): string {
  const normalized = normalizeArticleNum(num);
  const prefixMatch = normalized.match(/^([LRDA])(\d)/i);

  if (prefixMatch) {
    const prefix = prefixMatch[1].toUpperCase();
    const rest = normalized.slice(1);
    const prefixNames: Record<string, string> = {
      L: 'L.',
      R: 'R.',
      D: 'D.',
      A: 'A.',
    };
    return `Article ${prefixNames[prefix] ?? prefix} ${rest}`;
  }

  return `Article ${normalized}`;
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/**
 * Parse LEGI date format (YYYYMMDD or YYYY-MM-DD) to an ISO date string.
 *
 * Year-2999 dates are returned LITERALLY: their meaning depends on the bound
 * (review finding parser.ts:131). A 2999 DATE_FIN means "open-ended" — use
 * parseLegiDateOpenEnded for that bound. A 2999 DATE_DEBUT marks a
 * never-in-force (mort-né/annulled) version; mapping it to undefined would
 * invert it into "in force since forever".
 */
export function parseLegiDate(raw: string | number | undefined): string | undefined {
  if (!raw) return undefined;

  const s = String(raw).trim();

  // ISO date format: YYYY-MM-DD (used in current LEGI archives)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  // Compact format: YYYYMMDD (legacy)
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  return undefined;
}

/**
 * Parse a LEGI END date: year-2999 explicitly means "open-ended" and maps to
 * undefined. Only valid for DATE_FIN-shaped bounds.
 */
export function parseLegiDateOpenEnded(raw: string | number | undefined): string | undefined {
  const parsed = parseLegiDate(raw);
  if (parsed !== undefined && parsed.startsWith('2999')) return undefined;
  return parsed;
}

// ---------------------------------------------------------------------------
// HTML/XML content cleanup
// ---------------------------------------------------------------------------

export function stripHtml(html: string): string {
  if (!html) return '';

  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// XML Parser
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name: string) => ['ARTICLE', 'SECTION_TA'].includes(name),
  trimValues: true,
});

/**
 * Parse LEGI XML text and extract servable article versions (deliberate ETAT
 * vocabulary, fail-loud on unknown ETAT, loud accounting of versions dropped
 * for a missing NUM or an empty body — review findings parser.ts:189/:286).
 */
export function parseLegiXml(xmlText: string): ParseResult {
  const articles: ParsedArticle[] = [];
  const errors: string[] = [];
  let articleNodesSeen = 0;
  let servableVersions = 0;
  let missingNumVersions = 0;
  let emptyBodyVersions = 0;

  try {
    const parsed = xmlParser.parse(xmlText);

    // Navigate various possible root structures
    const articleNodes = findArticleNodes(parsed);
    articleNodesSeen = articleNodes.length;

    for (const artNode of articleNodes) {
      try {
        const outcome = extractArticle(artNode);
        switch (outcome.kind) {
          case 'servable':
            servableVersions++;
            articles.push(outcome.article);
            break;
          case 'missing_num':
            servableVersions++;
            missingNumVersions++;
            break;
          case 'empty_body':
            servableVersions++;
            emptyBodyVersions++;
            break;
          case 'excluded_etat':
            break;
        }
      } catch (err) {
        errors.push(`Error parsing article: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`XML parse error: ${(err as Error).message}`);
  }

  return { articles, errors, articleNodesSeen, servableVersions, missingNumVersions, emptyBodyVersions };
}

/**
 * Recursively find all ARTICLE nodes in the parsed XML tree.
 */
function findArticleNodes(obj: unknown, depth = 0): unknown[] {
  if (!obj || typeof obj !== 'object' || depth > 20) return [];

  const results: unknown[] = [];
  const record = obj as Record<string, unknown>;

  if (record.ARTICLE) {
    const arts = Array.isArray(record.ARTICLE) ? record.ARTICLE : [record.ARTICLE];
    results.push(...arts);
  }

  // Recurse into child elements
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ARTICLE') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        results.push(...findArticleNodes(item, depth + 1));
      }
    } else if (typeof value === 'object' && value !== null) {
      results.push(...findArticleNodes(value, depth + 1));
    }
  }

  return results;
}

/**
 * Recursively extract text content from a parsed XML node.
 * Handles strings, arrays, objects with #text, and nested structures.
 */
function extractTextContent(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);

  if (Array.isArray(node)) {
    return node.map(extractTextContent).join('\n\n');
  }

  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    // If it has #text, use that
    if (record['#text'] !== undefined) return String(record['#text']);
    // Otherwise concatenate all child text content
    return Object.values(record)
      .filter((v) => typeof v !== 'string' || !v.startsWith('@_'))
      .map(extractTextContent)
      .filter(Boolean)
      .join('\n\n');
  }

  return '';
}

type ExtractOutcome =
  | { kind: 'servable'; article: ParsedArticle }
  | { kind: 'excluded_etat'; etat: string }
  | { kind: 'missing_num' }
  | { kind: 'empty_body' };

/**
 * Classify a single ARTICLE XML node. Throws on an ETAT outside the mapped
 * vocabulary (including missing) — vocabulary drift must fail loud, never
 * silently drop law.
 */
function extractArticle(node: unknown): ExtractOutcome {
  if (!node || typeof node !== 'object') {
    throw new Error('ARTICLE node is not an object');
  }
  const art = node as Record<string, unknown>;

  // Navigate META structure
  const meta = art.META as Record<string, unknown> | undefined;
  const metaCommun = meta?.META_COMMUN as Record<string, unknown> | undefined;
  const metaSpec = meta?.META_SPEC as Record<string, unknown> | undefined;
  // LEGI XML uses META_ARTICLE (not META_ART as some docs suggest)
  const metaArt = (metaSpec?.META_ARTICLE ?? metaSpec?.META_ART) as Record<string, unknown> | undefined;

  const id = String(metaCommun?.ID ?? art['@_id'] ?? '');
  const num = String(metaArt?.NUM ?? '');
  const etatRaw = metaArt?.ETAT;
  const etat = etatRaw === undefined || etatRaw === null ? '' : String(etatRaw);
  const dateDebut = metaArt?.DATE_DEBUT;
  const dateFin = metaArt?.DATE_FIN;

  if (!SERVABLE_ARTICLE_ETATS.has(etat)) {
    if (EXCLUDED_ARTICLE_ETATS.has(etat)) {
      return { kind: 'excluded_etat', etat };
    }
    throw new Error(
      `Article ${id || '<no id>'} carries ${etat ? `unknown ETAT '${etat}'` : 'NO ETAT'} — ` +
        'outside the mapped DILA vocabulary, refusing to classify silently',
    );
  }

  if (!num) return { kind: 'missing_num' };

  // Extract content — CONTENU may be a string or an object (when it contains HTML tags)
  const blocTextuel = art.BLOC_TEXTUEL as Record<string, unknown> | undefined;
  const contenu = blocTextuel?.CONTENU;
  const rawContent = extractTextContent(contenu);
  const content = stripHtml(rawContent);

  if (!content) return { kind: 'empty_body' };

  const normalizedNum = normalizeArticleNum(num);

  return {
    kind: 'servable',
    article: {
      id,
      num,
      normalizedNum,
      title: articleTitle(num),
      content,
      dateDebut: parseLegiDate(dateDebut as string | number | undefined),
      dateFin: parseLegiDateOpenEnded(dateFin as string | number | undefined),
      etat,
    },
  };
}

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
  /** Articles with ETAT=VIGUEUR (the only versions servable as current law). */
  articles: ParsedArticle[];
  errors: string[];
  /**
   * Total ARTICLE nodes seen before the VIGUEUR filter. Lets callers tell
   * "text wholly out of force" (nodes seen, none VIGUEUR) apart from
   * "nothing parsed at all" — the two must not be conflated (issue #97).
   */
  articleNodesSeen: number;
}

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
 * Parse LEGI date format (YYYYMMDD) to ISO date string.
 */
export function parseLegiDate(raw: string | number | undefined): string | undefined {
  if (!raw) return undefined;

  const s = String(raw).trim();

  // ISO date format: YYYY-MM-DD (used in current LEGI archives)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (s.startsWith('2999')) return undefined; // "no end date"
    return s;
  }

  // Compact format: YYYYMMDD (legacy)
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    const year = s.slice(0, 4);
    const month = s.slice(4, 6);
    const day = s.slice(6, 8);
    if (year === '2999') return undefined;
    return `${year}-${month}-${day}`;
  }

  return undefined;
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
 * Parse LEGI XML text and extract in-force articles.
 */
export function parseLegiXml(xmlText: string): ParseResult {
  const articles: ParsedArticle[] = [];
  const errors: string[] = [];
  let articleNodesSeen = 0;

  try {
    const parsed = xmlParser.parse(xmlText);

    // Navigate various possible root structures
    const articleNodes = findArticleNodes(parsed);
    articleNodesSeen = articleNodes.length;

    for (const artNode of articleNodes) {
      try {
        const article = extractArticle(artNode);
        if (article && article.etat === 'VIGUEUR') {
          articles.push(article);
        }
      } catch (err) {
        errors.push(`Error parsing article: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    errors.push(`XML parse error: ${(err as Error).message}`);
  }

  return { articles, errors, articleNodesSeen };
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

/**
 * Extract a ParsedArticle from a single ARTICLE XML node.
 */
function extractArticle(node: unknown): ParsedArticle | null {
  if (!node || typeof node !== 'object') return null;
  const art = node as Record<string, unknown>;

  // Navigate META structure
  const meta = art.META as Record<string, unknown> | undefined;
  const metaCommun = meta?.META_COMMUN as Record<string, unknown> | undefined;
  const metaSpec = meta?.META_SPEC as Record<string, unknown> | undefined;
  // LEGI XML uses META_ARTICLE (not META_ART as some docs suggest)
  const metaArt = (metaSpec?.META_ARTICLE ?? metaSpec?.META_ART) as Record<string, unknown> | undefined;

  const id = String(metaCommun?.ID ?? art['@_id'] ?? '');
  const num = String(metaArt?.NUM ?? '');
  const etat = String(metaArt?.ETAT ?? '');
  const dateDebut = metaArt?.DATE_DEBUT;
  const dateFin = metaArt?.DATE_FIN;

  // Extract content — CONTENU may be a string or an object (when it contains HTML tags)
  const blocTextuel = art.BLOC_TEXTUEL as Record<string, unknown> | undefined;
  const contenu = blocTextuel?.CONTENU;
  const rawContent = extractTextContent(contenu);
  const content = stripHtml(rawContent);

  if (!content || !num) return null;

  const normalizedNum = normalizeArticleNum(num);

  return {
    id,
    num,
    normalizedNum,
    title: articleTitle(num),
    content,
    dateDebut: parseLegiDate(dateDebut as string | number | undefined),
    dateFin: parseLegiDate(dateFin as string | number | undefined),
    etat,
  };
}

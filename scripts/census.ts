#!/usr/bin/env tsx
/**
 * Census script for French Law MCP.
 *
 * Enumerates ALL codes and consolidated laws (TNC) from the DILA LEGI
 * open data archive.  Writes data/census.json in golden standard format.
 *
 * Strategy:
 *   1. Resolve the newest LEGI global archive + every incremental delta from
 *      the live DILA index (issue #97 — never a hardcoded archive), download,
 *      extract, apply deltas, stamp the corpus identity marker
 *   2. Walk the extracted directory tree to discover:
 *      a) All codes  (code_en_vigueur/LEGI/TEXT/...)
 *      b) All TNC — textes non codifiés (TNC_en_vigueur/JORF/TEXT/...)
 *   3. Select each text's TEXTE_VERSION by validity window (NOT files[0])
 *   4. Count article XML files per text
 *   5. Write data/census.json, stamped with the source archive identity
 *
 * Usage:
 *   npx tsx scripts/census.ts
 *   npx tsx scripts/census.ts --extracted /tmp/legi-cache/extracted
 *   npx tsx scripts/census.ts --archive /path/to/archive.tar.gz
 *   npx tsx scripts/census.ts --codes-only         # Skip TNC (laws)
 *   npx tsx scripts/census.ts --allow-unstamped    # accept an unprovable corpus (loud)
 *
 * Data source: https://echanges.dila.gouv.fr/OPENDATA/LEGI/
 * Licence: Licence Ouverte v2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { resolveCorpus } from './lib/legi-acquire.js';
import { selectTexteVersion } from './lib/texte-version.js';
import { assertCensusFloors } from './lib/corpus-gates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.resolve(__dirname, '../data');
const CENSUS_PATH = path.join(DATA_DIR, 'census.json');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  archive?: string;
  extracted?: string;
  codesOnly: boolean;
  allowUnstamped: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let archive: string | undefined;
  let extracted: string | undefined;
  let codesOnly = false;
  let allowUnstamped = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--archive' && args[i + 1]) { archive = args[i + 1]; i++; }
    else if (args[i] === '--extracted' && args[i + 1]) { extracted = args[i + 1]; i++; }
    else if (args[i] === '--codes-only') { codesOnly = true; }
    else if (args[i] === '--allow-unstamped') { allowUnstamped = true; }
  }
  return { archive, extracted, codesOnly, allowUnstamped };
}

/**
 * Walk-error accounting (PR #98 review finding census.ts:76): readdir
 * failures during the walk mean files vanished or became unreadable while
 * the census ran. They are COUNTED and gated (assertCensusFloors requires
 * zero), never swallowed into a silently smaller universe.
 */
interface WalkErrorCounter {
  count: number;
}

/**
 * Count article XML files under a text directory.
 */
function countArticleFiles(textDir: string, walkErrors: WalkErrorCounter): number {
  let count = 0;
  const walk = (dir: string) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { walkErrors.count++; return; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Only walk into 'article' directories and their children
        walk(fp);
      } else if (entry.name.startsWith('LEGIARTI') && entry.name.endsWith('.xml')) {
        count++;
      }
    }
  };
  walk(textDir);
  return count;
}

/**
 * Find all TEXTE directories under a base path.
 * Returns an array of { dir, textId } where textId is the LEGITEXT/JORFTEXT folder name.
 */
function findTextDirectories(
  baseDir: string,
  walkErrors: WalkErrorCounter,
): Array<{ dir: string; textId: string }> {
  const results: Array<{ dir: string; textId: string }> = [];

  if (!fs.existsSync(baseDir)) return results;

  // Walk up to the TEXT level, then look for LEGITEXT*/JORFTEXT* dirs
  const walkForTexts = (dir: string, depth: number) => {
    if (depth > 12) return; // safety guard
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { walkErrors.count++; return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const fp = path.join(dir, name);

      if (name.startsWith('LEGITEXT') || name.startsWith('JORFTEXT')) {
        results.push({ dir: fp, textId: name });
      } else {
        walkForTexts(fp, depth + 1);
      }
    }
  };

  walkForTexts(baseDir, 0);
  return results;
}

// ---------------------------------------------------------------------------
// Census entry
// ---------------------------------------------------------------------------

interface CensusLaw {
  id: string;
  title: string;
  title_en: string | null;
  identifier: string;
  url: string | null;
  /**
   * in_force | amended | repealed | not_yet_in_force | unknown.
   * 'unknown' = no parseable TEXTE_VERSION metadata — a FACT, never a
   * fabricated in_force (review finding ingest-legi.ts:375).
   */
  status: string;
  /** Scheduled repeal date for deferred repeals (text-level ABROGE_DIFF). */
  repeal_date: string | null;
  category: string;
  classification: 'ingestable' | 'inaccessible' | 'metadata_only';
  classification_reason: string;
  ingested: boolean;
  provision_count: number;
  ingestion_date: string | null;
}

interface CensusSourceArchive {
  base: string;
  base_stamp: string;
  deltas_applied: number;
  last_delta: string | null;
  source_stamp: string;
  acquired_at: string;
}

interface CensusOutput {
  schema_version: string;
  jurisdiction: string;
  jurisdiction_name: string;
  portal: string;
  census_date: string;
  agent: string;
  source_archive: CensusSourceArchive;
  summary: {
    total_laws: number;
    total_provisions: number;
    ingestable: number;
    ocr_needed: number;
    inaccessible: number;
    excluded: number;
  };
  laws: CensusLaw[];
}

function textIdToUrl(textId: string): string | null {
  if (textId.startsWith('LEGITEXT')) {
    return `https://www.legifrance.gouv.fr/codes/texte_lc/${textId}/`;
  } else if (textId.startsWith('JORFTEXT')) {
    return `https://www.legifrance.gouv.fr/loda/id/${textId}`;
  }
  return null;
}

/**
 * Well-known LEGITEXT IDs to stable document IDs.
 * These match the IDs established in the original seed data
 * and are referenced by eu-references.json.
 */
const WELL_KNOWN_IDS: Record<string, string> = {
  // Only IDs verified from the original ingest-legi.ts TARGET_CODES
  'LEGITEXT000006070719': 'code-penal',
  'LEGITEXT000006070721': 'code-civil',
  'LEGITEXT000005634379': 'code-commerce',
  'LEGITEXT000006071307': 'code-defense',
  'LEGITEXT000006070987': 'code-postes-telecom',
  'LEGITEXT000025503132': 'code-securite-interieure',
  'LEGITEXT000006072050': 'code-travail',
  'LEGITEXT000006068624': 'loi-informatique-libertes',
  'JORFTEXT000000886460': 'loi-informatique-libertes',
};

function textIdToDocumentId(textId: string, _title: string): string {
  // Use well-known mapping if available (established codes referenced by EU data)
  if (WELL_KNOWN_IDS[textId]) return WELL_KNOWN_IDS[textId];

  // Use the LEGI identifier (LEGITEXT/JORFTEXT number) as the document ID.
  // These are guaranteed unique across the entire DILA corpus.
  // Title-derived slugs cause massive collisions (e.g. 226 "arrete-du-6-octobre-2021").
  return textId.toLowerCase();
}

function categorizeText(nature: string | undefined, title: string): string {
  const n = (nature ?? '').toUpperCase();
  const t = title.toLowerCase();

  if (n === 'CODE' || t.startsWith('code ')) return 'code';
  if (n === 'LOI' || t.includes('loi n')) return 'loi';
  if (n === 'ORDONNANCE') return 'ordonnance';
  if (n === 'DECRET' || n === 'DÉCRET') return 'decret';
  if (t.includes('convention')) return 'convention';
  return 'other';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { archive, extracted, codesOnly, allowUnstamped } = parseArgs();

  console.log('=== French Law MCP — Census ===\n');

  // Acquire the CURRENT corpus: newest global + all incremental deltas,
  // resolved at runtime from the DILA index, identity-stamped.
  const { extractDir, identity } = await resolveCorpus({ archive, extracted, allowUnstamped });
  const today = new Date().toISOString().split('T')[0];

  // Discover all texts
  const codesBaseDir = path.join(extractDir, 'legi/global/code_et_TNC_en_vigueur/code_en_vigueur');
  const tncBaseDir = path.join(extractDir, 'legi/global/code_et_TNC_en_vigueur/TNC_en_vigueur');
  const walkErrors: WalkErrorCounter = { count: 0 };

  console.log('\nScanning for codes...');
  const codeTexts = findTextDirectories(codesBaseDir, walkErrors);
  console.log(`  Found ${codeTexts.length} code text directories`);

  let tncTexts: Array<{ dir: string; textId: string }> = [];
  if (!codesOnly) {
    console.log('Scanning for TNC (consolidated laws)...');
    tncTexts = findTextDirectories(tncBaseDir, walkErrors);
    console.log(`  Found ${tncTexts.length} TNC text directories`);
  }

  const allTexts = [...codeTexts, ...tncTexts];
  console.log(`\nTotal texts to process: ${allTexts.length}`);

  // Process each text
  const laws: CensusLaw[] = [];
  let totalArticles = 0;
  let processed = 0;
  let metadataMissing = 0;
  const metadataMissingSamples: string[] = [];

  for (const { dir, textId } of allTexts) {
    processed++;
    if (processed % 100 === 0) {
      console.log(`  Processing ${processed}/${allTexts.length}...`);
    }

    // Validity-aware TEXTE_VERSION selection (issue #97: files[0] picked the
    // first alphabetical version file — usually the OLDEST version).
    const metadata = selectTexteVersion(dir, today);
    if (metadata === null) {
      metadataMissing++;
      if (metadataMissingSamples.length < 10) metadataMissingSamples.push(textId);
    }

    const articleCount = countArticleFiles(dir, walkErrors);
    totalArticles += articleCount;

    const title = metadata?.title ?? textId;
    const docId = textIdToDocumentId(textId, title);
    const category = categorizeText(metadata?.nature, title);
    // No metadata = status UNKNOWN. Fabricating 'in_force' for an unreadable
    // text mis-states the law (review finding ingest-legi.ts:375).
    const status = metadata?.status ?? 'unknown';
    // Deferred repeal (text-level ABROGE_DIFF): in force today, repeal
    // scheduled at dateFin — record the date (review finding texte-version.ts:69).
    const repealDate = metadata?.etat === 'ABROGE_DIFF' && metadata.dateFin ? metadata.dateFin : null;

    // Classify
    let classification: 'ingestable' | 'inaccessible' | 'metadata_only' = 'ingestable';
    let classificationReason = 'Available in LEGI archive with XML articles';
    if (articleCount === 0) {
      classification = 'metadata_only';
      classificationReason = 'No article XML files found in archive';
    } else if (metadata === null) {
      classificationReason = 'Available in LEGI archive with XML articles (no parseable TEXTE_VERSION metadata)';
    }

    laws.push({
      id: docId,
      title,
      title_en: null,
      identifier: textId,
      url: textIdToUrl(textId),
      status,
      repeal_date: repealDate,
      category,
      classification,
      classification_reason: classificationReason,
      ingested: false,
      provision_count: articleCount,
      ingestion_date: null,
    });
  }

  // Sanity floors over the walked tree (review finding census.ts:76): the
  // identity marker certifies provenance, not integrity. A partial/vanished
  // tree must fail the census, never produce a smaller "valid" one.
  assertCensusFloors({
    codes: codeTexts.length,
    totalTexts: allTexts.length,
    totalArticleFiles: totalArticles,
    walkErrors: walkErrors.count,
    codesOnly,
  });

  // Sort: codes first, then by title
  laws.sort((a, b) => {
    if (a.category === 'code' && b.category !== 'code') return -1;
    if (a.category !== 'code' && b.category === 'code') return 1;
    return a.title.localeCompare(b.title, 'fr');
  });

  // Build summary
  const ingestable = laws.filter(l => l.classification === 'ingestable').length;
  const metadataOnly = laws.filter(l => l.classification === 'metadata_only').length;

  const census: CensusOutput = {
    schema_version: '1.0',
    jurisdiction: 'FR',
    jurisdiction_name: 'France',
    portal: 'https://www.legifrance.gouv.fr',
    census_date: today,
    agent: 'census.ts',
    source_archive: {
      base: identity.base,
      base_stamp: identity.base_stamp,
      deltas_applied: identity.deltas_applied.length,
      last_delta: identity.deltas_applied.at(-1) ?? null,
      source_stamp: identity.source_stamp,
      acquired_at: identity.updated_at,
    },
    summary: {
      total_laws: laws.length,
      total_provisions: totalArticles,
      ingestable,
      ocr_needed: 0,
      inaccessible: 0,
      excluded: metadataOnly,
    },
    laws,
  };

  // Write census
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CENSUS_PATH, JSON.stringify(census, null, 2), 'utf-8');

  console.log(`\n=== Census Summary ===`);
  console.log(`Source corpus: ${identity.base} + ${identity.deltas_applied.length} deltas (stamp ${identity.source_stamp})`);
  console.log(`Total texts: ${laws.length}`);
  console.log(`  Codes: ${laws.filter(l => l.category === 'code').length}`);
  console.log(`  Lois: ${laws.filter(l => l.category === 'loi').length}`);
  console.log(`  Ordonnances: ${laws.filter(l => l.category === 'ordonnance').length}`);
  console.log(`  Decrets: ${laws.filter(l => l.category === 'decret').length}`);
  console.log(`  Other: ${laws.filter(l => l.category === 'other').length}`);
  console.log(`Total article files: ${totalArticles}`);
  console.log(`Ingestable: ${ingestable}`);
  console.log(`Metadata only (no articles): ${metadataOnly}`);
  if (metadataMissing > 0) {
    console.log(
      `WARNING: ${metadataMissing} texts had no parseable TEXTE_VERSION metadata ` +
        `(title fell back to the text id, status recorded as 'unknown'). ` +
        `Samples: ${metadataMissingSamples.join(', ')}`,
    );
  }
  console.log(`\nWritten: ${CENSUS_PATH}`);
}

main().catch(err => {
  console.error('Census failed:', err);
  process.exit(1);
});

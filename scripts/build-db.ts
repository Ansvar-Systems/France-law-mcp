#!/usr/bin/env tsx
/**
 * Database builder for French Law MCP.
 *
 * Builds the SQLite database from seed JSON files in data/seed/.
 *
 * Usage: npm run build:db
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dedupeProvisionSeeds } from './lib/version-select.js';
import { verifySeedsAgainstCensus, type CensusSourceArchive } from './lib/corpus-gates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_DIR = path.resolve(__dirname, '../data/seed');
const DB_PATH = path.resolve(__dirname, '../data/database.db');
const CENSUS_PATH = path.resolve(__dirname, '../data/census.json');

// ---------------------------------------------------------------------------
// Seed file types
// ---------------------------------------------------------------------------

interface DocumentSeed {
  id: string;
  type: 'statute';
  title: string;
  title_en?: string;
  short_name?: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issued_date?: string;
  in_force_date?: string;
  url?: string;
  description?: string;
  provisions?: ProvisionSeed[];
}

interface ProvisionSeed {
  provision_ref: string;
  chapter?: string;
  section: string;
  title?: string;
  content: string;
  valid_from?: string;
  valid_to?: string;
}

interface EUDocumentSeed {
  id: string;
  type: 'directive' | 'regulation';
  year: number;
  number: number;
  community?: string;
  celex_number?: string;
  title?: string;
  short_name?: string;
  url_eur_lex?: string;
  in_force?: boolean;
  amended_by?: string;
  repeals?: string;
}

interface EUReferenceSeed {
  source_type: 'provision' | 'document';
  source_id: string;
  document_id: string;
  provision_ref?: string;
  eu_document_id: string;
  eu_article?: string;
  reference_type: string;
  reference_context?: string;
  full_citation?: string;
  is_primary_implementation?: boolean;
  implementation_status?: string;
}

interface EUSeedData {
  eu_documents: EUDocumentSeed[];
  eu_references: EUReferenceSeed[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
-- Legal documents (French codes and laws)
CREATE TABLE legal_documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'statute',
  title TEXT NOT NULL,
  title_en TEXT,
  short_name TEXT,
  status TEXT NOT NULL DEFAULT 'in_force'
    CHECK(status IN ('in_force', 'amended', 'repealed', 'not_yet_in_force')),
  issued_date TEXT,
  in_force_date TEXT,
  url TEXT,
  description TEXT,
  last_updated TEXT DEFAULT (datetime('now'))
);

-- Individual provisions (articles) from codes/laws
CREATE TABLE legal_provisions (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES legal_documents(id),
  provision_ref TEXT NOT NULL,
  chapter TEXT,
  section TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  order_index INTEGER,
  valid_from TEXT,
  valid_to TEXT,
  UNIQUE(document_id, provision_ref)
);

CREATE INDEX idx_provisions_doc ON legal_provisions(document_id);
CREATE INDEX idx_provisions_chapter ON legal_provisions(document_id, chapter);

-- FTS5 for full-text search on provisions
CREATE VIRTUAL TABLE provisions_fts USING fts5(
  content, title,
  content='legal_provisions',
  content_rowid='id',
  tokenize='unicode61'
);

-- FTS5 sync triggers
CREATE TRIGGER provisions_ai AFTER INSERT ON legal_provisions BEGIN
  INSERT INTO provisions_fts(rowid, content, title)
  VALUES (new.id, new.content, new.title);
END;

CREATE TRIGGER provisions_ad AFTER DELETE ON legal_provisions BEGIN
  INSERT INTO provisions_fts(provisions_fts, rowid, content, title)
  VALUES ('delete', old.id, old.content, old.title);
END;

CREATE TRIGGER provisions_au AFTER UPDATE ON legal_provisions BEGIN
  INSERT INTO provisions_fts(provisions_fts, rowid, content, title)
  VALUES ('delete', old.id, old.content, old.title);
  INSERT INTO provisions_fts(rowid, content, title)
  VALUES (new.id, new.content, new.title);
END;

-- EU Documents (directives and regulations)
CREATE TABLE eu_documents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('directive', 'regulation')),
  year INTEGER NOT NULL CHECK (year >= 1957 AND year <= 2100),
  number INTEGER NOT NULL CHECK (number > 0),
  community TEXT CHECK (community IN ('EU', 'EG', 'EEG', 'Euratom', 'CE')),
  celex_number TEXT,
  title TEXT,
  short_name TEXT,
  url_eur_lex TEXT,
  in_force BOOLEAN DEFAULT 1,
  amended_by TEXT,
  repeals TEXT,
  last_updated TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_eu_documents_type_year ON eu_documents(type, year DESC);

-- EU References (links French law provisions to EU directives/regulations)
CREATE TABLE eu_references (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('provision', 'document')),
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES legal_documents(id),
  provision_id INTEGER REFERENCES legal_provisions(id),
  eu_document_id TEXT NOT NULL REFERENCES eu_documents(id),
  eu_article TEXT,
  reference_type TEXT NOT NULL CHECK (reference_type IN (
    'implements', 'supplements', 'applies', 'references', 'complies_with',
    'derogates_from', 'amended_by', 'repealed_by'
  )),
  reference_context TEXT,
  full_citation TEXT,
  is_primary_implementation BOOLEAN DEFAULT 0,
  implementation_status TEXT CHECK (implementation_status IN ('complete', 'partial', 'pending', 'unknown')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_eu_references_document ON eu_references(document_id, eu_document_id);
CREATE INDEX idx_eu_references_eu_document ON eu_references(eu_document_id, document_id);

-- Views for common queries
CREATE VIEW v_eu_implementations AS
SELECT
  ed.id AS eu_document_id,
  ed.type,
  ed.year,
  ed.number,
  ed.title,
  ed.short_name,
  ld.id AS french_law_id,
  ld.title AS french_title,
  ld.short_name AS french_short_name,
  er.reference_type,
  er.is_primary_implementation,
  er.implementation_status
FROM eu_documents ed
JOIN eu_references er ON ed.id = er.eu_document_id
JOIN legal_documents ld ON er.document_id = ld.id
WHERE ed.type = 'directive'
ORDER BY ed.year DESC, ed.number, ld.id;

-- Build metadata
CREATE TABLE db_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Dedupe by provision_ref: newest valid_from wins; content length is the
// legacy fallback for unstamped seeds (issue #97 — keep-longest could revert
// an amendment that shortened an article). Lives in scripts/lib/version-select.ts.

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function buildDatabase(): void {
  console.log('Building French Law MCP database...\n');

  // Build gate (review findings build-db.ts:282 and :408): refuse an empty or
  // shrunken seed set, refuse seeds the census does not claim, refuse a
  // source stamp the seeds do not actually carry. Runs BEFORE the existing
  // database is touched — a failing gate leaves the previous build intact.
  const gate = verifySeedsAgainstCensus({ censusPath: CENSUS_PATH, seedDir: SEED_DIR });
  console.log(
    `Seed/census cross-check passed: ${gate.stampedSeedCount} ingest-stamped seed(s) at stamp ` +
      `${gate.sourceArchive?.source_stamp ?? 'unstamped'}, ${gate.manualSeedCount} manual seed(s).`,
  );

  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }

  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = DELETE');  // Required for node-sqlite3-wasm compatibility

  db.exec(SCHEMA);

  // Prepared statements
  const insertDoc = db.prepare(`
    INSERT INTO legal_documents (id, type, title, title_en, short_name, status, issued_date, in_force_date, url, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertProvision = db.prepare(`
    INSERT INTO legal_provisions (document_id, provision_ref, chapter, section, title, content, order_index, valid_from, valid_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEUDocument = db.prepare(`
    INSERT INTO eu_documents (id, type, year, number, community, celex_number, title, short_name, url_eur_lex, in_force, amended_by, repeals)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEUReference = db.prepare(`
    INSERT INTO eu_references (source_type, source_id, document_id, provision_id, eu_document_id, eu_article, reference_type, reference_context, full_citation, is_primary_implementation, implementation_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Seed files come from the gate — already verified non-empty and
  // census-consistent. The old "empty schema" success paths are gone: an
  // empty database stamped 'current' is never a valid build artifact.
  const seedFiles = gate.seedFiles;

  let totalDocs = 0;
  let totalProvisions = 0;

  const loadAll = db.transaction(() => {
    // Load document seed files
    for (const file of seedFiles) {
      const filePath = path.join(SEED_DIR, file);
      console.log(`  Loading ${file}...`);

      const content = fs.readFileSync(filePath, 'utf-8');
      const seed = JSON.parse(content) as DocumentSeed;

      insertDoc.run(
        seed.id, seed.type ?? 'statute', seed.title, seed.title_en ?? null,
        seed.short_name ?? null, seed.status,
        seed.issued_date ?? null, seed.in_force_date ?? null,
        seed.url ?? null, seed.description ?? null
      );
      totalDocs++;

      const provisions = dedupeProvisionSeeds(seed.provisions ?? []);

      for (let i = 0; i < provisions.length; i++) {
        const prov = provisions[i];
        insertProvision.run(
          seed.id, prov.provision_ref, prov.chapter ?? null,
          prov.section, prov.title ?? null, prov.content,
          i + 1, prov.valid_from ?? null, prov.valid_to ?? null
        );
        totalProvisions++;
      }

      console.log(`    ${provisions.length} provisions`);
    }

    // Load EU references
    const euRefsPath = path.join(SEED_DIR, 'eu-references.json');
    if (fs.existsSync(euRefsPath)) {
      console.log('  Loading EU references...');
      const euData = JSON.parse(fs.readFileSync(euRefsPath, 'utf-8')) as EUSeedData;

      for (const doc of euData.eu_documents) {
        if (doc.year < 1957 || doc.year > 2100) {
          console.log(`    WARNING: Skipping ${doc.id} — invalid year ${doc.year}`);
          continue;
        }

        insertEUDocument.run(
          doc.id, doc.type, doc.year, doc.number,
          doc.community ?? null, doc.celex_number ?? null,
          doc.title ?? null, doc.short_name ?? null,
          doc.url_eur_lex ?? null,
          (doc.in_force ?? true) ? 1 : 0,
          doc.amended_by ?? null, doc.repeals ?? null
        );
      }
      console.log(`    ${euData.eu_documents.length} EU documents`);

      // Build provision_id lookup
      const provisionIdMap = new Map<string, number>();
      const provRows = db.prepare('SELECT id, document_id, provision_ref FROM legal_provisions').all() as Array<{ id: number; document_id: string; provision_ref: string }>;
      for (const row of provRows) {
        provisionIdMap.set(`${row.document_id}:${row.provision_ref}`, row.id);
      }

      let insertedRefs = 0;
      for (const ref of euData.eu_references) {
        let provisionId: number | null = null;
        if (ref.source_type === 'provision' && ref.provision_ref) {
          const key = `${ref.document_id}:${ref.provision_ref}`;
          provisionId = provisionIdMap.get(key) ?? null;
        }

        try {
          insertEUReference.run(
            ref.source_type, ref.source_id, ref.document_id,
            provisionId, ref.eu_document_id,
            ref.eu_article ?? null, ref.reference_type,
            ref.reference_context ?? null, ref.full_citation ?? null,
            (ref.is_primary_implementation ?? false) ? 1 : 0,
            ref.implementation_status ?? null
          );
          insertedRefs++;
        } catch (err) {
          console.log(`    ERROR inserting EU reference ${ref.source_id} -> ${ref.eu_document_id}: ${err}`);
        }
      }
      console.log(`    ${insertedRefs} EU references`);
    }
  });

  loadAll();
  writeMetadata(db, gate.sourceArchive);

  db.exec('ANALYZE');
  db.exec('VACUUM');
  db.close();

  const size = fs.statSync(DB_PATH).size;
  console.log(
    `\nBuild complete: ${totalDocs} documents, ${totalProvisions} provisions`
  );
  console.log(`Output: ${DB_PATH} (${(size / 1024).toFixed(1)} KB)`);
}

/**
 * Stamp db_metadata from the gate-verified source identity. The gate
 * guarantees every ingest-stamped seed carries exactly this stamp; `source`
 * is null ONLY for a census-less, manual-only seed set (explicitly unstamped,
 * loudly warned — never a silently swallowed corrupt census; review finding
 * build-db.ts:408).
 */
function writeMetadata(db: Database.Database, source: CensusSourceArchive | null): void {
  if (!source) {
    console.warn(
      'WARNING: manual-only seed set without a census — db_metadata.source_stamp will be ' +
        "'unstamped'. Re-run census + ingest to get a provable corpus version (issue #97).",
    );
  }
  const insertMeta = db.prepare('INSERT OR REPLACE INTO db_metadata (key, value) VALUES (?, ?)');
  const writeMeta = db.transaction(() => {
    insertMeta.run('tier', 'free');
    insertMeta.run('schema_version', '1.0');
    insertMeta.run('jurisdiction', 'FR');
    insertMeta.run('built_at', new Date().toISOString());
    insertMeta.run('builder', 'build-db.ts');
    insertMeta.run('source_base_archive', source?.base ?? 'unstamped');
    insertMeta.run('source_last_delta', source?.last_delta ?? 'none');
    insertMeta.run('source_stamp', source?.source_stamp ?? 'unstamped');
    insertMeta.run('source_acquired_at', source?.acquired_at ?? 'unstamped');
  });
  writeMeta();
}

buildDatabase();

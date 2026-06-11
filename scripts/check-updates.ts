#!/usr/bin/env tsx
/**
 * Check for French law source updates.
 *
 * Compares the corpus source stamp recorded in db_metadata (issue #97:
 * 'source_stamp' = global archive stamp or last applied incremental delta)
 * against the newest archive published on the DILA index — globals AND the
 * daily incremental deltas. The pre-#97 checker only looked at
 * Freemium_legi_global_* names; DILA cuts those rarely (the only one online
 * is from 2025-07-13), so it could never detect the daily law changes.
 *
 * Usage:
 *   npm run check-updates
 *   CHECK_UPDATES_STRICT=1 npm run check-updates
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLegiIndexHtml, latestStamp, parseLegiIndex, stampToIso } from './lib/legi-archive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, '../data/database.db');
const REQUEST_TIMEOUT_MS = 15_000;
const STALE_DAYS_THRESHOLD = 30;
const STRICT_MODE = process.env['CHECK_UPDATES_STRICT'] === '1' || process.env['CI'] === 'true';

interface CheckSummary {
  checked_at: string;
  strict_mode: boolean;
  db_exists: boolean;
  built_at: string | null;
  db_source_stamp: string | null;
  legal_documents: number;
  legal_provisions: number;
  latest_archive_name: string | null;
  latest_archive_timestamp: string | null;
  latest_source_stamp: string | null;
  has_update: boolean;
  stale_days: number | null;
  warnings: string[];
  errors: string[];
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  return Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
}

async function main(): Promise<void> {
  const summary: CheckSummary = {
    checked_at: new Date().toISOString(),
    strict_mode: STRICT_MODE,
    db_exists: fs.existsSync(DB_PATH),
    built_at: null,
    db_source_stamp: null,
    legal_documents: 0,
    legal_provisions: 0,
    latest_archive_name: null,
    latest_archive_timestamp: null,
    latest_source_stamp: null,
    has_update: false,
    stale_days: null,
    warnings: [],
    errors: [],
  };

  console.log('French Law MCP - Update Checker');
  console.log('');

  if (!summary.db_exists) {
    summary.errors.push(`Database not found: ${DB_PATH}`);
    console.log(`ERROR: Database not found: ${DB_PATH}`);
    console.log('Run "npm run build:db" first.');
    printSummary(summary);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  try {
    const builtAtRow = db
      .prepare("SELECT value FROM db_metadata WHERE key = 'built_at'")
      .get() as { value: string } | undefined;
    summary.built_at = toIsoOrNull(builtAtRow?.value);

    const sourceStampRow = db
      .prepare("SELECT value FROM db_metadata WHERE key = 'source_stamp'")
      .get() as { value: string } | undefined;
    summary.db_source_stamp =
      sourceStampRow && sourceStampRow.value !== 'unstamped' ? sourceStampRow.value : null;

    summary.legal_documents = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM legal_documents').get() as { count: number }).count,
    );
    summary.legal_provisions = Number(
      (db.prepare('SELECT COUNT(*) AS count FROM legal_provisions').get() as { count: number }).count,
    );
  } finally {
    db.close();
  }

  if (summary.built_at) {
    summary.stale_days = daysSince(summary.built_at);
    if (summary.stale_days > STALE_DAYS_THRESHOLD) {
      summary.warnings.push(
        `Database is ${summary.stale_days} days old (threshold ${STALE_DAYS_THRESHOLD} days).`,
      );
    }
  } else {
    summary.warnings.push('No "built_at" metadata found in database.');
  }

  console.log(`Database: ${summary.legal_documents} documents, ${summary.legal_provisions} provisions`);
  console.log(`Built at: ${summary.built_at ?? 'unknown'}`);
  console.log(`Corpus source stamp: ${summary.db_source_stamp ?? 'unstamped'}`);

  try {
    const refs = parseLegiIndex(await fetchLegiIndexHtml(REQUEST_TIMEOUT_MS));
    const newest = latestStamp(refs);
    const newestRef = refs.find((r) => r.stamp === newest);
    summary.latest_source_stamp = newest;
    summary.latest_archive_name = newestRef?.name ?? null;
    summary.latest_archive_timestamp = stampToIso(newest);

    // DILA publishes deltas DAILY. A "newest" stamp older than the freshness
    // window means the delta regex stopped matching (index layout drift) —
    // comparing the DB against it would report UP TO DATE forever (PR #98
    // review finding legi-archive.ts:96, path a). Same envelope as a fetch
    // failure: this is a broken source check, not a fresh comparison.
    const staleDays = Math.floor(
      (Date.now() - new Date(stampToIso(newest)).getTime()) / (1000 * 60 * 60 * 24),
    );
    const maxIndexStaleDays = Number(process.env['LEGI_MAX_INDEX_STALENESS_DAYS'] ?? 7);
    if (staleDays > maxIndexStaleDays) {
      throw new Error(
        `Newest archive on the DILA index (${newestRef?.name ?? newest}) is ${staleDays} days old ` +
          `(max ${maxIndexStaleDays}; DILA publishes daily). The index is stale or the archive-name ` +
          'regex no longer matches — the up-to-date comparison would be meaningless.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.errors.push(`Source check failed: ${message}`);
    console.log(`ERROR: ${message}`);

    if (!STRICT_MODE) {
      summary.warnings.push(
        'Non-strict mode: source fetch error does not fail the command. Set CHECK_UPDATES_STRICT=1 to enforce.',
      );
    }

    printSummary(summary);
    process.exit(STRICT_MODE ? 2 : 0);
  }

  console.log(`Latest LEGI archive: ${summary.latest_archive_name} (globals + daily deltas considered)`);
  console.log(`Archive timestamp: ${summary.latest_archive_timestamp ?? 'unknown'}`);

  if (summary.db_source_stamp && summary.latest_source_stamp) {
    // Exact corpus-version comparison: stamps are zero-padded YYYYMMDD-HHMMSS,
    // so lexicographic order is chronological order.
    summary.has_update = summary.latest_source_stamp > summary.db_source_stamp;
  } else if (summary.built_at && summary.latest_archive_timestamp) {
    summary.warnings.push(
      'Database carries no source_stamp (built before issue #97 stamping) — falling back to a ' +
        'built_at comparison, which UNDERSTATES staleness. Rebuild via census + ingest + build:db.',
    );
    summary.has_update =
      new Date(summary.latest_archive_timestamp).getTime() > new Date(summary.built_at).getTime();
  } else {
    summary.has_update = false;
    summary.warnings.push(
      'Could not compare source archive stamp against local database metadata.',
    );
  }

  if (summary.has_update) {
    console.log('');
    console.log('UPDATE AVAILABLE');
    console.log('A newer LEGI archive exists than the corpus the database was built from.');
    console.log('Suggested next steps:');
    console.log('  npm run census');
    console.log('  npm run ingest:legi');
    console.log('  npm run build:db');
  } else {
    console.log('');
    console.log('UP TO DATE');
    console.log('No newer LEGI archive detected.');
  }

  for (const warning of summary.warnings) {
    console.log(`WARNING: ${warning}`);
  }

  printSummary(summary);
  process.exit(summary.has_update ? 1 : 0);
}

function printSummary(summary: CheckSummary): void {
  console.log('');
  console.log(`SUMMARY_JSON: ${JSON.stringify(summary)}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(2);
});

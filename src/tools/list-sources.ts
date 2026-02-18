/**
 * list_sources — Returns provenance metadata for all data sources in the database.
 *
 * Required by the Ansvar Law MCP standard tool set. Allows agents to understand
 * data origins, freshness, and coverage limitations before relying on results.
 */

import type { Database } from '@ansvar/mcp-sqlite';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface ListSourcesInput {
  // No required parameters
}

export interface DataSource {
  name: string;
  authority: string;
  url: string;
  language: string;
  license: string;
  last_ingested: string;
  coverage: {
    codes: number;
    provisions: number;
    scope: string;
    limitations: string;
  };
  eu_references: {
    eu_documents: number;
    eu_references: number;
  };
}

export interface ListSourcesResult {
  jurisdiction: string;
  tier: string;
  schema_version: string;
  built_at: string;
  sources: DataSource[];
}

function safeCount(db: Database, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  } catch {
    return 0;
  }
}

function readMeta(db: Database, key: string): string {
  try {
    const row = db.prepare('SELECT value FROM db_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function listSources(
  db: Database,
  _input: ListSourcesInput,
): Promise<ToolResponse<ListSourcesResult>> {
  const codes = safeCount(db, 'SELECT COUNT(*) as count FROM legal_documents');
  const provisions = safeCount(db, 'SELECT COUNT(*) as count FROM legal_provisions');
  const euDocs = safeCount(db, 'SELECT COUNT(*) as count FROM eu_documents');
  const euRefs = safeCount(db, 'SELECT COUNT(*) as count FROM eu_references');

  return {
    results: {
      jurisdiction: 'FR',
      tier: readMeta(db, 'tier'),
      schema_version: readMeta(db, 'schema_version'),
      built_at: readMeta(db, 'built_at'),
      sources: [
        {
          name: 'Legifrance',
          authority: 'DILA (Direction de l\'information légale et administrative)',
          url: 'https://www.legifrance.gouv.fr',
          language: 'fr',
          license: 'Licence Ouverte v2.0 (French government open data)',
          last_ingested: readMeta(db, 'built_at'),
          coverage: {
            codes,
            provisions,
            scope:
              'Major French codes including Code pénal, Code civil, Code de commerce, ' +
              'Code du travail, Code de la défense, Code de la sécurité intérieure, ' +
              'Code des postes et des communications électroniques, and key data protection / ' +
              'cybersecurity statutes (Loi Informatique et Libertés, LPM 2024-2030 cyber provisions, NIS2 transposition).',
            limitations:
              'This database covers 8 major codes and select statutes — it is NOT a complete ' +
              'corpus of all French legislation. Full coverage requires PISTE API OAuth credentials. ' +
              'Always verify against legifrance.gouv.fr for legal certainty.',
          },
          eu_references: {
            eu_documents: euDocs,
            eu_references: euRefs,
          },
        },
      ],
    },
    _metadata: generateResponseMetadata(db),
  };
}

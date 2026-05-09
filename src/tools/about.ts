/**
 * about — Server metadata, dataset statistics, and provenance.
 *
 * Returns the fleet envelope shape: { results: { server, dataset, provenance, security }, _metadata }.
 * Asserted by tests/integration/mcp-output.test.ts ('all tools return parseable JSON
 * with results and _metadata envelopes').
 */

import type Database from '@ansvar/mcp-sqlite';
import { detectCapabilities, readDbMetadata } from '../capabilities.js';
import { generateResponseMetadata } from '../utils/metadata.js';

export interface AboutContext {
  version: string;
  fingerprint: string;
  dbBuilt: string;
}

function safeCount(db: InstanceType<typeof Database>, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  } catch {
    return 0;
  }
}

function safeCapabilities(db: InstanceType<typeof Database>): string[] {
  try {
    return [...detectCapabilities(db)];
  } catch {
    return [];
  }
}

export function getAbout(db: InstanceType<typeof Database>, context: AboutContext) {
  const meta = readDbMetadata(db);

  return {
    results: {
      server: {
        name: 'French Law MCP',
        version: context.version,
        repository: 'https://github.com/Ansvar-Systems/French-law-mcp',
      },
      dataset: {
        jurisdiction: 'France (FR)',
        languages: ['fr'],
        counts: {
          legal_documents: safeCount(db, 'SELECT COUNT(*) as count FROM legal_documents'),
          legal_provisions: safeCount(db, 'SELECT COUNT(*) as count FROM legal_provisions'),
          definitions: safeCount(db, 'SELECT COUNT(*) as count FROM definitions'),
          eu_documents: safeCount(db, 'SELECT COUNT(*) as count FROM eu_documents'),
          eu_references: safeCount(db, 'SELECT COUNT(*) as count FROM eu_references'),
        },
        fingerprint: context.fingerprint,
        built_at: context.dbBuilt,
        tier: meta.tier,
        schema_version: meta.schema_version,
        capabilities: safeCapabilities(db),
      },
      provenance: {
        sources: [
          {
            name: 'Légifrance',
            authority: "Direction de l'information légale et administrative (DILA)",
            url: 'https://www.legifrance.gouv.fr',
            license: 'Public Domain (Code de la propriété intellectuelle, Art. L111-5)',
          },
        ],
      },
      security: {
        access_model: 'read-only',
        pii: 'none',
      },
    },
    _metadata: generateResponseMetadata(db),
  };
}

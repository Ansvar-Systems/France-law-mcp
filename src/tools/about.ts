import type Database from '@ansvar/mcp-sqlite';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface AboutContext {
  version: string;
  fingerprint: string;
  dbBuilt: string;
}

export interface AboutResult {
  server: {
    name: string;
    package: string;
    version: string;
    suite: string;
    repository: string;
  };
  dataset: {
    fingerprint: string;
    built: string;
    jurisdiction: string;
    content_basis: string;
    counts: Record<string, number>;
  };
  provenance: {
    sources: string[];
    license: string;
    authenticity_note: string;
  };
  security: {
    access_model: string;
    network_access: boolean;
    filesystem_access: boolean;
    arbitrary_code: boolean;
  };
}

function safeCount(db: InstanceType<typeof Database>, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  } catch {
    return 0;
  }
}

export function getAbout(
  db: InstanceType<typeof Database>,
  context: AboutContext
): ToolResponse<AboutResult> {
  return {
    results: {
      server: {
        name: 'French Law MCP',
        package: '@ansvar/french-law-mcp',
        version: context.version,
        suite: 'Ansvar Compliance Suite',
        repository: 'https://github.com/Ansvar-Systems/France-law-mcp',
      },
      dataset: {
        fingerprint: context.fingerprint,
        built: context.dbBuilt,
        jurisdiction: 'France (FR)',
        content_basis:
          'French statute text from Legifrance open data (LEGI archive). ' +
          'Covers 8 major codes: Code civil, Code de commerce, Code de la défense, ' +
          'Code pénal, Code des postes et des communications électroniques, ' +
          'Code de la sécurité intérieure, Code du travail, and key statutes ' +
          '(Loi Informatique et Libertés, LPM 2024-2030 cyber provisions, NIS2 transposition). ' +
          'NOT a complete corpus of all French legislation.',
        counts: {
          legal_documents: safeCount(db, 'SELECT COUNT(*) as count FROM legal_documents'),
          legal_provisions: safeCount(db, 'SELECT COUNT(*) as count FROM legal_provisions'),
          eu_documents: safeCount(db, 'SELECT COUNT(*) as count FROM eu_documents'),
          eu_references: safeCount(db, 'SELECT COUNT(*) as count FROM eu_references'),
        },
      },
      provenance: {
        sources: [
          'Legifrance (statutes, statutory instruments)',
          'EUR-Lex (EU directive references)',
        ],
        license:
          'Apache-2.0 (server code). Legal source texts under Licence Ouverte v2.0.',
        authenticity_note:
          'Statute text is derived from Legifrance open data. ' +
          'Verify against official publications when legal certainty is required.',
      },
      security: {
        access_model: 'read-only',
        network_access: false,
        filesystem_access: false,
        arbitrary_code: false,
      },
    },
    _metadata: generateResponseMetadata(db),
  };
}

/**
 * Tool registry for French Law MCP Server.
 * Shared between stdio (index.ts) and HTTP (api/mcp.ts) entry points.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import Database from '@ansvar/mcp-sqlite';

import { searchLegislation, SearchLegislationInput } from './search-legislation.js';
import { getProvision, GetProvisionInput } from './get-provision.js';
import { listSources, ListSourcesInput } from './list-sources.js';
import { validateCitationTool, ValidateCitationInput } from './validate-citation.js';
import { buildLegalStance, BuildLegalStanceInput } from './build-legal-stance.js';
import { formatCitationTool, FormatCitationInput } from './format-citation.js';
import { checkCurrency, CheckCurrencyInput } from './check-currency.js';
import { getEUBasis, GetEUBasisInput } from './get-eu-basis.js';
import { getFrenchImplementations, GetFrenchImplementationsInput } from './get-french-implementations.js';
import { searchEUImplementations, SearchEUImplementationsInput } from './search-eu-implementations.js';
import { getProvisionEUBasis, GetProvisionEUBasisInput } from './get-provision-eu-basis.js';
import { validateEUCompliance, ValidateEUComplianceInput } from './validate-eu-compliance.js';
import { getAbout, type AboutContext } from './about.js';
export type { AboutContext } from './about.js';

const COVERAGE_NOTE =
  'COVERAGE NOTE: This server indexes 8 major French codes (~29,935 provisions) ' +
  'from Legifrance open data. It is NOT a complete corpus of all French legislation. ' +
  'Always verify against legifrance.gouv.fr for legal certainty.';

const ABOUT_TOOL: Tool = {
  name: 'about',
  description:
    'Server metadata, dataset statistics, freshness, and provenance. ' +
    'Call this first to verify data coverage, currency, and content basis before relying on results.',
  inputSchema: { type: 'object', properties: {} },
};

export const TOOLS: Tool[] = [
  {
    name: 'search_legislation',
    description:
      'Search French statutes and regulations by keyword. Returns matched provisions ' +
      'with BM25-ranked snippets. Supports FTS5 boolean syntax (AND, OR, NOT) and ' +
      'phrase search ("exact phrase"). ' + COVERAGE_NOTE +
      '\n\nUse this tool when: You need to find provisions about a legal topic. ' +
      'Do NOT use this tool when: You already know the exact article reference — use get_provision instead.' +
      '\n\nOutput: Array of {document_id, document_title, provision_ref, chapter, section, title, snippet, relevance}.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query in French. Supports FTS5 syntax: boolean operators (AND, OR, NOT), ' +
            'phrase search ("protection des données"), prefix matching (cyber*). ' +
            'Example: "traitement automatisé" AND "données personnelles"',
        },
        document_id: {
          type: 'string',
          description:
            'Filter results to a specific statute. Use the document_id from search results or list_sources. ' +
            'Examples: "code-penal", "code-civil", "code-defense", "code-travail", "code-commerce", ' +
            '"code-securite-interieure", "code-postes-telecom", "loi-informatique-libertes"',
        },
        status: {
          type: 'string',
          enum: ['in_force', 'amended', 'repealed'],
          description: 'Filter by document status. Most useful to filter to "in_force" statutes only.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return. Default: 10, maximum: 50. Keep low for agent context efficiency.',
          default: 10,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_provision',
    description:
      'Retrieve the full text of a specific provision (article) from a French statute. ' +
      'Returns the provision content, chapter, section, and document metadata. ' +
      'If only document_id is provided (no section/provision_ref), returns up to 200 provisions ' +
      '(response includes truncated flag and hint if more exist). ' + COVERAGE_NOTE +
      '\n\nUse this tool when: You know the exact article reference (e.g., "art323-1" in "code-penal"). ' +
      'Do NOT use this tool when: You are searching by topic — use search_legislation instead.' +
      '\n\nFrench citation format: Articles use "art" prefix followed by number (e.g., "art323-1", "artL2321-1"). ' +
      'Legislative articles use L prefix (artL...), regulatory articles use R or D prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description:
            'Statute identifier. Use slug format: "code-penal", "code-civil", "code-defense", ' +
            '"code-travail", "code-commerce", "code-securite-interieure", "code-postes-telecom", ' +
            '"loi-informatique-libertes", "loi-programmation-militaire-cyber", "nis2-transposition-france". ' +
            'Also accepts full French titles (e.g., "Code pénal").',
        },
        section: {
          type: 'string',
          description: 'Section/article number (e.g., "323-1", "L2321-1"). Prefix with "art" for exact match.',
        },
        provision_ref: {
          type: 'string',
          description: 'Direct provision reference (e.g., "art323-1", "artL2321-1"). Takes precedence over section.',
        },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'list_sources',
    description:
      'Returns provenance metadata for all data sources in the database. ' +
      'Shows jurisdiction, data authority, coverage statistics, limitations, and license information. ' +
      'Call this tool to understand what data is available before performing searches.' +
      '\n\nUse this tool when: Starting a research session, or when you need to verify data coverage and freshness. ' +
      'Do NOT use this tool when: You already know the data is in scope.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'validate_citation',
    description:
      'Validate a French legal citation against the database. Returns whether the cited document and ' +
      'provision exist, with parsed components. Use this as a zero-hallucination check before citing French law.' +
      '\n\nSupported citation formats:\n' +
      '- "Code de la défense, art. L. 2321-1"\n' +
      '- "Article 323-1 du Code pénal"\n' +
      '- "Code pénal, article 323-1"\n' +
      '- "Loi n° 78-17 du 6 janvier 1978" (Informatique et Libertés)' +
      '\n\nUse this tool when: You want to verify a citation is real before including it in output. ' +
      'Do NOT use this tool when: You want the actual text — use get_provision instead.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: {
          type: 'string',
          description:
            'French legal citation to validate. Example: "Code de la défense, art. L. 2321-1" or ' +
            '"Article 323-1 du Code pénal"',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'build_legal_stance',
    description:
      'Build a comprehensive set of citations for a legal question by searching across all indexed French statutes. ' +
      'Runs multiple query strategies (exact phrase, individual terms, prefix expansion) and aggregates results. ' +
      COVERAGE_NOTE +
      '\n\nUse this tool when: Researching a broad legal topic and need comprehensive references. ' +
      'Do NOT use this tool when: Looking for a single specific provision — use get_provision or search_legislation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Legal question or topic to research in French. Example: "protection des données personnelles"',
        },
        document_id: {
          type: 'string',
          description: 'Optionally limit search to one statute (e.g., "code-penal")',
        },
        limit: {
          type: 'number',
          description: 'Max results per search strategy (default: 5, max: 20)',
          default: 5,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'format_citation',
    description:
      'Format a French legal citation per standard conventions. Returns the citation in the requested format.' +
      '\n\nFormats:\n' +
      '- full: "Code pénal, article 323-1"\n' +
      '- short: "C. pén., art. 323-1"\n' +
      '- pinpoint: "art. 323-1"' +
      '\n\nUse this tool when: You need to format a citation for output to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        citation: {
          type: 'string',
          description: 'Citation string to format. Example: "Code pénal, art. 323-1"',
        },
        format: {
          type: 'string',
          enum: ['full', 'short', 'pinpoint'],
          description: 'Output format. "full" (default) gives complete citation, "short" is abbreviated, "pinpoint" is article only.',
          default: 'full',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'check_currency',
    description:
      'Check if a French statute or provision is currently in force. Returns document status ' +
      '(in_force, amended, repealed, not_yet_in_force) and validity dates.' +
      '\n\nUse this tool when: You need to confirm a statute is current before relying on it. ' +
      'Do NOT use this tool when: You just need the text — use get_provision (which includes status in response).',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'Statute identifier (e.g., "code-penal") or full French title',
        },
        provision_ref: {
          type: 'string',
          description: 'Optional specific provision to check (e.g., "art323-1")',
        },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'get_eu_basis',
    description:
      'Get EU legal basis (directives and regulations) for a French statute. Shows which EU law a French ' +
      'statute implements, supplements, or references, with CELEX numbers and implementation status.' +
      '\n\nUse this tool when: You need to trace a French law back to its EU directive origin. ' +
      'For provision-level EU mapping, use get_provision_eu_basis instead.' +
      '\n\nNote: EU cross-references are limited to the 5 major directives/regulations currently indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'French statute identifier (e.g., "loi-informatique-libertes", "nis2-transposition-france")',
        },
        include_articles: {
          type: 'boolean',
          description: 'Include specific EU article references in the response (default: false)',
          default: false,
        },
        reference_types: {
          type: 'array',
          items: { type: 'string', enum: ['implements', 'supplements', 'applies'] },
          description: 'Filter by reference type. Omit to return all types.',
        },
      },
      required: ['document_id'],
    },
  },
  {
    name: 'get_french_implementations',
    description:
      'Find French statutes implementing a specific EU directive or regulation. ' +
      'Given an EU document ID, returns all French laws that implement or reference it.' +
      '\n\nEU document ID format: "directive:YYYY/N" or "regulation:YYYY/N" ' +
      '(e.g., "regulation:2016/679" for GDPR, "directive:2022/2555" for NIS2).',
    inputSchema: {
      type: 'object',
      properties: {
        eu_document_id: {
          type: 'string',
          description: 'EU document ID. Format: "regulation:2016/679" (GDPR), "directive:2022/2555" (NIS2), "directive:2013/40" (Cybercrime)',
        },
        primary_only: {
          type: 'boolean',
          description: 'Return only primary implementing statutes (default: false)',
          default: false,
        },
        in_force_only: {
          type: 'boolean',
          description: 'Return only in-force statutes (default: false)',
          default: false,
        },
      },
      required: ['eu_document_id'],
    },
  },
  {
    name: 'search_eu_implementations',
    description:
      'Search for EU directives and regulations that have French implementation information in the database. ' +
      'Returns EU documents with counts of French statutes referencing them.' +
      '\n\nNote: Limited to ~5 major EU instruments currently indexed (GDPR, NIS2, NIS1, Cybercrime Directive, Cybersecurity Act).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword search across EU document titles and short names. Example: "data protection", "cybersecurity"',
        },
        type: {
          type: 'string',
          enum: ['directive', 'regulation'],
          description: 'Filter by EU document type',
        },
        year_from: { type: 'number', description: 'Filter by year (from)' },
        year_to: { type: 'number', description: 'Filter by year (to)' },
        has_french_implementation: {
          type: 'boolean',
          description: 'Filter to only EU documents that have French implementing legislation',
        },
        limit: {
          type: 'number',
          description: 'Max results (default: 20, max: 100)',
          default: 20,
        },
      },
    },
  },
  {
    name: 'get_provision_eu_basis',
    description:
      'Get EU legal basis for a specific provision within a French statute. Returns the EU directives/regulations ' +
      'that a specific article implements or references, with article-level precision.' +
      '\n\nUse this tool when: You need to know which EU article a specific French provision implements.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'French statute identifier (e.g., "loi-informatique-libertes")',
        },
        provision_ref: {
          type: 'string',
          description: 'Provision reference within the statute (e.g., "art1", "3")',
        },
      },
      required: ['document_id', 'provision_ref'],
    },
  },
  {
    name: 'validate_eu_compliance',
    description:
      'Validate EU compliance status for a French statute or provision. Checks for references to ' +
      'repealed EU directives, missing implementation, and outdated references. ' +
      'Returns compliance status: compliant, partial, unclear, or not_applicable.' +
      '\n\nNote: Phase 1 validation only. Full compliance checking against EU requirements planned for future releases.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'French statute identifier',
        },
        provision_ref: {
          type: 'string',
          description: 'Optional specific provision to check',
        },
        eu_document_id: {
          type: 'string',
          description: 'Optional: check compliance with a specific EU document (e.g., "regulation:2016/679")',
        },
      },
      required: ['document_id'],
    },
  },
];

export function buildTools(context?: AboutContext): Tool[] {
  return context ? [...TOOLS, ABOUT_TOOL] : TOOLS;
}

export function registerTools(
  server: Server,
  db: InstanceType<typeof Database>,
  context?: AboutContext,
): void {
  const allTools = buildTools(context);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case 'search_legislation':
          result = await searchLegislation(db, args as unknown as SearchLegislationInput);
          break;
        case 'get_provision':
          result = await getProvision(db, args as unknown as GetProvisionInput);
          break;
        case 'list_sources':
          result = await listSources(db, args as unknown as ListSourcesInput);
          break;
        case 'validate_citation':
          result = await validateCitationTool(db, args as unknown as ValidateCitationInput);
          break;
        case 'build_legal_stance':
          result = await buildLegalStance(db, args as unknown as BuildLegalStanceInput);
          break;
        case 'format_citation':
          result = await formatCitationTool(args as unknown as FormatCitationInput);
          break;
        case 'check_currency':
          result = await checkCurrency(db, args as unknown as CheckCurrencyInput);
          break;
        case 'get_eu_basis':
          result = await getEUBasis(db, args as unknown as GetEUBasisInput);
          break;
        case 'get_french_implementations':
          result = await getFrenchImplementations(db, args as unknown as GetFrenchImplementationsInput);
          break;
        case 'search_eu_implementations':
          result = await searchEUImplementations(db, args as unknown as SearchEUImplementationsInput);
          break;
        case 'get_provision_eu_basis':
          result = await getProvisionEUBasis(db, args as unknown as GetProvisionEUBasisInput);
          break;
        case 'validate_eu_compliance':
          result = await validateEUCompliance(db, args as unknown as ValidateEUComplianceInput);
          break;
        case 'about':
          if (context) {
            result = getAbout(db, context);
          } else {
            return {
              content: [{ type: 'text', text: 'About tool not configured.' }],
              isError: true,
            };
          }
          break;
        default:
          return {
            content: [{ type: 'text', text: `Error: Unknown tool "${name}".` }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
}

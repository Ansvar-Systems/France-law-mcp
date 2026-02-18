import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../../src/tools/registry.js';
import { openReadonlyDatabase, closeDatabase } from '../fixtures/db.js';

type ToolInputMap = Record<string, Record<string, unknown>>;

const TOOL_INPUTS: ToolInputMap = {
  search_legislation: { query: 'securite', limit: 3 },
  get_provision: { document_id: 'code-defense', provision_ref: 'artL2321-1' },
  validate_citation: { citation: 'Code de la défense, art. L. 2321-1' },
  build_legal_stance: { query: 'cybersecurity incident notification obligations', limit: 3 },
  format_citation: { citation: 'Code pénal, art. 323-1', format: 'short' },
  check_currency: { document_id: 'code-defense' },
  get_eu_basis: { document_id: 'nis2-transposition-france' },
  get_french_implementations: { eu_document_id: 'directive:2013/40' },
  search_eu_implementations: { query: 'GDPR', limit: 5 },
  get_provision_eu_basis: { document_id: 'code-penal', provision_ref: 'art323-1' },
  validate_eu_compliance: { document_id: 'code-defense' },
  list_sources: {},
  about: {},
};

describe('MCP tool output contract', () => {
  let db: ReturnType<typeof openReadonlyDatabase>;
  let client: Client;

  beforeAll(async () => {
    db = openReadonlyDatabase();

    const server = new Server(
      { name: 'fr-law-mcp-output-test', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    registerTools(server, db, {
      version: '1.0.0',
      fingerprint: 'test-fingerprint',
      dbBuilt: '2026-02-16T00:00:00Z',
    });

    client = new Client({ name: 'fr-law-mcp-output-test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(() => {
    closeDatabase(db);
  });

  it('all tools return parseable JSON with results and _metadata envelopes', async () => {
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();

    for (const toolName of tools) {
      expect(TOOL_INPUTS[toolName], `No test input configured for tool "${toolName}"`).toBeDefined();

      const response = await client.callTool({
        name: toolName,
        arguments: TOOL_INPUTS[toolName],
      });

      expect(response.isError === true, `Tool "${toolName}" returned an MCP error`).toBe(false);

      const content = response.content as Array<{ type: string; text: string }>;
      const text = content?.[0]?.text ?? '';
      expect(text.length, `Tool "${toolName}" returned empty text output`).toBeGreaterThan(0);

      let parsed: unknown;
      expect(() => {
        parsed = JSON.parse(text);
      }, `Tool "${toolName}" output is not valid JSON`).not.toThrow();

      const object = parsed as Record<string, unknown>;
      expect(typeof object, `Tool "${toolName}" output should be an object`).toBe('object');
      expect(object).toHaveProperty('results');
      expect(object).toHaveProperty('_metadata');

      const metadata = object['_metadata'] as Record<string, unknown>;
      expect(typeof metadata).toBe('object');
      expect(metadata).toHaveProperty('data_freshness');
      expect(metadata).toHaveProperty('disclaimer');
      expect(metadata).toHaveProperty('source_authority');
    }
  }, 30_000);
});

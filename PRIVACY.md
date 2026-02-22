# Privacy & Client Confidentiality

**IMPORTANT READING FOR LEGAL PROFESSIONALS**

This document addresses privacy and confidentiality considerations when using this Tool, with particular attention to professional obligations under French bar association rules.

---

## Executive Summary

**Key Risks:**
- Queries through Claude API flow via Anthropic cloud infrastructure
- Query content may reveal client matters and privileged information
- French bar rules (Conseil National des Barreaux / Ordre des Avocats) require strict confidentiality (secret professionnel)

**Safe Use Options:**
1. **General Legal Research**: Use Tool for non-client-specific queries
2. **Local npm Package**: Install `@ansvar/french-law-mcp` locally — database queries stay on your machine
3. **Remote Endpoint**: Vercel Streamable HTTP endpoint — queries transit Vercel infrastructure
4. **On-Premise Deployment**: Self-host with local LLM for privileged matters

---

## Data Flows and Infrastructure

### MCP (Model Context Protocol) Architecture

This Tool uses the **Model Context Protocol (MCP)** to communicate with AI clients:

```
User Query -> MCP Client (Claude Desktop/Cursor/API) -> Anthropic Cloud -> MCP Server -> Database
```

### Deployment Options

#### 1. Local npm Package (Most Private)

```bash
npx @ansvar/french-law-mcp
```

- Database is local SQLite file on your machine
- No data transmitted to external servers (except to AI client for LLM processing)
- Full control over data at rest

#### 2. Remote Endpoint (Vercel)

```
Endpoint: https://french-law-mcp.vercel.app/mcp
```

- Queries transit Vercel infrastructure
- Tool responses return through the same path
- Subject to Vercel's privacy policy

### What Gets Transmitted

When you use this Tool through an AI client:

- **Query Text**: Your search queries and tool parameters
- **Tool Responses**: Statute text (textes législatifs), provision content, search results
- **Metadata**: Timestamps, request identifiers

**What Does NOT Get Transmitted:**
- Files on your computer
- Your full conversation history (depends on AI client configuration)

---

## Professional Obligations (France)

### French Bar Association Rules

French lawyers (avocats) are bound by strict confidentiality rules under the Loi du 31 décembre 1971, the Décret n° 2005-790 (Règlement Intérieur National, RIN), and the local bar codes of conduct.

#### Secret professionnel

- All client communications are privileged (Article 66-5, Loi du 31 décembre 1971)
- Client identity may be confidential in sensitive matters
- Case strategy and legal analysis are protected
- Information that could identify clients or matters must be safeguarded
- Breach of confidentiality is a criminal offense (Article 226-13, Code pénal) as well as a disciplinary violation

### CNIL, Loi Informatique et Libertés, and GDPR

Under **GDPR Article 28** and the **Loi Informatique et Libertés (Loi n° 78-17)**, when using services that process client data:

- You are the **Data Controller** (responsable du traitement)
- AI service providers (Anthropic, Vercel) may be **Data Processors** (sous-traitants)
- A **Data Processing Agreement** (contrat de sous-traitance) may be required
- Ensure adequate technical and organizational measures
- The Commission Nationale de l'Informatique et des Libertés (CNIL) oversees compliance

---

## Risk Assessment by Use Case

### LOW RISK: General Legal Research

**Safe to use through any deployment:**

```
Example: "What does Article 1240 of the Code civil say about tort liability?"
```

- No client identity involved
- No case-specific facts
- Publicly available legal information

### MEDIUM RISK: Anonymized Queries

**Use with caution:**

```
Example: "What are the penalties for abus de biens sociaux under French commercial law?"
```

- Query pattern may reveal you are working on a corporate fraud matter
- Anthropic/Vercel logs may link queries to your API key

### HIGH RISK: Client-Specific Queries

**DO NOT USE through cloud AI services:**

- Remove ALL identifying details
- Use the local npm package with a self-hosted LLM
- Or use commercial legal databases (Dalloz, LexisNexis France, Lexbase) with proper data processing agreements

---

## Data Collection by This Tool

### What This Tool Collects

**Nothing.** This Tool:

- Does NOT log queries
- Does NOT store user data
- Does NOT track usage
- Does NOT use analytics
- Does NOT set cookies

The database is read-only. No user data is written to disk.

### What Third Parties May Collect

- **Anthropic** (if using Claude): Subject to [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy)
- **Vercel** (if using remote endpoint): Subject to [Vercel Privacy Policy](https://vercel.com/legal/privacy-policy)

---

## Recommendations

### For Solo Practitioners / Small Firms (Avocats individuels / Petits cabinets)

1. Use local npm package for maximum privacy
2. General research: Cloud AI is acceptable for non-client queries
3. Client matters: Use commercial legal databases (Dalloz, LexisNexis France, Lexbase)

### For Large Firms / Corporate Legal (Grands cabinets / Directions juridiques)

1. Negotiate Data Processing Agreements (contrats de sous-traitance) with AI service providers
2. Consider on-premise deployment with self-hosted LLM
3. Train staff on safe vs. unsafe query patterns

### For Government / Public Sector (Administration publique)

1. Use self-hosted deployment, no external APIs
2. Follow French government IT security requirements (ANSSI guidelines, SecNumCloud)
3. Air-gapped option available for classified matters

---

## Questions and Support

- **Privacy Questions**: Open issue on [GitHub](https://github.com/Ansvar-Systems/French-law-mcp/issues)
- **Anthropic Privacy**: Contact privacy@anthropic.com
- **CNB / Bar Guidance**: Consult the Conseil National des Barreaux or your local Ordre des Avocats ethics commission

---

**Last Updated**: 2026-02-22
**Tool Version**: 1.0.0

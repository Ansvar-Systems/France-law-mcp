# French Law MCP Server

<!-- ANSVAR-CTA-BEGIN -->
> **The French law corpus is now served through the Ansvar Gateway.** Connect your AI assistant (Claude, Copilot, Cursor, custom MCP client) to `https://gateway.ansvar.eu/mcp` — one OAuth connection, free tier available, covering this corpus plus EU regulations, national law across 28 audited jurisdictions, and CVE/security intelligence, every result with a verbatim source citation. Start at https://ansvar.eu/docs/quickstart

### Connect

**Claude Code** (one line):

```bash
claude mcp add ansvar --transport http https://gateway.ansvar.eu/mcp
```

**Claude Desktop / Cursor** — add to `claude_desktop_config.json` (or `mcp.json`):

```json
{
  "mcpServers": {
    "ansvar": {
      "type": "url",
      "url": "https://gateway.ansvar.eu/mcp"
    }
  }
}
```

**Claude.ai** — Settings → Connectors → Add custom connector → paste `https://gateway.ansvar.eu/mcp`

First request opens an OAuth signup flow (setup details: [ansvar.eu/docs/quickstart](https://ansvar.eu/docs/quickstart)). After signup, your client is bound to your account; tier (free / premium / team / company) determines fan-out, quota, and which downstream MCPs are reachable.

---

## Self-host this MCP

You can also clone this repo and build the corpus yourself. The schema,
fetcher, and tool implementations all live here. What is not in the repo is
the pre-built database — TDM and standards-licensing constraints on the
upstream sources mean we host the corpus on Ansvar infrastructure rather
than redistribute it as a public artifact.

Build your own: run this repo's ingestion script (entry-point varies per
repo — typically `scripts/ingest.sh`, `npm run ingest`, or `make ingest`;
check the repo root).
<!-- ANSVAR-CTA-END -->


**The Légifrance alternative for the AI age.**

[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub stars](https://img.shields.io/github/stars/Ansvar-Systems/France-law-mcp?style=social)](https://github.com/Ansvar-Systems/France-law-mcp)
[![CI](https://github.com/Ansvar-Systems/France-law-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Ansvar-Systems/France-law-mcp/actions/workflows/ci.yml)
[![Daily Data Check](https://github.com/Ansvar-Systems/France-law-mcp/actions/workflows/check-updates.yml/badge.svg)](https://github.com/Ansvar-Systems/France-law-mcp/actions/workflows/check-updates.yml)
[![Database](https://img.shields.io/badge/database-pre--built-green)](docs/EU_INTEGRATION_GUIDE.md)
[![Provisions](https://img.shields.io/badge/provisions-193%2C793-blue)](docs/EU_INTEGRATION_GUIDE.md)

Query **3,958 French statutes** -- from le RGPD (loi Informatique et Libertés), le Code pénal, and le Code civil to le Code du travail, le Code de commerce, and more -- directly from Claude, Cursor, or any MCP-compatible client.

If you're building legal tech, compliance tools, or doing French legal research, this is your verified reference database.

Built by [Ansvar Systems](https://ansvar.eu) -- Stockholm, Sweden

---

## Why This Exists

French legal research is scattered across Légifrance, the Journal Officiel, legistix, and EUR-Lex. Whether you're:
- A **lawyer** validating citations in a brief or contract
- A **compliance officer** checking RGPD obligations or sectoral regulations
- A **legal tech developer** building tools on French law
- A **researcher** tracing legislative history from projet de loi to code

...you shouldn't need dozens of browser tabs and manual cross-referencing between codes. Ask Claude. Get the exact provision. With context.

This MCP server makes French law **searchable, cross-referenceable, and AI-readable**.

---

## Example Queries

Once connected, just ask naturally:

- *"Que dit l'article 6 de la loi Informatique et Libertés sur le consentement ?"*
- *"Recherche 'protection des données personnelles' dans le droit français (RGPD, loi Informatique et Libertés)"*
- *"Quelles dispositions du Code pénal concernent la fraude informatique ?"*
- *"Trouve les articles sur le droit du travail liés aux heures supplémentaires dans le Code du travail"*
- *"What EU directives does the loi Informatique et Libertés implement?"*
- *"Which French laws implement the NIS2 Directive?"*
- *"Valide la citation 'Article L. 226-1 du Code pénal'"*
- *"Compare les exigences de notification d'incident sous NIS2 et la loi française de transposition"*
- *"Recherche 'responsabilité civile' dans le Code civil"*
- *"Get the premium case law for RGPD enforcement decisions"*

---

## What's Included

| Category | Count | Details |
|----------|-------|---------|
| **Statutes** | 3,958 statutes | Comprehensive French legislation from Légifrance |
| **Provisions** | 193,793 articles | Full-text searchable with FTS5 |
| **Case Law** | 7,112 decisions | Premium tier -- judicial decisions |
| **Preparatory Works** | 3,411 documents | Premium tier -- projets de loi, rapports |
| **Agency Guidance** | 0 (free tier) | Reserved for future ingestion |
| **Database Size** | ~335 MB | Optimized SQLite, portable |
| **Daily Updates** | Automated | Freshness checks against Légifrance |

**Verified data only** -- every citation is validated against official sources (Légifrance, legifrance.gouv.fr). Zero LLM-generated content.

---

## See It In Action

### Why This Works

**Verbatim Source Text (No LLM Processing):**
- All statute text is ingested from Légifrance official publications
- Provisions are returned **unchanged** from SQLite FTS5 database rows
- Zero LLM summarization or paraphrasing -- the database contains regulation text, not AI interpretations

**Smart Context Management:**
- Search returns ranked provisions with BM25 scoring (safe for context)
- Provision retrieval gives exact text by code + article number
- Cross-references help navigate without loading everything at once

**Technical Architecture:**
```
Légifrance API --> Parse --> SQLite --> FTS5 snippet() --> MCP response
                    ^                        ^
             Provision parser         Verbatim database query
```

### Traditional Research vs. This MCP

| Traditional Approach | This MCP Server |
|---------------------|-----------------|
| Search Légifrance by code name | Search by plain French: *"protection données personnelles"* |
| Navigate multi-book codes manually | Get the exact article with context |
| Manual cross-referencing between codes | `build_legal_stance` aggregates across sources |
| "Est-ce que cet article est en vigueur ?" -> check manually | `check_currency` tool -> answer in seconds |
| Find EU basis -> dig through EUR-Lex | `get_eu_basis` -> linked EU directives instantly |
| Check Légifrance, Journal Officiel, EUR-Lex separately | Daily automated freshness checks |
| No API, no integration | MCP protocol -> AI-native |

**Traditional:** Search Légifrance -> Navigate the code -> Ctrl+F -> Cross-reference with RGPD -> Check EUR-Lex for directive -> Repeat

**This MCP:** *"Quels textes européens ont conduit à l'article L. 34-5 du Code des postes ?"* -> Done.

---

## Available Tools (13)

### Core Legal Research Tools (8)

| Tool | Description |
|------|-------------|
| `search_legislation` | FTS5 full-text search across 193,793 provisions with BM25 ranking |
| `get_provision` | Retrieve specific provision by code + article number |
| `validate_citation` | Validate citation against database (zero-hallucination check) |
| `build_legal_stance` | Aggregate citations from statutes, case law, preparatory works |
| `format_citation` | Format citations per French conventions (full/short/pinpoint) |
| `check_currency` | Check if statute is in force, amended, or repealed |
| `list_sources` | List all available statutes with metadata and data provenance |
| `about` | Server info, capabilities, dataset statistics, and coverage summary |

### EU Law Integration Tools (5)

| Tool | Description |
|------|-------------|
| `get_eu_basis` | Get EU directives/regulations underlying a French statute |
| `get_french_implementations` | Find French laws implementing a specific EU act |
| `search_eu_implementations` | Search EU documents with French implementation counts |
| `get_provision_eu_basis` | Get EU law references for a specific provision |
| `validate_eu_compliance` | Check implementation status against EU directives |

---

## EU Law Integration

France is a founding EU member state and plays a central role in EU law-making. French law has extensive EU cross-references across all major regulatory domains.

| Metric | Value |
|--------|-------|
| **EU Integration** | Founding EU member (1957) |
| **GDPR Implementation** | Loi Informatique et Libertés (modified 2018, CNIL oversight) |
| **NIS2 Transposition** | Loi de programmation militaire + ANSSI framework |
| **AI Act** | Direct application (no transposition needed for regulation) |
| **EUR-Lex Integration** | Automated metadata fetching |

### Key EU Acts with French Implementations

1. **GDPR** (2016/679) -- Loi Informatique et Libertés, CNIL decisions
2. **NIS2 Directive** (2022/2555) -- Loi relative à la résilience des infrastructures critiques
3. **eIDAS Regulation** (910/2014) -- Ordonnance n° 2017-1426 (identité numérique)
4. **AI Act** (2024/1689) -- Direct application + French adaptation measures
5. **DORA** (2022/2554) -- Direct application in financial sector

See [EU_INTEGRATION_GUIDE.md](docs/EU_INTEGRATION_GUIDE.md) for detailed documentation and [EU_USAGE_EXAMPLES.md](docs/EU_USAGE_EXAMPLES.md) for practical examples.

---

## Data Sources & Freshness

All content is sourced from authoritative French legal databases:

- **[Légifrance](https://www.legifrance.gouv.fr/)** -- Official French legal database (Direction de l'information légale et administrative)
- **[Journal Officiel de la République Française](https://www.journal-officiel.gouv.fr/)** -- Official gazette
- **[EUR-Lex](https://eur-lex.europa.eu/)** -- Official EU law database (metadata only)

### Data Provenance

| Field | Value |
|-------|-------|
| **Authority** | Direction de l'information légale et administrative (DILA) |
| **Retrieval method** | Légifrance API (legifrance.gouv.fr) |
| **Languages** | French (official language of law) |
| **License** | Légifrance open data (Licence Ouverte / Open Licence) |
| **Coverage** | 3,958 consolidated statutes and codes |
| **Last ingested** | 2026-02-25 |

### Automated Freshness Checks (Daily)

A [daily GitHub Actions workflow](.github/workflows/check-updates.yml) monitors all data sources:

| Source | Check | Method |
|--------|-------|--------|
| **Statute amendments** | Légifrance API date comparison | All 3,958 statutes checked |
| **New statutes** | Journal Officiel publications (90-day window) | Diffed against database |
| **Preparatory works** | Légifrance proposition API (30-day window) | New texts detected |
| **EU reference staleness** | Git commit timestamps | Flagged if >90 days old |

---

## Security

This project uses multiple layers of automated security scanning:

| Scanner | What It Does | Schedule |
|---------|-------------|----------|
| **CodeQL** | Static analysis for security vulnerabilities | Weekly + PRs |
| **Semgrep** | SAST scanning (OWASP top 10, secrets, TypeScript) | Every push |
| **Gitleaks** | Secret detection across git history | Every push |
| **Trivy** | CVE scanning on filesystem and npm dependencies | Daily |
| **Docker Security** | Container image scanning + SBOM generation | Daily |
| **Socket.dev** | Supply chain attack detection | PRs |
| **OSSF Scorecard** | OpenSSF best practices scoring | Weekly |
| **Dependabot** | Automated dependency updates | Weekly |

See [SECURITY.md](SECURITY.md) for the full policy and vulnerability reporting.

---

## Important Disclaimers

### Legal Advice

> **THIS TOOL IS NOT LEGAL ADVICE**
>
> Statute text is sourced from official Légifrance publications. However:
> - This is a **research tool**, not a substitute for professional legal counsel
> - **Court case coverage is limited** (premium tier) -- do not rely solely on this for case law research
> - **Verify critical citations** against primary sources for court filings
> - **EU cross-references** are extracted from French statute text, not EUR-Lex full text
> - **Regulatory guidance** (CNIL, ANSSI decisions) is not included in the free tier

**Before using professionally, read:** [DISCLAIMER.md](DISCLAIMER.md) | [PRIVACY.md](PRIVACY.md)

### Client Confidentiality

Queries go through the Claude API. For privileged or confidential matters, use on-premise deployment. For guidance on professional obligations, consult the Conseil National des Barreaux (CNB). See [PRIVACY.md](PRIVACY.md) for compliance guidance.

---

## Documentation

- **[EU Integration Guide](docs/EU_INTEGRATION_GUIDE.md)** -- Detailed EU cross-reference documentation
- **[EU Usage Examples](docs/EU_USAGE_EXAMPLES.md)** -- Practical EU lookup examples
- **[Security Policy](SECURITY.md)** -- Vulnerability reporting and scanning details
- **[Disclaimer](DISCLAIMER.md)** -- Legal disclaimers and professional use notices
- **[Privacy](PRIVACY.md)** -- Client confidentiality and data handling

---

## Development

### Setup

```bash
git clone https://github.com/Ansvar-Systems/France-law-mcp
cd France-law-mcp
npm install
npm run build
npm test
```

### Running Locally

```bash
npm run dev                                       # Start MCP server
npx @anthropic/mcp-inspector node dist/index.js   # Test with MCP Inspector
```

### Data Management

```bash
npm run ingest                         # Ingest statutes from Légifrance
npm run ingest:legi                    # Ingest via Légifrance API
npm run build:db                       # Rebuild SQLite database
npm run drift:detect                   # Run drift detection against anchors
npm run check-updates                  # Check for amendments and new statutes
npm run census                         # Generate coverage census report
```

### Performance

- **Search Speed:** <100ms for most FTS5 queries
- **Database Size:** ~335 MB (efficient, portable)
- **Reliability:** 100% ingestion success rate

---

## More Ansvar MCPs

Full fleet coverage at [ansvar.eu/coverage](https://ansvar.eu/coverage).
## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Priority areas:
- Court case law expansion (Cour de cassation, Conseil d'État)
- CNIL guidance and decisions ingestion
- Historical statute versions and amendment tracking
- Regional and local authority regulations

---

## Roadmap

- [x] Core statute database with FTS5 search
- [x] Full corpus ingestion (3,958 statutes, 193,793 provisions)
- [x] EU law integration tools
- [x] Vercel Streamable HTTP deployment

- [x] Premium case law (7,112 decisions)
- [x] Premium preparatory works (3,411 documents)
- [ ] CNIL decisions and guidance documents
- [ ] Conseil d'État and Cour de cassation full coverage
- [ ] Historical statute versions (amendment tracking)
- [ ] English translations for key codes

---

## Citation

If you use this MCP server in academic research:

```bibtex
@software{french_law_mcp_2026,
  author = {Ansvar Systems AB},
  title = {French Law MCP Server: Production-Grade Legal Research Tool},
  year = {2026},
  url = {https://github.com/Ansvar-Systems/France-law-mcp},
  note = {3,958 French statutes and codes with 193,793 provisions and EU law cross-references}
}
```

---

## License

Apache License 2.0. See [LICENSE](./LICENSE) for details.

### Data Licenses

Upstream legal materials are reused under the **French Open Licence v2.0**
(Licence Ouverte, Etalab) — Ansvar attribution code `FR-Etalab-2.0`.

- **Statutes & Codes:** DILA / Direction de l'information légale et administrative — published under [Licence Ouverte v2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/). Commercial reuse permitted with attribution and licence-notice preservation.
- **Case Law:** Légifrance open data, same Etalab licence.
- **EU Metadata:** EUR-Lex (EU public-domain notice).

**Important:** French statutes are NOT in the public domain. France did not
adopt a statutory-PD carve-out comparable to Germany (UrhG §5) or Spain
(TRLPI Art. 13). The reuse basis is Etalab's open licence, which requires
attribution and licence-notice preservation. The Ansvar attribution code
`FR-Etalab-2.0` is declared in `infrastructure/attribution-licenses.json`
in the Ansvar architecture-documentation repo.

---

## About Ansvar Systems

We build AI-accelerated compliance and legal research tools for the European market. This MCP server started as our internal reference tool for French law -- turns out everyone building for the French and EU markets has the same research frustrations.

So we're open-sourcing it. Navigating 3,958 statutes and codes shouldn't require a law degree.

**[ansvar.eu](https://ansvar.eu)** -- Stockholm, Sweden

---

<p align="center">
  <sub>Built with care in Stockholm, Sweden</sub>
</p>

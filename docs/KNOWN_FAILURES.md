# Known Failures

## NEEDS_REVIEW — 2026-05-19

Flagged by `scripts/apply-mcp-standard.py`. Treatment was skipped pending resolution.

**Reason:** `pre_existing_gate_failure: G3-test,G4-contract`

**Gate state at pre-flight:**
- PASS: G1-build, G2-lint
- N/A:  (none)
- FAIL: G3-test, G4-contract

**Profile detected:** `node-wasm-curated`

**Next steps:** the reason string above maps to a known pattern in
`docs/handover/2026-04-26-golden-standard-next-batch-handover.md` §4. Resolve
on a separate fix branch, then re-run the sweep on a fresh `audit/` branch
once `main` is green.

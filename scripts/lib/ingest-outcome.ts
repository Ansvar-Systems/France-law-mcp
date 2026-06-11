/**
 * Outcome classification for a text that yielded ZERO provisions at ingest.
 *
 * The fail-loud rule (issue #97 / no-silent-fallbacks) needs a distinction the
 * first implementation lacked: a text can legitimately produce zero in-force
 * provisions because it is WHOLLY OUT OF FORCE upstream — DILA keeps abrogated
 * texts in the "en vigueur" dump with every article version marked
 * non-servable (often with empty bodies), while the text-level TEXTE_VERSION
 * metadata may still claim VIGUEUR (observed: Code du domaine public fluvial,
 * abrogated 2013, text meta VIGUEUR since 1956). Text-level status therefore
 * CANNOT gate the decision; only the article-level evidence can.
 *
 * "Servable" = ETAT in {VIGUEUR, ABROGE_DIFF} (deferred repeal is in force
 * until its date — review finding parser.ts:189).
 *
 * Expected (excluded, enumerated, NOT a failure):
 *   - article nodes exist but none carries a servable ETAT;
 *   - servable versions exist but all have empty bodies;
 *   - selectable versions exist but every validity window is closed.
 *
 * Anything else stays an anomaly and fails the run — including servable
 * versions that vanished for a MISSING NUM (data damage, review finding
 * parser.ts:286).
 */

export interface ZeroProvisionStats {
  /** Article XML files found under the text directory. */
  articleFiles: number;
  /** Whole files that failed to read/parse. */
  fileErrors: number;
  /** Per-article extraction errors reported by the parser (incl. unknown ETAT). */
  parseErrors: number;
  /** Total ARTICLE nodes seen across all files (before any filtering). */
  articleNodesSeen: number;
  /** Article versions with a servable ETAT (VIGUEUR/ABROGE_DIFF), before NUM/body checks. */
  servableVersions: number;
  /** Servable versions dropped because they carry no NUM (data damage). */
  missingNumVersions: number;
  /** Servable versions dropped because the body is empty (abrogation-in-place pattern). */
  emptyBodyVersions: number;
  /** Servable versions with a NUM and a non-empty body (input to window selection). */
  selectableVersions: number;
  /** Article numbers whose every candidate window is closed today. */
  expiredOnlyNums: number;
}

export type ZeroProvisionOutcome =
  | { kind: 'out_of_force'; reason: string }
  | { kind: 'anomaly'; reason: string };

export function classifyZeroProvisionText(s: ZeroProvisionStats): ZeroProvisionOutcome {
  if (s.fileErrors > 0 || s.parseErrors > 0) {
    return {
      kind: 'anomaly',
      reason: `parse failures (file errors: ${s.fileErrors}, article errors: ${s.parseErrors})`,
    };
  }
  if (s.articleFiles === 0) {
    return { kind: 'anomaly', reason: 'no article XML files found (census counted some)' };
  }
  if (s.articleNodesSeen === 0) {
    return { kind: 'anomaly', reason: `${s.articleFiles} article file(s) contained no ARTICLE nodes` };
  }
  if (s.servableVersions === 0) {
    return {
      kind: 'out_of_force',
      reason:
        `0 of ${s.articleNodesSeen} article versions carry an in-force-capable ETAT ` +
        '(VIGUEUR/ABROGE_DIFF) — text wholly out of force upstream',
    };
  }
  if (s.selectableVersions === 0) {
    if (s.missingNumVersions > 0) {
      return {
        kind: 'anomaly',
        reason:
          `every servable version vanished before selection: ${s.missingNumVersions} missing a NUM, ` +
          `${s.emptyBodyVersions} with empty bodies — data damage, not an out-of-force pattern`,
      };
    }
    return {
      kind: 'out_of_force',
      reason: `all ${s.servableVersions} servable version(s) have empty bodies (abrogated-in-place upstream)`,
    };
  }
  if (s.expiredOnlyNums > 0) {
    return {
      kind: 'out_of_force',
      reason: `every article number's validity window is closed today (${s.expiredOnlyNums} expired-only numbers)`,
    };
  }
  return {
    kind: 'anomaly',
    reason:
      `unexplained zero-provision result (files: ${s.articleFiles}, nodes: ${s.articleNodesSeen}, ` +
      `servable: ${s.servableVersions}, selectable: ${s.selectableVersions})`,
  };
}

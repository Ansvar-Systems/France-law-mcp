/**
 * Outcome classification for a text that yielded ZERO provisions at ingest.
 *
 * The fail-loud rule (issue #97 / no-silent-fallbacks) needs a distinction the
 * first implementation lacked: a text can legitimately produce zero in-force
 * provisions because it is WHOLLY OUT OF FORCE upstream — DILA keeps abrogated
 * texts in the "en vigueur" dump with every article version marked non-VIGUEUR
 * (often with empty bodies), while the text-level TEXTE_VERSION metadata may
 * still claim VIGUEUR (observed: Code du domaine public fluvial, abrogated
 * 2013, text meta VIGUEUR since 1956). Text-level status therefore CANNOT
 * gate the decision; only the article-level evidence can.
 *
 * Expected (excluded, enumerated, NOT a failure):
 *   - article nodes exist but none carries ETAT=VIGUEUR;
 *   - VIGUEUR versions exist but all have empty bodies;
 *   - non-empty VIGUEUR versions exist but every validity window is closed.
 *
 * Anything else stays an anomaly and fails the run.
 */

export interface ZeroProvisionStats {
  /** Article XML files found under the text directory. */
  articleFiles: number;
  /** Whole files that failed to read/parse. */
  fileErrors: number;
  /** Per-article extraction errors reported by the parser. */
  parseErrors: number;
  /** Total ARTICLE nodes seen across all files (before any filtering). */
  articleNodesSeen: number;
  /** Article versions with ETAT=VIGUEUR (before the empty-content filter). */
  vigueurVersions: number;
  /** VIGUEUR versions with non-empty content (input to window selection). */
  nonEmptyVigueurVersions: number;
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
  if (s.vigueurVersions === 0) {
    return {
      kind: 'out_of_force',
      reason: `0 of ${s.articleNodesSeen} article versions carry ETAT=VIGUEUR (text wholly out of force upstream)`,
    };
  }
  if (s.nonEmptyVigueurVersions === 0) {
    return {
      kind: 'out_of_force',
      reason: `all ${s.vigueurVersions} VIGUEUR version(s) have empty bodies (abrogated-in-place upstream)`,
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
      `VIGUEUR: ${s.vigueurVersions}, non-empty: ${s.nonEmptyVigueurVersions})`,
  };
}

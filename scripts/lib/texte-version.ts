/**
 * TEXTE_VERSION metadata parsing and validity-aware selection for LEGI
 * `texte/version/` directories (issue #97 mechanism 2).
 *
 * A text directory holds one TEXTE_VERSION xml per version of the text:
 *   {TEXT_ID}/texte/version/{LEGITEXT_version_id}.xml
 * census.ts used to pick files[0] (first alphabetical) — for texts with
 * several versions that is usually the OLDEST one. Selection must follow the
 * [DATE_DEBUT, DATE_FIN) validity windows instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { parseLegiDate, parseLegiDateOpenEnded } from './parser.js';
import { selectCurrentOrLatest } from './version-select.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
});

export type TexteStatus = 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';

export interface TexteVersionMeta {
  /** Version id (LEGITEXT… of this TEXTE_VERSION file). */
  id: string;
  title: string;
  shortName?: string;
  status: TexteStatus;
  etat: string;
  /** ISO date; undefined when absent/unparseable. */
  dateDebut?: string;
  /** ISO date; undefined = open-ended (2999-01-01). */
  dateFin?: string;
  nature?: string;
  /** Path of the xml file this metadata came from. */
  file: string;
}

// ---------------------------------------------------------------------------
// Text-level ETAT -> status mapping (deliberate, fail-loud on drift)
// ---------------------------------------------------------------------------

/** Terminal not-in-force states — the text no longer carries force under this identity. */
const TERMINAL_TEXTE_ETATS: ReadonlySet<string> = new Set([
  'ABROGE', // repealed (effective)
  'PERIME', // lapsed
  'TRANSFERE', // content moved to another text/code
  'DEPLACE', // moved
  'ANNULE', // annulled
  'MORT_NE', // never entered force
  'MODIFIE_MORT_NE', // modification that never entered force
]);

/**
 * Map a text-level ETAT plus its validity window to a status FACT (review
 * finding texte-version.ts:69): ABROGE_DIFF is a DEFERRED repeal — the text
 * is IN FORCE until its DATE_FIN; the scheduled repeal date stays recorded in
 * dateFin. Unknown ETAT values throw — DILA vocabulary drift must fail loud,
 * never default to "in force".
 */
export function mapTexteEtatToStatus(
  etat: string,
  window: { dateDebut?: string; dateFin?: string },
  today: string,
  opts: { etatPresent?: boolean } = {},
): TexteStatus {
  const e = etat.toUpperCase();

  if (TERMINAL_TEXTE_ETATS.has(e)) return 'repealed';

  let status: TexteStatus;
  if (e === 'VIGUEUR' || e === 'ABROGE_DIFF') {
    status = 'in_force';
  } else if (e === 'VIGUEUR_DIFF') {
    // Deferred entry-into-force: the LABEL says not-yet, but the window is
    // the controlling fact in BOTH directions (round 3 — a VIGUEUR_DIFF
    // whose DATE_DEBUT has passed is in force; live case JORFTEXT000048582228).
    status = 'not_yet_in_force';
  } else if (e === 'MODIFIE') {
    status = 'amended';
  } else if (e === '' && opts.etatPresent) {
    // Present-but-empty <ETAT/>: undeclared — the window decides (the same
    // rule the article level applies; round 3).
    status = 'in_force';
  } else {
    throw new Error(
      `TEXTE_VERSION carries ${e ? `unknown ETAT '${e}'` : 'NO ETAT'} — outside the mapped ` +
        'DILA vocabulary, refusing to classify silently',
    );
  }

  // The validity window is the controlling fact: [dateDebut, dateFin) —
  // overriding the label in BOTH directions.
  if (window.dateFin !== undefined && window.dateFin <= today) return 'repealed';
  if (window.dateDebut !== undefined && window.dateDebut > today) return 'not_yet_in_force';
  if (status === 'not_yet_in_force' && window.dateDebut !== undefined && window.dateDebut <= today) {
    return 'in_force';
  }
  return status;
}

/**
 * Parse one TEXTE_VERSION xml. Returns null when the file is missing or not
 * parseable as a TEXTE_VERSION (callers count these loudly). An ETAT outside
 * the mapped vocabulary — including a MISSING one — THROWS instead: a parse
 * problem is countable, a mis-stated legal status is not.
 */
export function parseTexteVersionFile(xmlPath: string, today?: string): TexteVersionMeta | null {
  if (!fs.existsSync(xmlPath)) return null;
  let parsed: Record<string, unknown> | undefined;
  try {
    const xml = fs.readFileSync(xmlPath, 'utf-8');
    parsed = xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const texteVersion = (parsed as any).TEXTE_VERSION ?? parsed;
  const meta = texteVersion?.META;
  const metaCommun = meta?.META_COMMUN;
  const metaSpec = meta?.META_SPEC;
  const metaTexte = metaSpec?.META_TEXTE_VERSION ?? metaSpec?.META_TEXTE_CHRONICLE;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const id = String(metaCommun?.ID ?? '');
  const nature = String(metaCommun?.NATURE ?? metaTexte?.NATURE ?? '');
  const titre = String(metaTexte?.TITRE ?? metaTexte?.TITREFULL ?? '');
  const titreShort = String(metaTexte?.TITRECOURT ?? '');
  const etatRaw = metaTexte?.ETAT;
  const etatPresent = etatRaw !== undefined && etatRaw !== null;
  const etat = etatPresent ? String(etatRaw) : '';
  const dateDebut = parseLegiDate(metaTexte?.DATE_DEBUT as string | number | undefined);
  const dateFin = parseLegiDateOpenEnded(metaTexte?.DATE_FIN as string | number | undefined);

  if (!id && !titre) return null;

  const effectiveToday = today ?? new Date().toISOString().split('T')[0];
  const status = mapTexteEtatToStatus(etat, { dateDebut, dateFin }, effectiveToday, { etatPresent });

  return {
    id,
    title: titre || titreShort || id,
    shortName: titreShort || undefined,
    status,
    etat,
    dateDebut,
    dateFin,
    nature: nature || undefined,
    file: xmlPath,
  };
}

/**
 * Pick the authoritative TEXTE_VERSION for a text directory: the newest
 * version in force today; for fully-repealed texts, the newest version overall
 * (it carries the final title/ABROGE state). Returns null when the directory
 * holds no parseable version file.
 *
 * `textDir` is the text directory ({…}/LEGITEXT…/ or {…}/JORFTEXT…/); the
 * version files live under texte/version/. When that subdirectory is missing,
 * a recursive search (bounded depth) mirrors the previous fallback, but the
 * selection over what it finds is validity-aware instead of first-found.
 */
export function selectTexteVersion(
  textDir: string,
  today: string,
  opts: { onVersionError?: (err: unknown, file: string) => void } = {},
): TexteVersionMeta | null {
  const versionDir = path.join(textDir, 'texte', 'version');
  let files: string[] = [];
  if (fs.existsSync(versionDir)) {
    files = fs
      .readdirSync(versionDir)
      .filter((f) => f.endsWith('.xml'))
      .map((f) => path.join(versionDir, f));
  }
  if (files.length === 0) {
    files = findTexteVersionXmlFiles(textDir);
  }
  if (files.length === 0) return null;

  // One drifted version file must not kill the whole census: vocabulary
  // throws are isolated per version and surfaced via onVersionError — the
  // selection proceeds over the healthy versions (round 3). With NO handler
  // the throw still propagates (fail-loud default for single-file callers).
  const versions: TexteVersionMeta[] = [];
  for (const f of files) {
    try {
      const v = parseTexteVersionFile(f, today);
      if (v !== null) versions.push(v);
    } catch (err) {
      if (!opts.onVersionError) throw err;
      opts.onVersionError(err, f);
    }
  }
  if (versions.length === 0) return null;

  // Tie-break identical windows deterministically by version id (newest id wins).
  return selectCurrentOrLatest(versions, today, (a, b) => b.id.localeCompare(a.id));
}

function findTexteVersionXmlFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fp = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fp, depth + 1);
      } else if (
        entry.name.endsWith('.xml') &&
        (entry.name.startsWith('LEGITEXT') || entry.name.startsWith('JORFTEXT'))
      ) {
        results.push(fp);
      }
    }
  };
  walk(dir, 0);
  return results;
}

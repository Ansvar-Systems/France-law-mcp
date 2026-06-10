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
import { parseLegiDate } from './parser.js';
import { selectCurrentOrLatest } from './version-select.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
});

export interface TexteVersionMeta {
  /** Version id (LEGITEXT… of this TEXTE_VERSION file). */
  id: string;
  title: string;
  shortName?: string;
  status: 'in_force' | 'amended' | 'repealed';
  etat: string;
  /** ISO date; undefined when absent/unparseable. */
  dateDebut?: string;
  /** ISO date; undefined = open-ended (2999-01-01). */
  dateFin?: string;
  nature?: string;
  /** Path of the xml file this metadata came from. */
  file: string;
}

/**
 * Parse one TEXTE_VERSION xml. Returns null when the file is missing or not
 * parseable as a TEXTE_VERSION (callers count these loudly).
 */
export function parseTexteVersionFile(xmlPath: string): TexteVersionMeta | null {
  try {
    if (!fs.existsSync(xmlPath)) return null;
    const xml = fs.readFileSync(xmlPath, 'utf-8');
    const parsed = xmlParser.parse(xml);

    const texteVersion = parsed.TEXTE_VERSION ?? parsed;
    const meta = texteVersion?.META;
    const metaCommun = meta?.META_COMMUN;
    const metaSpec = meta?.META_SPEC;
    const metaTexte = metaSpec?.META_TEXTE_VERSION ?? metaSpec?.META_TEXTE_CHRONICLE;

    const id = String(metaCommun?.ID ?? '');
    const nature = String(metaCommun?.NATURE ?? metaTexte?.NATURE ?? '');
    const titre = String(metaTexte?.TITRE ?? metaTexte?.TITREFULL ?? '');
    const titreShort = String(metaTexte?.TITRECOURT ?? '');
    const etat = String(metaTexte?.ETAT ?? 'VIGUEUR');
    const dateDebut = parseLegiDate(metaTexte?.DATE_DEBUT as string | number | undefined);
    const dateFin = parseLegiDate(metaTexte?.DATE_FIN as string | number | undefined);

    if (!id && !titre) return null;

    let status: 'in_force' | 'amended' | 'repealed' = 'in_force';
    const etatUpper = etat.toUpperCase();
    if (etatUpper === 'ABROGE' || etatUpper === 'ABROGE_DIFF') {
      status = 'repealed';
    } else if (etatUpper === 'MODIFIE') {
      status = 'amended';
    }
    if (dateFin && dateFin < new Date().toISOString().split('T')[0]) {
      status = 'repealed';
    }

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
  } catch {
    return null;
  }
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
export function selectTexteVersion(textDir: string, today: string): TexteVersionMeta | null {
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

  const versions = files
    .map((f) => parseTexteVersionFile(f))
    .filter((v): v is TexteVersionMeta => v !== null);
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

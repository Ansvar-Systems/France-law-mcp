import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { legiTextDirCandidates, resolveTextDir } from '../../scripts/lib/text-path.js';

const BASE = 'legi/global/code_et_TNC_en_vigueur';

describe('legiTextDirCandidates', () => {
  it('maps LEGITEXT ids to BOTH code_en_vigueur and TNC_en_vigueur candidates', () => {
    expect(legiTextDirCandidates('LEGITEXT000006070719')).toEqual([
      `${BASE}/code_en_vigueur/LEGI/TEXT/00/00/06/07/07/LEGITEXT000006070719`,
      `${BASE}/TNC_en_vigueur/LEGI/TEXT/00/00/06/07/07/LEGITEXT000006070719`,
    ]);
  });

  it('maps JORFTEXT ids to the TNC_en_vigueur/JORF candidate', () => {
    expect(legiTextDirCandidates('JORFTEXT000000886460')).toEqual([
      `${BASE}/TNC_en_vigueur/JORF/TEXT/00/00/00/88/64/JORFTEXT000000886460`,
    ]);
  });

  it('throws on identifiers it cannot map — never guesses a path', () => {
    expect(() => legiTextDirCandidates('CETATEXT000012345678')).toThrow(/Cannot derive/);
  });
});

describe('resolveTextDir', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-path-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mk = (rel: string) => fs.mkdirSync(path.join(root, rel), { recursive: true });

  it('resolves a code under code_en_vigueur', () => {
    mk(`${BASE}/code_en_vigueur/LEGI/TEXT/00/00/06/07/07/LEGITEXT000006070719`);
    const { dir } = resolveTextDir(root, 'LEGITEXT000006070719');
    expect(dir).toBe(path.join(root, `${BASE}/code_en_vigueur/LEGI/TEXT/00/00/06/07/07/LEGITEXT000006070719`));
  });

  it('resolves a LEGITEXT-keyed consolidated loi under TNC_en_vigueur (issue #97 follow-up)', () => {
    mk(`${BASE}/TNC_en_vigueur/LEGI/TEXT/00/00/06/07/06/LEGITEXT000006070669`);
    const { dir } = resolveTextDir(root, 'LEGITEXT000006070669');
    expect(dir).toBe(path.join(root, `${BASE}/TNC_en_vigueur/LEGI/TEXT/00/00/06/07/06/LEGITEXT000006070669`));
  });

  it('returns null plus every checked path when the text is absent', () => {
    const { dir, checked } = resolveTextDir(root, 'LEGITEXT000006070669');
    expect(dir).toBeNull();
    expect(checked).toHaveLength(2);
    expect(checked.every((c) => c.startsWith(root))).toBe(true);
  });

  it('throws on ambiguity instead of silently picking the first match', () => {
    mk(`${BASE}/code_en_vigueur/LEGI/TEXT/00/00/06/07/06/LEGITEXT000006070669`);
    mk(`${BASE}/TNC_en_vigueur/LEGI/TEXT/00/00/06/07/06/LEGITEXT000006070669`);
    expect(() => resolveTextDir(root, 'LEGITEXT000006070669')).toThrow(/ambiguous/);
  });
});

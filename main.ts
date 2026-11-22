// main.ts is mend, the CLI SPEC.md specifies (MIT starter base, sections 1 to 4, 9 and 10, plus my own
// sections 5 to 8 below: three-tier line matching, unified diffs, SEARCH/REPLACE blocks and V4A patches,
// and the R output line for moves). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = ((tree: Tree) => void) & { moves?: [string, string][] };

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Line model and three-tier matching (SPEC.md sections 3 and 5). Written here.
// ---------------------------------------------------------------------------

interface FileInfo {
  lines: string[];
  br: string;
  ends: boolean;
}

function fileInfo(text: string): FileInfo {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function linesToText(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: `ctx` is its index in O when it is a context line, else a new line. */
interface NItem {
  text: string;
  ctx?: number;
}

/** Build the replacement lines for a match at `pos` on `tier` (section 5). */
function buildN(lines: string[], pos: number, o: string[], n: NItem[], tier: number): string[] {
  const f = leadingWs(lines[pos] ?? '');
  const p = leadingWs(o[0] ?? '');
  return n.map((it) => {
    if (it.ctx !== undefined) return lines[pos + it.ctx]!;
    if (tier !== 2) return it.text;
    const t = it.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6). Written here.
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs' | 'empty';
  text: string;
}

interface Hunk {
  a: number;
  o: string[];
  n: NItem[];
  noEol: boolean;
  lastPlusNoEol: boolean;
}

interface Section {
  oldFromPair: string | null;
  oldPairPresent: boolean;
  newFromPair: string | null;
  newPairPresent: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isNewFile: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    oldFromPair: null,
    oldPairPresent: false,
    newFromPair: null,
    newPairPresent: false,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    isNewFile: false,
    isDeleted: false,
    hunks: [],
  };
}

/** Path from a `--- ` / `+++ ` header line: text after the four characters, up to the first tab,
 *  surrounding spaces removed, `/dev/null` as null, a leading `a/` or `b/` removed. */
function headerPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return raw;
}

function classifyBody(bl: string): BodyLine {
  if (bl === '') return { kind: 'empty', text: '' };
  if (bl.startsWith(' ')) return { kind: 'ctx', text: bl.slice(1) };
  if (bl.startsWith('-')) return { kind: 'old', text: bl.slice(1) };
  if (bl.startsWith('+')) return { kind: 'new', text: bl.slice(1) };
  return { kind: 'bs', text: bl.slice(1) };
}

function makeHunk(a: number, body: BodyLine[]): Hunk {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const b of body) {
    if (b.kind === 'ctx' || b.kind === 'empty') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: idx });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text });
    }
  }
  const isCtxOrNew = (b: BodyLine): boolean => b.kind === 'ctx' || b.kind === 'empty' || b.kind === 'new';
  let noEol = false;
  let lastPlusNoEol = false;
  for (let i = body.length - 1; i >= 0; i--) {
    if (isCtxOrNew(body[i]!)) {
      noEol = body[i + 1] !== undefined && body[i + 1]!.kind === 'bs';
      break;
    }
  }
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === 'new') {
      lastPlusNoEol = body[i + 1] !== undefined && body[i + 1]!.kind === 'bs';
      break;
    }
  }
  return { a, o, n, noEol, lastPlusNoEol };
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: |$)/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** Parse one section's header and hunks starting at `i`; return the index after the section. */
function parseSection(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  let inHeader = true;
  while (i < n) {
    const line = lines[i]!;
    if (inHeader) {
      if (line.startsWith('@@')) {
        inHeader = false;
        continue;
      }
      if (line.startsWith('diff --git')) break;
      if (line.startsWith('--- ')) {
        const nxt = lines[i + 1] ?? '';
        if (nxt.startsWith('+++ ')) {
          if (sec.oldPairPresent) break;
          sec.oldFromPair = headerPath(line);
          sec.oldPairPresent = true;
          sec.newFromPair = headerPath(nxt);
          sec.newPairPresent = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNewFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDeleted = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const body: BodyLine[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          body.push(classifyBody(bl));
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'empty') body.pop();
      sec.hunks.push(makeHunk(a, body));
      continue;
    }
    i += 1;
  }
  return i;
}

function applyHunks(info: FileInfo, hunks: Hunk[], strict: boolean, failPath: string): string {
  const lines = [...info.lines];
  let ends = info.ends;
  const br = info.br;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const ins = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = ins === lines.length;
      const add = h.n.map((it) => it.text);
      lines.splice(ins, 0, ...add);
      if (atEnd) ends = !h.noEol;
      d += add.length;
      continue;
    }
    const found = findTier(lines, h.o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length === lines.length;
    const repl = buildN(lines, best, h.o, h.n, found.tier);
    lines.splice(best, h.o.length, ...repl);
    if (atEnd) ends = !h.noEol;
    d += h.n.length - h.o.length;
  }
  return linesToText(lines, br, ends);
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.oldPairPresent ? sec.oldFromPair : (sec.renameFrom ?? sec.diffOld ?? null);
  const newPath = sec.newPairPresent ? sec.newFromPair : (sec.renameTo ?? sec.diffNew ?? null);
  const isCreate = (sec.oldPairPresent && sec.oldFromPair === null) || sec.isNewFile;
  const isDelete = (sec.newPairPresent && sec.newFromPair === null) || sec.isDeleted;
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  const edit: Edit = (tree) => {
    if (isCreate) {
      const np = newPath ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let ends = false;
      let sawPlus = false;
      for (const h of sec.hunks) {
        for (const b of h.n) {
          if (b.ctx === undefined) plus.push(b.text);
        }
        if (h.n.some((b) => b.ctx === undefined)) {
          sawPlus = true;
          ends = !h.lastPlusNoEol;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (sawPlus && ends ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const op = oldPath ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (isMove) {
      const op = oldPath!;
      const np = newPath!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(fileInfo(cur), sec.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      return;
    }
    const p = oldPath ?? newPath ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const out = applyHunks(fileInfo(cur), sec.hunks, strict, p);
    tree.now.set(p, out);
  };
  if (isMove) edit.moves = [[oldPath!, newPath!]];
  return edit;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec = newSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      i += 1;
      i = parseSection(lines, i, sec);
      sections.push(sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = newSection();
      i = parseSection(lines, i, sec);
      sections.push(sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => sectionEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7). Written here.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const info = fileInfo(cur);
    const found = findTier(info.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const items: NItem[] = newLines.map((t) => ({ text: t }));
    const repl = buildN(info.lines, pos, oldLines, items, found.tier);
    const lines = [...info.lines];
    lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, linesToText(lines, info.br, info.ends));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let sep = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    let rep = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < n; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (sep < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, rep);
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevReplace = rep;
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8). Written here.
// ---------------------------------------------------------------------------

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function isVSectionStart(l: string): boolean {
  return l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
}

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NItem[];
  eof: boolean;
}

function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  const edit: Edit = (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const info = fileInfo(cur);
    const lines = [...info.lines];
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundPos = -1;
        outer: for (const t of tiers) {
          for (let idx = cursor; idx < lines.length; idx++) {
            if (normLine(lines[idx]!, t) === normLine(ch.anchor!, t)) {
              foundPos = idx;
              break outer;
            }
          }
        }
        if (foundPos < 0) throw new Fail('no-match', path);
        cursor = foundPos + 1;
      }
      if (ch.o.length === 0) {
        const ins = ch.eof ? lines.length : cursor;
        const add = ch.n.map((it) => it.text);
        lines.splice(ins, 0, ...add);
        cursor = ins + add.length;
        continue;
      }
      let chosen: { tier: number; pos: number } | null = null;
      for (const t of tiers) {
        const occ = occurrences(lines, ch.o, t).filter((p) => p >= cursor && (!ch.eof || p + ch.o.length === lines.length));
        if (occ.length > 0) {
          chosen = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (chosen === null) throw new Fail('no-match', path);
      const repl = buildN(lines, chosen.pos, ch.o, ch.n, chosen.tier);
      lines.splice(chosen.pos, ch.o.length, ...repl);
      cursor = chosen.pos + repl.length;
    }
    const out = linesToText(lines, info.br, info.ends);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
    } else {
      tree.now.set(path, out);
    }
  };
  if (moveTo !== null) edit.moves = [[path, moveTo]];
  return edit;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const line = lines[i]!;
    const lineNo = i + 1;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith(V_ADD)) {
      kind = 'add';
      path = line.slice(V_ADD.length).trim();
    } else if (line.startsWith(V_DEL)) {
      kind = 'delete';
      path = line.slice(V_DEL.length).trim();
    } else if (line.startsWith(V_UPD)) {
      kind = 'update';
      path = line.slice(V_UPD.length).trim();
    } else {
      throw new Exit2(`error: parse ${lineNo}`);
    }
    let j = i + 1;
    while (j < last && !isVSectionStart(lines[j]!)) j += 1;
    let rawEnd = j;
    while (rawEnd > i + 1 && blank(lines[rawEnd - 1]!)) rawEnd -= 1;
    const body = lines.slice(i + 1, rawEnd);
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(vAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(vDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith(V_MOVE)) {
        moveTo = body[0]!.slice(V_MOVE.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      for (; k < body.length; k++) {
        const bl = body[k]!;
        const ln = i + 2 + k;
        if (bl.startsWith('@@')) {
          cur = { anchor: bl.slice(2).trim(), o: [], n: [], eof: false };
          chunks.push(cur);
          firstChunk = false;
          continue;
        }
        if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (bl.startsWith(V_MOVE)) throw new Exit2(`error: parse ${ln}`);
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl === '') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${ln}`);
            cur = { anchor: null, o: [], n: [], eof: false };
            chunks.push(cur);
            firstChunk = false;
          }
          if (bl === '') {
            const idx = cur.o.length;
            cur.o.push('');
            cur.n.push({ text: '', ctx: idx });
          } else if (bl.startsWith(' ')) {
            const idx = cur.o.length;
            const t = bl.slice(1);
            cur.o.push(t);
            cur.n.push({ text: t, ctx: idx });
          } else if (bl.startsWith('-')) {
            cur.o.push(bl.slice(1));
          } else {
            cur.n.push({ text: bl.slice(1) });
          }
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
      if (edit.moves !== undefined) {
        for (const m of edit.moves) moves.push(m);
      }
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: cache every original before writing anything, then merge a
  // successful move's D and A rows into one R row (section 2).
  const origMap = new Map<string, string | null>();
  for (const p of tree.now.keys()) origMap.set(p, tree.original(p));
  const rows = new Map<string, { key: string; text: string }>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = origMap.get(p)!;
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of moves) {
    const oldRow = rows.get(oldP);
    const newRow = rows.get(newP);
    if (oldRow === undefined || newRow === undefined) continue;
    if (!oldRow.text.startsWith('D ') || !newRow.text.startsWith('A ')) continue;
    if (origMap.get(oldP) === null || origMap.get(newP) !== null) continue;
    if (tree.now.get(oldP) !== null || tree.now.get(newP) === null) continue;
    rows.delete(oldP);
    rows.delete(newP);
    rows.set(newP, { key: newP, text: `R ${oldP} -> ${newP}` });
  }
  const sorted = [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...sorted.map((r) => r.text), `ok: ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = origMap.get(p)!;
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPdfPaintPage,
  certifyCanonicalBlock,
  changedGalleyLines,
  galleyLineWitnesses,
} from '../engine/checkpoint/canonical-paint-index.js';
import {
  classifyResidentRun,
  stableRunLayoutRecord,
} from '../engine/checkpoint/run-semantics.js';

const certifiedBackend = {
  schema: 2,
  engine: 'luatex',
  version: 124,
  revision: 0,
  outputMode: 1,
  capture: 'resident-post-linebreak',
  emptyRuleSubtype: 3,
  format: 'test-format',
};

const ruleRun = ({ subtype = 3, widthSp = 0, heightSp = 605_552, depthSp = 0, ...rest } = {}) => ({
  rule: true,
  rv: 2,
  rs: subtype,
  rw: widthSp,
  rh: heightSp,
  rd: depthSp,
  ri: 0,
  rl: 0,
  rr: 0,
  rdir: 'TLT',
  ra: '',
  x: 9.2,
  dy: -8.1,
  w: widthSp / 65_781.76,
  h: (heightSp + depthSp) / 65_781.76,
  c: '#000000',
  ...rest,
});

const lineBox = (text, { width = 240, x = 0, size = 9.2 } = {}) => ({
  k: 'box',
  w: width,
  h: 8.1,
  d: 1.1,
  runs: [{ t: text, x, w: Array.from(text).length * size, s: size, f: 'body', dy: 0, c: '#000000' }],
});

const witnessFor = (text, options) => galleyLineWitnesses({ items: [lineBox(text, options)] })[0];

const candidateFor = ({ page = 1, left = 48, baseline = 80, width = 240 } = {}) => ({
  page,
  x: left,
  y: baseline,
  box: { left, top: baseline - 8.1, right: left + width, bottom: baseline + 2.3 },
});

const paintFor = (text, { page = 1, left = 48, baseline = 80, size = 9.2 } = {}) => ({
  page,
  items: [{
    page,
    left,
    right: left + Array.from(text).length * size,
    baseline,
    paintText: text,
    glyphSizes: Array.from(text, () => size),
    safe: true,
  }],
});

test('only certified LuaTeX empty_rule is omitted from the paint witness', () => {
  const empty = ruleRun();
  const positiveAreaEmpty = ruleRun({ widthSp: 65_782 });
  const normalZeroWidth = ruleRun({ subtype: 0 });
  assert.equal(classifyResidentRun(empty, certifiedBackend).tag, 'LayoutOnly');
  assert.equal(classifyResidentRun(empty, { ...certifiedBackend, engine: 'luahbtex' }).tag, 'LayoutOnly',
    'LaTeX production uses LuaHBTeX with the same certified PDF rule backend');
  assert.equal(classifyResidentRun(positiveAreaEmpty, certifiedBackend).tag, 'LayoutOnly',
    'backend subtype, not zero-area geometry, proves no paint');
  assert.deepEqual(classifyResidentRun(normalZeroWidth, certifiedBackend), {
    tag: 'OtherPaint',
    reason: 'NORMAL_ZERO_AREA_RULE',
  });
  assert.equal(classifyResidentRun(empty, { ...certifiedBackend, version: 84 }).reason, 'PROFILE_MISMATCH');
  assert.equal(classifyResidentRun({ ...empty, rv: 1 }, certifiedBackend).reason, 'RULE_SCHEMA_UNKNOWN');

  const glyph = lineBox('日本語');
  glyph.runs.unshift(empty);
  const witnesses = galleyLineWitnesses({ backend: certifiedBackend, items: [glyph] });
  assert.equal(witnesses?.[0].paintText, '日本語');
  const unsafe = structuredClone(glyph);
  unsafe.runs[0] = normalZeroWidth;
  assert.equal(galleyLineWitnesses({ backend: certifiedBackend, items: [unsafe] }), null,
    'a normal zero-width rule can paint a PDF hairline and fails closed');
});

test('layout-only rule structure remains in the ordered layout witness', () => {
  const beforeItem = lineBox('字');
  beforeItem.runs.unshift(ruleRun());
  const afterItem = structuredClone(beforeItem);
  afterItem.runs[0].rh += 1;
  assert.notDeepEqual(stableRunLayoutRecord(beforeItem.runs[0]), stableRunLayoutRecord(afterItem.runs[0]));
  const before = galleyLineWitnesses({ backend: certifiedBackend, items: [beforeItem] });
  const after = galleyLineWitnesses({ backend: certifiedBackend, items: [afterItem] });
  assert.deepEqual(changedGalleyLines(before, after), [0],
    'a no-paint rule is omitted only from paint matching, never from layout identity');
});

test('negative dimensions and unknown rule schemas never enter the glyph-only path', () => {
  for (const run of [
    ruleRun({ widthSp: -1 }),
    ruleRun({ heightSp: -1 }),
    ruleRun({ depthSp: -1 }),
    { ...ruleRun(), rs: Number.NaN },
    { rule: true, x: 0, dy: 0, w: 0, h: 8 },
  ]) {
    assert.notEqual(classifyResidentRun(run, certifiedBackend).tag, 'LayoutOnly');
  }
  assert.equal(classifyResidentRun(ruleRun({ rest: true, x: -12, dy: -8 }), certifiedBackend).tag, 'LayoutOnly',
    'negative positions are valid and are not confused with dimensions');
});

test('same-baseline left and right columns remain separate SyncTeX windows', () => {
  const witnesses = [witnessFor('LEFT'), witnessFor('RIGHT')];
  const left = candidateFor({ left: 48, baseline: 77 });
  const right = candidateFor({ left: 307, baseline: 77 });
  const paint = {
    page: 1,
    items: [
      paintFor('LEFT', { left: 48, baseline: 77 }).items[0],
      paintFor('RIGHT', { left: 307, baseline: 77 }).items[0],
    ],
  };
  const result = certifyCanonicalBlock({ witnesses, candidates: [right, left], paintPages: [paint] });
  assert.equal(result?.[0].candidate.box.left, 48);
  assert.equal(result?.[1].candidate.box.left, 307);
});

test('an enclosing SyncTeX column box is normalized only after PDF line-paint proof', () => {
  const witness = witnessFor('日本語');
  const enclosing = candidateFor({ left: 48, baseline: 710 });
  enclosing.box.top = 48;
  enclosing.box.bottom = 794;
  const result = certifyCanonicalBlock({
    witnesses: [witness],
    candidates: [enclosing],
    paintPages: [paintFor('日本語', { left: 48, baseline: 710 })],
  });
  assert.deepEqual(result?.[0].candidate.box, {
    left: 48,
    top: 701.9,
    right: 288,
    bottom: 711.1,
  });
  const missesBaseline = structuredClone(enclosing);
  missesBaseline.box.bottom = 700;
  assert.equal(certifyCanonicalBlock({
    witnesses: [witness],
    candidates: [missesBaseline],
    paintPages: [paintFor('日本語', { left: 48, baseline: 710 })],
  }), null);
});

test('an arbitrary visual line maps across a page boundary without page-flow guessing', () => {
  const texts = Array.from({ length: 7 }, (_, index) => `行${index}固有`);
  const witnesses = texts.map((text) => witnessFor(text));
  const candidates = texts.map((text, index) => candidateFor({
    page: index < 5 ? 20 : 21,
    left: index < 5 ? 307 : 48,
    baseline: index < 5 ? 700 + index * 14 : 61 + (index - 5) * 16,
  }));
  const paintPages = [20, 21].map((page) => ({
    page,
    items: texts.flatMap((text, index) => candidates[index].page === page
      ? paintFor(text, {
          page,
          left: candidates[index].box.left,
          baseline: candidates[index].y,
        }).items
      : []),
  }));
  const result = certifyCanonicalBlock({
    witnesses,
    candidates: [...candidates].reverse(),
    paintPages,
  });
  assert.equal(result?.length, 7);
  assert.equal(result?.[6].candidate.page, 21);
  assert.equal(result?.[6].candidate.box.left, 48);
  assert.equal(result?.[6].candidate.y, 77);
});

test('duplicate physical occurrences fail closed instead of choosing by order or area', () => {
  const witnesses = [witnessFor('重複行')];
  const first = candidateFor({ page: 1, left: 48, baseline: 80 });
  const second = candidateFor({ page: 2, left: 48, baseline: 80 });
  assert.equal(certifyCanonicalBlock({
    witnesses,
    candidates: [first, second],
    paintPages: [
      paintFor('重複行', { page: 1, left: 48, baseline: 80 }),
      paintFor('重複行', { page: 2, left: 48, baseline: 80 }),
    ],
  }), null);
});

test('duplicate raw nodes for one exact hbox are deduplicated, not treated as two outputs', () => {
  const witness = witnessFor('一意行');
  const candidate = candidateFor({ page: 3, left: 307, baseline: 120 });
  const result = certifyCanonicalBlock({
    witnesses: [witness],
    candidates: [candidate, structuredClone(candidate), structuredClone(candidate)],
    paintPages: [paintFor('一意行', { page: 3, left: 307, baseline: 120 })],
  });
  assert.equal(result?.length, 1);
});

test('the base-to-current effect set includes every changed visual line', () => {
  const base = galleyLineWitnesses({ items: ['a', 'b', 'c', 'd', 'e', 'f'].map((text) => lineBox(text)) });
  const current = galleyLineWitnesses({ items: ['a', 'B', 'c', 'd', 'e', 'F'].map((text) => lineBox(text)) });
  assert.deepEqual(changedGalleyLines(base, current), [1, 5]);
  const reflowed = current.map((line) => ({ ...line }));
  reflowed[4].lineWidth += 1;
  assert.equal(changedGalleyLines(base, reflowed), null, 'external line geometry change fails closed');
});

test('operator-list glyph identity and TextContent geometry must agree exactly', () => {
  const OPS = {
    setFont: 1,
    showText: 2,
    save: 3,
    restore: 4,
    setTextRenderingMode: 5,
    clip: 6,
    eoClip: 7,
    paintFormXObjectBegin: 8,
    paintFormXObjectEnd: 9,
    beginMarkedContent: 10,
    beginMarkedContentProps: 11,
    endMarkedContent: 12,
  };
  const Util = {
    transform(left, right) {
      return [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5],
      ];
    },
  };
  const glyph = (unicode) => ({ unicode, isSpace: false, isInFont: true, accent: null });
  const base = {
    pageNumber: 1,
    viewport: { transform: [1, 0, 0, -1, 0, 842], rotation: 0 },
    OPS,
    Util,
    textContent: {
      items: [{
        str: 'AB', dir: 'ltr', width: 18.4, height: 9.2,
        transform: [9.2, 0, 0, 9.2, 48, 765],
      }],
    },
    operatorList: {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['body', 9.2], [[glyph('A'), glyph('B')]]],
    },
  };
  const page = buildPdfPaintPage(base);
  assert.equal(page?.items[0].baseline, 77);
  assert.equal(page?.items[0].paintText, 'AB');
  assert.deepEqual(page?.items[0].glyphSizes, [9.2, 9.2]);
  assert.equal(buildPdfPaintPage({
    ...base,
    operatorList: { ...base.operatorList, argsArray: [['body', 9.2], [[glyph('A'), glyph('C')]]] },
  }), null, 'text extraction disagreement rejects the entire page index');
  const marked = buildPdfPaintPage({
    ...base,
    operatorList: {
      fnArray: [OPS.beginMarkedContentProps, OPS.setFont, OPS.showText, OPS.endMarkedContent],
      argsArray: [['Span'], ['body', 9.2], [[glyph('A'), glyph('B')]], []],
    },
  });
  assert.equal(marked.items.length, 1);
  assert.equal(marked.items[0].safe, false, 'marked/ActualText-like paint is not certified');
  const form = buildPdfPaintPage({
    ...base,
    operatorList: {
      fnArray: [OPS.paintFormXObjectBegin, OPS.setFont, OPS.showText, OPS.paintFormXObjectEnd],
      argsArray: [[], ['body', 9.2], [[glyph('A'), glyph('B')]], []],
    },
  });
  assert.equal(form.items.length, 1);
  assert.equal(form.items[0].safe, false, 'form reuse is not certified');
});

test('randomized arbitrary line counts and candidate orders keep a unique mapping', () => {
  let seed = 0x6d2b79f5;
  const random = () => {
    seed = (Math.imul(seed ^ seed >>> 15, 1 | seed) + 0x6d2b79f5) | 0;
    return ((seed ^ seed >>> 14) >>> 0) / 0x100000000;
  };
  for (let round = 0; round < 250; round++) {
    const count = 1 + Math.floor(random() * 40);
    const witnesses = [];
    const candidates = [];
    const pages = new Map();
    for (let index = 0; index < count; index++) {
      const text = `R${round}L${index}`;
      const page = 1 + Math.floor(index / 12);
      const column = index % 2;
      const left = column ? 307 : 48;
      const baseline = 60 + Math.floor(index / 2) % 6 * 16;
      witnesses.push(witnessFor(text));
      candidates.push(candidateFor({ page, left, baseline }));
      if (!pages.has(page)) pages.set(page, { page, items: [] });
      pages.get(page).items.push(paintFor(text, { page, left, baseline }).items[0]);
    }
    candidates.sort(() => random() - 0.5);
    const result = certifyCanonicalBlock({ witnesses, candidates, paintPages: [...pages.values()] });
    assert.equal(result?.length, count, `round ${round}, ${count} lines`);
    for (let index = 0; index < count; index++) {
      assert.equal(result[index].candidate.box.left, index % 2 ? 307 : 48);
    }
  }
});

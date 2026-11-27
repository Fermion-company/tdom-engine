import { test } from 'node:test';
import { captureCanonicalAnchorBase, planTerminalCanonicalAnchor } from '../engine/checkpoint/canonical-anchor.js';
import assert from 'node:assert/strict';
import {
  buildPdfPaintPage,
  certifyCanonicalBlock,
  changedGalleyLines,
  changedTextSpan,
  mixedGalleyFrame,
  galleyLineWitnesses,
  galleyMixedLineWitnesses,
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

const lineBox = (text, { width = 240, x = 0, size = 9.2, color = '#000000' } = {}) => ({
  k: 'box',
  w: width,
  h: 8.1,
  d: 1.1,
  runs: [{ t: text, x, w: Array.from(text).length * size, s: size, f: 'body', dy: 0, c: color }],
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
    glyphColors: Array.from(text, () => '#000000'),
    safe: true,
  }],
});

test('mixed line repaint admits native text confined to a slot beside an unchanged formula', () => {
  const line = lineBox('温度');
  const formula = { ...line.runs[0], t: 'n', m: 1, s: 7, x: 22, dy: 2, w: 4 };
  line.runs.push(formula);
  const base = { items: [line], backend: certifiedBackend };
  const project = (modify, native = true) => {
    const current = structuredClone(base);
    current.items[0].runs[0].t = '湿度';
    modify?.(current);
    return changedTextSpan(mixedGalleyFrame(base, [null]), mixedGalleyFrame(current, [null]),
      current, [null], [null], () => native);
  };
  const span = project();
  assert.equal(span.oldWitness.paintText, '温度');
  assert.equal(span.newWitness.paintText, '湿度');
  assert.deepEqual(span.runs.map(run => run.t), ['湿度']);
  assert.equal(project(undefined, false), null);
  assert.equal(project(g => { g.items[0].runs[0].w++; }).expands, true);
  assert.equal(project(g => { g.items[0].runs[0].w += 4; }), null);
  assert.equal(project(g => { g.items[0].runs[1].dy++; }), null);
  assert.equal(project(g => { g.items[0].h++; }), null);
  assert.equal(project(g => { g.trail = 'changed'; }), null);
  formula.x = 18.7;
  assert.equal(project(), null, 'unchanged adjacent math must still clear the text mask');
});

test('reflow into a mixed line repaints all changed plain rows and preserves their slots', () => {
  const last = lineBox('日');
  last.runs.push({ ...last.runs[0], t: 'n', m: 1, s: 7, x: 32, dy: 2, w: 4 });
  const base = { items: [lineBox('測定'), lineBox('午後'), last], backend: certifiedBackend };
  const current = structuredClone(base);
  current.items[0].runs[0].t = '外気';
  current.items[1].runs[0].t = '測定';
  current.items[2].runs[0].t = '温';
  const change = () => {
    const before = galleyMixedLineWitnesses(base), after = galleyMixedLineWitnesses(current);
    return changedTextSpan(mixedGalleyFrame(base, before), mixedGalleyFrame(current, after),
      current, before, after, () => true);
  };
  assert.deepEqual(change()?.changedPlainLines, [0, 1]);
  assert.equal(change().index, 2);
  const source = '測定午後日$n$';
  const block = (galley, text) => ({
    id: 'paragraph', text, start: 0, end: text.length,
    galley: { ...galley, epochs: [1, 1, 1], closure: 'native', trail: 'unchanged' },
    stateVec: '[1,2,3,4,5,6,7,8]', fidelity: { level: 'exact-preview-required', itemFlags: [0, 0, 1] },
    editRegions: [{ kind: 'text', contentStart: 0, contentEnd: text.indexOf('$') }],
  });
  const edit = { start: 0, end: 5, text: '外気測定温' };
  const dom = { id: 'paragraph', span: { start: 0, end: source.length },
    source: { file: 'main.tex', start: { line: 1, column: 1 }, end: { line: 1, column: source.length + 1 } } };
  const certificate = { id: 1, rev: 1, inputEpoch: 1, pdfHash: 'pdf', synctexHash: 'synctex' };
  const baseSnapshot = captureCanonicalAnchorBase({ blocks: [block(base, source)], domBlocks: [dom], edit, certificate });
  const report = { mode: 'structured', previewPolicy: 'canonical-anchor', srcRev: 2, canonical: { id: 1, rev: 1, pageCount: 1 },
    patches: [], dirtySourceNodes: ['src-paragraph'] };
  const plan = planTerminalCanonicalAnchor({ blocks: [block(current, edit.text + '$n$')], domBlocks: [dom], edit, report, baseSnapshot,
    geometry: { textheight: 680, paintCallbacks: 'none' }, paintContext: { fonts: new Map([['body', { tier: 'native' }]]) } });
  assert.deepEqual(plan?.provisionalPages, [], 'an unchanged chunk claims no provisional page');
  assert.deepEqual(plan.linePlans.map(line => line.commands.map(cmd => cmd.text).join('')), ['外気', '測定', '温']);
  current.items[1].d++;
  assert.equal(change(), null, 'line depths must still match the printed paragraph');
});

test('a moved math tail needs a rigid translation and its original PDF paint', () => {
  const line = lineBox('温度');
  line.runs.push({ ...line.runs[0], t: 'x', x: 24, w: 5, m: 1 },
    { ...line.runs[0], t: 'n', x: 29, w: 4, s: 7, dy: 1, m: 1 });
  const base = { items: [line], backend: certifiedBackend };
  const current = structuredClone(base);
  const [prefix, x, n] = current.items[0].runs;
  prefix.t += '差';
  prefix.w += 9.2;
  x.x += 9.2;
  n.x += 9.2;
  const change = () => changedTextSpan(mixedGalleyFrame(base, [null]), mixedGalleyFrame(current, [null]),
    current, [null], [null], () => true);
  const span = change();
  assert.ok(span.expands);
  const paint = paintFor('温度');
  paint.items.push({ ...paintFor('x', { left: 72 }).items[0], right: 77 },
    { ...paintFor('n', { left: 77, size: 7, baseline: 81 }).items[0], right: 81 });
  const match = () => certifyCanonicalBlock({ witnesses: [span.oldWitness], candidates: [candidateFor()], paintPages: [paint] });
  assert.equal(match(), null, 'a page containing unaccounted graphics cannot be copied');
  paint.cropSafe = true;
  assert.ok(match());
  paint.items.at(-1).baseline = 80;
  assert.equal(match(), null, 'the printed subscript must be on the witnessed baseline');
  paint.items.at(-1).baseline = 81;
  paint.items.push({ ...paint.items.at(-1), paintText: 'z' });
  assert.equal(match(), null, 'overlaid text does not belong to the tail');
  n.x += 1;
  assert.equal(change(), null, 'two different horizontal offsets are not a translation');
  n.x -= 1;
  n.t = 'k';
  assert.equal(change(), null, 'an edited formula cannot reuse its old pixels');
});

test('a fraction between text runs can move only with its exact printed bar', () => {
  const line = lineBox('温度');
  const glyph = (t, x, dy) => ({ ...line.runs[0], t, x, w: 4, s: 7, dy, m: 1 });
  const bar = { ...ruleRun({ subtype: 0 }), x: 23, dy: -2, w: 4, h: 0.4, rw: -1073741824 };
  line.runs.push(glyph('x', 23, -3), bar, glyph('n', 23, 1));
  const base = { items: [line], backend: certifiedBackend }, current = structuredClone(base);
  current.items[0].runs[0].t += '差';
  current.items[0].runs[0].w += 9.2;
  for (const run of current.items[0].runs.slice(1)) run.x += 9.2;
  const change = changedTextSpan(mixedGalleyFrame(base, [null]), mixedGalleyFrame(current, [null]),
    current, [null], [null], () => true);
  assert.ok(change);
  const paint = paintFor('温度');
  for (const [letter, baseline] of [['x', 77], ['n', 81]]) {
    paint.items.push({ ...paintFor(letter, { left: 71, baseline, size: 7 }).items[0], right: 75 });
  }
  paint.cropRules = [{ left: 71, right: 75, top: 78, bottom: 78.4 }];
  const match = () => certifyCanonicalBlock({ witnesses: [change.oldWitness], candidates: [candidateFor()], paintPages: [paint] });
  assert.ok(match());
  paint.cropRules[0].right += 0.2;
  assert.equal(match(), null, 'the width of the printed bar must agree');
  paint.cropRules[0].right -= 0.2;
  paint.cropRules.push({ left: 55, right: 61, top: 75, bottom: 76 });
  assert.equal(match(), null, 'an unrelated stroke behind the new text must stay visible');
});

test('a native punctuation glyph can have advance overlapping the neighbouring formula', () => {
  const line = lineBox('温度');
  const punctuation = { ...line.runs[0], t: '。', x: 18, w: 9.2, ink: [0.38, 2.98] };
  const formula = { ...line.runs[0], t: 'x', m: 1, x: 26, w: 5 };
  line.runs.push(punctuation, formula);
  const base = { items: [line], backend: certifiedBackend };
  const check = () => {
    const current = structuredClone(base);
    current.items[0].runs[0].t = '湿度';
    return changedTextSpan(mixedGalleyFrame(base, [null]), mixedGalleyFrame(current, [null]),
      current, [null], [null], () => true);
  };
  assert.equal(check().oldWitness.inkRight, 20.98);
  punctuation.t = '文';
  assert.equal(check(), null);
  punctuation.t = '。';
  delete punctuation.ink;
  assert.equal(check(), null);
});

test('partial paint normalizes the SyncTeX box of a line with an overhanging last glyph', () => {
  const witness = { ...witnessFor('温度'), partial: true, frameLeft: 0, frameRight: 244.6 };
  const match = width => certifyCanonicalBlock({ witnesses: [witness],
    candidates: [candidateFor({ width })], paintPages: [paintFor('温度')] });
  assert.ok(match(244.6));
  assert.equal(match(246), null);
});

test('a partial text witness rejects ambiguous, overlapping or unsafe canonical paint', () => {
  const witness = { ...witnessFor('温度'), partial: true };
  const candidate = candidateFor(), texts = paintFor('温度'), math = paintFor('n', { left: 74 });
  const certify = (item, candidates = [candidate]) => certifyCanonicalBlock({ witnesses: [witness],
    candidates, paintPages: [{ page: 1, items: [...texts.items, item] }] });
  assert.ok(certify(math.items[0]));
  assert.equal(certify({ ...math.items[0], left: 58, baseline: 81 }), null);
  assert.equal(certify({ ...math.items[0], left: 58, safe: false }), null);
  assert.equal(certify({ ...math.items[0], left: 61, right: 70 }), null);
  assert.equal(certify({ ...math.items[0], left: 48, right: texts.items[0].right }), null);
});

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

test('one line reported through several enclosing boxes is one slot, not an ambiguity (tex64-internal #66)', () => {
  // two-column SyncTeX: each source line of a paragraph returns the line's
  // baseline and horizontal extent through the column vbox and its parents
  const texts = ['前方参照は番号', '後段処理に依存', '浮動体位置Q'];
  const witnesses = texts.map((text) => witnessFor(text));
  const candidates = texts.flatMap((text, index) => [700, 60, 48].map((top) => {
    const candidate = candidateFor({ page: 6, left: 307, baseline: 324 + index * 16 });
    candidate.box.top = top;
    candidate.box.bottom = 794 - top / 4;
    return candidate;
  })).filter((candidate) => candidate.box.top <= candidate.y);
  const paint = {
    page: 6,
    items: texts.flatMap((text, index) => paintFor(text, { page: 6, left: 307, baseline: 324 + index * 16 }).items),
  };
  const result = certifyCanonicalBlock({ witnesses, candidates, paintPages: [paint] });
  assert.equal(result?.length, 3);
  assert.deepEqual(result.map((entry) => entry.candidate.y), [324, 340, 356]);
  assert.ok(result.every((entry) => entry.candidate.box.bottom - entry.candidate.box.top < 12),
    'the certified slot takes its height from the witness, whichever report it came through');
});

test('a JFM half-width punctuation mark may overhang the next paint item, nothing else may (tex64-internal #66)', () => {
  // 「…得る。Q」: the 。 item ends a full em after its start, TeX set the Q
  // half an em in (ltjsarticle, two-column stress paper)
  const size = 9.2;
  const witness = {
    ...witnessFor('変わり得る。Q'),
    contentRight: 5.5 * size + 7.75,
  };
  const paint = (lastText, overlap) => ({
    page: 1,
    items: [
      { page: 1, left: 48, right: 48 + Array.from(lastText).length * size, baseline: 80, paintText: lastText,
        glyphSizes: Array.from(lastText, () => size), glyphColors: Array.from(lastText, () => '#000000'), safe: true },
      { page: 1, left: 48 + Array.from(lastText).length * size - overlap, right: 48 + 5.5 * size + 7.75, baseline: 80,
        paintText: 'Q', glyphSizes: [size], glyphColors: ['#000000'], safe: true },
    ],
  });
  witness.glyphSizes = Array.from('変わり得る。Q', () => size);
  const certify = (lastText, overlap, w = witness) => certifyCanonicalBlock({
    witnesses: [w], candidates: [candidateFor({ page: 1, left: 48, baseline: 80 })], paintPages: [paint(lastText, overlap)],
  });
  assert.equal(certify('変わり得る。', size / 2)?.length, 1, 'the 。 item reaches half an em into the Q');
  assert.equal(certify('変わり得る。', size / 2 + 1), null, 'more than half an em is not JFM layout');
  const plain = { ...witnessFor('変わり得るよQ'), contentRight: witness.contentRight, glyphSizes: witness.glyphSizes };
  assert.equal(certify('変わり得るよ', size / 2, plain), null, 'an ordinary glyph never overlaps its successor');
});

test('a line whose JFM-boxed 、 overflows it certifies through SyncTeX\'s visible box (tex64-internal #66)', () => {
  // the 、 glyph advances a full em inside its half-em JFM box, so the line
  // paints half an em past its 240 bp box and SyncTeX reports that extent
  const size = 9.2;
  const text = 'を同時に検査すると、';
  const overflowing = { ...witnessFor(text, { width: 240, size }) };
  overflowing.contentRight = 240 + size / 2;
  const paint = paintFor(text, { page: 2, left: 48, baseline: 378, size });
  paint.items[0].right = 48 + 240 + size / 2;
  const visible = candidateFor({ page: 2, left: 48, baseline: 378, width: 240 + size / 2 });
  const column = candidateFor({ page: 2, left: 48, baseline: 378, width: 240 });
  const result = certifyCanonicalBlock({ witnesses: [overflowing], candidates: [visible], paintPages: [paint] });
  assert.equal(result?.length, 1);
  assert.equal(result[0].candidate.box.left, 48);
  assert.equal(result[0].candidate.box.right, 288, 'the anchor keeps the resident line box, not the visible extent');
  assert.equal(certifyCanonicalBlock({ witnesses: [overflowing], candidates: [visible, column], paintPages: [paint] })?.length, 1,
    'the visible box and the column box of one line are one slot');
  const fitting = { ...overflowing, contentRight: 240 };
  const fittingPaint = paintFor(text, { page: 2, left: 48, baseline: 378, size });
  fittingPaint.items[0].right = 288;
  assert.equal(certifyCanonicalBlock({ witnesses: [fitting], candidates: [visible], paintPages: [fittingPaint] }), null,
    'a wider box is only a visible extent when the resident line overflows by exactly that much');
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
  // tex64-internal #66: a disagreement costs the items it touches, not the
  // whole page. They carry no size and are never certified.
  const disagreed = buildPdfPaintPage({
    ...base,
    operatorList: { ...base.operatorList, argsArray: [['body', 9.2], [[glyph('A'), glyph('C')]]] },
  });
  assert.equal(disagreed.items[0].safe, false, 'a glyph text extraction disagrees with is never certified');
  assert.ok(disagreed.items[0].glyphSizes.some(Number.isNaN));
  const line = (str, y) => ({ str, dir: 'ltr', width: 9.2 * str.length, height: 9.2, transform: [9.2, 0, 0, 9.2, 48, y] });
  const delimiter = buildPdfPaintPage({
    ...base,
    textContent: { items: [line('max(0,R', 765), line('next line', 750)] },
    operatorList: {
      fnArray: [OPS.setFont, OPS.showText],
      // an extensible delimiter painted without a Unicode mapping
      argsArray: [['body', 9.2], [[...'max0,Rnextline'].map(glyph)]],
    },
  });
  assert.ok(delimiter, 'one unmapped delimiter keeps the page index');
  assert.equal(delimiter.items[0].safe, false);
  assert.equal(delimiter.items[1].safe, true, 'the next line still certifies');
  assert.deepEqual(delimiter.items[1].glyphSizes, Array(8).fill(9.2));
  assert.equal(buildPdfPaintPage({
    ...base,
    operatorList: { ...base.operatorList, argsArray: [['body', 9.2], [[...'QRSTUVWXYZQRSTUVWXYZ'].map(glyph)]] },
  }), null, 'text that never realigns still rejects the entire page index');
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

test('a copied bar must be an isolated, solid horizontal stroke', () => {
  const OPS = { save: 1, transform: 2, setDash: 3, setLineCap: 4, setLineWidth: 5, constructPath: 6, restore: 7, stroke: 8 };
  const args = [[], [1, 0, 0, 1, 10, 50], [[], 0], [0], [0.5], [OPS.stroke, [[0, 0, 0, 1, 5, 0]]], []];
  const page = () => buildPdfPaintPage({ pageNumber: 1, OPS, Util, textContent: { items: [] },
    viewport: { transform: [1, 0, 0, -1, 0, 100] },
    operatorList: { fnArray: [1, 2, 3, 4, 5, 6, 7], argsArray: args } });
  assert.equal(page().cropSafe, false, 'a line is paint even when no text is present');
  assert.deepEqual(page().cropRules, [{ left: 10, right: 15, top: 49.75, bottom: 50.25 }]);
  args[5][1][0][5] = 1;
  assert.equal(page().cropRules, null, 'a diagonal path is not a printed fraction bar');
  args[5][1][0][5] = 0;
  args[2][0] = [1, 2];
  assert.equal(page().cropRules, null, 'a dashed line cannot be copied as a solid bar');
  args[2][0] = [];
  args[4][0] = 0;
  assert.equal(page().cropRules, null, 'a device hairline has no fixed width in paper units');
});

test('every canonical glyph must be filled in the color its witness paints', () => {
  const OPS = {
    setFont: 1, showText: 2, save: 3, restore: 4,
    paintFormXObjectBegin: 8, paintFormXObjectEnd: 9,
    setFillRGBColor: 13, setFillColorN: 14, setFillTransparent: 15,
  };
  const glyph = (unicode) => ({ unicode, isSpace: false, isInFont: true, accent: null });
  // pdf.js reports every fill as setFillRGBColor with a hex string
  const page = (before) => buildPdfPaintPage({
    pageNumber: 1,
    viewport: { transform: [1, 0, 0, -1, 0, 842], rotation: 0 },
    OPS,
    Util,
    textContent: {
      items: [{ str: 'AB', dir: 'ltr', width: 18.4, height: 9.2, transform: [9.2, 0, 0, 9.2, 48, 765] }],
    },
    operatorList: {
      fnArray: [...before.map(([name]) => OPS[name]), OPS.setFont, OPS.showText],
      argsArray: [...before.map(([, ...args]) => args), ['body', 9.2], [[glyph('A'), glyph('B')]]],
    },
  });
  const certifies = (before, color = '#000000') => certifyCanonicalBlock({
    witnesses: galleyLineWitnesses({ items: [lineBox('AB', { color })] }),
    candidates: [candidateFor({ baseline: 77 })],
    paintPages: [page(before)],
  }) !== null;
  assert.equal(certifies([]), true, 'the page starts black');
  assert.equal(certifies([['setFillRGBColor', '#ff0000']]), false,
    'a color the resident runs never saw would be repainted black');
  assert.equal(certifies([['setFillRGBColor', '#ff0000']], '#ff0000'), true);
  assert.equal(certifies([], '#ff0000'), false);
  assert.equal(certifies([['save'], ['setFillRGBColor', '#ff0000'], ['restore']]), true);
  assert.equal(certifies([['paintFormXObjectBegin'], ['setFillRGBColor', '#ff0000'], ['paintFormXObjectEnd']]), true,
    "a form's fill color ends with the form");
  assert.equal(certifies([['setFillRGBColor', '#2c2e35']]), true, 'pdf.js turns DeviceCMYK black into #2c2e35');
  assert.equal(certifies([['setFillColorN', 'TilingPattern']]), false, 'a pattern is no witnessed color');
  assert.equal(certifies([['setFillTransparent']]), false);
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

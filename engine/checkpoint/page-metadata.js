import { fnv1a } from '../hash.js';
import { formatFolio } from './util/tex.js';

const stateKeys = new WeakMap();
export function furnitureStateKey(state) {
  if (!state) return '';
  let key = stateKeys.get(state);
  if (key === undefined) {
    key = fnv1a(JSON.stringify(state));
    stateKeys.set(state, key);
  }
  return key;
}

const furniturePageKeys = new WeakMap();
export function furniturePageKey(page) {
  let key = furniturePageKeys.get(page);
  if (key === undefined) {
    key = JSON.stringify([page.number, page.folio, !!page.floatPage, !!page.topFloats?.length,
      !!page.botFloats?.length, [...new Set((page.draw ?? []).map(({ u }) => u?.blockId))], page.evs ?? []]);
    furniturePageKeys.set(page, key);
  }
  return key;
}

// The furniture uses events and recorder continuity even if the galley's
// display units are unchanged.
const furnitureGalleyKeys = new WeakMap();
export function furnitureGalleyKey(galley) {
  if (!galley) return '';
  let key = furnitureGalleyKeys.get(galley);
  if (key === undefined) {
    const state = galley.furniture;
    const events = (galley.events ?? []).map(({ covered, ...event }) => event);
    key = JSON.stringify([state?.before, state?.after, state?.folios, events]);
    furnitureGalleyKeys.set(galley, key);
  }
  return key;
}

function furnitureWitnesses(blocks) {
  const witnesses = new Map();
  let prior, lastRecorded;
  for (const [index, block] of blocks.entries()) {
    const galley = block.galley;
    const state = galley?.furniture;
    if (!state || state.source !== block.text) {
      prior = null;
      continue;
    }
    if (index === 0 || state.before === prior) {
      witnesses.set(block.id, state);
      lastRecorded = state;
      prior = state.after;
    } else {
      // An isolated block or an owed walk can break the full-state chain.
      // Keep both observations so a slot can still use the values they
      // agree on, even when unrelated controls differ.
      witnesses.set(block.id, { ...state, inherited: lastRecorded ?? { values: [] } });
      prior = null;
    }
  }
  return witnesses;
}

function furnitureState(values, guarded = false, uncertain = [], covered = null) {
  return { values: values ?? [], uncertain, ...(guarded ? { guarded: true } : {}), ...(covered ? { covered } : {}) };
}

const observedStates = new WeakMap();
function stateFromWitness(witness, values, covered) {
  let state = values && observedStates.get(values);
  if (!state || (state.covered ?? null) !== (covered ?? null)) {
    state = furnitureState(values, false, [], covered);
    if (values) observedStates.set(values, state);
  }
  return witness.inherited ? agreeingState(witness.inherited, state) : state;
}

const agreements = new WeakMap();
function agreeingState(before, after) {
  let withBefore = agreements.get(before);
  if (!withBefore) {
    withBefore = new WeakMap();
    agreements.set(before, withBefore);
  }
  const priorResult = withBefore.get(after);
  if (priorResult) return priorResult;
  const prior = new Map(before.values.map((item) => [item[0], item]));
  const uncertain = new Set(prior.keys());
  const matching = [];
  for (const item of after.values) {
    const [name, fingerprint, kind] = item;
    const previous = prior.get(name);
    if (previous?.[1] === fingerprint) {
      matching.push(kind && kind === previous[2] && item[3] === previous[3] ? item : [name, fingerprint, '', '']);
      uncertain.delete(name);
    } else uncertain.add(name);
  }
  for (const name of [...(before.uncertain ?? []), ...(after.uncertain ?? [])]) uncertain.add(name);
  let covered = before.covered ?? after.covered;
  if (before.covered && after.covered && before.covered !== after.covered) {
    const right = new Set(after.covered);
    covered = before.covered.filter((name) => right.has(name));
  }
  const state = { ...furnitureState(matching.filter(([name]) => !uncertain.has(name)), false, [...uncertain].sort(), covered), bridged: true };
  withBefore.set(after, state);
  return state;
}

function fillUncovered(state, bridge) {
  if (!state.covered || !bridge || bridge.covered) return state;
  const covered = new Set(state.covered);
  covered.add('$font');
  covered.add('$color');
  const values = [...state.values, ...bridge.values.filter(([name]) => !covered.has(name))];
  values.sort(([a], [b]) => a < b ? -1 : Number(a > b));
  const uncertain = [...state.uncertain, ...bridge.uncertain.filter((name) => !covered.has(name))].sort();
  return { ...furnitureState(values, state.guarded, uncertain), bridged: true };
}

const EMPTY_CONTENTS = Object.freeze({ toc: '\n', lof: '\n', lot: '\n' });
const EMPTY_TOC = Object.freeze({ hash: fnv1a(JSON.stringify(EMPTY_CONTENTS)), contents: EMPTY_CONTENTS });

/**
 * Regenerate the contents files (toc / lof / lot) from the toclines the
 * daemon captured off \addcontentsline — the entries are TeX's own,
 * already expanded with the class's real numbering; the orchestrator
 * substitutes only the page number, which it owns (it builds the pages).
 */
export function computeToc(pages, blocks, initialStyle) {
  if (!blocks.some((block) => block.galley?.toclines?.length)) return EMPTY_TOC;
  // toc entries print the FOLIO (roman front matter, arabic body...), not
  // the physical page index — take it from the page specs, formatted with
  // the kernel's \@arabic/\@roman/... transcriptions
  const specs = pageSpecs(pages, blocks, initialStyle, { furniture: false });
  const folioText = new Map(specs.map((s) => [s.page, formatFolio(s.folio, s.fmt)]));
  const blockPage = new Map();
  for (const page of pages) {
    for (const d of page.draw ?? []) {
      const bid = d.u?.blockId;
      if (bid && !blockPage.has(bid)) blockPage.set(bid, page.number);
    }
    for (const f of page.floats ?? []) {
      const bid = f.blockId ?? f.id?.split('#')[0];
      if (bid && !blockPage.has(bid + '#float')) blockPage.set(bid + '#float', page.number);
    }
  }
  // toclines are stream-anchored (tdom:tl markers): the entry's page is
  // the page its marker landed on, exact even inside multi-page blocks
  const tlPage = new Map();
  for (const page of pages) {
    for (const r of page.tls ?? []) tlPage.set(`${r.bid}:${r.i}`, page.number);
  }
  const files = { toc: [], lof: [], lot: [] };
  for (const block of blocks) {
    (block.galley?.toclines ?? []).forEach((tl, idx) => {
      const ext = tl.e ?? 'toc';
      if (!files[ext]) files[ext] = [];
      if (tl.l === '@raw') {
        // \addtocontents material (inter-group \addvspace etc.): replayed
        // verbatim in document order between the entries
        files[ext].push(tl.t);
        return;
      }
      // float captions (lof/lot) sit on the page the float landed on when
      // known; everything else on the page its stream marker reached
      const page =
        (ext !== 'toc' ? blockPage.get(block.id + '#float') : undefined) ??
        tlPage.get(`${block.id}:${idx}`) ??
        blockPage.get(block.id) ??
        1;
      // 4th (destination) argument required by LaTeX 2020-10 and later
      files[ext].push(`\\contentsline {${tl.l}}{${tl.t}}{${folioText.get(page) ?? page}}{}%`);
    });
  }
  const contents = {};
  for (const [ext, lines] of Object.entries(files)) {
    contents[ext] = lines.join('\n') + '\n';
  }
  return { hash: fnv1a(JSON.stringify(contents)), contents };
}

/**
 * Each page's spec: what its head and foot are made from (the runs job,
 * hfJobBody). Besides folio, format, style, marks and where floats landed
 * (`fl`), `tpl` names the page's template: its style, the chain of body
 * definitions replayed before it (\fancyhead/\fancyfoot/\fancyhf and
 * \floatpagestyle, in page order) and the folio's parity (twoside's odd and
 * even heads, \ifthenelse{\isodd{\value{page}}}), and `lp` is what
 * \pageref{LastPage} prints. The runs job measures, once per template and
 * float state (probeContext), which of the other components its head and
 * foot change with (docs/10 §10.7a F2).
 */
export function pageSpecs(pages, blocks, initialStyle, { furniture = true } = {}) {
  // events ride the node stream as markers, so each page's event list
  // (page.evs) is exact even when one block spans several pages
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const witnesses = furniture ? furnitureWitnesses(blocks) : new Map();
  const lastPageOf = new Map();
  if (furniture) {
    for (const page of pages) {
      for (const { u } of page.draw ?? []) if (u?.blockId) lastPageOf.set(u.blockId, page.number);
      for (const { bid } of page.evs ?? []) if (bid) lastPageOf.set(bid, page.number);
    }
  }
  const sourceOrder = furniture ? new Map(blocks.map((block, index) => [block.id, index])) : null;
  const pageWitnesses = [];
  const specs = [];
  let style = initialStyle;
  let fmt = 'arabic';
  let folio = 1;
  let lmark = '';
  let rmark = '';
  let chain = '';
  let floatLists = '';
  // what body \setcounter{page}/\addtocounter{page} added to the builder's
  // folio (it follows \pagenumbering only), and whether one could not be
  // placed (inside a paragraph)
  let offset = 0;
  let pageReadUnproved = false;
  for (const page of pages) {
    let thisstyle = null;
    let unknown = false;
    const counted = [];
    const fancy = [];
    const base = page.folio ?? folio;
    const ctrEvidence = [];
    let boundary;
    let lastBlock;
    const see = (id) => {
      if (sourceOrder.has(id) && (!lastBlock || sourceOrder.get(id) > sourceOrder.get(lastBlock))) lastBlock = id;
    };
    if (furniture) for (const { u } of page.draw ?? []) see(u?.blockId);
    // TeX mark semantics: \leftmark = botmark's left (LAST mark on the
    // page), \rightmark = firstmark's right (FIRST mark on the page, or
    // the carried value when the page has no marks)
    const rmarkAtStart = rmark;
    let firstRight = null;
    for (const ref of page.evs ?? []) {
      // synthetic events (blank verso pages) carry their payload inline
      const ev = ref.bid ? blockById.get(ref.bid)?.galley?.events?.[ref.i] : ref;
      if (!ev) continue;
      if (furniture) see(ref.bid);
      if (ev.k === 'style') style = ev.a;
      else if (ev.k === 'thisstyle') thisstyle = ev.a;
      else if (ev.k === 'pagenum') {
        if (ref.bid) counted.push(ref.bid);
        const placed = folio + offset;
        if (ev.before != null) {
          ctrEvidence.push({ resident: ev.before, placed, guarded: !!ev.guard });
          unknown ||= ev.guard || ev.before !== placed;
        }
        fmt = ev.a;
        folio = 1; // \pagenumbering resets the page counter (kernel behavior)
        offset = 0;
      } else if (ev.k === 'mark') {
        lmark = ev.a;
        if (firstRight === null) firstRight = ev.b;
        rmark = ev.b;
      } else if (ev.k === 'fancy') {
        fancy.push([ev.a, ev.b]);
      } else if (ev.k === 'fpstyle') {
        // a body \floatpagestyle: the float pages after it take that style
        fancy.push(['fps', `{${ev.a}}`]);
      } else if (ev.k === 'pagectr') {
        // a body \setcounter{page}/\addtocounter{page} reached this page
        // (tex-templates.js): `set` a value, `add` a delta, or an
        // unproven value or landing position.
        if (ref.bid) counted.push(ref.bid);
        const placed = base + offset;
        const value = Number(ev.b);
        ctrEvidence.push({ resident: ev.before ?? null, placed, guarded: !!ev.guard });
        if (ev.guard || ev.before !== placed || !/^[+-]?\d+$/.test(ev.b ?? '') || !Number.isSafeInteger(value)) unknown = true;
        else if (ev.a === 'set') offset = value - base;
        else offset += value;
      } else if (ev.k === 'markr') {
        if (firstRight === null) firstRight = ev.a;
        rmark = ev.a;
      } else if (ev.k === 'hfstate' && witnesses.has(ref.bid)) {
        pageReadUnproved ||= ev.b?.some((resident) => resident !== base + offset) ?? false;
        boundary = { witness: witnesses.get(ref.bid), values: ev.a, covered: ev.covered };
      }
    }
    // A trailing assignment can affect the last sheet without contributing
    // a line to it. A recorded eject takes precedence over end-of-body state.
    const terminal = !boundary && !page.floatPage && page === pages.at(-1);
    if (furniture && terminal) see(blocks.at(-1)?.id);
    const last = witnesses.get(lastBlock);
    const lastOnBlock = last && (terminal || lastPageOf.get(lastBlock) === page.number);
    if (!boundary && lastOnBlock) pageReadUnproved ||= last.folios?.some((resident) => resident !== base + offset) ?? false;
    // An explicit eject samples the resident output boundary. At the
    // end of a block its state is available even if the block left no ink.
    if (furniture) pageWitnesses.push({
      record: boundary ?? (lastOnBlock ? { witness: last, values: last.values, covered: last.covered } : null),
      // A natural break in the middle of the same executed block can
      // occur between a state change and its restoration.
      guarded: pageReadUnproved || (!boundary && !!last && !lastOnBlock),
    });
    for (const [kind, args] of fancy) chain = fnv1a(`${chain}|${kind}${args}`);
    const pageStyle = thisstyle ?? style;
    const pageFolio = base + offset;
    if (!page.floatPage) floatLists = (page.topFloats?.length ? 't' : '') + (page.botFloats?.length ? 'b' : '');
    specs.push({
      page: page.number,
      folio: pageFolio,
      fmt,
      style: pageStyle,
      lmark,
      rmark: firstRight ?? rmarkAtStart,
      // where floats landed (\iftopfloat, \ifbotfloat, \iffloatpage and a
      // float page's own style read them at output): `p` a float page, else
      // `t`/`b` for floats at its top/bottom (hfJobBody)
      fl: page.floatPage ? 'p' : floatLists,
      ...(page.floatPage && floatLists ? { flCarry: floatLists } : {}),
      tpl: fnv1a(`${pageStyle}|${chain}|${Math.abs(pageFolio % 2)}`),
      tplBody: chain,
      ...(fancy.length ? { fancy } : {}),
      ...(unknown ? { ctr: 'unknown' } : {}),
      ...(counted.length ? { ctrb: counted, ctrEvidence } : {}),
    });
    folio = base + 1;
  }
  // A page without its own observation can borrow only the values both
  // neighboring observations establish. Keep uncertainty per control.
  const observed = pageWitnesses.map(({ record }) => record && stateFromWitness(record.witness, record.values, record.covered));
  const nextFull = [];
  let right = null;
  for (let index = observed.length - 1; index >= 0; index--) {
    nextFull[index] = right;
    const state = observed[index];
    if (state && !state.covered) right = state;
  }
  let before = null;
  let left = null;
  for (let i = 0; i < pageWitnesses.length;) {
    const { record, guarded } = pageWitnesses[i];
    if (record) {
      const observedState = observed[i];
      if (!observedState.covered) left = observedState;
      const bridge = observedState.covered && left && nextFull[i] ? agreeingState(left, nextFull[i]) : null;
      const filled = fillUncovered(observedState, bridge);
      const state = guarded ? { ...filled, guarded: true } : filled;
      before = filled;
      if (state.guarded || state.values.length || state.uncertain.length || state.covered || state.bridged) specs[i].state = state;
      i++;
      continue;
    }
    let end = i + 1;
    while (end < specs.length && !pageWitnesses[end].record) end++;
    const after = observed[end];
    const state = before && after
      ? agreeingState(before, after)
      : furnitureState([], false, ['$font', '$color'], []);
    for (; i < end; i++) {
      if (pageWitnesses[i].guarded) specs[i].state = { ...state, guarded: true };
      else if (state.guarded || state.values.length || state.uncertain.length || state.covered || state.bridged) specs[i].state = state;
    }
  }
  const last = specs[specs.length - 1];
  const lp = last ? formatFolio(last.folio, last.fmt) : '';
  for (const spec of specs) spec.lp = lp;
  return specs;
}

// The components a template's probes perturb, one at a time (docs/10
// §10.7a F2): marks (empty, and a non-empty sentinel), a top float, a bottom
// float, a float page, LastPage. They are measured in a context: the
// template (style, chain, the folio's parity) and where floats landed, on
// the first page that has that context (its representative). A context's
// head may read a component only under another context (twoside's even
// head reads \rightmark, the odd one does not; \iftopfloat{\rightmark}{}),
// so no context's measure stands for another's (audit/scratch r10 even).
// The folio is not probed: a band or entry is never drawn on another folio.
// A probe entry is keyed `q<context>.<component>`.
export const HF_PROBES = ['m0', 'm1', 't', 'b', 'p', 'l'];
export const HF_PROBE_KEYS = { m0: 'marks', m1: 'marks', t: 't', b: 'b', p: 'p', l: 'lp' };
const HF_PROBE_TEMPLATES = Number(process.env.TDOM_HF_PROBE_TEMPLATES || 64);
const toggle = (fl, c) => (fl.includes(c) ? fl.replace(c, '') : fl + c);
// where floats landed, in one spelling (`p`, or `t` before `b`)
const floatState = (fl) => (fl === 'p' ? 'p' : ['t', 'b'].filter((c) => (fl ?? '').includes(c)).join(''));

/** The context a spec's sensitivity is measured in: its template and where
 * its floats landed. */
export function probeContext(s) {
  const state = s.state ? `|${furnitureStateKey(s.state)}` : '';
  return `${s.tpl}|${floatState(s.fl)}${s.fl === 'p' ? s.flCarry ?? '' : ''}${state}`;
}

/** The float probe that turns float state `was` into `now`, or null when
 * none does (two flags at once). */
export function floatProbe(was, now) {
  for (const which of ['t', 'b', 'p']) if (floatState(perturbed({ fl: was ?? '' }, which).fl) === floatState(now)) return which;
  return null;
}

function perturbed(s, which) {
  switch (which) {
    case 'm0': return { ...s, lmark: '', rmark: '' };
    case 'm1': return { ...s, lmark: 'TDOMprobeLeft', rmark: 'TDOMprobeRight' };
    case 't': return { ...s, fl: toggle(s.fl === 'p' ? '' : s.fl ?? '', 't') };
    case 'b': return { ...s, fl: toggle(s.fl === 'p' ? '' : s.fl ?? '', 'b') };
    case 'p': return s.fl === 'p' ? { ...s, fl: s.flCarry ?? '' } : { ...s, fl: 'p', flCarry: s.fl };
    default: return s;
  }
}

/** A page's state and its two boxes, under `key` (the page, or a probe).
 * `trace`: the boxes are set to see what they read (daemon.lua
 * tdom_hf_trace), the marks reporting their expansion; nothing of them is
 * kept but that. */
function slotLines(L, s, key, trace = false, alternate = false) {
  const read = (v) => (trace ? `\\directlua{tdom_hf_read(1)}${v}` : v);
  L.push(`\\global\\c@page=${s.folio}`);
  L.push(`\\gdef\\thepage{\\csname @${s.fmt}\\endcsname\\c@page}`);
  L.push(`\\def\\leftmark{${read(s.lmark)}}`);
  L.push(`\\def\\rightmark{${read(s.rmark)}}`);
  L.push(`\\TDOM@hffloats{${s.fl ?? ''}${s.fl === 'p' ? s.flCarry ?? '' : ''}}`);
  // reset then apply the page style (an unknown style leaves all empty),
  // then the one the output routine would take instead: a float page's
  // under floatpag (\floatpagestyle)
  if (trace) L.push('\\directlua{tdom_hf_style_begin()}');
  L.push('\\def\\@oddhead{}\\def\\@evenhead{}\\def\\@oddfoot{}\\def\\@evenfoot{}');
  L.push(`\\csname ps@${s.style}\\endcsname`);
  L.push('\\global\\@specialpagefalse\\if@fcolmade\\ifdefined\\at@float@page\\at@float@page\\fi\\fi' +
    '\\if@specialpage\\global\\@specialpagefalse\\@nameuse{ps@\\@specialstyle}\\fi');
  if (trace) L.push('\\directlua{tdom_hf_style_end()}');
  const odd = '\\let\\TDOMhd\\@oddhead\\let\\TDOMft\\@oddfoot';
  const even = '\\let\\TDOMhd\\@evenhead\\let\\TDOMft\\@evenfoot';
  L.push(odd, `\\if@twoside\\ifodd\\c@page${alternate ? even : ''}\\else${alternate ? odd : even}\\fi\\fi`);
  // (`ship`: the page's furniture on its paper, furniture-render.js)
  if (trace === 'ship') {
    L.push(`\\TDOM@shipfurniture{${key}}`);
    return;
  }
  const begin = trace ? '\\directlua{tdom_hf_slot_begin()}' : '';
  const end = (which) => key == null ? '' :
    (trace ? `\\directlua{tdom_hf_trace(${key}, '${which}')}` : `\\directlua{tdom_hf_box(0, ${key}, '${which}')}`);
  L.push(`${begin}\\setbox\\z@\\vbox{\\hsize\\textwidth\\hb@xt@\\textwidth{\\normalcolor\\TDOMhd}}${end('h')}`);
  L.push(`${begin}\\setbox\\z@\\vbox{\\hsize\\textwidth\\hb@xt@\\textwidth{\\normalcolor\\TDOMft}}${end('f')}`);
}

const lastPageLine = (lp) => `\\global\\@namedef{r@LastPage}{{}{${lp}}}`;
// (pgf's picture count, saved and restored around boxes set only to be measured)
const PGF_SAVE = '\\ifdefined\\pgf@picture@serial@count\\edef\\TDOM@pgfser{\\the\\pgf@picture@serial@count}\\fi';
const PGF_RESTORE = '\\ifdefined\\pgf@picture@serial@count\\global\\pgf@picture@serial@count=\\TDOM@pgfser\\relax\\fi';

// Always establish all three output flags. A float page retains the
// preceding text page's fancyhdr lists, even when that page isn't shipped.
const HF_FLOATS = '\\def\\TDOM@hffloats#1{\\global\\@fcolmadefalse\\in@ p{#1}\\ifin@\\global\\@fcolmadetrue\\fi' +
  '\\global\\let\\f@nch@topfloat\\@empty\\global\\let\\f@nch@botfloat\\@empty' +
  '\\in@ t{#1}\\ifin@\\gdef\\f@nch@topfloat{\\TDOM@float}\\fi' +
  '\\in@ b{#1}\\ifin@\\gdef\\f@nch@botfloat{\\TDOM@float}\\fi}';

export const HF_UNESTABLISHED = 8 | 32 | 64;
export const HF_FOLIO = 128;
export const HF_PARITY = 256;

const HF_MACRO_RECIPES = new Set(['macro', 'long', 'protected', 'protected-long']);

const HF_TRACE_FLOATS = ['iftopfloat', 'ifbotfloat', 'iffloatpage'].map((name) =>
  `\\ifdefined\\${name}\\let\\TDOM@trace@${name}\\${name}\\def\\${name}{\\directlua{tdom_hf_read(16)}\\TDOM@trace@${name}}\\fi`).join('');
const HF_TRACE_RAW_MARKS = ['firstmark', 'botmark', 'topmark', 'firstmarks', 'botmarks', 'topmarks'].map((name) =>
  `\\let\\TDOM@trace@${name}\\${name}\\def\\${name}{\\directlua{tdom_hf_read(32)}\\TDOM@trace@${name}}`).join('');

function replayFurnitureState(L, spec, trace = false) {
  if (!spec.fancy?.length) return;
  if (trace) L.push('\\directlua{tdom_hf_replay_begin()}');
  for (const [kind, args] of spec.fancy ?? []) {
    const name = kind === 'hf' ? 'fancyhf' : kind === 'fps' ? 'floatpagestyle' : `fancy${kind}`;
    L.push(`\\ifdefined\\TDOM@${name}\\${name}${args}\\fi`);
  }
  if (trace) L.push('\\directlua{tdom_hf_replay_end()}');
}

// A fresh group per page keeps a page's replay separate from the next
// page's root state. Only recipes captured and checked by TeX are used.
function furniturePage(L, spec, paint, trace = true) {
  L.push('\\begingroup');
  const values = [];
  for (const [name, fingerprint, kind, value] of spec.state?.values ?? []) {
    if (!/^[\w@:_$]+$/.test(name)) continue;
    const recipe = !spec.state.guarded && !name.startsWith('$');
    if (recipe && kind === 'let') {
      L.push(`\\expandafter\\let\\csname ${name}\\expandafter\\endcsname\\csname ${value}\\endcsname`);
    } else if (recipe && kind === 'count') {
      // Local register assignment. LaTeX's setcounter is global.
      L.push(`\\csname ${name}\\endcsname=${value}\\relax`);
    } else if (recipe && kind === 'dim') {
      L.push(`\\csname ${name}\\endcsname=${value}sp\\relax`);
    } else if (recipe && HF_MACRO_RECIPES.has(kind)) {
      const hex = Buffer.from(value, 'utf8').toString('hex');
      L.push(`\\directlua{tdom_hf_replay_macro("${name}","${hex}","${kind}")}`);
    }
    if (trace) values.push(`["${name}"]="${fingerprint}"`);
  }
  if (trace) {
    const uncertain = (spec.state?.uncertain ?? []).filter((name) => /^[\w@:_$]+$/.test(name))
      .map((name) => `["${name}"]=true`);
    const covered = spec.state?.covered;
    const known = covered ? `{${covered.filter((name) => /^[\w@:_$]+$/.test(name)).map((name) => `["${name}"]=true`).join(',')}}` : 'nil';
    L.push(`\\directlua{tdom_hf_state({${values.join(',')}},{${uncertain.join(',')}},${known})}`);
  }
  paint();
  L.push('\\endgroup');
}

export function hfJobBody(specs, { compareSides = false, discover = false, traceCopies = null, kept = null } = {}) {
  const L = ['\\makeatletter'];
  // every PDF literal the heads draw is made by the daemon with its payload
  // readable (daemon.lua tdom_hf_ext): part of the entry, so of its
  // fingerprint (docs/10 §10.7a F1)
  L.push('\\let\\TDOM@pdfext\\pdfextension\\protected\\def\\pdfextension{\\directlua{tdom_hf_ext()}}');
  // \pageref{LastPage} in headers/footers: the label lastpage would write
  // at \enddocument is the LAST page's folio — a value the page builder
  // owns outright (\pageref prints the second group of \r@LastPage)
  const lp = specs[specs.length - 1]?.lp;
  if (lp != null) L.push(lastPageLine(lp));
  // where floats landed, as fancyhdr's \@makecol leaves it for the output
  // routine (a float page keeps the last text page's top and bottom lists)
  L.push(HF_FLOATS);
  // (the body's \fancyhead/\fancyfoot/\fancyhf and \floatpagestyle of a
  // page, in order: the job runs the specs in page order, so each page sees
  // every earlier one)
  // The authoritative pass: each page's head and foot, in page order, as
  // v0.1.32 set them and nothing else between them (a head that steps a
  // counter, writes, labels, numbers each page: audit/scratch r12 value).
  // In a group, so that the measuring pass below starts from the preamble's
  // definitions again.
  // (floatpag's \floatpagestyle is global: put back too)
  if (!discover) {
    L.push('\\let\\TDOM@atfp\\at@float@page\\begingroup');
    for (const s of specs) {
      replayFurnitureState(L, s);
      furniturePage(L, s, () => slotLines(L, s, s.page), false);
    }
    L.push('\\endgroup\\global\\let\\at@float@page\\TDOM@atfp');
  }
  // The measuring pass, after every page is set: what each page's slots read
  // (the trace), and each context's probes. Nothing it does reaches a page's
  // own boxes. Within it: no \immediate output, no label, index or contents
  // entry, every LaTeX counter put back after each measurement, pgf's
  // picture count and LastPage too.
  L.push('\\begingroup\\let\\immediate\\relax\\let\\label\\@gobble\\let\\index\\@gobble' +
    '\\def\\addtocontents#1#2{}\\def\\addcontentsline#1#2#3{}');
  L.push('\\begingroup\\def\\@elt#1{\\global\\csname c@#1\\endcsname=\\the\\csname c@#1\\endcsname\\relax}' +
    '\\xdef\\TDOM@ctrs{\\cl@@ckpt}\\endgroup');
  L.push(HF_TRACE_FLOATS, HF_TRACE_RAW_MARKS);
  L.push('\\directlua{tdom_hf_replay_reset()}');
  const isolated = (fn) => {
    L.push(`\\begingroup${PGF_SAVE}`);
    fn();
    if (lp != null) L.push(lastPageLine(lp));
    L.push(`${PGF_RESTORE}\\TDOM@ctrs\\endgroup`);
  };
  const probed = new Map();
  for (const s of specs) {
    if (!discover) replayFurnitureState(L, s, true);
    if (traceCopies?.has(s.page)) continue;
    // what this page's head and foot read (`hr`/`fr`: the marks, LastPage)
    isolated(() => {
      if (discover) {
        L.push('\\directlua{tdom_hf_replay_reset()}');
        replayFurnitureState(L, s, true);
      }
      if (lp != null) L.push(lastPageLine(`\\directlua{tdom_hf_read(2)}${lp}`));
      if (kept?.has(s.page)) furniturePage(L, s, () => slotLines(L, s, null), false);
      else furniturePage(L, s, () => slotLines(L, s, s.page, true));
    });
    if (compareSides) {
      isolated(() => furniturePage(L, s, () => slotLines(L, s, `'qside.${s.page}'`, false, true), false));
    }
    // the first page of a context: its probes, each beside the page set again
    // in the same state (`q<i>.base`)
    if (discover || s.state?.guarded || !s.tpl || probed.has(probeContext(s)) || probed.size >= HF_PROBE_TEMPLATES) continue;
    const index = probed.size;
    probed.set(probeContext(s), s.page);
    isolated(() => furniturePage(L, s, () => slotLines(L, s, `'q${index}.base'`), false));
    for (const which of HF_PROBES) {
      isolated(() => {
        if (which === 'l') L.push(lastPageLine('TDOMprobeLast'));
        furniturePage(L, s, () => slotLines(L, perturbed(s, which), `'q${index}.${which}'`), false);
      });
    }
  }
  L.push('\\endgroup');
  L.push('\\directlua{tdom_hf_flush()}');
  return L.join('\n');
}

/**
 * The body of a furniture render (furniture-render.js): the job's state for
 * every page in order, as the header job sets it, and for each page of
 * `wanted` its head and foot shipped on the paper where \@outputpage puts
 * them, the text area left empty. pgf's remembered positions go to the
 * daemon (tdompos.aux, as page art's) and, from the pass before (`marks`),
 * are defined first.
 */
export function hfRenderBody(timelines, marks = null, trace = true) {
  const L = ['\\makeatletter',
    '\\hoffset=0pt\\voffset=0pt\\pagewidth=\\paperwidth\\pageheight=\\paperheight'];
  if (!trace) L.push('\\directlua{tdom_hf_position_pass()}');
  L.push('\\expandafter\\def\\csname pgfsys@markposition\\endcsname#1{\\edef\\TDOMartid{#1}' +
    '\\expandafter\\TDOMartmark\\expandafter{\\TDOMartid}}');
  L.push("\\def\\TDOMartmark#1{\\latelua{tdom_page_art_mark('\\luaescapestring{#1}')}}");
  if (marks?.size) {
    L.push([...marks].map(([name, [x, y]]) =>
      `\\expandafter\\gdef\\csname pgf@sys@pdf@mark@pos@${name}\\endcsname{\\pgfqpoint{${x}sp}{${y}sp}}`).join(''));
    L.push(`\\directlua{tdom_hf_positions({${[...marks.keys()].map((name) => `"${name}"`).join(',')}})}`);
  }
  L.push(HF_FLOATS, HF_TRACE_FLOATS, HF_TRACE_RAW_MARKS);
  L.push('\\def\\TDOM@hfslot{\\directlua{tdom_hf_slot_begin()}}');
  // (\@outputpage: the head box's bottom at \topmargin+\headheight, the foot's
  // baseline \footskip under the text area, the margin of the page's side)
  L.push('\\def\\TDOM@shipfurniture#1{\\if@twoside\\ifodd\\c@page\\let\\TDOM@margin\\oddsidemargin\\else' +
    '\\let\\TDOM@margin\\evensidemargin\\fi\\else\\let\\TDOM@margin\\oddsidemargin\\fi' +
    '\\shipout\\vbox{\\reset@font\\normalsize\\normalcolor\\vskip\\topmargin\\moveright\\TDOM@margin\\vbox{\\setbox\\@tempboxa' +
    '\\vbox to\\headheight{\\vfil\\TDOM@hfslot\\hb@xt@\\textwidth{\\normalcolor\\TDOMhd}' +
    "\\directlua{tdom_hf_render_trace(#1,'h')}}\\dp\\@tempboxa\\z@\\box\\@tempboxa" +
    '\\vskip\\headsep\\vbox to\\textheight{}\\baselineskip\\footskip\\TDOM@hfslot\\hb@xt@\\textwidth{\\normalcolor\\TDOMft}' +
    "\\directlua{tdom_hf_render_trace(#1,'f')}}}}");
  for (const { specs, wanted } of timelines) {
    L.push('\\let\\TDOM@atfp\\at@float@page\\begingroup');
    L.push('\\directlua{tdom_hf_replay_reset()}');
    const lp = specs.at(-1)?.lp;
    if (lp != null) L.push(lastPageLine(`\\directlua{tdom_hf_read(2)}${lp}`));
    for (const s of specs) {
      replayFurnitureState(L, s, true);
      if (wanted.has(s.page)) furniturePage(L, s, () => slotLines(L, s, wanted.get(s.page), 'ship'));
    }
    L.push('\\endgroup\\global\\let\\at@float@page\\TDOM@atfp');
  }
  return L.join('\n');
}

/** The contexts a job body probes: context -> [probe index, page]. */
export function hfProbedTemplates(specs) {
  const probed = new Map();
  for (const s of specs) {
    if (s.state?.guarded || !s.tpl || probed.has(probeContext(s)) || probed.size >= HF_PROBE_TEMPLATES) continue;
    probed.set(probeContext(s), [probed.size, s.page]);
  }
  return probed;
}

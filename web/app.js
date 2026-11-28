// Thin client for the TDOM Engine (core build).
//
// The editor sends text deltas; the viewer applies display-list patches; the
// inspector renders the engine's dirty report. All typesetting intelligence
// lives in the resident engine process — this file only draws.
//
// Every page is TWO stacked layers with a strict ranking:
//   - provisional: display-list commands (glyph runs + exact-render chunk
//     images) painted keystroke-synchronously by the resident engine;
//   - canonical: the same page as real LuaLaTeX output (/canonical/n.svg),
//     which ALWAYS wins once a compile of the current source has landed.
// An edit flips the touched pages back to provisional; the next canonical
// compile flips them to exact again. Pages the edit never touched keep
// their canonical pixels throughout. In opaque mode (safety-gate demotion)
// there is no provisional layer at all — the canonical pages are the
// display.

const editor = document.getElementById('editor');
const editorHighlightEl = document.getElementById('editor-highlight');
const pagesEl = document.getElementById('pages');

// ---- outer paper ---------------------------------------------------------
// When the host keeps one chapter of a long document live, the server names
// the paper of its last full Build (/status `outer`, server.js). Its sheets
// before and after the chapter stand around the live pages as pictures, so
// the reader scrolls one paper. They are no pages of this document: nothing
// below edits, stages or verifies them.
let outerPaper = null;
const outerBeforeEl = document.createElement('div');
const outerAfterEl = document.createElement('div');
outerBeforeEl.className = outerAfterEl.className = 'outer-run';
pagesEl.append(outerBeforeEl, outerAfterEl);
let outerAspect = '';
function outerSheet(sheet, key) {
  const div = document.createElement('div');
  div.className = 'outer-page';
  div.dataset.sheet = sheet;
  if (outerAspect) div.style.aspectRatio = outerAspect;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  img.alt = '';
  img.src = `/outer/${sheet}.svg?k=${encodeURIComponent(key)}`;
  div.appendChild(img);
  return div;
}
function applyOuterPaper(next) {
  const paper = activePaperGeometry();
  const aspect = paper.width > 0 && paper.height > 0 ? `${paper.width} / ${paper.height}` : outerAspect;
  const key = next?.key ?? null;
  const sameSheets = (outerPaper?.key ?? null) === key;
  if (sameSheets && aspect === outerAspect) return;
  // the live page on screen stays where it is while sheets appear above it
  const anchor = pagesEl.querySelector('.page');
  const anchorTop = anchor?.getBoundingClientRect().top;
  outerAspect = aspect;
  if (sameSheets) {
    for (const div of pagesEl.querySelectorAll('.outer-page')) div.style.aspectRatio = aspect;
  } else {
    outerPaper = next ?? null;
    const before = [];
    const after = [];
    if (outerPaper) {
      for (let sheet = 1; sheet <= outerPaper.before; sheet++) before.push(outerSheet(sheet, key));
      for (let sheet = outerPaper.afterFrom; sheet <= outerPaper.pages; sheet++) after.push(outerSheet(sheet, key));
    }
    outerBeforeEl.replaceChildren(...before);
    outerAfterEl.replaceChildren(...after);
  }
  if (anchor?.isConnected && Number.isFinite(anchorTop)) {
    pagesEl.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  }
}
const statusEl = document.getElementById('status');
const inspectorEl = document.getElementById('inspector');
const layoutViewEl = document.getElementById('layout-view');
const layoutSplitterEl = document.getElementById('workspace-preview-splitter');
const layoutEl = document.getElementById('layout');
const workspacePaneEl = document.getElementById('workspace-pane');
const previewPaneEl = document.getElementById('preview-pane');
const initialParams = new URLSearchParams(location.search);
const embeddedHost = initialParams.get('embed') === '1';
let embeddedViewport = () => null;
const embedActivationId = initialParams.get('activationId') ?? '';
// Direct editing on the paper (a caret and an input surface over the printed
// page: activateDirectEditor, openDirectEditor, MathLive), and the MathLive
// drafts of an edited formula shown on the printed paper until TeX catches up
// (warmSourceFormula, previewSourceFormula), have one switch: this line. Its
// default (the last `true`) is on, as origin/dev 504adab has it; whether it
// stays on is the owner's decision (docs/13). Off, a click on the paper does
// only what it does besides editing: Cmd/Ctrl+click names the source line, a
// selection and the context menu offer the place to the host; the pointer,
// key, paste and selection listeners are not installed and MathLive is not
// loaded. Tests set globalThis.__tdomDirectEditing (true or false) before
// this script runs (no URL or message can).
const directEditingOn = () =>
  typeof globalThis.__tdomDirectEditing === 'boolean' ? globalThis.__tdomDirectEditing : true;
if (directEditingOn() && typeof document?.createElement === 'function') {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/host/mathlive/mathlive-static.css';
  const script = document.createElement('script');
  script.src = '/host/mathlive/mathlive.min.js';
  document.head.append(css, script);
}

let splitRatio = 48;

const FONT_FAMILY = {
  regular: `'Times New Roman', Times, serif`,
  italic: `'Times New Roman', Times, serif`,
  bold: `'Times New Roman', Times, serif`,
  bolditalic: `'Times New Roman', Times, serif`,
  mono: `'Courier New', Courier, monospace`,
};

let geometry = { paperwidth: 612, paperheight: 792 };
let backend = 'internal';
const loadedFonts = new Set();
const readyFonts = new Set();
const fontLoads = new Map();
const failedFonts = new Set(); // families reported to /font-fail (once each)

let serverText = '';
let appliedRev = 0;
// Reports (updates, /doc) apply in their own order, and each page keeps the
// newest display list it was sent. The engine numbers both from one counter,
// but publishes an update's report only once the update has returned, while
// work that landed meanwhile (a canonical verification, a render queued on
// the chain) publishes its patches at once, under a later number: an update
// compared with those was taken for stale and dropped, with its source
// revision (tex64-internal #121: after an undo, or a keystroke queued behind
// a preamble reboot, every page asked for the mapping of the revision
// before and Live stayed off until the next canonical).
let appliedReportRev = 0;
const pageListRev = new Map(); // page -> rev of the display list it was last sent
// The page set (the count, a removed tail, a page added at the end) is the
// newest event's that stated one: every report and async patch carries the
// engine's page count of its revision (async-repaginate.js), the /doc
// snapshot its revision (server.js layoutRev). An older event, a report
// published after patches of its own revision, still brings the lists of the
// pages left alone since, never its page set (audit/scratch boundaries.mjs:
// such a report took a newly added third page away, and gave a deleted
// second page back; r7 ordering.mjs: a repaint of page 3 under revision 5,
// which restored it, was taken for no news about the page set, and report 4
// removed it again; a repaint of page 2 after growth to four cut report 4's
// pages 3 and 4).
let pageTopologyRev = 0;
let pageTopologyCount = 0;
/** The last page an event of engine revision `rev` may still send (Infinity: any). */
function pageSetEnd(rev) {
  return rev !== null && rev < pageTopologyRev ? pageTopologyCount : Infinity;
}
let composing = false;
let sending = Promise.resolve();
let debounceTimer = null;
let pendingEditorInputAtEpochMs = null;
let inFlight = false;
const history = [];
const pageDivs = new Map();
const provisionalStages = new Map(); // latest unpublished display list per page
// blocks each page shows now (its last committed display list): material
// moving between two staged pages is found through the page it leaves
const committedPageSrcs = new Map(); // page -> Set of block ids
// pages of one edit: a report's pages that paint, or painted, a block the
// edit changed, added or removed (a paragraph split or merged across an
// unchanged float page keeps its halves in one transaction)
const pageEditGroup = new Map(); // page -> report sequence
let editGroupSeq = 0;
// Stage timings for measurement drivers: recorded only after one sets
// window.__tdomStageTrace = [] (epoch ms, comparable with the engine's).
function traceStage(ev, page, extra = {}) {
  const trace = globalThis.__tdomStageTrace;
  if (Array.isArray(trace) && trace.length < 20000) trace.push({ ev, page, srcRev: appliedSrcRev, at: Date.now(), ...extra });
}
const provisionalRemovedPages = new Set();
const provisionalDisplayLists = new Map(); // complete resident page layout, including unchanged pages
// Resident pages held by a zero-layout placeholder (a page-wide pending-exact:
// a block whose galley has not arrived). While any exist the resident page
// count is not settled. A line-level pending-exact only waits for ink.
const provisionalPendingLayout = new Set();
let openingPreview = false;
let openingEdited = true;
let residentPageCountAuthoritative = false;
let committedCanonicalGeneration = null;
let lastEngineStatus = null;
let viewportWarmTimer = null;
let viewportWarmKey = '';
let liveSearch = { query: '', results: [], current: -1 };
let editDomCache = null;
let directEditor = null;
const directEditRevisits = []; // bounded accepted-lineage candidates for still-visible old ink
let mathWysiwygModulePromise = null;
let mathCaretProbe = null;
let mathCaretProbeSeq = 0;
const mathCaretOffsetCache = new Map();
const canonicalTextBoxesCache = new Map();
const canonicalPageWordsCache = new Map();
const canonicalGlyphCache = new Map();
const canonicalSourceBoxCache = new Map();
const chunkGlyphCache = new Map();
const chunkInputGeometry = new WeakMap();
const provisionalSnapshotCache = new Map();
const shipGlyphCache = new Map();

async function canonicalGlyphs(pageNumber, id) {
  const key = `${id}:${pageNumber}`;
  if (!canonicalGlyphCache.has(key)) {
    const pending = fetch(`/canonical/glyphs?c=${Number(id)}&page=${Number(pageNumber)}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(data => data?.glyphs ?? []).catch(() => []);
    canonicalGlyphCache.set(key, pending);
    while (canonicalGlyphCache.size > 16) canonicalGlyphCache.delete(canonicalGlyphCache.keys().next().value);
  }
  return canonicalGlyphCache.get(key);
}
async function canonicalSourceEditBoxes(pageNumber, id, region, wholePage = false) {
  const source = region?.source;
  if (!source?.file || !wholePage && (!Number.isInteger(source.start?.line) || !Number.isInteger(source.end?.line))) return [];
  const epoch = documentReset.adoptedEpoch;
  if (documentReset.pending) return [];
  const range = wholePage ? { wholePage: true } : { startLine: source.start.line, endLine: source.end.line };
  const key = `${epoch}:${id}:${pageNumber}:${source.file}:${wholePage ? 'page' : range.startLine + ':' + range.endLine}`;
  if (!canonicalSourceBoxCache.has(key)) {
    const pending = fetch('/canonical/source-boxes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, page: pageNumber, documentEpoch: epoch, file: source.file,
        ...range }),
    }).then(r => r.ok ? r.json() : null).then(data =>
      data?.id === id && data?.page === pageNumber && data?.documentEpoch === epoch &&
      !documentReset.pending && documentReset.adoptedEpoch === epoch ? data.boxes ?? [] : []).catch(() => []);
    canonicalSourceBoxCache.set(key, pending);
    while (canonicalSourceBoxCache.size > 32) canonicalSourceBoxCache.delete(canonicalSourceBoxCache.keys().next().value);
  }
  return canonicalSourceBoxCache.get(key);
}
const canonicalRegionBoundsCache = new Map();
let directEditClickEpoch = 0;
let bootComplete = false;
let bootRequestEpoch = 0;
let stateEventEpoch = 0;
const documentReset = new window.TdomDocumentResetCoordinator({ hostRequired: embeddedHost });
let resetBootInFlight = false;
const presentedDomSnapshots = new Map();
const presentedDomFetches = new Map();
const canonicalPageRetries = new WeakMap();
const opaqueCanonicalBatches = new Map();
let opaqueBatchCommitDepth = 0;
let shipWaveBatch = null;

// Exact SVGs are decoded off-DOM, but a long paper must not decode every
// page on every keystroke. Pages near the viewport stage immediately;
// offscreen pages keep only the latest wanted URL and stage on approach.
const canonicalStageObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const page = entry.target;
        const wanted = page.dataset.canonWanted;
        if (!wanted) continue;
        page.dataset.canonStage = wanted;
        canonicalStageObserver.unobserve(page);
        updateCanonState(Number(page.dataset.page));
      }
    }, { root: pagesEl, rootMargin: '200% 0px' })
  : null;

// canonical (exact LuaLaTeX) layer state — all comparisons use SOURCE
// revisions (srcRev): async repaints (TikZ chunk swaps …) advance the patch
// rev without changing the source, and must not un-freshen the canonical
let mode = 'structured'; // 'structured' | 'opaque'
let modeReasons = [];
let previewPolicy = 'structured'; // structured | canonical-anchor | shipping-exact
let previewReasons = [];
let canonical = null; // {id, rev(srcRev), pageCount, paper, inFlight, error}
// incremental authority (shipping chain): page -> {gen, srcRev}. A shipped
// page is the SAME fidelity class as a canonical page (a real LuaLaTeX
// page), it just arrives ~ms after the edit instead of after a full compile.
const shipPages = new Map();
let appliedSrcRev = 0;
const pageDirtyRev = new Map(); // page -> srcRev of the last provisional patch
let lastRemoveRev = 0; // srcRev of the last provisional remove-pages patch
let documentStartSrcRev = null;
let canonicalAnchorPreview = null;
let canonicalAnchorPendingPatch = null;
const canonicalAnchorEditStartedAt = new Map(); // srcRev -> inferred server-accept time on renderer clock
const canonicalAnchorCanvasCache = new WeakMap();
const deferredDirectPresentationEvents = [];
const deferredDirectPresentationCommits = new Map();
let flushingDirectPresentation = false;
const docStateEl = document.getElementById('doc-state');

// Page convergence is BINARY: a page shows either the canonical render
// (a compile of the CURRENT source covers it) or the provisional layer —
// never a mix. A band-granular splice used to keep canonical pixels outside
// the edited y-band with a clip-path window, but that composite is only
// coherent when the provisional and canonical layouts agree outside the
// band, and nothing verifies that: with any drift (approximated floats,
// diverging page breaks, half-broken documents mid-typing) the old
// canonical line and the freshly edited provisional line showed up
// TOGETHER, a line apart. Self-consistent-but-provisional beats
// fast-but-wrong, so the splice is gone.

// ---------------------------------------------------------------- layout

function applyLayoutView(value = layoutViewEl?.value || 'both') {
  document.body.dataset.layoutView = value;
}

function applySplitRatio(value = splitRatio) {
  const workspace = Math.max(35, Math.min(70, Number(value) || splitRatio || 48));
  splitRatio = workspace;
  const { workspacePx, previewPx } = splitColumnWidths(workspace);
  document.documentElement.style.setProperty('--workspace-width', `${workspacePx}px`);
  document.documentElement.style.setProperty('--preview-width', `${previewPx}px`);
  layoutSplitterEl?.setAttribute('aria-valuenow', String(Math.round(workspace)));
}

function splitColumnWidths(workspaceRatio) {
  const layoutWidth = layoutEl?.getBoundingClientRect().width || window.innerWidth || 1;
  const splitterVisible = layoutSplitterEl && getComputedStyle(layoutSplitterEl).display !== 'none';
  const splitterWidth = splitterVisible ? layoutSplitterEl.getBoundingClientRect().width || 8 : 0;
  const available = Math.max(1, layoutWidth - splitterWidth);
  const workspacePx = Math.round((available * workspaceRatio) / 100);
  return {
    workspacePx,
    previewPx: Math.max(1, Math.round(available - workspacePx)),
  };
}

function splitRatioFromPointer(clientX) {
  if (!workspacePaneEl || !previewPaneEl) return splitRatio;
  const workspaceRect = workspacePaneEl.getBoundingClientRect();
  const previewRect = previewPaneEl.getBoundingClientRect();
  const left = workspaceRect.left;
  const right = previewRect.right;
  const total = right - left;
  if (total <= 0) return splitRatio;
  return ((clientX - left) / total) * 100;
}

function beginLayoutResize(ev) {
  if (document.body.dataset.layoutView !== 'both') return;
  ev.preventDefault();
  layoutSplitterEl?.setPointerCapture?.(ev.pointerId);
  document.body.classList.add('is-resizing-layout');
  applySplitRatio(splitRatioFromPointer(ev.clientX));

  function onPointerMove(moveEv) {
    applySplitRatio(splitRatioFromPointer(moveEv.clientX));
  }

  function finish() {
    document.body.classList.remove('is-resizing-layout');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

function nudgeLayoutSplit(delta) {
  applySplitRatio(splitRatio + delta);
}

// --------------------------------------------------------- editor highlight

// One left-to-right pass, escaping each token as it is emitted. Chained
// .replace() calls over already-emitted markup used to corrupt it: an
// escaped percent started a comment span, and the command rule then matched
// the backslash-plus-'<' of that span's own opening tag, so the tag leaked
// into the editor as literal text. Alternation order is precedence: a
// control sequence (an escaped percent included) never starts a comment.
const TOKEN_RE = /(\\[A-Za-z@]+|\\.)|(%[^\n]*)|(\{[^{}\n]*\})|(\$[^$\n]*\$)/g;

function highlightLineHtml(line) {
  let out = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(line))) {
    out += escapeHtml(line.slice(last, m.index));
    const cls = m[1] ? 'tok-command' : m[2] ? 'tok-comment' : m[3] ? 'tok-brace' : 'tok-math';
    out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

// Incremental highlight: one <span> per source line (the tokenizer is
// line-local, so lines are independent). A keystroke re-renders only the
// lines that changed instead of rebuilding a document-sized innerHTML —
// on long documents the full rebuild was tens of milliseconds of parse
// plus layout PER KEYSTROKE.
let hlLines = []; // current line strings
let hlSpans = []; // corresponding <span> elements

function highlightTexSource(source) {
  const lines = (source || '').split('\n');
  // common prefix / suffix of the line arrays — only the middle changed
  let p = 0;
  const maxP = Math.min(hlLines.length, lines.length);
  while (p < maxP && hlLines[p] === lines[p]) p++;
  let s = 0;
  const maxS = Math.min(hlLines.length, lines.length) - p;
  while (s < maxS && hlLines[hlLines.length - 1 - s] === lines[lines.length - 1 - s]) s++;

  const removeCount = hlLines.length - p - s;
  const insertLines = lines.slice(p, lines.length - s);
  const newSpans = insertLines.map((ln, i) => {
    const span = document.createElement('span');
    span.innerHTML = highlightLineHtml(ln) + (p + i < lines.length - 1 ? '\n' : '');
    return span;
  });
  // the span BEFORE the suffix carries a trailing \n that may appear or
  // vanish when the last line moves — refresh the boundary span's newline
  const anchor = hlSpans[p + removeCount] ?? null;
  for (let i = 0; i < removeCount; i++) hlSpans[p + i].remove();
  for (const span of newSpans) editorHighlightEl.insertBefore(span, anchor);
  hlSpans.splice(p, removeCount, ...newSpans);
  hlLines = lines;
  // A span's trailing newline depends on whether it is the LAST line.
  // Exactly two positions can change "lastness" in a splice: the new last
  // (truncation) and the span before the insertion point (append after
  // the old last). Repair both.
  const last = hlSpans.length - 1;
  const fixNl = (i) => {
    if (i < 0 || i > last) return;
    const wantNl = i < last;
    if (hlSpans[i].textContent.endsWith('\n') !== wantNl) {
      hlSpans[i].innerHTML = highlightLineHtml(hlLines[i]) + (wantNl ? '\n' : '');
    }
  };
  fixNl(last);
  fixNl(p - 1);
}

let lastHighlighted = null;
let highlightRaf = 0;

function syncHighlightScroll() {
  // compositor-only: translating the content-sized pre avoids the layout
  // pass a scrollTop write would force on every scroll event
  editorHighlightEl.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
}

function syncEditorHighlight() {
  if (!editor || !editorHighlightEl) return;
  if (editor.value !== lastHighlighted) {
    lastHighlighted = editor.value;
    highlightTexSource(lastHighlighted);
  }
  syncHighlightScroll();
}

function scheduleHighlight() {
  if (highlightRaf) return;
  highlightRaf = requestAnimationFrame(() => {
    highlightRaf = 0;
    syncEditorHighlight();
  });
}

// -------------------------------------------------------- topbar selects

const topbarSelectMenus = new Map();

function enhanceTopbarSelect(select) {
  if (!select || topbarSelectMenus.has(select)) return;
  select.dataset.topbarEnhanced = 'true';
  select.tabIndex = -1;

  const wrap = document.createElement('div');
  wrap.className = 'topbar-select';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'topbar-select-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.title = select.title || '';
  const menu = document.createElement('div');
  menu.className = 'topbar-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  wrap.appendChild(button);
  wrap.appendChild(menu);
  select.after(wrap);

  const state = { wrap, button, menu };
  topbarSelectMenus.set(select, state);

  function close() {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function render() {
    const selected = select.selectedOptions?.[0] ?? select.options[select.selectedIndex] ?? select.options[0];
    button.textContent = selected?.textContent || select.title || '選択';
    menu.textContent = '';
    for (const option of select.options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'topbar-select-item';
      item.textContent = option.textContent;
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      item.disabled = option.disabled;
      item.addEventListener('click', () => {
        if (option.value === select.value) {
          close();
          return;
        }
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        render();
        close();
      });
      menu.appendChild(item);
    }
  }

  button.addEventListener('click', (ev) => {
    ev.stopPropagation();
    for (const other of topbarSelectMenus.values()) {
      if (other !== state) {
        other.menu.hidden = true;
        other.button.setAttribute('aria-expanded', 'false');
      }
    }
    const nextHidden = !menu.hidden;
    menu.hidden = nextHidden;
    button.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
  });
  select.addEventListener('change', render);
  new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true });
  render();
}

document.addEventListener('click', () => {
  for (const state of topbarSelectMenus.values()) {
    state.menu.hidden = true;
    state.button.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  for (const state of topbarSelectMenus.values()) {
    state.menu.hidden = true;
    state.button.setAttribute('aria-expanded', 'false');
  }
});

// ----------------------------------------------------------------- fonts

function injectFonts(keys) {
  const missing = (keys ?? []).filter((k) => !loadedFonts.has(k));
  if (!missing.length) return;
  const css = missing
    .map(
      (k) =>
        `@font-face{font-family:'${k}';src:url('/font/${encodeURIComponent(k)}');font-display:block;}`
    )
    .join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  for (const k of missing) loadedFonts.add(k);
  // fidelity gate: verify each face actually loads. A face the browser
  // rejects (unsupported table, truncated file) silently falls back to a
  // default font — report it so the engine demotes those lines to exact
  // preview chunks instead of showing wrong glyphs.
  for (const k of missing) {
    fontLoads.set(k, document.fonts.load(`12px "${k}"`).then(
      (faces) => {
        if (!faces || faces.length === 0) {
          reportFontFailure(k);
          return;
        }
        readyFonts.add(k);
        // Pages may have been patched while the local face was decoding.
        // Reveal only runs that now have their real TeX font; a fallback is
        // never an intermediate presentation state.
        for (const node of document.querySelectorAll('text[data-font-pending="1"]')) {
          if (node.dataset.fontFamily === k) node.removeAttribute('data-font-pending');
        }
      },
      () => reportFontFailure(k)
    ));
  }
}

function reportFontFailure(family) {
  if (failedFonts.has(family)) return;
  failedFonts.add(family);
  fetch('/font-fail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ family }),
  }).catch(() => {});
}

// ---------------------------------------------------------------- boot

function presentedSnapshotKey(id, rev, epoch = documentReset.adoptedEpoch) {
  return `${Number(epoch)}:${Number(id)}:${Number(rev)}`;
}

async function ensurePresentedDomSnapshot(id, rev, epoch = documentReset.adoptedEpoch) {
  const numericId = Number(id);
  const numericRev = Number(rev);
  if (!Number.isFinite(numericId) || !Number.isFinite(numericRev)) return null;
  const key = presentedSnapshotKey(numericId, numericRev, epoch);
  if (presentedDomSnapshots.has(key)) return presentedDomSnapshots.get(key);
  if (presentedDomFetches.has(key)) return presentedDomFetches.get(key);
  const cached = provisionalSnapshotCache.get(`${epoch}:${numericRev}`);
  const pending = (cached ?? fetch(`/dom?srcRev=${numericRev}&printedEpoch=${epoch}`, { cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null))
    .then((snapshot) => {
      // An already captured revision or a new response must describe the
      // exact source of the printed generation before it can map clicks.
      if (!snapshot || snapshot.sourceCurrent === false || Number(snapshot.srcRev) !== numericRev ||
          Number(snapshot.documentEpoch) !== epoch || documentReset.adoptedEpoch > epoch) return null;
      presentedDomSnapshots.set(key, snapshot);
      while (presentedDomSnapshots.size > 4) {
        presentedDomSnapshots.delete(presentedDomSnapshots.keys().next().value);
      }
      return snapshot;
    })
    .catch(() => null)
    .finally(() => presentedDomFetches.delete(key));
  presentedDomFetches.set(key, pending);
  return pending;
}

async function boot(expectedDocumentEpoch = null) {
  if (expectedDocumentEpoch !== null && !documentReset.canAdopt(expectedDocumentEpoch)) return;
  const requestEpoch = ++bootRequestEpoch;
  const eventEpoch = stateEventEpoch;
  bootComplete = false;
  const doc = await fetch('/doc', { cache: 'no-store' }).then((r) => r.json());
  if (typeof doc.boot === 'string') serverBootId = doc.boot;
  if (requestEpoch !== bootRequestEpoch) return;
  if (expectedDocumentEpoch !== null && Number(doc.documentEpoch) !== Number(expectedDocumentEpoch)) {
    if (documentReset.canAdopt(expectedDocumentEpoch)) {
      setTimeout(() => boot(expectedDocumentEpoch), 0);
    }
    return;
  }
  if (eventEpoch !== stateEventEpoch) {
    queueMicrotask(() => boot(expectedDocumentEpoch));
    return;
  }
  if (documentReset.pending &&
      (expectedDocumentEpoch === null || !documentReset.canAdopt(expectedDocumentEpoch))) {
    return;
  }
  if ((doc.mode === 'opaque' || doc.previewPolicy === 'canonical-anchor') &&
      doc.canonical?.id && doc.canonical.rev === (doc.report.srcRev ?? doc.report.rev)) {
    await ensurePresentedDomSnapshot(doc.canonical.id, doc.canonical.rev, Number(doc.documentEpoch));
  }
  if (requestEpoch !== bootRequestEpoch || eventEpoch !== stateEventEpoch) {
    queueMicrotask(() => boot(expectedDocumentEpoch));
    return;
  }
  if (!documentReset.adopt(doc.documentEpoch)) {
    if (expectedDocumentEpoch !== null) queueMicrotask(() => boot(expectedDocumentEpoch));
    return;
  }
  // Source/chunk mapping requests must capture the adopted document epoch.
  adoptDoc(doc);
  bootComplete = true;
  statusEl.textContent = '';
  renderInspector(doc.report, null);
}

function maybeAdoptCompletedReset(epoch) {
  if (resetBootInFlight || !documentReset.canAdopt(epoch)) return;
  resetBootInFlight = true;
  boot(epoch).finally(() => {
    resetBootInFlight = false;
    if (documentReset.canAdopt(epoch)) queueMicrotask(() => maybeAdoptCompletedReset(epoch));
  });
}

function beginClientDocumentReset(epoch) {
  if (!documentReset.begin(epoch)) return false;
  deferredDirectPresentationEvents.length = 0;
  deferredDirectPresentationCommits.clear();
  shipGlyphCache.clear();
  provisionalStages.clear();
  committedPageSrcs.clear();
  pageEditGroup.clear();
  provisionalRemovedPages.clear();
  provisionalDisplayLists.clear();
  provisionalPendingLayout.clear();
  // (patches held for a report of the old document, and lists owed from its
  // /doc: the reset's own /doc brings the new one, boot)
  dropHeldPatches();
  clearDocResync();
  residentPageCountAuthoritative = false;
  bootComplete = false;
  directEditClickEpoch++;
  cancelDirectOpenings();
  closeDirectEditor();
  directEditRevisits.length = 0;
  retirePendingFormulas();
  if (embeddedHost) {
    window.parent.postMessage({
      source: 'tdom-embed',
      activationId: embedActivationId,
      action: 'reset-pending',
      viewport: embeddedViewport(),
      documentEpoch: Number(epoch),
    }, '*');
  }
  return true;
}

function completeClientDocumentReset(epoch) {
  if (documentReset.complete(epoch)) maybeAdoptCompletedReset(Number(epoch));
}

function adoptDoc(doc) {
  directEditClickEpoch++;
  cancelDirectOpenings();
  closeDirectEditor();
  directEditRevisits.length = 0;
  retirePendingFormulas();
  cancelObsoleteOpaqueBatches();
  geometry = doc.geometry;
  backend = doc.backend ?? 'checkpoint';
  injectFonts(doc.fonts);
  serverText = doc.source;
  editor.value = doc.source;
  syncEditorHighlight();
  pagesEl.textContent = '';
  // the outer paper's sheets are not this document's pages: they stay
  pagesEl.append(outerBeforeEl, outerAfterEl);
  pageDivs.clear();
  provisionalStages.clear();
  committedPageSrcs.clear();
  pageEditGroup.clear();
  provisionalRemovedPages.clear();
  provisionalDisplayLists.clear();
  provisionalPendingLayout.clear();
  committedCanonicalGeneration = null;
  pageDirtyRev.clear();
  clearCanonicalAnchorPreview();
  lastRemoveRev = 0;
  mode = doc.mode ?? 'structured';
  modeReasons = doc.modeReasons ?? [];
  previewPolicy = doc.previewPolicy ?? 'structured';
  previewReasons = doc.previewReasons ?? [];
  document.body.classList.toggle('is-opaque-document', usesCanonicalSurface());
  canonical = doc.canonical ?? null;
  openingPreview = doc.opening === true;
  openingEdited = !openingPreview;
  documentStartSrcRev = doc.documentStartSrcRev ?? null;
  if (shipWaveBatch) cancelShipWaveBatch(shipWaveBatch);
  shipPages.clear();
  appliedRev = doc.report.rev;
  appliedReportRev = doc.report.rev;
  // (patches held for a report, and lists owed from /doc: the snapshot has
  // their revision or a later one)
  dropHeldPatches();
  clearDocResync();
  lastReportFrozen = false;
  adoptedDocBoot = typeof doc.boot === 'string' ? doc.boot : null;
  appliedSrcRev = doc.report.srcRev ?? doc.report.rev;
  pageListRev.clear();
  pageTopologyRev = 0;
  pageTopologyCount = 0;
  // (the snapshot's lists are of the engine's revision when it was taken:
  // an event of an older one, still on its way, does not take them back)
  const layoutRev = Number.isInteger(doc.layoutRev) ? doc.layoutRev : null;
  if (layoutRev !== null) appliedRev = Math.max(appliedRev, layoutRev);
  residentPageCountAuthoritative =
    currentCanonicalPageCount(canonical, null, documentReset.adoptedEpoch, appliedSrcRev) === doc.pages.length;
  if (previewPolicy === 'structured') {
    stageProvisionalPatches(doc.pages.map(displayList => ({ type: 'replace-page', displayList })), false, doc.pages.length, null, layoutRev);
  }
  // a canonical compile older than the document state cannot vouch for any
  // page — show provisional until the fresh one lands (reload after
  // convergence has canonical.rev === srcRev: exact from frame one)
  if (mode === 'structured' && canonical && canonical.rev < appliedSrcRev) {
    for (const dl of doc.pages) pageDirtyRev.set(dl.page, appliedSrcRev);
  }
  syncCanonical();
}

// ---------------------------------------------------------------- pages

// The newest exact generation of this document is the page-count reference.
// Requiring one for the CURRENT revision made every keystroke's count
// unknown until canonical caught up: the toolbar flickered to "/ —" and each
// keystroke demanded a full canonical compile (tex64-internal #72). A
// resident count that matches the newest canonical stays authoritative; a
// mismatch still demands canonical and shows "/ —" (#67).
function currentCanonicalPageCount(reported, committed, documentEpoch, srcRev) {
  const generations = [];
  const count = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  if (Number(reported?.rev) > 0 && Number(reported.rev) <= Number(srcRev) && count(reported.pageCount)) {
    generations.push({ rev: Number(reported.rev), pageCount: Number(reported.pageCount) });
  }
  if (Number(committed?.epoch) === Number(documentEpoch) &&
      Number(committed?.rev) > 0 && Number(committed.rev) <= Number(srcRev) && count(committed.pageCount)) {
    generations.push({ rev: Number(committed.rev), pageCount: Number(committed.pageCount) });
  }
  if (!generations.length) return null;
  const newest = Math.max(...generations.map(generation => generation.rev));
  const counts = generations.filter(generation => generation.rev === newest).map(generation => generation.pageCount);
  return counts.every(value => value === counts[0]) ? counts[0] : null;
}

// The canonical cannot vouch for a page count of `srcRev`: its newest compile
// failed (a half-typed source, typically) and none of this revision is
// running. Its count is an older source's, and its next attempt may be
// minutes away (the cost cooldown after a long compile).
function canonicalCountStalled(reported, srcRev) {
  // (a first canonical that failed has no generation to count from either:
  // audit/scratch first-failure.mjs, the resident shrink was never settled
  // and the host kept waiting for a vanished sheet)
  const rev = Number(reported?.rev) > 0 ? Number(reported.rev) : 0;
  if (rev >= Number(srcRev)) return false;
  if (!reported?.error || !(Number(reported.errorRev) > rev)) return false;
  return !(Number(reported.runningRev) >= Number(srcRev));
}

function residentPageTransactionValid(pageCount, residentPages, stagePages, removedPages) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) return false;
  const resident = new Set(residentPages);
  if (resident.size !== pageCount) return false;
  for (let page = 1; page <= pageCount; page++) if (!resident.has(page)) return false;
  return [...stagePages].every(page => Number.isSafeInteger(page) && page >= 1 && page <= pageCount) &&
    [...removedPages].every(page => Number.isSafeInteger(page) && page > pageCount);
}

function displayListSrcs(dl) {
  const srcs = new Set();
  for (const cmd of dl?.commands ?? []) {
    if (cmd.src && !String(cmd.src).startsWith('_')) srcs.add(cmd.src); // '_…' is page furniture
  }
  return srcs;
}

// A failed native job can reuse the last galley's chunk with a different
// reveal mask. Keep the actual page and its matching click map when that is
// its only change. A moved block, new picture or changed neighbour must paint.
function onlyRejectedInkChanged(previous, next, rejected) {
  if (!previous || !rejected.size || previous.commands.length !== next.commands.length) return false;
  return next.commands.every((cmd, i) => {
    const old = previous.commands[i];
    if (old === cmd) return true;
    if (cmd.op === 'chunk' && old.op === 'chunk' && cmd.src === old.src && rejected.has(cmd.src)) {
      const { show: oldMask, ...oldInk } = old;
      const { show: newMask, ...newInk } = cmd;
      return JSON.stringify(oldInk) === JSON.stringify(newInk);
    }
    return JSON.stringify(old) === JSON.stringify(cmd);
  });
}

/** Staged pages that must change together (docs/04 §4.5): consecutive
 * pages (material reflows across the page break), pages that paint or
 * painted the same block (a paragraph moving across an unchanged float
 * page), and the pages of one edit (a split or merge renames blocks).
 * Consecutive pages are tied only while one of them shows a paper, and a
 * blank page whose stage is not ready joins nothing: it stays blank, and
 * next to a blank shell no reflow can duplicate or drop a line. On a
 * document's first presentation every page is blank, and tying them made
 * the whole document one group (tex64-internal #83). A page the reader
 * cannot see (`away`) whose stage is not ready joins nothing either: it
 * keeps what it shows until its own pixels land. A keystroke that adds a
 * line moves one line across every page break of the chapter, which tied
 * every page of it to the one being typed on; the pages never scrolled to
 * have no exact pixels yet, and the paper stood still until the next
 * canonical compile (measured: all 14 keystrokes of a run unanswered). */
function provisionalCommitGroups(stages, committedSrcs, editGroup, painted = () => true, ready = () => true,
  away = () => false) {
  const root = new Map(stages.map(stage => [stage.dl.page, stage.dl.page]));
  const find = page => {
    while (root.get(page) !== page) page = root.get(page);
    return page;
  };
  const join = (a, b) => root.set(find(a), find(b));
  const pageOfSrc = new Map();
  const pageOfEdit = new Map();
  const note = (map, key, page) => {
    if (map.has(key)) join(page, map.get(key));
    else map.set(key, page);
  };
  const staged = new Map(stages.map(stage => [stage.dl.page, stage]));
  const waiting = stage => !ready(stage) && (!painted(stage.dl.page) || away(stage.dl.page));
  // A page still waiting for exact pixels that no edit touched (the replay
  // towards a keystroke re-delivers such pages of a long document) ties its
  // neighbour only through what the two actually share, not by standing
  // next to it: otherwise the page being typed on waited for every picture
  // of the chapter before it.
  const loose = stage => !ready(stage) && !editGroup.has(stage.dl.page);
  for (const stage of stages) {
    const page = stage.dl.page;
    if (waiting(stage)) continue;
    if (root.has(page - 1) && !waiting(staged.get(page - 1)) && (painted(page) || painted(page - 1)) &&
        !loose(stage) && !loose(staged.get(page - 1))) join(page, page - 1);
    stage.srcs ??= displayListSrcs(stage.dl);
    for (const src of stage.srcs) note(pageOfSrc, src, page);
    for (const src of committedSrcs.get(page) ?? []) note(pageOfSrc, src, page);
    const edit = editGroup.get(page);
    if (edit !== undefined) note(pageOfEdit, edit, page);
  }
  const groups = new Map();
  for (const stage of stages) {
    const group = find(stage.dl.page);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(stage);
  }
  return [...groups.values()];
}

// What keeps a staged page from being shown as it is: canonical-only ink,
// exact pixels not rendered yet, browser math, a stale picture.
const owesExactInk = cmd => cmd.op === 'canon' || cmd.op === 'pending-exact' ||
  cmd.op === 'glyphs' && cmd.math || cmd.op === 'chunk' && cmd.st;

// The pages whose paper crosses the pane now. Read once per turn of the
// event loop: an update stages every page it delivers in one go.
let sightMemo = null;
function pagesInSight() {
  if (sightMemo) return sightMemo;
  const sight = new Set();
  const viewport = pagesEl.getBoundingClientRect();
  if (viewport.height > 0) {
    for (const [page, div] of pageDivs) {
      const bounds = div.getBoundingClientRect();
      if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) sight.add(page);
    }
  }
  sightMemo = sight;
  queueMicrotask(() => { sightMemo = null; });
  return sight;
}

function pagePainted(page) {
  const div = pageDivs.get(page);
  return Boolean(div) && (div.dataset.prov === '1' || div.dataset.canonPresentedRev !== undefined);
}

function srcOf(target) {
  const src = target?.dataset?.src ?? target?.closest?.('[data-src]')?.dataset?.src;
  if (!src || src.startsWith('_')) return null;
  return src;
}

function stageProvisionalPatches(patches, flash, pageCount = null, editIds = null, rev = null, fromStream = false) {
  if (editIds?.size) {
    const group = ++editGroupSeq;
    for (const patch of patches) {
      if (patch.type !== 'replace-page') continue;
      const page = patch.displayList.page;
      const shown = committedPageSrcs.get(page) ?? new Set();
      if ([...displayListSrcs(patch.displayList)].some(id => editIds.has(id)) || [...shown].some(id => editIds.has(id))) {
        pageEditGroup.set(page, group);
      }
    }
  }
  const end = pageSetEnd(rev);
  let topology = false;
  if (end !== Infinity) {
    patches = patches.filter(patch => patch.type === 'replace-page' && patch.displayList.page <= end);
    pageCount = null;
  } else if (rev !== null && (Number.isInteger(pageCount) || patches.some(patch => patch.type === 'remove-pages' ||
      patch.type === 'replace-page' && patch.displayList.page > Math.max(0, ...provisionalDisplayLists.keys())))) {
    pageTopologyRev = rev;
    topology = true;
  }
  // (each page keeps the newest list it was sent: a /doc snapshot older than
  // a patch taken meanwhile does not take it back; the list it has, staged
  // again under a newer source revision by applyReport, stays)
  if (rev !== null) {
    patches = patches.filter(patch => patch.type !== 'replace-page' || (pageListRev.get(patch.displayList.page) ?? 0) <= rev ||
      provisionalDisplayLists.get(patch.displayList.page) === patch.displayList);
  }
  const delivered = patches.filter(patch => patch.type === 'replace-page').map(patch => patch.displayList.page);
  if (delivered.length) traceStage('deliver', null, { pages: delivered });
  // (a warm or an exact render that lands gives the page's pictures new versions)
  if (delivered.length) scheduleChunkPrefetch();
  for (const patch of patches) {
    if (patch.type === 'replace-page') {
      const dl = patch.displayList;
      if (rev !== null) pageListRev.set(dl.page, Math.max(pageListRev.get(dl.page) ?? 0, rev));
      provisionalDisplayLists.set(dl.page, dl);
      if (dl.commands?.some(cmd => cmd.op === 'pending-exact' && cmd.wholePage)) provisionalPendingLayout.add(dl.page);
      else provisionalPendingLayout.delete(dl.page);
    } else if (patch.type === 'remove-pages') {
      for (const n of provisionalDisplayLists.keys()) if (n >= patch.from) provisionalDisplayLists.delete(n);
      for (const n of provisionalPendingLayout) if (n >= patch.from) provisionalPendingLayout.delete(n);
      for (const n of pageListRev.keys()) if (n >= patch.from) pageListRev.delete(n);
    }
  }
  if (Number.isInteger(pageCount) && pageCount >= 0) {
    for (const n of provisionalDisplayLists.keys()) if (n > pageCount) provisionalDisplayLists.delete(n);
    for (const n of pageListRev.keys()) if (n > pageCount) pageListRev.delete(n);
    for (const n of provisionalPendingLayout) if (n > pageCount) provisionalPendingLayout.delete(n);
    if ([...pageDivs.keys(), ...provisionalStages.keys()].some(n => n > pageCount)) removePagesFrom(pageCount + 1);
  }
  // (an event that told no count: the pages it left are the page set)
  if (topology) pageTopologyCount = Number.isInteger(pageCount) && pageCount >= 0 ? pageCount : Math.max(0, ...provisionalDisplayLists.keys());
  if (fromStream) recoverStreamSheets(patches, pageCount);
  if (usesCanonicalSurface()) {
    provisionalStages.clear();
    provisionalRemovedPages.clear();
    return;
  }
  if (committedCanonicalGeneration?.rev === appliedSrcRev &&
      committedCanonicalGeneration.epoch === documentReset.adoptedEpoch) {
    committedCanonicalGeneration.residentLayoutCompatible =
      provisionalDisplayLists.size === committedCanonicalGeneration.pageCount && !provisionalPendingLayout.size;
    return;
  }
  // An async chunk patch may replace only one page of an unfinished reflow.
  // Carry every other unpublished DL, including across a new source edit;
  // otherwise the first ready page can erase ink still waiting on another.
  const displayLists = new Map([...provisionalStages].map(([n, stage]) => [n, stage.dl]));
  const replaced = new Set();
  for (const patch of patches) {
    if (patch.type === 'replace-page') {
      displayLists.set(patch.displayList.page, patch.displayList);
      replaced.add(patch.displayList.page);
      provisionalRemovedPages.delete(patch.displayList.page);
    } else if (patch.type === 'remove-pages') {
      removePagesFrom(patch.from);
      for (const n of displayLists.keys()) if (n >= patch.from) displayLists.delete(n);
    }
  }
  const building = [];
  for (const [n, dl] of displayLists) {
    const previous = provisionalStages.get(n);
    if (replaced.has(n) || !previous || previous.sourceRev !== appliedSrcRev ||
        previous.documentEpoch !== documentReset.adoptedEpoch) building.push(dl);
  }
  // (of an update of many pages, those the reader is not near are put off:
  // renderPage. Fewer than four are simply built.)
  const mayDefer = building.length >= 4;
  if (mayDefer) traceStage('many', null, { pages: building.length });
  for (const dl of building) renderPage(dl, flash, mayDefer);
  queueMicrotask(tryCommitProvisionalStages);
}

function holdingDirectOpeningPaper() {
  return Boolean(openingDirectInput?.sink && !openingDirectInput.waitingForShipMap);
}

function directPresentationBlocked() {
  return holdingDirectOpeningPaper() || flushingDirectPresentation;
}

function shippingPresentationBlocked() {
  return documentReset.pending || Boolean(directEditor) || Boolean(openingDirectInput) ||
    queuedDirectOpenings.length > 0 || flushingDirectPresentation || opaqueBatchCommitDepth > 0;
}

// The first keystroke on a page stages it from its display list, and every
// chunk picture on it is then loaded for the first time: 8 pictures and
// 25-35 ms on a page of code boxes, on top of the keystroke itself. The
// pictures of the pages the reader is looking at are asked for ahead of that,
// so they come from the browser's cache when the page is staged. Only
// pictures with a fixed address are kept there (chunkImageSrc).
// (the picture objects are kept: one that is let go has to be read from the
// cache and parsed again when its page is staged, 20 ms for eight of them)
const prefetchedChunks = new Map(); // src -> Image, most recently asked for last
let chunkPrefetchTimer = null;
function prefetchVisibleChunks() {
  if (typeof serverBootId !== 'string' || documentReset.pending || usesCanonicalSurface()) return;
  const viewport = pagesEl.getBoundingClientRect();
  const visible = new Set();
  for (const [page, div] of pageDivs) {
    const bounds = div.getBoundingClientRect();
    if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
    for (const n of [page - 1, page, page + 1]) visible.add(n);
  }
  for (const n of visible) {
    for (const cmd of provisionalDisplayLists.get(n)?.commands ?? []) {
      if (cmd.op !== 'chunk') continue;
      const src = chunkImageSrc(cmd);
      let image = prefetchedChunks.get(src);
      if (image) prefetchedChunks.delete(src);
      else {
        image = new Image();
        image.src = src;
        void image.decode?.().catch(() => {});
      }
      prefetchedChunks.set(src, image);
    }
  }
  while (prefetchedChunks.size > 256) prefetchedChunks.delete(prefetchedChunks.keys().next().value);
  // The source map too: the next keystroke's update brings only the change
  // from the one this viewer holds (adoptPushedSnapshot). Held as of now,
  // that change is the edited block; held from before the pages settled, it
  // was every block of the document (1.4 MB on a 72-page book).
  if (Number.isSafeInteger(appliedSrcRev) && appliedSrcRev > 0) {
    provisionalSnapshotCache.delete(`${documentReset.adoptedEpoch}:${appliedSrcRev}`);
    void loadProvisionalSnapshot(appliedSrcRev).catch(() => {});
  }
}
function scheduleChunkPrefetch() {
  if (chunkPrefetchTimer !== null) return;
  chunkPrefetchTimer = window.setTimeout(() => {
    chunkPrefetchTimer = null;
    prefetchVisibleChunks();
  }, 200);
}

// `owedOnly`: asked because a page in sight holds a commit back, not because
// the reader moved; then only such a page is worth a warm.
function scheduleViewportWarm({ owedOnly = false } = {}) {
  scheduleChunkPrefetch();
  if (owedOnly && viewportWarmTimer !== null) return;
  window.clearTimeout(viewportWarmTimer);
  viewportWarmTimer = window.setTimeout(() => {
    viewportWarmTimer = null;
    if (documentReset.pending || usesCanonicalSurface() || directEditor || inFlight || composing) return;
    const viewport = pagesEl.getBoundingClientRect();
    const center = (viewport.top + viewport.bottom) / 2;
    let nearest = null;
    let distance = Infinity;
    // A page in sight still waiting for exact pixels that the edit in hand
    // did not touch (the engine renders the edit's own pages itself): a page
    // left stale while it was out of sight and now scrolled to, or one that
    // took a block from the page after it. It is warmed before the page at
    // the centre, and it asks for the canonical compile it did not ask for
    // while out of sight.
    let owed = null;
    let owedDistance = Infinity;
    for (const [page, div] of pageDivs) {
      const bounds = div.getBoundingClientRect();
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
      const gap = Math.abs((bounds.top + bounds.bottom) / 2 - center);
      if (gap < distance) { nearest = page; distance = gap; }
      const stage = provisionalStages.get(page);
      if (stage && !stage.ready && !pageEditGroup.has(page) && stage.dl.commands.some(owesExactInk)) {
        requestCanonicalDisplay({ residentImpossible: stage.dl.commands.some(cmd => cmd.op === 'canon') });
        if (gap < owedDistance) { owed = page; owedDistance = gap; }
      }
    }
    if (owed !== null) nearest = owed;
    else if (owedOnly) return;
    if (nearest === null) return;
    const key = `${documentReset.adoptedEpoch}:${appliedSrcRev}:${nearest}`;
    if (viewportWarmKey === key) return;
    viewportWarmKey = key;
    void fetch('/warm', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: nearest }),
    }).catch(() => { if (viewportWarmKey === key) viewportWarmKey = ''; });
  }, 160);
}

function flushDirectPresentationUpdates() {
  if (holdingDirectOpeningPaper() || flushingDirectPresentation || documentReset.pending) return;
  // Replay source events in order, while keeping their intermediate surfaces
  // offscreen. Delta patches cannot be replaced by only the last event.
  flushingDirectPresentation = true;
  try {
    while (deferredDirectPresentationEvents.length && !holdingDirectOpeningPaper()) {
      deferredDirectPresentationEvents.shift()();
    }
  } finally {
    flushingDirectPresentation = false;
  }
  if (holdingDirectOpeningPaper() || documentReset.pending) return;
  for (const pageNumber of pageDivs.keys()) updateCanonState(pageNumber);
  for (const batch of opaqueCanonicalBatches.values()) tryCommitOpaqueCanonicalBatch(batch);
  tryCommitProvisionalStages();
  if (shipWaveBatch) tryCommitShipWaveBatch(shipWaveBatch);
  tryApplyPendingCanonicalAnchor();
  const commits = [...deferredDirectPresentationCommits.values()];
  deferredDirectPresentationCommits.clear();
  for (const commit of commits) commit();
}

// Why the paper is or is not following the source, for a diagnostic session:
// call window.__tdomViewerState() in the frame's console.
globalThis.__tdomViewerState = (pages = []) => ({
  pages: pages.map((n) => {
    const stage = provisionalStages.get(n);
    const dl = stage?.dl ?? provisionalDisplayLists.get(n);
    const owed = (dl?.commands ?? []).filter(cmd => cmd.op === 'canon' || cmd.op === 'pending-exact' ||
      cmd.op === 'glyphs' && cmd.math || cmd.op === 'chunk' && cmd.st);
    return { page: n, staged: !!stage, ready: !!stage?.ready, rev: stage?.sourceRev ?? null,
      painted: pageDivs.get(n)?.className ?? null, owed: owed.length,
      owedBy: [...new Set(owed.map(cmd => `${cmd.op}${cmd.st ? ':stale' : ''}:${cmd.src}`))].slice(0, 8) };
  }),
  appliedSrcRev,
  residentPages: provisionalDisplayLists.size,
  pendingLayout: [...provisionalPendingLayout].slice(0, 20),
  staged: provisionalStages.size,
  stagedReady: [...provisionalStages.values()].filter(stage => stage.ready).length,
  removed: provisionalRemovedPages.size,
  canonical: committedCanonicalGeneration && { ...committedCanonicalGeneration },
  reported: canonical && { rev: canonical.rev, pageCount: canonical.pageCount },
  canonicalSurface: usesCanonicalSurface(),
  resetPending: documentReset.pending,
});

function tryCommitProvisionalStages() {
  resyncPendingLayout();
  if (directPresentationBlocked()) return traceStage('hold', null, { why: 'direct-presentation' });
  if (usesCanonicalSurface() || documentReset.pending) return traceStage('hold', null, { why: 'canonical-surface' });
  // Canonical may have replaced an incomplete or differently paginated
  // resident layout and cleared its stages. Its next delta cannot certify
  // physical page addresses, even if every delivered chunk is drawable.
  if (committedCanonicalGeneration?.epoch === documentReset.adoptedEpoch &&
      committedCanonicalGeneration.rev < appliedSrcRev &&
      committedCanonicalGeneration.residentLayoutCompatible === false) {
    for (const page of pageDivs.keys()) pageDirtyRev.set(page, appliedSrcRev);
    requestCanonicalDisplay({ residentImpossible: true });
    return traceStage('hold', null, { why: 'layout-incompatible' });
  }
  if (!provisionalStages.size && !provisionalRemovedPages.size) return;
  const residentPageCount = provisionalDisplayLists.size;
  const stages = [...provisionalStages.values()].sort((a, b) => a.dl.page - b.dl.page);
  // A report is the resident generation boundary. Refuse a malformed or
  // incomplete address space, including delayed pages beyond its declared
  // tail, rather than publishing a mixed paper.
  if (!residentPageTransactionValid(
    residentPageCount,
    provisionalDisplayLists.keys(),
    stages.map(stage => Number(stage.dl?.page)),
    provisionalRemovedPages
  )) {
    requestCanonicalDisplay({ residentImpossible: true });
    return traceStage('hold', null, { why: 'page-transaction', residentPageCount });
  }
  // Removing the page that owns a live editor would disconnect its native
  // focus/selection (and possibly an IME composition). Keep the exact path
  // for that uncommon case; ordinary pagination changes remain provisional.
  if (directEditor && provisionalRemovedPages.has(Number(directEditor.pageNumber))) {
    requestCanonicalDisplay({ residentImpossible: true });
    return;
  }
  // A canonical that cannot vouch for this revision (canonicalCountStalled)
  // has no count here: the settled resident layout is the only one, as before
  // the first canonical, for growth and shrink alike (tex64-internal #121:
  // the back cover stayed out of reach while a failed compile waited 94 s).
  const canonicalStalled = canonicalCountStalled(canonical, appliedSrcRev);
  const canonicalPageCount = canonicalStalled ? null : currentCanonicalPageCount(
    canonical, committedCanonicalGeneration, documentReset.adoptedEpoch, appliedSrcRev
  );
  const pageCountMismatch = canonicalPageCount !== null &&
    canonicalPageCount !== residentPageCount;
  // (a page only canonical can paint never becomes ready without one: while
  // the canonical is stalled it holds neither the count nor the pages next to it)
  const canonicalOnly = stage => canonicalStalled && stage.dl.commands.some(cmd => cmd.op === 'canon');
  // A shrink with no page to replace: the settled resident count removes the
  // tail itself while the canonical is stalled.
  if (canonicalStalled && !provisionalPendingLayout.size && provisionalRemovedPages.size &&
      stages.every(canonicalOnly)) {
    reconcilePageCount(residentPageCount);
    provisionalRemovedPages.clear();
    residentPageCountAuthoritative = false;
    if (!stages.length) return traceStage('commit', null, { removedTail: true });
  }
  if ((canonical?.rev === appliedSrcRev && pageCountMismatch) ||
      (provisionalPendingLayout.size && (pageCountMismatch || provisionalRemovedPages.size)) ||
      (provisionalRemovedPages.size && !stages.length)) {
    for (const page of pageDivs.keys()) pageDirtyRev.set(page, appliedSrcRev);
    requestCanonicalDisplay({ residentImpossible: true });
    return traceStage('hold', null, { why: 'page-count', residentPageCount, canonicalPageCount,
      pendingLayout: provisionalPendingLayout.size, removed: provisionalRemovedPages.size });
  }
  if (canonicalPageCount === null || pageCountMismatch) requestCanonicalDisplay();
  const stageReady = stage => stage.ready && stage.sourceRev === appliedSrcRev &&
    stage.documentEpoch === documentReset.adoptedEpoch &&
    Number(stage.snapshot?.srcRev) === appliedSrcRev &&
    Number(stage.snapshot?.documentEpoch) === stage.documentEpoch;
  // Before this document's first canonical the resident count is the only
  // one. Once no resident page waits for a block's geometry (the boot walk
  // compiled its rescues) it is settled, and a ready group need not wait for
  // every page's exact ink: on the 316-page book that wait lasted until the
  // first canonical, about four minutes after opening (tex64-internal #83).
  const residentCountSettled = canonicalPageCount === null && !provisionalPendingLayout.size;
  // A shell is only a place: its page commits when its group is ready, and
  // one scrolled to asks for its pixels. Once no resident page waits for its
  // layout, the resident count makes the places, before any page in sight is
  // waited for: a new last page (the back cover an inserted lesson moved on)
  // was out of reach while a page in sight waited for exact ink, and after a
  // document reset the paper had five places for the host's handoff to page
  // 29 (tex64-internal #121).
  if (!provisionalPendingLayout.size) for (let n = 1; n <= residentPageCount; n++) ensureShell(n);
  let committing = stages;
  // (the pages a partial commit leaves staged on purpose: out of sight, not ready)
  let sight = null;
  if (!stages.every(stageReady)) {
    // While the page count is settled, a ready group (provisionalCommitGroups)
    // does not wait for another: typically a page elsewhere still waiting for
    // exact pixels (the previous keystroke's, or a running head the edit
    // touched) would hold back the page being typed on now. Numbers on far
    // pages may briefly lag until theirs land.
    // A page count that differs from canonical's, or a tail being removed,
    // waits for every page the reader can see; pages out of sight that still
    // owe exact pixels keep what they show until they are scrolled to
    // (scheduleViewportWarm) or the next canonical lands.
    sight = pagesInSight();
    const owedInSight = stages.filter(stage => !stageReady(stage) && sight.has(stage.dl.page) && !canonicalOnly(stage));
    const tailInSight = [...provisionalRemovedPages].some(page => sight.has(page));
    if (((pageCountMismatch || provisionalRemovedPages.size) && (owedInSight.length || (tailInSight && !canonicalStalled))) ||
        (canonicalPageCount === null && !residentCountSettled) || directEditor) {
      // (where no page is taken without the others, the pages put off while
      // out of sight are built after all: renderPage `mayDefer`)
      if ((canonicalPageCount === null && !residentCountSettled) || directEditor) buildDeferredStages();
      if (owedInSight.length) scheduleViewportWarm({ owedOnly: true });
      return traceStage('hold', null, { why: 'not-all-ready', residentPageCount, canonicalPageCount,
        pendingLayout: provisionalPendingLayout.size, removed: provisionalRemovedPages.size, editor: !!directEditor,
        waiting: stages.filter(stage => !stageReady(stage)).map(stage => stage.dl.page).slice(0, 12) });
    }
    // (a count canonical does not have yet, while a resident page still
    // waits for its layout: its new pages get their shells when they are
    // committed, as when every page is ready)
    if (!pageCountMismatch && stages.some(stage => !pageDivs.has(stage.dl.page))) {
      return traceStage('hold', null, { why: 'no-shell' });
    }
    committing = provisionalCommitGroups(stages, committedPageSrcs, pageEditGroup, pagePainted, stageReady,
      page => !sight.has(page))
      .filter(group => group.every(stageReady)).flat()
      .sort((a, b) => a.dl.page - b.dl.page);
    if (!committing.length) {
      if (owedInSight.length) scheduleViewportWarm({ owedOnly: true });
      return traceStage('hold', null, { why: 'no-ready-group',
        waiting: stages.filter(stage => !stageReady(stage)).map(stage => stage.dl.page).slice(0, 12) });
    }
    if (owedInSight.length) scheduleViewportWarm({ owedOnly: true });
  }
  const editorStage = committing.find(stage => stage.dl.page === directEditor?.pageNumber);
  const editorRegion = editorStage ? directEditorRegionInSnapshot(editorStage.snapshot, directEditor) : null;
  if (editorStage && !provisionalStageKeepsEditor(editorStage, editorRegion)) {
    const pending = directEditorSnapshotPending(editorStage.snapshot, directEditor, editorStage.sourceRev, editorRegion);
    requestCanonicalDisplay({ residentImpossible: !pending });
    return;
  }
  // (the reader's place, put back after the pages change: viewAnchor; the
  // page its line moves to goes with the page it leaves)
  const viewAnchor = captureViewAnchor(new Set([...stages.map(stage => stage.dl.page), ...provisionalRemovedPages]));
  committing = keepViewAnchorLine(viewAnchor, committing, stageReady);
  if (!committing.length) return traceStage('hold', null, { why: 'view-anchor' });
  if (viewAnchorWait && committing.some(stage => stage.dl.page === viewAnchorWait.page)) clearViewAnchorWait();
  if (committing !== stages && !sight) sight = pagesInSight();
  const nextLists = viewAnchor && provisionalAnchorLists(viewAnchor, committing);
  if (nextLists) restoreViewAnchor(viewAnchor, { nextLists });
  // All affected pages change within this synchronous transaction. A new
  // provisional page is also kept detached until its complete ink is ready.
  if (committing === stages) {
    provisionalStages.clear();
    pageEditGroup.clear();
  } else for (const stage of committing) provisionalStages.delete(stage.dl.page);
  for (const stage of committing) {
    const { dl, staging, sourceRev, snapshot } = stage;
    // (for a diagnostic session: the blocks this page shows from an earlier
    // galley's pixels, i.e. not yet what the source says now)
    traceStage('commit', dl.page, Array.isArray(globalThis.__tdomStageTrace)
      ? { sourceRev,
        held: [...new Set(dl.commands.filter(cmd => cmd.op === 'chunk' && cmd.held && !cmd.part).map(cmd => cmd.src))],
        parts: dl.commands.filter(cmd => cmd.op === 'chunk' && cmd.part).length }
      : { sourceRev });
    const srcs = stage.srcs ?? displayListSrcs(dl);
    committedPageSrcs.set(dl.page, srcs);
    pageEditGroup.delete(dl.page);
    let div = pageDivs.get(dl.page);
    if (!div) div = ensureShell(dl.page);
    const prior = div.paintedResidentPage;
    if (prior && snapshot.rejectedBlocks?.length && !provisionalRemovedPages.size && !pageCountMismatch &&
        residentPageCount === pageDivs.size && prior.width === stage.paperWidth && prior.height === stage.paperHeight) {
      const rejected = new Set(snapshot.rejectedBlocks.filter(id => srcs.has(id)));
      if (onlyRejectedInkChanged(prior.dl, dl, rejected)) {
        div.dataset.provNativeHold = '1';
        delete div.dataset.provPending;
        continue;
      }
    }
    delete div.dataset.provNativeHold;
    div.paintedResidentPage = { dl, width: stage.paperWidth, height: stage.paperHeight };
    const committedSvg = div.querySelector(':scope > svg:not(.tdom-canonical-delta)');
    let stagedSvg = staging.firstElementChild?.localName === 'svg' ? staging.firstElementChild : null;
    // (the lines that did not change keep their elements: patchProvisionalSvg)
    let kept = false;
    const cut = stagedSvg ? stage.svgCut : null;
    if (cut) {
      if (committedSvg && !globalThis.__tdomWholePageCommit && div.provisionalSvgParts === cut.base &&
          committedSvg.childNodes.length === cut.base.length - 2) {
        spliceSvgChildren(committedSvg, cut.head, cut.base.length - 2 - cut.tail, [...stagedSvg.childNodes]);
        kept = true;
      } else {
        // the page is not the one this stage was cut against any more: its whole SVG after all
        const whole = document.createElement('div');
        whole.innerHTML = stage.svgParts.join('');
        whole.querySelectorAll('text[data-font-pending]').forEach(node => node.removeAttribute('data-font-pending'));
        stagedSvg.replaceWith(whole.firstElementChild);
        stagedSvg = staging.firstElementChild;
      }
    }
    if (!kept) kept = patchProvisionalSvg(committedSvg, div.provisionalSvgParts, stagedSvg, stage.svgParts);
    if (kept) stagedSvg.remove();
    else committedSvg?.remove();
    div.provisionalSvgParts = stage.svgParts ?? null;
    div.querySelectorAll(':scope > .chunkwin').forEach(e => e.remove());
    div.append(...staging.childNodes);
    div.provisionalEpoch = (div.provisionalEpoch ?? 0) + 1;
    retirePendingFormulas(div);
    div.provisionalSnapshot = snapshot;
    div.provisionalDl = dl;
    div.dataset.prov = '1';
    div.dataset.provRev = String(sourceRev);
    delete div.dataset.provPending;
    div.provisionalDropped = false;
    div.classList.remove('awaiting-canonical');
  }
  // Tail removal belongs to the same renderer transaction as the replacement
  // pages above. The browser cannot paint old tail pages beside the new
  // resident generation, even when its page count is only provisional.
  if (provisionalRemovedPages.size) reconcilePageCount(residentPageCount);
  provisionalRemovedPages.clear();
  residentPageCountAuthoritative = canonicalPageCount === residentPageCount;
  for (const stage of committing) updateCanonState(stage.dl.page);
  if (!nextLists) restoreViewAnchor(viewAnchor, { measure: true });
  // (what a partial commit left staged is out of the reader's sight)
  const shown = committing === stages ||
    stages.every(stage => committing.includes(stage) || !sight.has(stage.dl.page));
  if (residentPageCountAuthoritative && shown && committing.every(stage => {
    const page = pageDivs.get(stage.dl.page);
    return !page.classList.contains('is-final') || Number(page.dataset.canonPresentedRev) >= stage.sourceRev;
  })) fulfillCanonicalDisplay();
  if (liveSearch.query) scheduleLiveSearchRefresh();
  if (committing.some(stage => stage.dl.page === directEditor?.pageNumber)) {
    repositionDirectEditor();
    void refreshDirectEditGeometry();
  }
  updateBadge();
}

// ---------------------------------------------------------------- view anchor
// The reader's place, kept across every change of the paper (docs/04,
// web/view-anchor.js): taken just before a commit changes the pages and put
// back just after it, in the same task, so no frame shows the paper moved.
// The line of the last edit, while it is in view, holds the paper still; it
// is put back only once it has left the view. Otherwise the line at the
// viewport centre stays exactly where it was. What outranks it: a Jump or
// the host's handoff on their way, an editor on the paper (they place the
// paper themselves), and the reader's own scrolling (the latest position
// wins). Only the pages in sight and two either side are read, and nothing
// after the commit is measured: a commit moves no page box, so where a line
// stands now follows from the boxes taken before and the lists now on paper.
let viewEditSrcs = null; // the blocks of the last edit (applyReport)
let viewAnchorScrollOffset = 0; // scroll applied by earlier paper restores
const viewClock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// (set by the embed code: a Jump refining, a handoff the host has not revealed)
const viewAnchorHolds = { jump: () => false, handoff: () => false, scrolled: () => {} };
function viewAnchorHeld() {
  return Boolean(directEditor) || viewAnchorHolds.jump() || viewAnchorHolds.handoff();
}
// Use the ink under the reader: resident SVG or the glyph index attached
// to the decoded exact image. An old resident list is only a fallback for
// an exact image whose text geometry could not be extracted.
function viewAnchorList(div) {
  if (!div) return null;
  const exact = div.classList.contains('is-final') ? div.querySelector?.('img.canon')?.viewAnchorDl : null;
  if (exact) return exact;
  if (div.dataset.prov !== '1' || !div.provisionalDl) return null;
  if (!div.classList.contains('is-final')) return div.provisionalDl;
  return div.exactListDl ?? null;
}
// The pages in sight and `span` on either side, top to bottom, with their
// boxes and the list each shows (viewAnchorList).
function viewAnchorPages(span = 2) {
  if (typeof pagesEl?.getBoundingClientRect !== 'function' || !(pagesEl.clientHeight > 0)) return null;
  const entries = [...pageDivs].filter(([, div]) => div.isConnected).sort((a, b) => a[0] - b[0]);
  if (!entries.length) return null;
  const view = pagesEl.getBoundingClientRect();
  const viewBottom = view.top + pagesEl.clientHeight;
  // (the first page whose bottom is below the viewport's top)
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid][1].getBoundingClientRect().bottom > view.top) hi = mid;
    else lo = mid + 1;
  }
  const pages = [];
  let after = 0;
  for (let k = Math.max(0, lo - span); k < entries.length && after <= span; k++) {
    const [page, div] = entries[k];
    const rect = div.getBoundingClientRect();
    if (rect.top >= viewBottom) after++;
    pages.push({ page, el: div, top: rect.top, height: rect.height, width: rect.width,
      paperHeight: viewAnchorPaperHeight(div, rect.height), dl: viewAnchorList(div) });
  }
  return { pages, viewTop: view.top, viewBottom };
}
function viewAnchorPaperHeight(div, fallback) {
  return Number(div.classList.contains('is-final') && div.dataset.canonPaperH || geometry.paperheight) || fallback;
}
// `touched`: the pages the change replaces or removes; none of them in reach,
// nothing in view can move.
function captureViewAnchor(touched = null) {
  if (openingPreview && !openingEdited) return null;
  const Anchor = globalThis.TdomViewAnchor;
  if (!Anchor || viewAnchorHeld()) return null;
  const near = viewAnchorPages();
  if (!near?.pages.length || touched && !near.pages.some((p) => touched.has(p.page))) return null;
  if (typeof outerPaper !== 'undefined' && outerPaper) {
    const centre = (near.viewTop + near.viewBottom) / 2;
    if ([outerBeforeEl, outerAfterEl].some(run => {
      const first = run.firstElementChild, last = run.lastElementChild;
      return first && first.getBoundingClientRect().top <= centre && centre < last.getBoundingClientRect().bottom;
    })) return null;
  }
  let anchor = Anchor.captureAnchor({ ...near, editSrcs: viewEditSrcs });
  if (anchor?.kind === 'reading' && viewEditSrcs?.size) {
    const sourcePages = near.pages.map(p => p.dl?.exact
      ? { ...p, dl: p.el.exactListDl ?? p.el.provisionalDl ?? provisionalDisplayLists.get(p.page) } : p);
    const edit = Anchor.captureAnchor({ ...near, pages: sourcePages, editSrcs: viewEditSrcs });
    if (edit?.kind === 'edit') anchor = edit;
  }
  if (!anchor) return null;
  anchor.readerScroll = pagesEl.scrollTop - viewAnchorScrollOffset;
  anchor.boxes = near.pages;
  anchor.following = Anchor.followingLines(anchor, near.pages.find((p) => p.page === anchor.page)?.dl);
  return anchor;
}
// Where the anchor stands now on the pages it was taken on (their boxes as
// taken, or read again: `measure`), the lists now on their paper.
function viewAnchorNow(anchor, measure = false, nextLists = null) {
  const pages = anchor.boxes.filter((p) => p.el.isConnected).map((p) => {
    const box = measure ? p.el.getBoundingClientRect() : p;
    return { page: p.page, el: p.el, top: box.top, height: box.height, width: box.width,
      paperHeight: measure ? viewAnchorPaperHeight(p.el, box.height) : p.paperHeight,
      dl: nextLists?.has(p.page) ? nextLists.get(p.page) : viewAnchorList(p.el) };
  });
  if (anchor.kind === 'page') return pages.find((p) => p.page === anchor.page) ?? null;
  return globalThis.TdomViewAnchor.locateAnchor(anchor, pages, anchor.following);
}
function scrollViewAnchor(anchor, now) {
  const delta = globalThis.TdomViewAnchor.restoreDelta(anchor, now);
  if (!delta) return 0;
  const before = pagesEl.scrollTop;
  pagesEl.scrollTop = before + delta;
  viewAnchorScrollOffset += pagesEl.scrollTop - before;
  viewAnchorHolds.scrolled();
  return delta;
}
// The pages of one commit leave the reader's line on paper. A page committed
// alone (its group ready, the next page still decoding or put off) could take
// the line away while the page it moves to still shows the old list: the line
// gone from both, the place lost. That page goes with it: taken in when
// ready, built when put off, and the reader's page waits for it, at most
// VIEW_ANCHOR_WAIT_MS.
const VIEW_ANCHOR_WAIT_MS = 1000;
let viewAnchorWait = null;
function clearViewAnchorWait() {
  if (viewAnchorWait?.timer != null) clearTimeout(viewAnchorWait.timer);
  viewAnchorWait = null;
}
function keepViewAnchorLine(anchor, committing, ready) {
  const Anchor = globalThis.TdomViewAnchor;
  if (!anchor || anchor.kind === 'page' || !Anchor) return committing;
  const taking = new Map(committing.map(stage => [stage.dl.page, stage]));
  if (!taking.has(anchor.page)) return committing;
  const has = (dl) => Boolean(Anchor.lineExtent(dl, anchor.src, anchor.line) ||
    Anchor.contentPlace(anchor.content, dl, anchor.content?.y)?.context);
  const near = [...new Set([anchor.page, anchor.page + 1, anchor.page - 1, anchor.page + 2, anchor.page - 2, anchor.page + 3])]
    .filter(page => pageDivs.has(page) && !provisionalRemovedPages.has(page));
  // (on paper after this commit: the lists taken, the others as they are)
  const after = (page) => taking.get(page)?.dl ?? viewAnchorList(pageDivs.get(page));
  if (near.some(page => has(after(page)))) return committing;
  // ...and in the newest lists (a page staged, or as it is)
  const destination = near.find(page => has(provisionalStages.get(page)?.dl ?? after(page)));
  const stage = destination === undefined ? null : provisionalStages.get(destination);
  if (!stage || taking.has(destination)) {
    if (anchor.kind !== 'reading' || !anchor.content) return committing;
  } else if (ready(stage)) {
    return [...committing, stage].sort((a, b) => a.dl.page - b.dl.page);
  }
  const now = viewClock();
  const epoch = documentReset.adoptedEpoch;
  const key = JSON.stringify([epoch, anchor.page, anchor.src, anchor.line, anchor.content?.text]);
  if (viewAnchorWait?.key !== key) {
    clearViewAnchorWait();
    const wait = viewAnchorWait = { key, page: anchor.page, deadline: now + VIEW_ANCHOR_WAIT_MS, timer: null };
    if (typeof setTimeout === 'function') {
      wait.timer = setTimeout(() => {
        wait.timer = null;
        if (viewAnchorWait === wait && epoch === documentReset.adoptedEpoch) {
          wait.expired = true;
          tryCommitProvisionalStages();
        }
      }, VIEW_ANCHOR_WAIT_MS);
    }
  }
  if (viewAnchorWait.expired || now >= viewAnchorWait.deadline) return committing;
  if (stage?.deferred) renderPage(provisionalDisplayLists.get(destination) ?? stage.dl, false);
  if (!stage) requestCanonicalDisplay({ residentImpossible: true });
  return committing.filter(stage => stage.dl.page !== anchor.page);
}
// A resident commit keeps the page boxes. Calculate its adjustment against
// the lists the pages will show and scroll before replacing SVG children,
// while layout is clean. Canonical overlays can change the visible layer
// independently, so those transactions resolve against the mounted layer.
function provisionalAnchorLists(anchor, committing) {
  if (canonicalAnchorPreview || canonicalAnchorPendingPatch || provisionalRemovedPages.size) return null;
  const next = new Map();
  for (const stage of committing) {
    const n = stage.dl.page;
    const page = anchor.boxes.find(box => box.page === n);
    if (!page) continue;
    if (!page.el.classList.contains('is-final')) {
      next.set(n, stage.dl);
      continue;
    }
    if (!page.dl?.exact) return null;
    const dirty = pageDirtyRev.get(n) ?? 0;
    const ship = shipPages.get(n);
    const keepExact = canonical?.id && (n > canonical.pageCount || dirty <= canonical.rev) ||
      ship && dirty <= ship.srcRev && (!embeddedHost || !shippingPresentationBlocked());
    next.set(n, keepExact ? page.dl : stage.dl);
  }
  return next;
}
function restoreViewAnchor(anchor, { measure = false, nextLists = null } = {}) {
  if (!anchor || viewAnchorHeld()) return 0;
  const now = viewAnchorNow(anchor, measure, nextLists);
  if (anchor.kind === 'page' || now?.exact) return scrollViewAnchor(anchor, now);
  const box = anchor.boxes.find(p => p.page === anchor.page);
  if (!(box?.height > 0)) return 0;
  if (now?.page === anchor.page) {
    const old = globalThis.TdomViewAnchor.lineExtent(box.dl, now.src, now.line);
    if (old) {
      const y = box.top + old.top * box.height / box.paperHeight;
      return scrollViewAnchor({ kind: 'reading', y, fraction: 0 }, now);
    }
  }
  const page = { ...anchor, kind: 'page', fraction: (anchor.y - box.top) / box.height };
  return scrollViewAnchor(page, viewAnchorNow(page, measure, nextLists));
}

// A page marked "no layout yet" (a block whose first galley had not arrived
// when this viewer read the document) is cleared by the patch that brings
// the layout. A viewer that loads while a long document is still booting can
// miss that patch: the engine sent it before the snapshot was applied. The
// mark then stayed for the whole session, the resident page count never
// counted as settled, and no keystroke was shown before the next canonical
// (a 389-page book: 20 pages marked, the engine holding none). While marks
// remain, ask the engine again and take the pages it has laid out since.
let pendingLayoutResyncAt = 0;
let pendingLayoutResyncing = false;
function docRecoveryVisible() {
  if (typeof document !== 'undefined' && document.hidden) return false;
  const options = { visibilityProperty: true };
  return pagesEl.checkVisibility?.(options) !== false &&
    (typeof window === 'undefined' || window.frameElement?.checkVisibility?.(options) !== false);
}
function resyncPendingLayout() {
  // Also while canonical found the resident paper paginated differently. That
  // verdict is taken once, when the generation is committed; a Build taken as
  // canonical arrives while the boot's rescues are still landing (387 pages
  // against 389), and the pages that follow come as patches of single pages,
  // which never say how many pages there are now. The book then held every
  // keystroke as "layout-incompatible" although the engine had all 389.
  const mismatched = committedCanonicalGeneration?.epoch === documentReset.adoptedEpoch &&
    committedCanonicalGeneration.residentLayoutCompatible === false;
  if (pendingLayoutResyncing || (!provisionalPendingLayout.size && !mismatched)) return;
  if (usesCanonicalSurface() || documentReset.pending || !docRecoveryVisible()) return;
  if (typeof fetch !== 'function' || typeof performance === 'undefined') return;
  const now = performance.now();
  if (now - pendingLayoutResyncAt < 4000) return;
  pendingLayoutResyncAt = now;
  pendingLayoutResyncing = true;
  const rev = appliedSrcRev;
  const epoch = documentReset.adoptedEpoch;
  fetch('/doc').then(response => response.json()).then((doc) => {
    if (appliedSrcRev !== rev || documentReset.adoptedEpoch !== epoch || documentReset.pending) return;
    if (Number(doc.report?.srcRev ?? doc.report?.rev) !== Number(rev)) return;
    // (read between an update and its report, the lists are of the next source: docResync)
    if (doc.layoutSrcRev != null && Number(doc.layoutSrcRev) !== Number(rev)) return;
    if (doc.documentEpoch != null && epoch != null && Number(doc.documentEpoch) !== Number(epoch)) return;
    const settled = dl => !dl.commands?.some(cmd => cmd.op === 'pending-exact' && cmd.wholePage);
    const recount = mismatched && (doc.pages ?? []).length !== provisionalDisplayLists.size &&
      (doc.pages ?? []).every(settled);
    const laidOut = (doc.pages ?? []).filter(dl => recount || (provisionalPendingLayout.has(dl.page) && settled(dl)));
    if (!laidOut.length) return;
    // (a snapshot older than patches taken meanwhile: its revision orders it,
    // audit/scratch r7 ordering.mjs, a delayed GET took a restored page 3 back)
    stageProvisionalPatches(laidOut.map(displayList => ({ type: 'replace-page', displayList })), false, doc.pages.length, null,
      Number.isInteger(doc.layoutRev) ? doc.layoutRev : null);
    if (committedCanonicalGeneration && committedCanonicalGeneration.epoch === documentReset.adoptedEpoch &&
        provisionalDisplayLists.size === committedCanonicalGeneration.pageCount && !provisionalPendingLayout.size) {
      committedCanonicalGeneration.residentLayoutCompatible = true;
    }
    tryCommitProvisionalStages();
  }).catch(() => {}).finally(() => { pendingLayoutResyncing = false; });
}

// A canonical report that stalls the canonical (its newest compile failed,
// none of this revision running) hands the page count to the settled
// resident layout: a commit held for it while this revision compiled (a
// shrink waiting for canonical, typically) is tried again now, not at the
// next edit or render (tex64-internal #121).
function retryCommitAfterCanonicalStall() {
  if (!canonicalCountStalled(canonical, appliedSrcRev)) return;
  if (provisionalStages.size || provisionalRemovedPages.size) tryCommitProvisionalStages();
}

let lastCanonicalDisplayDemand = '';
let currentCanonicalDisplayDemand = null;
let canonicalDisplayRequests = Promise.resolve();
function sendCanonicalDisplayRequest(body) {
  // Preserve request/fulfilled/re-request order without blocking input.
  // Each viewer owns its demand ID; a delayed release cannot clear another.
  canonicalDisplayRequests = canonicalDisplayRequests.then(() => fetch('/canonical/display-demand', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).catch(() => {});
}
function requestCanonicalDisplay({ residentImpossible = false } = {}) {
  const documentEpoch = documentReset.adoptedEpoch;
  const srcRev = appliedSrcRev;
  if (documentReset.pending || !Number.isSafeInteger(documentEpoch) || documentEpoch < 1 ||
      !Number.isSafeInteger(srcRev) || srcRev < 1 || canonical?.rev >= srcRev ||
      canonical?.errorRev === srcRev) return;
  const key = `${documentEpoch}:${srcRev}`;
  if (lastCanonicalDisplayDemand === key) {
    const demand = currentCanonicalDisplayDemand;
    if (residentImpossible && demand?.key === key && !demand.residentImpossible) {
      demand.residentImpossible = true;
      sendCanonicalDisplayRequest({ documentEpoch, srcRev, demandId: demand.demandId, residentImpossible: true });
    }
    return;
  }
  const demandId = crypto.randomUUID();
  lastCanonicalDisplayDemand = key;
  currentCanonicalDisplayDemand = { key, documentEpoch, srcRev, demandId, residentImpossible };
  // The held paper needs this revision for display. A later complete
  // resident commit can return its unstarted job to the authority cadence.
  sendCanonicalDisplayRequest({ documentEpoch, srcRev, demandId, residentImpossible });
}
function fulfillCanonicalDisplay() {
  // Resident ink can finish while Jump still needs the canonical mapping.
  if (viewAnchorHolds.jump() && Number(canonical?.rev ?? 0) < appliedSrcRev) return;
  const demand = currentCanonicalDisplayDemand;
  if (!demand || documentReset.pending || demand.documentEpoch !== documentReset.adoptedEpoch ||
      demand.srcRev !== appliedSrcRev || lastCanonicalDisplayDemand !== demand.key) return;
  currentCanonicalDisplayDemand = null;
  lastCanonicalDisplayDemand = '';
  sendCanonicalDisplayRequest({ documentEpoch: demand.documentEpoch, srcRev: demand.srcRev,
    demandId: demand.demandId, fulfilled: true });
}

function provisionalStageKeepsEditor(stage, region) {
  const session = directEditor;
  if (!session) return true;
  if (!region) return false;
  const owners = (stage.snapshot.blocks ?? []).filter(block =>
    (block.sourceRanges ?? [block.source]).some(source =>
      sameSourceFile(source?.file, region.source.file) &&
      sourceContainsPosition({ source }, region.source.start) && sourceContainsPosition({ source }, region.source.end)));
  if (owners.length !== 1) return false;
  const owner = owners[0];
  if (stage.snapshot.rejectedBlocks?.includes(owner.id)) return false;
  const identical = (owner.editRegions ?? []).filter(item => item.kind === session.kind &&
    directEditValuesEqual(session.kind, item.value, region.value));
  // A same-valued neighbor cannot prove that the edited occurrence stayed
  // on this page. Its canonical/source mapping handles that reflow instead.
  if (identical.length !== 1 || directSourceRangeKey(identical[0]) !== directSourceRangeKey(region)) return false;
  const glyphs = (stage.glyphs ?? []).filter(glyph => glyph.sourceId === owner.id);
  const directGeometry = window.TdomDirectEditGeometry;
  if (session.kind === 'text' && !glyphs.length) {
    const native = stage.dl.commands.filter(command => command.op === 'glyphs' &&
      !command.math && command.src === owner.id);
    return native.length > 0 && printedKey(native.map(command => command.text).join('')) === printedKey(region.value);
  }
  if (!glyphs.length) return false;
  const bounds = { left: 0, top: 0, right: Number(stage.paperWidth), bottom: Number(stage.paperHeight) };
  const matches = session.kind === 'math'
    ? directGeometry.mathMaps(session.control, glyphs, bounds)
    : directGeometry.textMaps(region.value, glyphs);
  return matches.length === 1;
}

function provisionalChunkGlyphs(commands, chunks) {
  const glyphs = [];
  let index = 0;
  for (const command of commands) {
    if (command.op !== 'chunk') continue;
    const data = chunks[index++];
    for (const glyph of command.partGlyphs ?? []) glyphs.push({ ...glyph, sourceId: command.src });
    if (command.held || !(data?.width > 0)) continue;
    const scale = command.w / data.width;
    const top = command.y - command.sy;
    for (const glyph of data.glyphs) {
      const box = { ...glyph, sourceId: command.src,
        left: command.x + glyph.left * scale, right: command.x + glyph.right * scale,
        top: top + glyph.top * scale, bottom: top + glyph.bottom * scale,
        baseline: top + glyph.baseline * scale };
      const center = (box.top + box.bottom) / 2;
      if (center >= command.y - 0.1 && center <= command.y + command.h + 0.1) glyphs.push(box);
    }
  }
  return glyphs;
}

// One version of a chunk in one document of one server process is one
// picture (server.js /chunk): with all three in the URL the browser keeps it.
let serverBootId = null; // from /doc and /status: known before the first page is staged
function chunkImageSrc(cmd) {
  const boot = serverBootId;
  const fixed = typeof boot === 'string' && boot
    ? `&e=${documentReset.adoptedEpoch}&b=${encodeURIComponent(boot)}` : '';
  return `/chunk/${encodeURIComponent(cmd.chunk)}.svg?v=${cmd.cv ?? 0}${fixed}`;
}

// A page the reader is not near is not built when its update arrives. A
// keystroke that makes a paragraph a line longer moves one line across every
// page break after it: in the middle of a 191-page single flow, 96 pages
// arrive in one update. Building them all (their markup, parsing it, then
// the browser's layout of 96 pages) held this thread for three seconds,
// during which twenty keystrokes went unshown, and each key that followed
// built them all again, because a stage belongs to one revision.
// Such a page gets a stage with nothing built in it: to the commit it is a
// page out of sight that is not ready, which joins nothing and keeps what it
// shows (provisionalCommitGroups `away`), exactly like a page out of sight
// that waits for exact pixels. It is built when it comes near the pane
// (stageDeferredNearSight), or never, if canonical pages arrive first.
// A page that shows nothing yet is put off too: in a long document most
// pages never scrolled to are empty shells (their canonical picture is
// loaded when they come near, canonicalStageObserver), and built as their
// lists arrived, a tenth of a second each, they kept the page being typed
// on from being shown for the next six keystrokes.
// Only an update of many pages is treated so; a keystroke's own page or two
// are built as they come, and a page that has no shell yet (the first
// presentation of a document) always is. globalThis.__tdomStageAllPages =
// true: build every page of every update, as before.
const NEAR_SIGHT_PAGES = 2; // (a page this close to one in sight is built)
function nearSight(page) {
  if (!pageDivs.has(page)) return true; // (no place yet)
  const sight = pagesInSight();
  for (let step = -NEAR_SIGHT_PAGES; step <= NEAR_SIGHT_PAGES; step++) if (sight.has(page + step)) return true;
  return false;
}
let deferredStageFrame = 0;
function stageDeferredNearSight() {
  if (deferredStageFrame) return;
  deferredStageFrame = requestAnimationFrame(() => {
    deferredStageFrame = 0;
    if (usesCanonicalSurface() || documentReset.pending) return;
    const pages = [];
    for (const [page, stage] of provisionalStages) if (stage.deferred && nearSight(page)) pages.push(page);
    for (const page of pages) {
      const stage = provisionalStages.get(page);
      // (the page's list did not change since it was put off, whatever revisions came after)
      if (stage?.deferred) renderPage(provisionalDisplayLists.get(page) ?? stage.dl, false);
    }
  });
}
/** Builds every page that was put off (a commit that takes no page without the others needs them all). */
function buildDeferredStages() {
  let built = 0;
  for (const [page, stage] of [...provisionalStages]) {
    if (!stage.deferred) continue;
    renderPage(provisionalDisplayLists.get(page) ?? stage.dl, false);
    built++;
  }
  return built;
}
const listOwesExactInk = new WeakMap(); // a display list -> whether a command of it owes exact ink
function owesExactInkAnywhere(dl) {
  let owes = listOwesExactInk.get(dl);
  if (owes === undefined) listOwesExactInk.set(dl, owes = dl.commands.some(owesExactInk));
  return owes;
}

// These are the same openings used by chunkShowClip, intersected with the window.
function chunkInkOpenings(cmd) {
  if (!(cmd.w > 0 && cmd.h > 0)) return [];
  const show = Array.isArray(cmd.show) &&
    cmd.show.every(box => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite));
  if (!show) return [[0, 0, cmd.w, cmd.h]];
  return cmd.show.map(([x, y, w, h]) => [
    Math.max(0, x - cmd.x), Math.max(0, y - cmd.y),
    Math.min(cmd.w, x + w - cmd.x), Math.min(cmd.h, y + h - cmd.y),
  ]).filter(([left, top, right, bottom]) => right > left && bottom > top);
}

function commandDrawsInk(cmd) {
  if (cmd.op === 'chunk') return chunkInkOpenings(cmd).length > 0;
  if (cmd.op === 'folio') return Boolean(cmd.text?.trim());
  if (cmd.op !== 'rule' && cmd.op !== 'glyphs') return false;
  if (/^(?:none|transparent|#[\da-f]{3}0|#[\da-f]{6}00)$/i.test(cmd.color ?? '')) return false;
  if (cmd.op === 'rule') return cmd.w > 0 && cmd.h > 0;
  if (cmd.size <= 0 || cmd.math && !cmd.ov) return false;
  return cmd.ov && Array.isArray(cmd.runs)
    ? cmd.runs.some(([, text]) => text?.trim())
    : Boolean(cmd.text?.trim());
}

// Track when the body and furniture last changed. The furniture actually on
// screen is compared slot by slot in updateOwedFurnitureClip. The body leaves
// out source lines, picture versions, and whether a picture is held.
const listContentSigs = new WeakMap();
function listContentSig(dl) {
  let sig = listContentSigs.get(dl);
  if (sig) return sig;
  let body = 0x811c9dc5, body2 = 0x2bf, furniture = 0x811c9dc5, hasBody = false, folioOnly = true;
  const mix = (h, text) => {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  for (const cmd of dl?.commands ?? []) {
    if (!commandDrawsInk(cmd)) continue;
    const furnitureCmd = cmd.op === 'folio' || String(cmd.src ?? '').startsWith('_');
    const band = furnitureBandOf(cmd);
    if (band) {
      folioOnly = false;
      // Rendered bands and cuts from the PDF have independent chunk versions.
      furniture = mix(furniture, `band|${band.slot}|${cmd.chunk}|${cmd.cv ?? ''}|${band.source === 'canonical' ? cmd.hfGeneration ?? '' : ''};`);
      continue;
    }
    const text = `${cmd.op}|${cmd.src ?? ''}|${cmd.chunk ?? ''}|${cmd.x}|${cmd.y}|${cmd.w}|${cmd.h}|${cmd.sy ?? ''}|` +
      `${cmd.text ?? ''}|${cmd.fam ?? cmd.font ?? ''}|${cmd.size ?? ''}|${cmd.color ?? ''}|` +
      (cmd.op === 'chunk' ? `${cmd.part ? cmd.sx : ''}|${cmd.show ? JSON.stringify(cmd.show) : ''}`
        : cmd.ov && cmd.runs ? JSON.stringify(cmd.runs) : '') + ';';
    if (furnitureCmd) {
      furniture = mix(furniture, text);
      if (cmd.op !== 'folio') folioOnly = false;
    } else {
      hasBody = true;
      body = mix(body, text);
      body2 = mix(body2, text);
    }
  }
  // (the engine says what the body is apart from how it is drawn now, display-list.js
  // bodySignature: a block owed and the same block drawn are one body)
  sig = { body: dl?.body ?? `${body}:${body2}`, hasBody, furniture: String(furniture),
    // (the provisional folio alone: the header job has not said yet what the head and foot are)
    placeholder: folioOnly && furniture !== 0x811c9dc5 };
  listContentSigs.set(dl, sig);
  return sig;
}

// Since which source revision page `div` has had what list `dl` shows: the
// body since `bodyRev` (an edit of one of its blocks counts as a change,
// `touched`), the head and foot since `furnitureRev` (canonicalShowsList).
function noteListContent(div, dl, rev, touched) {
  if (!div) return;
  const sig = listContentSig(dl);
  const epoch = documentReset.adoptedEpoch;
  const was = div.listContent?.epoch === epoch ? div.listContent : null;
  // An accepted exact layout can reach this shell before any resident commit.
  const mountedBodyRev = !was && dl.body && dl.body === div.exactListDl?.body &&
    div.exactListSrc === div.dataset.canonPresentedSrc ? div.exactListRev : undefined;
  const bodyRev = was?.sig.body === sig.body ? was.bodyRev : mountedBodyRev ?? rev;
  div.listContent = { epoch, sig, rev,
    bodyRev: touched ? rev : bodyRev,
    // (the header job's first head and foot after the provisional folio are
    // not a change: that folio told nothing about them)
    furnitureRev: was && (was.sig.furniture === sig.furniture || was.sig.placeholder) ? was.furnitureRev : rev };
  if (!was) div.listHistory = new Map();
  const history = div.listHistory ??= new Map();
  history.set(rev, { dl, geometry });
  while (history.size > 4) {
    // Keep the mounted image's provenance even when several reports pass it.
    const presentedRev = Number(div.dataset.canonPresentedRev);
    const forget = [...history.keys()].find(source => source !== presentedRev);
    history.delete(forget);
  }
}

// A list can supply the mounted image's provenance if both its body and
// furniture have held since that revision.
function canonicalShowsList(div, dl, rev) {
  return canonicalShowsBody(div, dl, rev) && div.listContent.furnitureRev <= rev;
}

// The body alone: the canonical page of `rev` keeps the page's body on the
// paper while it shows the body of `dl`, whatever is decided for the head
// and foot (updateOwedFurnitureClip). The resident list's pictures, each made
// alone, lack what only the page draws (the booklet's writing rules, rules to
// the column foot): sheet 25 lost its eleven when a warm completed its list
// (tex64-internal #121, round 11, fix 4).
function canonicalShowsBody(div, dl, rev) {
  const known = div?.listContent;
  if (!known || !dl || known.epoch !== documentReset.adoptedEpoch || known.sig !== listContentSig(dl)) return false;
  return known.sig.hasBody && known.bodyRev <= rev;
}

// The canonical generations this document has had, the newest last (the
// engine keeps four, canonical.js GENERATION_MAX): a page kept by its body
// may be shown one whose hit map is in hand (keptGeneration).
const canonicalGenerations = new Map();
function noteCanonicalGeneration(info) {
  // (a failed compile reports the last good generation with its error)
  if (!info?.id || !(info.pageCount > 0)) return;
  const epoch = documentReset.adoptedEpoch;
  for (const [id, gen] of canonicalGenerations) if (gen.epoch !== epoch) canonicalGenerations.delete(id);
  if (canonicalGenerations.get(info.id)?.rev === info.rev) return;
  canonicalGenerations.delete(info.id);
  canonicalGenerations.set(info.id, { id: info.id, rev: info.rev, pageCount: info.pageCount,
    papers: info.papers, paper: info.paper, epoch });
  while (canonicalGenerations.size > 4) canonicalGenerations.delete(canonicalGenerations.keys().next().value);
}

// The generation to show page `n` whose list `dl` a canonical page keeps by
// its body: an image is shown only with the hit map of its own source (the
// /dom snapshot of its revision, ensurePresentedDomSnapshot), and /dom
// describes only the current source. A generation of a source the viewer has
// passed has its map only if one was read while it was current; the booklet's
// rev-5 canonical landed with the source at 190 and its pages were never
// shown: they fell back to the resident paper, writing rules lost (round 11).
// So: the current generation when its map can be had; else the one the page
// shows; else the newest one whose map is in hand, if it shows the body.
function keptGeneration(div, n, dl) {
  const mapped = (gen) => gen.rev === appliedSrcRev ||
    presentedDomSnapshots.has(presentedSnapshotKey(gen.id, gen.rev));
  const fits = (gen) => gen && gen.epoch === documentReset.adoptedEpoch && n <= gen.pageCount &&
    canonicalShowsBody(div, dl, gen.rev) && furnitureHolds(div, dl, gen.rev) && mapped(gen);
  const current = canonicalGenerations.get(canonical?.id);
  if (fits(current)) return current;
  const shown = canonicalGenerations.get(Number(div.dataset.canonPresentedId));
  if (shown && Number(div.dataset.canonPresentedRev) === shown.rev && fits(shown)) return shown;
  for (const gen of [...canonicalGenerations.values()].reverse()) if (fits(gen)) return gen;
  return current ?? null;
}

// A block can cross a break. Page-space hit boxes don't identify which of
// its fragments is visible; use the rows or the window in the chunk itself.
const listBodyFragments = new WeakMap();
function bodyFragments(dl) {
  const cached = listBodyFragments.get(dl);
  if (cached) return cached;
  const fragments = new Map();
  for (const cmd of dl.commands) {
    if (!cmd.src || String(cmd.src).startsWith('_') || furnitureBandOf(cmd) || !commandDrawsInk(cmd)) continue;
    let fragment = fragments.get(cmd.src);
    if (!fragment) fragments.set(cmd.src, fragment = { windows: [], lines: new Set(), cropped: false });
    if (cmd.line != null) fragment.lines.add(cmd.line);
    if (cmd.op !== 'chunk' || !Number.isFinite(cmd.sy)) continue;
    fragment.cropped = true;
    const sx = cmd.part ? Number(cmd.sx) || 0 : 0;
    for (const [left, top, right, bottom] of chunkInkOpenings(cmd)) {
      fragment.windows.push({ chunk: cmd.chunk, left: sx + left, right: sx + right,
        top: cmd.sy + top, bottom: cmd.sy + bottom });
    }
  }
  listBodyFragments.set(dl, fragments);
  return fragments;
}

function paperOfAnotherPage(painted, next) {
  if (!painted || !next || painted === next) return false;
  const oldBody = bodyFragments(painted);
  const nextBody = bodyFragments(next);
  if (!oldBody.size) {
    // A picture-only canonical can lack any resident ink. Its old picture
    // placeholders can identify a disappeared block in this special case.
    const pictureSources = dl => dl.commands.filter(cmd =>
      (cmd.op === 'pending-exact' || cmd.op === 'canon') && cmd.src && !String(cmd.src).startsWith('_')).map(cmd => cmd.src);
    const old = pictureSources(painted);
    const current = new Set([...nextBody.keys(), ...pictureSources(next)]);
    return old.length > 0 && !old.some(src => current.has(src));
  }
  // A sheet whose entire body still awaits layout has no visible
  // replacement to compare. Keep its paper until geometry arrives.
  if (!nextBody.size && next.commands.some(cmd => cmd.op === 'pending-exact')) return false;
  for (const [src, fragment] of nextBody) {
    const old = oldBody.get(src);
    if (!old) continue;
    if (old.cropped && fragment.cropped) {
      if (old.windows.some(a => fragment.windows.some(b => a.chunk === b.chunk &&
        Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) &&
        Math.min(a.right, b.right) > Math.max(a.left, b.left)))) return false;
    } else if (old.lines.size && fragment.lines.size) {
      if ([...fragment.lines].some(line => old.lines.has(line))) return false;
    } else {
      return false;
    }
  }
  return true;
}

function bodyMovedToNeighbour(painted, next) {
  if (!painted || !bodyFragments(painted).size) return false;
  const { body } = listContentSig(painted);
  if (body === listContentSig(next).body) return false;
  return [next.page - 1, next.page + 1].some(n => {
    const neighbour = provisionalDisplayLists.get(n);
    return neighbour && listContentSig(neighbour).body === body;
  });
}

// Take such a paper off the page: the page waits for its canonical page as a
// shell does (its box keeps its size: ensureShell gave it the paper's aspect).
function dropProvisionalPaper(div) {
  div.querySelector(':scope > svg:not(.tdom-canonical-delta)')?.remove();
  div.querySelectorAll(':scope > .chunkwin').forEach(e => e.remove());
  div.provisionalSvgParts = null;
  div.provisionalDl = null;
  div.provisionalSnapshot = null;
  div.provisionalEpoch = (div.provisionalEpoch ?? 0) + 1;
  div.provisionalDropped = true;
  if (!div.classList.contains('is-final')) div.classList.add('awaiting-canonical');
  traceStage('dropped', Number(div.dataset.page));
}

const displacedPaperWaits = new WeakMap();
// If the reader's line is already in the new layout on another sheet, keep
// its current pixels for the atomic scroll and page swap. The same old
// paper gets one allowance, even if another source report restages it.
function waitForDisplacedReadingLine(div, dl, paper) {
  if (!globalThis.TdomViewAnchor || !pagesInSight().has(dl.page) || typeof setTimeout !== 'function') return false;
  const anchor = captureViewAnchor();
  if (anchor?.kind !== 'reading' || anchor.page !== dl.page) return false;
  const next = viewAnchorNow(anchor, false, provisionalDisplayLists);
  if (!next?.exact || next.page === dl.page) return false;
  const before = displacedPaperWaits.get(div);
  if (before?.paper === paper) return viewClock() < before.deadline;
  const epoch = documentReset.adoptedEpoch;
  const wait = { paper, deadline: viewClock() + VIEW_ANCHOR_WAIT_MS };
  displacedPaperWaits.set(div, wait);
  setTimeout(() => {
    if (!div.isConnected || pageDivs.get(dl.page) !== div || displacedPaperWaits.get(div) !== wait || documentReset.pending ||
        documentReset.adoptedEpoch !== epoch) return;
    const shown = div.classList.contains('is-final') ? div.querySelector('img.canon') : div.provisionalDl;
    const stage = provisionalStages.get(dl.page);
    displacedPaperWaits.delete(div);
    if (shown !== paper || !stage || !owesExactInkAnywhere(stage.dl)) return;
    retireDisplacedPaper(div, stage.dl, stage.sourceRev, false);
    updateCanonState(dl.page);
  }, VIEW_ANCHOR_WAIT_MS);
  return true;
}

function retireDisplacedPaper(div, dl, rev, followReadingLine = true) {
  if (!div) return;
  const displaced = painted => paperOfAnotherPage(painted, dl) || bodyMovedToNeighbour(painted, dl);
  const img = div.querySelector('img.canon');
  const dropProvisional = displaced(div.provisionalDl);
  const dropExact = img && !(Number(div.dataset.canonPresentedRev) >= rev) && displaced(div.exactListDl);
  const shownDisplaced = div.classList.contains('is-final') ? dropExact : dropProvisional;
  if (followReadingLine && shownDisplaced &&
      waitForDisplacedReadingLine(div, dl, div.classList.contains('is-final') ? img : div.provisionalDl)) return;
  if (dropProvisional) dropProvisionalPaper(div);
  if (dropExact) dropExactPaper(div, img, dl.page);
}

// Take the exact page off: the page shows its provisional paper, or waits
// hidden for a canonical page.
function dropExactPaper(div, img, page) {
  img.remove();
  div.querySelector('svg.tdom-canonical-delta')?.remove();
  div.exactListDl = null;
  div.canonRetired = true;
  delete div.dataset.canonPresentedSrc;
  delete div.dataset.canonPresentedId;
  delete div.dataset.canonPresentedRev;
  delete div.dataset.canonFallback;
  div.classList.remove('is-final', 'is-partial');
  if (!div.provisionalDl) div.classList.add('awaiting-canonical');
  traceStage('dropped-canonical', page);
}

// B1: whether an exact page of source revision `rev` still prints the head
// and foot page `dl` has: nothing they are made from changed after `rev`
// (the engine's stamp, display-list.js hfSince), or the list it was mounted
// with described both slots, so that each can be withdrawn on its own
// (updateOwedFurnitureClip). Otherwise its bands are not known, and it
// cannot stay: a retained sheet kept the old section head under the edited
// one while the next PDF was on its way.
function furnitureHolds(div, dl, rev) {
  if (!(Number(dl?.hfSince) > rev)) return true;
  const mountedHere = div?.exactListRev === rev && div.exactListDl;
  const mounted = mountedHere ? div.exactListDl : div?.listHistory?.get(rev)?.dl;
  if (!mounted) return false;
  const attested = mountedHere ? div.exactFurniture ?? {} : {};
  return [...String(mounted.hfUnknown ?? '')].every((which) => attested[which]);
}

// The exact page on `div` goes when the head or foot it prints is no longer
// the page's and its bands are not known (furnitureHolds).
function retireStaleFurniturePaper(div, dl, page) {
  const img = div?.querySelector('img.canon');
  const rev = Number(div?.dataset.canonPresentedRev);
  if (!img || !dl || !Number.isFinite(rev) || furnitureHolds(div, dl, rev)) return false;
  dropExactPaper(div, img, page);
  return true;
}

function furnitureBandOf(cmd) {
  const match = cmd.op === 'chunk' && /^__hf(r?)-\d+-([hf])$/.exec(cmd.chunk);
  return match ? { source: match[1] ? 'render' : 'canonical', slot: match[2] } : null;
}

// Use explicit slots on current lists and infer the slot for older lists.
function furnitureSlotOf(cmd, geo = geometry) {
  if (cmd.op === 'folio') return 'f';
  if (cmd.op === 'chunk') return furnitureBandOf(cmd)?.slot ?? (cmd.src === '_hf' ? cmd.hfSlot : null);
  if (cmd.src !== '_hf') return null;
  if (cmd.hfSlot) return cmd.hfSlot;
  const head = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0);
  const foot = head + (geo.headsep ?? 0) + (geo.textheight ?? 0) + (geo.footskip ?? 30);
  return cmd.y < (head + foot) / 2 ? 'h' : 'f';
}

const furnitureLists = new WeakMap();
function listFurniture(dl, geo) {
  const cached = furnitureLists.get(dl);
  if (cached?.geo === geo) return cached.slots;
  const slots = {};
  for (const cmd of dl.commands) {
    const which = furnitureSlotOf(cmd, geo);
    if (!which || !commandDrawsInk(cmd)) continue;
    const slot = slots[which] ??= { paint: '', rect: [Infinity, Infinity, -Infinity, -Infinity], commands: [] };
    // Include paint as well as the coordinates. Chunk versions refer to
    // particular cuts, even if their URL's base key is the same.
    slot.paint += JSON.stringify(cmd);
    slot.commands.push(cmd);
    const band = furnitureBandOf(cmd);
    if (band?.source === 'canonical') slot.generation = cmd.hfGeneration;
    const size = cmd.size ?? 10;
    const glyph = cmd.op === 'glyphs' || cmd.op === 'folio';
    const w = cmd.w ?? Math.max(1, (cmd.text?.length ?? 0) * size * 0.6);
    const left = cmd.op === 'folio' ? cmd.x - w / 2 : cmd.x;
    const top = glyph ? cmd.y - (cmd.gh ?? size * 0.8) : cmd.y;
    const bottom = glyph ? cmd.y + (cmd.gd ?? size * 0.2) : cmd.y + cmd.h;
    const bleed = cmd.op === 'chunk' ? 0 : 1;
    const [l, t, r, b] = slot.rect;
    slot.rect = [Math.min(l, left - bleed), Math.min(t, top - bleed),
      Math.max(r, left + w + bleed), Math.max(b, bottom + bleed)];
  }
  furnitureLists.set(dl, { geo, slots });
  return slots;
}

function intersectPaperRects(a, b) {
  const result = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return result[2] > result[0] && result[3] > result[1] ? result : null;
}

function subtractBodyInk(rect, dl) {
  let rects = [rect];
  for (const [x, y, w, h] of dl.bodyOverhang ?? []) {
    rects = rects.flatMap(area => {
      const overlap = intersectPaperRects(area, [x, y, x + w, y + h]);
      if (!overlap) return [area];
      const [l, t, r, b] = area;
      const [left, top, right, bottom] = overlap;
      return [[l, t, r, top], [l, bottom, r, b], [l, top, left, bottom], [right, top, r, bottom]]
        .filter(([a, c, d, e]) => d > a && e > c);
    });
  }
  return rects;
}

// CSS polygons join rectangle contours with a path walked in both directions.
// With the page rectangle first, even-odd filling cuts the other rectangles out.
function furnitureClipPath(rects, paper, cut = false) {
  if (!rects.length) return cut ? '' : 'polygon(0 0,0 0,0 0)';
  const [left, top, right, bottom] = paper;
  const pctX = x => (x - left) / (right - left) * 100;
  const pctY = y => (y - top) / (bottom - top) * 100;
  if (cut && rects.every(([l, t, r, b]) => l === left && r === right && (t === top || b === bottom))) {
    const head = rects.find(([, t]) => t === top);
    const foot = rects.find(([, t, , b]) => t > top && b === bottom);
    return `inset(${head ? pctY(head[3]) : 0}% 0 ${foot ? (bottom - foot[1]) / (bottom - top) * 100 : 0}% 0)`;
  }
  const contours = (cut ? [paper, ...rects] : rects).map(([l, t, r, b]) => {
    const point = (x, y) => `${pctX(x)}% ${pctY(y)}%`;
    return [point(l, t), point(r, t), point(r, b), point(l, b), point(l, t)];
  });
  return `polygon(evenodd,${[...contours.flat(), ...contours.map(points => points[0]).reverse()].join(',')})`;
}

// A slot can change while the page's body transaction is still blocked.
function stageFurnitureSlot(div, which, slot, paper) {
  const previous = div.stagedFurniture?.[which];
  const key = slot && JSON.stringify([slot.paint, paper]);
  if (previous?.key === key) return previous?.layer;
  if (previous) {
    previous.layer.remove();
    delete div.stagedFurniture[which];
  }
  if (!slot) return null;

  const slots = div.stagedFurniture ??= {};
  const layer = document.createElement('div');
  layer.className = 'tdom-staged-furniture';
  layer.dataset.hfSlot = which;
  layer.hidden = true;
  const W = paper[2], H = paper[3];
  const families = [...new Set(slot.commands.filter(cmd => cmd.op === 'glyphs' && cmd.fam).map(cmd => cmd.fam))];
  injectFonts(families);
  layer.innerHTML = svgParts({ commands: slot.commands }).join('');
  for (const cmd of slot.commands) if (cmd.op === 'chunk') appendChunkWindow(layer, cmd, W, H);
  const entry = slots[which] = { key, layer };
  div.append(layer);
  Promise.all([
    ...[...layer.querySelectorAll('img')].map(img => img.decode()),
    ...families.map(family => fontLoads.get(family)),
  ]).then(() => {
    if (slots[which] === entry && families.every(family => readyFonts.has(family))) layer.hidden = false;
  }).catch(() => {}); // The current list still supersedes the old slot if its image fails.
  return layer;
}

function updateOwedFurnitureClip(div, img, stage) {
  // (an unedited opening shows exactly what v0.1.32 shows; an edit during it
  // withdraws what it changed, B1)
  if (openingPreview && !openingEdited) return false;
  const old = div.exactListDl;
  const next = stage?.dl;
  const show = {};
  const cut = [];
  const oldGeo = div.exactListGeometry ?? geometry;
  const oldPaper = [0, 0, Number(div.dataset.canonPaperW) || oldGeo.paperwidth,
    Number(div.dataset.canonPaperH) || oldGeo.paperheight];
  const nextPaper = [0, 0, stage?.paperWidth ?? geometry.paperwidth, stage?.paperHeight ?? geometry.paperheight];
  const id = Number(div.dataset.canonPresentedId);
  const attested = div.exactFurniture ??= {};
  const after = next && listFurniture(next, geometry);
  const painted = div.provisionalDl && listFurniture(div.provisionalDl, geometry);
  if (!old && !painted?.h && !painted?.f && !after?.h && !after?.f &&
      !div.stagedFurniture && !img?.style?.clipPath) return false;
  const before = old && listFurniture(old, oldGeo);
  const exactBody = old ?? div.provisionalDl ?? {};
  let changed = false;
  for (const which of ['h', 'f']) {
    const current = after?.[which];
    const mounted = painted?.[which];
    const replacesMounted = Boolean(next && current?.paint !== mounted?.paint);
    div.classList.toggle(`withdrawn-slot-${which}`, replacesMounted && Boolean(mounted));
    const layer = stageFurnitureSlot(div, which, replacesMounted ? current : null, nextPaper);
    if (current?.generation != null && current.generation === id) attested[which] = current;
    const exact = attested[which] ?? before?.[which];
    const differsFromExact = img && (old || exact) && next &&
      Number(div.dataset.canonPresentedRev) < stage.sourceRev && current?.paint !== exact?.paint;
    if (differsFromExact) {
      changed = true;
      const remove = exact && intersectPaperRects(exact.rect, oldPaper);
      if (remove) cut.push(...subtractBodyInk(remove, exactBody));
      const overlay = current && intersectPaperRects(current.rect, nextPaper);
      if (overlay) show[which] = subtractBodyInk(overlay, exactBody);
    }
    if (layer) {
      layer.classList.toggle('over-canonical', Boolean(show[which]?.length));
      layer.style.setProperty('--tdom-furniture-clip', furnitureClipPath(show[which] ?? [], nextPaper));
    }
    if (replacesMounted) delete show[which];
  }
  if (img) {
    img.style.clipPath = furnitureClipPath(cut, oldPaper, true);
    img.sourceClickCuts = cut;
  }
  showListSlots(div, show, nextPaper);
  return changed;
}

function showListSlots(div, show, paper) {
  div.classList.toggle('canon-slots', Boolean(show.h?.length || show.f?.length));
  for (const which of ['h', 'f']) {
    const rects = show[which];
    div.classList.toggle(`canon-slot-${which}`, Boolean(rects?.length));
    if (rects?.length) div.style.setProperty?.(`--canon-slot-${which}`, furnitureClipPath(rects, paper));
    else div.style.removeProperty?.(`--canon-slot-${which}`);
  }
  for (const window of div.querySelectorAll(':scope > .chunkwin[data-hf-slot]')) {
    const rects = show[window.dataset.hfSlot];
    if (!rects?.length) {
      window.style.removeProperty('--canon-slot-clip');
      continue;
    }
    const x = parseFloat(window.style.left) * paper[2] / 100;
    const y = parseFloat(window.style.top) * paper[3] / 100;
    const bounds = [x, y, x + parseFloat(window.style.width) * paper[2] / 100,
      y + parseFloat(window.style.height) * paper[3] / 100];
    const openings = rects.map(rect => intersectPaperRects(rect, bounds)).filter(Boolean);
    window.style.setProperty('--canon-slot-clip', furnitureClipPath(openings, bounds));
  }
}

function appendChunkWindow(staging, cmd, W, H) {
  const shiftPct = (cmd.sy / cmd.w) * 100;
  // A part (display-list.js partCommands) is a window narrower than its
  // picture: one run of a formula, cut out of the picture made for an
  // earlier galley and set where the run stands now. The picture keeps
  // its own width and is moved left as well as up behind the window.
  const part = cmd.part && cmd.cw > 0
    ? `width:${(cmd.cw / cmd.w) * 100}%;max-width:none;margin-left:-${(cmd.sx / cmd.w) * 100}%;` : '';
  const slot = furnitureSlotOf(cmd);
  const slotAttr = slot ? ` data-hf-slot="${slot}"` : '';
  staging.insertAdjacentHTML(
    'beforeend',
    `<div class="chunkwin${cmd.st ? ' stale' : ''}${cmd.held ? ' held' : ''}${cmd.part ? ' part' : ''}" data-src="${cmd.src}"${slotAttr}${cmd.line == null ? '' : ` data-line="${escapeXml(String(cmd.line))}"`} style="left:${(cmd.x / W) * 100}%;top:${(cmd.y / H) * 100}%;width:${(cmd.w / W) * 100}%;height:${(cmd.h / H) * 100}%;${chunkShowClip(cmd)}">` +
      `<img class="chunk" src="${chunkImageSrc(cmd)}" style="${part}margin-top:-${shiftPct}%" draggable="false"></div>`
  );
  if (cmd.partGlyphs) staging.lastElementChild.partGlyphs = cmd.partGlyphs;
}

function renderPage(dl, flash, mayDefer = false) {
  if (usesCanonicalSurface()) return;
  const div = pageDivs.get(dl.page);
  // Stage the entire next surface off-DOM. A dirty mixed text/math line
  // deliberately has no browser math ink; publishing it would erase other
  // expressions on the page while its exact chunk is still being compiled.
  const sourceRev = appliedSrcRev;
  const stage = { dl, sourceRev, documentEpoch: documentReset.adoptedEpoch, ready: false,
    paperWidth: geometry.paperwidth, paperHeight: geometry.paperheight };
  provisionalStages.set(dl.page, stage);
  // Carried pages are part of this source generation too. An intermediate
  // canonical metadata event must not let one retain older exact pixels
  // while its neighboring page reveals this provisional transaction.
  pageDirtyRev.set(dl.page, sourceRev);
  if (div) div.dataset.provPending = '1';
  noteListContent(div, dl, sourceRev, editGroupSeq > 0 && pageEditGroup.get(dl.page) === editGroupSeq);
  const owesInk = owesExactInkAnywhere(dl);
  if (owesInk) {
    traceStage('blocked', dl.page);
    stage.srcs = displayListSrcs(dl);
    if (!openingPreview || openingEdited) retireDisplacedPaper(div, dl, sourceRev);
  }
  // A withheld slot is known before any image in this stage decodes.
  if (div) {
    retireStaleFurniturePaper(div, dl, dl.page);
    updateOwedFurnitureClip(div, div.querySelector('img.canon'), stage);
  }
  if (owesInk) {
    committedPageSrcs.set(dl.page, new Set([...(committedPageSrcs.get(dl.page) ?? []), ...stage.srcs]));
    // A page the reader cannot see waits without asking for a canonical
    // compile: three pages of a 72-page book that owed exact pixels asked on
    // every keystroke, and LuaLaTeX compiled the whole book back to back for
    // as long as the typing lasted. The page asks when it is scrolled to.
    const impossible = dl.commands.some(cmd => cmd.op === 'canon');
    if (impossible || pagesInSight().has(dl.page)) requestCanonicalDisplay({ residentImpossible: impossible });
    // Clear an obsolete wanted image, or request the eligible exact page.
    if (div && !div.classList.contains('is-final') &&
        (div.provisionalDropped || div.canonRetired || canonical?.id && canonicalShowsBody(div, dl, canonical.rev))) {
      updateCanonState(dl.page);
    }
    return;
  }
  // (with an editor open on the paper every page commits together,
  // tryCommitProvisionalStages: nothing is put off then)
  if (mayDefer && !directEditor && !globalThis.__tdomStageAllPages && !nearSight(dl.page)) {
    stage.deferred = true;
    return;
  }
  traceStage('stage', dl.page);
  const families = [...new Set(dl.commands.filter(cmd => cmd.op === 'glyphs' && cmd.fam).map(cmd => cmd.fam))];
  injectFonts(families);
  const staging = document.createElement('div');
  stage.svgParts = svgParts(dl);
  // (only what differs from the page as it stands is parsed: patchProvisionalSvg)
  const base = div?.provisionalSvgParts ?? null;
  const cut = svgPartsCut(base, stage.svgParts);
  if (cut) {
    stage.svgCut = { base, head: cut.head, tail: cut.tail };
    staging.innerHTML = stage.svgParts[0] +
      stage.svgParts.slice(cut.head + 1, stage.svgParts.length - 1 - cut.tail).join('') + '</svg>';
  } else staging.innerHTML = stage.svgParts.join('');
  for (const cmd of dl.commands) {
    if (cmd.op === 'chunk') appendChunkWindow(staging, cmd, geometry.paperwidth, geometry.paperheight);
  }
  const ready = () => {
    if (provisionalStages.get(dl.page) !== stage || usesCanonicalSurface() ||
        sourceRev !== appliedSrcRev || stage.documentEpoch !== documentReset.adoptedEpoch) return;
    if (families.some(family => !readyFonts.has(family))) {
      return traceStage('fonts-waiting', dl.page, { families: families.filter(family => !readyFonts.has(family)) });
    }
    // Font promises can resolve while the SVG is still detached. Its
    // pending markers must be cleared here as well as in injectFonts().
    staging.querySelectorAll('text[data-font-pending]').forEach(node => node.removeAttribute('data-font-pending'));
    stage.staging = staging;
    stage.ready = true;
    traceStage('ready', dl.page);
    tryCommitProvisionalStages();
  };
  const images = [...staging.querySelectorAll('img')];
  // one decode per picture: the trace reads the same promises the stage waits for
  const decodes = images.map(img => img.decode());
  // Where each glyph of a chunk's picture sits decides one thing here:
  // whether an editor open on the paper stays with this stage
  // (provisionalStageKeepsEditor). The server reads it from the chunk's PDF,
  // tens of milliseconds for a chunk it has not read yet, and the edited
  // block's chunk is new on every keystroke. With no editor on the paper the
  // stage does not wait for it; a click loads a chunk's geometry when it
  // needs it (loadChunkInputGeometry).
  const chunkGeometry = directEditor ? Promise.all(images.map(img =>
    img.parentElement.classList.contains('held') ? null : loadChunkInputGeometry(img))).then(chunks => {
    stage.glyphs = provisionalChunkGlyphs(dl.commands, chunks);
  }) : null;
  if (Array.isArray(globalThis.__tdomStageTrace)) {
    const shown = new Set([...(div?.querySelectorAll('img.chunk') ?? [])].map(img => img.getAttribute('src')));
    const freshImages = images.filter(img => !shown.has(img.getAttribute('src')));
    const fresh = freshImages.length;
    const stagedAt = performance.now();
    void Promise.all(decodes).then(() => {
      const detail = freshImages.slice(0, 3).map(img => {
        const entry = performance.getEntriesByName(new URL(img.getAttribute('src'), location.href).href).pop();
        return { src: img.getAttribute('src'), win: img.parentElement?.className, fetchStart: entry ? Math.round(entry.startTime - stagedAt) : null,
          fetchMs: entry ? Math.round(entry.duration) : null, wait: entry ? Math.round(entry.responseStart - entry.requestStart) : null,
          kb: entry ? Math.round(entry.encodedBodySize / 1024) : null, cached: entry ? entry.transferSize === 0 : null };
      });
      traceStage('decoded', dl.page, { images: images.length, fresh, detail, ms: Math.round(performance.now() - stagedAt) });
    }, () => {});
    void chunkGeometry?.then(() => traceStage('geometry', dl.page), () => {});
    void Promise.all(families.map(family => fontLoads.get(family))).then(() => traceStage('fonts', dl.page), () => {});
  }
  const pending = [
    loadProvisionalSnapshot(sourceRev).then(snapshot => { stage.snapshot = snapshot; traceStage('snapshot', dl.page); }),
    ...decodes,
    ...(chunkGeometry ? [chunkGeometry] : []),
    ...families.map(family => fontLoads.get(family)),
  ];
  void Promise.all(pending).then(ready).catch((error) => {
    traceStage('load-failed', dl.page, { error: String(error?.message ?? error).slice(0, 160) });
    // A failed load can be a superseded source/chunk response. It cannot
    // prove resident impossibility; the bounded canonical grace still ends
    // if a persistent failure prevents the next page from committing.
    if (provisionalStages.get(dl.page) === stage && sourceRev === appliedSrcRev &&
        stage.documentEpoch === documentReset.adoptedEpoch) requestCanonicalDisplay();
  });
}

// The text of a line whose exact picture is shown only where it has to be
// (a chunk command's `show`, display-list.js): drawn by the glyph layer so
// that it looks as it did before the picture landed. It is ink only: the
// line's editing, hit testing and geometry go by its picture and its source
// hit box, as they do for a line shown whole from the picture.
const OVER_TEXT_ATTRS = ' data-ov="1" pointer-events="none"';

/** The openings of a picture window as a clip path: [x, y, w, h] on the page,
 * as percentages of the window. One polygon, each opening walked the same
 * way round and joined to the next by a line walked there and back. */
function chunkShowClip(cmd) {
  if (!Array.isArray(cmd.show) || !(cmd.w > 0) || !(cmd.h > 0)) return '';
  const pct = (value) => `${Math.round(Math.max(0, Math.min(100, value)) * 1000) / 1000}%`;
  const corners = [];
  const starts = [];
  for (const box of cmd.show) {
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return '';
    const left = pct(((box[0] - cmd.x) / cmd.w) * 100), right = pct(((box[0] + box[2] - cmd.x) / cmd.w) * 100);
    const top = pct(((box[1] - cmd.y) / cmd.h) * 100), bottom = pct(((box[1] + box[3] - cmd.y) / cmd.h) * 100);
    starts.push(`${left} ${top}`);
    corners.push(`${left} ${top}`, `${right} ${top}`, `${right} ${bottom}`, `${left} ${bottom}`, `${left} ${top}`);
  }
  // nothing to show: the window stays in place for geometry, with no ink
  if (!corners.length) return 'clip-path:polygon(0 0,0 0,0 0);';
  return `clip-path:polygon(${[...corners, ...starts.reverse()].join(',')});`;
}

/** Unified SVG page: TeX-positioned glyph runs, rules, chunk images, folio. */
function svgFor(dl, className = '') {
  return svgParts(dl, className).join('');
}

// The element a command draws into the page's SVG ('' when it draws none
// there), kept with the command: the commands of the lines a keystroke did
// not change are the objects this stream already carried (resolveStreamLists),
// and their elements were written out again for every keystroke (1 ms of a
// dense page's 2,000 commands). The one thing outside the command a piece
// depends on is whether its font has arrived.
const commandPiece = new WeakMap(); // a command -> { piece, ready }
function pieceOfCommand(cmd) {
  const ready = cmd.op !== 'glyphs' || !cmd.fam || readyFonts.has(cmd.fam);
  const kept = commandPiece.get(cmd);
  if (kept && kept.ready === ready) return kept.piece;
  const piece = commandMarkup(cmd);
  commandPiece.set(cmd, { piece, ready });
  return piece;
}
function commandMarkup(cmd) {
  const lineAttr = cmd.line == null ? '' : ` data-line="${escapeXml(String(cmd.line))}"`;
  if (cmd.op === 'canonical-tail') {
    if (![cmd.x, cmd.y, cmd.w, cmd.h, cmd.dx].every(Number.isFinite) || !(cmd.w > 0 && cmd.h > 0) ||
        !Number.isSafeInteger(cmd.page) || !Number.isSafeInteger(cmd.generation)) return '';
    const source = `/canonical/${cmd.page}.svg?c=${cmd.generation}`;
    const id = `tdom-tail-${cmd.page}-${cmd.generation}-${cmd.x}-${cmd.y}`;
    return `<g transform="translate(${cmd.dx} 0)" pointer-events="none"><clipPath id="${id}"><rect x="${cmd.x}" y="${cmd.y}" width="${cmd.w}" height="${cmd.h}"/></clipPath><image clip-path="url(#${id})" width="${geometry.paperwidth}" height="${geometry.paperheight}" href="${source}"/></g>`;
  }
  if (cmd.op === 'glyphs') {
    let fontAttrs;
    if (cmd.fam) {
      // checkpoint backend: real TeX font, TeX positions; disable browser
      // shaping so run-start x + font advances reproduce TeX exactly
      const pending = readyFonts.has(cmd.fam) ? '' : ' data-font-pending="1"';
      fontAttrs = ` font-family="${escapeXml(cmd.fam)}" data-font-family="${escapeXml(cmd.fam)}"${pending} style="font-kerning:none;font-variant-ligatures:none;letter-spacing:0"`;
    } else {
      const it = cmd.font === 'italic' || cmd.font === 'bolditalic' ? ` font-style="italic"` : '';
      const b = cmd.font === 'bold' || cmd.font === 'bolditalic' ? ` font-weight="bold"` : '';
      fontAttrs = ` font-family="${FONT_FAMILY[cmd.font] || FONT_FAMILY.regular}"${it}${b}`;
    }
    if (cmd.ov && Array.isArray(cmd.runs)) {
      // (one element for the runs of a line that look alike, each at its own place)
      return `<text y="${cmd.y}" font-size="${cmd.size}"${fontAttrs} fill="${cmd.color || '#1a1a1a'}"${OVER_TEXT_ATTRS} xml:space="preserve">` +
        cmd.runs.map(([x, text]) => `<tspan x="${x}">${escapeXml(text)}</tspan>`).join('') + '</text>';
    }
    return `<text x="${cmd.x}" y="${cmd.y}" font-size="${cmd.size}"${fontAttrs} fill="${cmd.color || '#1a1a1a'}" data-width="${cmd.w ?? 0}" data-gh="${cmd.gh ?? 0}" data-gd="${cmd.gd ?? 0}"${cmd.ov ? OVER_TEXT_ATTRS : ` data-src="${cmd.src}"${lineAttr}${cmd.math ? ' data-math="1"' : ''}${cmd.edit ? ` data-edit="${escapeXml(cmd.edit)}"` : ''}`} xml:space="preserve">${escapeXml(cmd.text)}</text>`;
  }
  if (cmd.op === 'rule' && cmd.w > 0 && cmd.h > 0) {
    return `<rect x="${cmd.x}" y="${cmd.y}" width="${cmd.w}" height="${cmd.h}" fill="${cmd.color || '#1a1a1a'}"${cmd.ov ? OVER_TEXT_ATTRS : ` data-src="${cmd.src}"${lineAttr}${cmd.edit ? ` data-edit="${escapeXml(cmd.edit)}"` : ''}`}/>`;
  }
  if (cmd.op === 'chunk' && cmd.partRule) {
    const [x, y, w, h] = cmd.partRule;
    return `<rect class="tdom-source-hit" x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent" stroke="transparent" stroke-width="1" data-src="${cmd.src}"${lineAttr} data-math="1" data-part="rule"/>`;
  }
  if (cmd.op === 'chunk' && cmd.partGlyphs?.length) {
    const first = cmd.partGlyphs[0], last = cmd.partGlyphs.at(-1);
    return `<rect class="tdom-source-hit" x="${first.left}" y="${first.top}" width="${last.right - first.left}" height="${first.bottom - first.top}" fill="transparent" data-src="${cmd.src}"${lineAttr} data-math="1" data-part="1"/>`;
  }
  if (cmd.op === 'editbox') {
    return `<rect class="tdom-edit-hit" x="${cmd.x}" y="${cmd.y}" width="${Math.max(cmd.w, 0.5)}" height="${Math.max(cmd.h, 0.5)}" fill="transparent" data-src="${cmd.src}" data-edit="${escapeXml(cmd.edit)}"/>`;
  }
  if (cmd.op === 'sourcebox') {
    return `<rect class="tdom-source-hit" x="${cmd.x}" y="${cmd.y}" width="${Math.max(cmd.w, 0.5)}" height="${Math.max(cmd.h, 0.5)}" fill="transparent" data-src="${cmd.src}"${lineAttr}${cmd.ink ? ' data-ink="1"' : ''}${cmd.math ? ' data-math="1"' : ''}${cmd.stale ? ' data-stale="1"' : ''}${cmd.complex ? ' data-complex="1"' : ''}/>`;
  }
  // (exact-render chunks are drawn as HTML <img> overlays, see renderPage)
  if (cmd.op === 'folio') {
    return `<text x="${cmd.x}" y="${cmd.y}" font-size="10" font-family="${FONT_FAMILY.regular}" fill="#1a1a1a" text-anchor="middle">${escapeXml(cmd.text)}</text>`;
  }
  return '';
}

// The page's SVG as its pieces: the opening tag, one element a command that
// draws into it (in the commands' order), the closing tag. A commit keeps the
// elements whose piece did not change (patchProvisionalSvg).
function svgParts(dl, className = '') {
  const parts = [
    `<svg${className ? ` class="${escapeXml(className)}"` : ''} viewBox="0 0 ${geometry.paperwidth} ${geometry.paperheight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
  ];
  for (const cmd of dl.commands) {
    const piece = pieceOfCommand(cmd);
    if (!piece) continue;
    const slot = furnitureSlotOf(cmd);
    parts.push(slot ? piece.replace(/^<\w+/, `$& data-hf-slot="${slot}"`) : piece);
  }
  parts.push('</svg>');
  return parts;
}

// A keystroke changes a line or two of its page, and the page was replaced
// whole: the old SVG removed, the new one put in. The browser then lays out
// and paints every element of the page again; on a dense page of Japanese
// text (an element a character, 1,500 of them) that was 18 ms of layout
// after every keystroke, more than the engine takes to typeset it.
//
// The elements of an SVG built by svgParts stand in the order of its pieces
// and nothing else adds or removes one. So the committed SVG stays, and of
// the staged one only the elements between the pieces that are the same at
// the start and the same at the end are moved in, in place of the old ones.
// Same piece, same element: the one change made to an element after it is
// built, clearing its font-pending mark, is left out of the comparison (the
// mark is cleared on the page as soon as the font is ready, injectFonts).
// Anything unexpected (another paper, a count that does not match the
// pieces) leaves the page to be replaced whole, as before.
//
// The staged page is cut the same way before it is parsed (renderPage): of
// a page whose committed pieces are known, only the pieces between the
// shared start and end become elements, and the commit puts exactly those
// in. If the page is no longer the one the stage was cut against, the whole
// SVG is built at the commit instead.
// globalThis.__tdomWholePageCommit = true: build and replace whole, always.
const fontSettled = piece => (piece.includes(' data-font-pending="1"') ? piece.replace(' data-font-pending="1"', '') : piece);
// How many pieces two pages share at their start and at their end.
function svgPartsCut(oldParts, newParts) {
  if (globalThis.__tdomWholePageCommit || !Array.isArray(oldParts) || !Array.isArray(newParts)) return null;
  const oldCount = oldParts.length - 2;
  const newCount = newParts.length - 2;
  if (oldCount < 0 || newCount < 0 || oldParts[0] !== newParts[0]) return null;
  const same = (a, b) => a === b || fontSettled(a) === fontSettled(b);
  let head = 0;
  while (head < oldCount && head < newCount && same(oldParts[head + 1], newParts[head + 1])) head++;
  let tail = 0;
  while (tail < oldCount - head && tail < newCount - head && same(oldParts[oldCount - tail], newParts[newCount - tail])) tail++;
  return { head, tail };
}
// The children [head, end) of `svg` make room for `fresh`.
function spliceSvgChildren(svg, head, end, fresh) {
  const stale = Array.prototype.slice.call(svg.childNodes, head, end);
  const before = svg.childNodes[end] ?? null;
  for (const node of stale) node.remove();
  for (const node of fresh) svg.insertBefore(node, before);
}
function patchProvisionalSvg(oldSvg, oldParts, newSvg, newParts) {
  const cut = oldSvg && newSvg ? svgPartsCut(oldParts, newParts) : null;
  if (!cut || oldSvg.childNodes.length !== oldParts.length - 2 || newSvg.childNodes.length !== newParts.length - 2) return false;
  spliceSvgChildren(oldSvg, cut.head, oldParts.length - 2 - cut.tail,
    Array.prototype.slice.call(newSvg.childNodes, cut.head, newParts.length - 2 - cut.tail));
  return true;
}

function removePagesFrom(from) {
  // Stage a resident shrink until every replacement page is ready, so the
  // old tail and the new generation disappear in one browser transaction.
  lastRemoveRev = appliedSrcRev;
  for (const n of provisionalStages.keys()) if (n >= from) provisionalStages.delete(n);
  for (const [n, div] of pageDivs) if (n >= from) {
    provisionalRemovedPages.add(n);
    div.dataset.provPending = '1';
  }
}

function applyReport(report) {
  if (holdingDirectOpeningPaper()) {
    deferredDirectPresentationEvents.push(() => applyReport(report));
    return;
  }
  if (report.rev <= appliedReportRev) return;
  // (the engine revision of the report's lists: a /doc snapshot's layoutRev
  // when one stands in for a report the stream lost, adoptResyncDoc)
  const listsRev = Number.isSafeInteger(report.resyncLayoutRev) ? report.resyncLayoutRev : report.rev;
  // Font registration and the page patch are one visual transaction. The
  // SVG may be inserted before the local face finishes decoding, but its
  // affected runs remain hidden until injectFonts marks that face ready.
  injectFonts(report.fonts);
  appliedReportRev = report.rev;
  appliedRev = Math.max(appliedRev, report.rev, listsRev);
  if (!openingEdited && report.srcRev > appliedSrcRev) {
    openingEdited = true;
    const Anchor = globalThis.TdomViewAnchor;
    if (Anchor?.exactDisplayList) {
      // An opening image may have been mounted without its reading geometry.
      // Load that geometry for the reader's first edit, using the mounted generation.
      for (const n of pagesInSight()) {
        const div = pageDivs.get(n);
        const image = div?.querySelector('img.canon');
        const id = Number(div?.dataset.canonPresentedId);
        if (!image || image.viewAnchorDl || !Number.isSafeInteger(id)) continue;
        const src = image.getAttribute('src');
        void canonicalGlyphs(n, id).then(glyphs => {
          if (glyphs.length && image.getAttribute('src') === src) image.viewAnchorDl = Anchor.exactDisplayList(src, glyphs);
        });
      }
    }
  }
  appliedSrcRev = report.srcRev ?? appliedSrcRev;
  openingDirectInput?.checkShipMap?.();
  const wasCanonicalSurface = usesCanonicalSurface();
  previewPolicy = report.previewPolicy ?? previewPolicy;
  previewReasons = report.previewReasons ?? previewReasons;
  setMode(report.mode ?? 'structured', report.modeReasons ?? []);
  document.body.classList.toggle('is-opaque-document', usesCanonicalSurface());
  if (!wasCanonicalSurface && usesCanonicalSurface()) {
    closeDirectEditor();
    pageDirtyRev.clear();
    for (const div of pageDivs.values()) prepareOpaqueShell(div);
    if (canonical?.id) void ensurePresentedDomSnapshot(canonical.id, canonical.rev);
    for (const pageNumber of pageDivs.keys()) updateCanonState(pageNumber);
  }
  if (report.canonical) canonical = report.canonical;
  const anchorIntent = report.canonicalAnchor?.status === 'pending'
    ? report.canonicalAnchor
    : null;
  if (anchorIntent) {
    // Embedded TeX64 edits arrive over SSE, not through this iframe's own
    // fetch('/edit'). Reconstruct the server-accept instant from the elapsed
    // duration carried by the report so the same 850ms publication contract
    // works in both clients. The value is diagnostic/deadline state only;
    // authority still comes from source/canonical generation checks.
    const elapsed = Number(anchorIntent.acceptedElapsedMs);
    const inferredStart = performance.now() - (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0);
    const rev = Number(anchorIntent.srcRev);
    const previous = canonicalAnchorEditStartedAt.get(rev);
    if (!Number.isFinite(previous) || inferredStart < previous) {
      canonicalAnchorEditStartedAt.set(rev, inferredStart);
    }
    for (const knownRev of canonicalAnchorEditStartedAt.keys()) {
      if (knownRev < rev - 4) canonicalAnchorEditStartedAt.delete(knownRev);
    }
  }
  // An unresolved patch belongs to one exact source revision. Keep the
  // already-painted previous keystroke while the newest one resolves, but
  // never let an offscreen load commit a patch from an older revision.
  canonicalAnchorPendingPatch = null;
  const closureDeferred = !!report.stats?.closureDeferred;
  // A canonical build for an intermediate keystroke retires the server's
  // proof lineage, so the next keystroke in the same block gets no anchor
  // (base-generation / canonical-behind). The overlay already on paper is
  // still that earlier revision's certified page: keep it as the last good
  // presentation rather than dropping to the older base page underneath.
  const dirtyBlock = report.dirtySourceNodes?.length === 1
    ? String(report.dirtySourceNodes[0]).replace(/^src-/, '')
    : null;
  // A cumulative overlay covers every block edited since its base; the
  // server lists them so a refusal in any of them keeps the lease.
  const previewBlocks = canonicalAnchorPreview
    ? (Array.isArray(canonicalAnchorPreview.blockIds) ? canonicalAnchorPreview.blockIds : [canonicalAnchorPreview.blockId])
    : [];
  const intentBlocks = anchorIntent
    ? (Array.isArray(anchorIntent.blockIds) ? anchorIntent.blockIds : [anchorIntent.blockId])
    : [];
  // A keystroke in a covered block got no anchor (its proof lineage was
  // retired by a canonical build, or the change cannot be an overlay: a box
  // shifted, a line reflowed). The overlay on paper is still that block's
  // certified rendering over the same base page, one keystroke behind:
  // keep it as the last good presentation rather than exposing the older
  // base page. A restore that made the canonical current and a reboot
  // retire it as before.
  const canonicalCurrent = Boolean(report.canonical?.id) && report.canonical.rev >= (report.srcRev ?? 0);
  const leased = !anchorIntent && canonicalAnchorPreview && !canonicalAnchorPreview.retiring &&
    !!dirtyBlock && previewBlocks.includes(dirtyBlock) && report.rebooted !== true &&
    report.canonicalAnchorRefused !== 'canonical-current' && !canonicalCurrent;
  // An edit in a block the overlay does not cover got no anchor (a box, a
  // reflowing line, a cold keystroke). The overlay is still the certified
  // rendering of its own blocks over the same base page: keep it as the
  // last good presentation instead of exposing the older base page. The
  // overlay's own pages stay frozen while other pages may still take this
  // edit's provisional patches.
  const leasedOther = !leased && !anchorIntent && canonicalAnchorPreview && !canonicalAnchorPreview.retiring &&
    !!dirtyBlock && !previewBlocks.includes(dirtyBlock) && report.rebooted !== true &&
    report.canonicalAnchorRefused !== 'canonical-current' && !canonicalCurrent;
  const overlayPages = new Set((canonicalAnchorPreview?.pages ?? []).map((entry) => Number(entry.page)));
  if (canonicalAnchorPreview?.retiring) {
    // A covering canonical is on its way to this page. Until that image
    // commits (or a new anchor replaces the delta atomically), no report may
    // clear the overlay or move its target: either would expose the older
    // base page, or leave the delta over the covering one.
  } else if (closureDeferred && canonicalAnchorPreview) {
    // The source revision advances while an unfinished TeX construct holds
    // the last successful pixels. Keep that exact previous overlay eligible
    // for the new revision; it will be replaced when native closure succeeds.
    canonicalAnchorPreview.targetSrcRev = appliedSrcRev;
  } else if (leased || leasedOther) {
    // Ownership, not currency: presentation stays pending (the overlay's own
    // srcRev is older than appliedSrcRev) until a new anchor or a canonical
    // page covering this revision is on paper.
    canonicalAnchorPreview.targetSrcRev = appliedSrcRev;
  } else if (!anchorIntent || canonicalAnchorPreview && (
    !previewBlocks.every((id) => intentBlocks.includes(id)) ||
    canonicalAnchorPreview.baseGeneration !== anchorIntent.baseGeneration
  )) {
    clearCanonicalAnchorPreview();
  } else if (anchorIntent && canonicalAnchorPreview) {
    // Keep the previous keystroke visible while the next cumulative patch is
    // resolving, but make its convergence target the newest source revision.
    canonicalAnchorPreview.targetSrcRev = anchorIntent.srcRev;
  }
  const frozen = leased || Boolean(canonicalAnchorPreview?.retiring);
  const provisionalPatches = [];
  // (a report older than the page set: stageProvisionalPatches)
  const end = pageSetEnd(listsRev);
  for (const patch of report.patches) {
    if (previewPolicy !== 'structured') continue;
    // A leased refusal came before the plan could prove that this edit
    // leaves line breaks and page count alone, and a retiring delta still
    // sits on its base image: publishing any provisional page beside either
    // could compose no real revision.
    if (frozen) continue;
    if (leasedOther && patch.type === 'replace-page' && overlayPages.has(Number(patch.displayList?.page))) continue;
    if (patch.type === 'replace-page') {
      const dl = patch.displayList;
      if (dl.page > end) continue;
      // (a page sent again since, by patches published before this report:
      // made from this revision's layout, so it is this revision's page too)
      if ((pageListRev.get(dl.page) ?? 0) > listsRev) {
        pageDirtyRev.set(dl.page, appliedSrcRev);
        continue;
      }
      if (anchorIntent && (anchorIntent.provisionalPages ?? [anchorIntent.provisionalPage]).includes(dl.page) &&
          dl.commands?.some((command) => intentBlocks.includes(command.src))) {
        // The provisional page number belongs to the resident renderer's
        // local address space. While canonical anchoring resolves, retain
        // the unchanged physical page instead of repainting the unrelated
        // canonical page with the same number.
        continue;
      }
      provisionalPatches.push(patch);
      // this page now differs from the last canonical compile — provisional
      // owns it until a compile of srcRev >= this lands
      pageDirtyRev.set(dl.page, appliedSrcRev);
    } else if (patch.type === 'remove-pages') {
      if (end === Infinity) provisionalPatches.push(patch);
    }
  }
  // Such a page painted while the viewer still held the source before this
  // report's has current pictures, but the click mapping and the source
  // revision of that older source. Stage its list again under this one
  // (audit/scratch map.mjs: a page painted between patch 5 and report 4 kept
  // the mapping of source 2 with no paint to follow, and Jump took its ink
  // for an older layout's).
  if (!frozen && previewPolicy === 'structured') {
    for (const [page, listRev] of pageListRev) {
      if (listRev <= listsRev || page > end) continue;
      const dl = provisionalDisplayLists.get(page);
      const div = pageDivs.get(page);
      if (!dl || div?.dataset.prov !== '1' || Number(div.dataset.provRev) === appliedSrcRev) continue;
      if (leasedOther && overlayPages.has(page)) continue;
      provisionalPatches.push({ type: 'replace-page', displayList: dl });
      pageDirtyRev.set(page, appliedSrcRev);
    }
  }
  // (patches held for a source this report has passed: their report was
  // lost, or not taken, and with it lists of pages this one does not send)
  for (const msg of heldPatchEvents) {
    if (msg.srcRev < appliedSrcRev) noteMissedPatch(msg);
  }
  lastReportFrozen = frozen;
  // Not even an empty call while frozen: it re-renders earlier staged pages
  // for the new appliedSrcRev.
  if (!frozen) {
    // While lists are owed (docResync), a page staged before this report may
    // hold a list that a lost report changed: it is not carried to this
    // source. It keeps the paper it shows, with the map of its own source,
    // until /doc brings its list.
    if (docResync.owed) {
      const sent = new Set(provisionalPatches.filter(patch => patch.type === 'replace-page').map(patch => patch.displayList.page));
      for (const [page, stage] of provisionalStages) {
        if (stage.sourceRev === appliedSrcRev || sent.has(page)) continue;
        provisionalStages.delete(page);
        pageEditGroup.delete(page);
        docResync.pages.add(page);
      }
    }
    const editIds = new Set([...(report.dirtySourceNodes ?? []), ...(report.removedSourceNodes ?? [])]
      .map(node => String(node).replace(/^src-/, '')));
    // (the edit's blocks hold the paper still while in view: viewAnchor; an
    // edit of many blocks, a preamble's, has no place of its own)
    if (Array.isArray(report.dirtySourceNodes) && report.dirtySourceNodes.length) {
      const edited = new Set(report.dirtySourceNodes.map(node => String(node).replace(/^src-/, '')));
      viewEditSrcs = edited.size <= 4 ? edited : null;
    }
    stageProvisionalPatches(provisionalPatches, true, report.stats?.pageCount, editIds, listsRev,
      report.resyncLayoutRev === undefined && previewPolicy === 'structured');
  }
  for (const patch of provisionalPatches) {
    if (patch.type === 'replace-page') updateCanonState(patch.displayList.page);
  }
  // (the patches of this revision published before it: now, after its lists;
  // those of a revision it has passed: never, releaseHeldPatches)
  releaseHeldPatches(frozen);
  // (lists owed since a report was lost: read again)
  pumpDocResync();
  void previewSourceFormula(report).catch(() => {});
  updateBadge();
}

// Async patches of a source revision the viewer has not applied yet (the
// engine published them before the report of that revision): painted now,
// their ink would take the click map of the revision before (audit/scratch
// r8 click-map: line 12 for ink of line 47). They are held. The page keeps
// the paper it shows, clicked against the map of its own source, until a
// list and a map of one source are both in hand:
// - the report of their revision applies them after its own lists, in
//   revision order;
// - a report of a later revision means theirs was lost (or not taken: a
//   frozen report). They are never painted under it (r9 click-supersede:
//   ink of 3 against the map of 4); the lists are taken again from /doc
//   (docResync);
// - with no report after HELD_PATCH_MS, /doc is read, and taken when its
//   report is theirs or later (r9 click-timeout: the timer painted ink of 3
//   over the map of 2, line 12 for line 47, until the report came). A /doc
//   read between an update and its report leaves the current paper and
//   its click map in place while recovery backs off;
// - a document reset, or a stream that connects again, drops them.
const HELD_PATCH_MS = 3000;
let heldPatchEvents = [];
let heldPatchTimer = null;
// (whether the last report took lists: a frozen one, applyReport, did not)
let lastReportFrozen = false;
// (the engine run the adopted /doc came from: a /doc of another is not this document's)
let adoptedDocBoot = null;
function applyPatchEvent(msg) {
  // (the page count of the patch's revision: the page set as of it)
  stageProvisionalPatches(msg.patches, true, Number.isInteger(msg.pageCount) ? msg.pageCount : null, null, msg.rev,
    msg.srcRev === appliedSrcRev && !lastReportFrozen);
  for (const patch of msg.patches) {
    if (patch.type === 'replace-page') updateCanonState(patch.displayList.page);
  }
}
function holdPatchEvent(msg) {
  heldPatchEvents.push(msg);
  armHeldPatchTimer();
}
function armHeldPatchTimer() {
  if (docResync.stopped || heldPatchTimer !== null || !heldPatchEvents.length || typeof setTimeout !== 'function') return;
  heldPatchTimer = scheduleRecoveryTimer(() => {
    heldPatchTimer = null;
    // (left by a report of a later source, or of their own that took no lists)
    releaseHeldPatches(lastReportFrozen);
    // their report has not come: the document as the engine has it now
    if (heldPatchEvents.some((msg) => msg.srcRev > appliedSrcRev)) {
      docResync.wanted = true;
      pumpDocResync();
    }
  }, HELD_PATCH_MS);
}
function dropHeldPatches() {
  heldPatchEvents = [];
  if (heldPatchTimer !== null) clearTimeout(heldPatchTimer);
  heldPatchTimer = null;
}
function releaseHeldPatches(frozen = false) {
  if (!heldPatchEvents.length) return;
  // (of a source the viewer has passed: their ink is never put under its map)
  const passed = heldPatchEvents.filter((msg) => msg.srcRev < appliedSrcRev);
  const ready = frozen ? [] : heldPatchEvents.filter((msg) => msg.srcRev === appliedSrcRev).sort((a, b) => a.rev - b.rev);
  heldPatchEvents = heldPatchEvents.filter((msg) => !passed.includes(msg) && !ready.includes(msg));
  if (!heldPatchEvents.length && heldPatchTimer !== null) {
    clearTimeout(heldPatchTimer);
    heldPatchTimer = null;
  }
  if (mode !== 'opaque' && previewPolicy === 'structured') {
    for (const msg of ready) applyPatchEvent(msg);
  }
  if (docResync.wanted && !docResyncNeeded()) clearDocResync();
}

// The stream connected again (EventSource does so by itself): what it sent
// meanwhile is lost, perhaps the report the held patches wait for, and lists
// of pages no later report sends. The held patches go, and the lists are
// owed until /doc brings them.
function streamReconnected() {
  dropHeldPatches();
  docResync.unknown = true;
  docResync.covered.clear();
  docResync.coverageSource = null;
  docResync.wanted = true;
  pumpDocResync();
}

// The lists again, as the engine has them (GET /doc), when the stream lost or
// passed a report. Until then a page's newest list may be older than its
// source: "a page a report does not send is unchanged" no longer holds. Taken
// only when the snapshot's lists and its report are of one source (server.js
// docPayload `layoutSrcRev`; read between an update and its report they are
// not) and that source is the viewer's or later. While the lists are owed
// (`owed`), a report does not carry a page staged before it to its own source
// (applyReport): the page keeps its paper and the map of its source, and the
// report reads /doc again. Keep a single request or backoff timer until the
// missing source and lists arrive, even if the stream sends nothing else.
const DOC_RESYNC_MAX_DELAY = 12000;
const DOC_RESYNC_TIMEOUT = 10000;
const docResync = { stopped: false, unknown: false, wanted: false, request: null, at: -Infinity,
  delay: HELD_PATCH_MS, timer: null, pages: new Set(), covered: new Set(), coverageSource: null,
  get owed() { return this.unknown || this.pages.size > 0; } };
function docResyncNeeded() {
  return docResync.owed || docResync.wanted && heldPatchEvents.some(msg => !lastReportFrozen || msg.srcRev > appliedSrcRev);
}
function noteMissedPatch(msg) {
  const pages = docResync.pages;
  for (const patch of msg.patches) {
    if (patch.type === 'replace-page') pages.add(patch.displayList.page);
    else if (patch.type === 'remove-pages') {
      for (const page of provisionalDisplayLists.keys()) if (page >= patch.from) pages.add(page);
    }
  }
  if (Number.isInteger(msg.pageCount)) {
    for (const page of provisionalDisplayLists.keys()) if (page > msg.pageCount) pages.add(page);
    for (let page = provisionalDisplayLists.size + 1; page <= msg.pageCount; page++) pages.add(page);
  }
  if (docResync.owed) docResync.wanted = true;
}
function recoverStreamSheets(patches, pageCount) {
  if (!docResync.owed) return;
  const { pages, covered } = docResync;
  if (docResync.unknown && docResync.coverageSource !== appliedSrcRev) {
    covered.clear();
    docResync.coverageSource = appliedSrcRev;
  }
  for (const patch of patches) {
    if (patch.type === 'replace-page') {
      const page = patch.displayList.page;
      if (docResync.unknown) covered.add(page);
      pages.delete(page);
    } else if (patch.type === 'remove-pages') {
      for (const page of pages) if (page >= patch.from) pages.delete(page);
      for (const page of covered) if (page >= patch.from) covered.delete(page);
    }
  }
  if (Number.isInteger(pageCount) && pageCount >= 0) {
    for (const page of pages) if (page > pageCount) pages.delete(page);
    for (const page of covered) if (page > pageCount) covered.delete(page);
    // A reconnect can miss sheets we never saw. Consecutive deliveries of one
    // source can replace the whole surviving set, including those sheets.
    if (docResync.unknown && covered.size === pageCount && provisionalDisplayLists.size === pageCount &&
        [...provisionalDisplayLists.keys()].every(page => covered.has(page))) docResync.unknown = false;
  }
  if (!docResyncNeeded()) clearDocResync();
}
function syncDocResyncVisibility() {
  if (docRecoveryVisible()) pumpDocResync();
  else pauseDocResync();
}
function scheduleRecoveryTimer(callback, wait) {
  const timer = setTimeout(callback, wait);
  // The browser returns a numeric ID. Node harnesses can let this work go
  // when their scenario is finished and no other work keeps them alive.
  timer?.unref?.();
  return timer;
}
function pumpDocResync() {
  if (docResync.stopped || !docResyncNeeded() || docResync.request || documentReset.pending ||
      !docRecoveryVisible() || typeof fetch !== 'function') return;
  const now = viewClock();
  const wait = docResync.at - now;
  if (wait > 0) {
    if (docResync.timer === null && typeof setTimeout === 'function') {
      docResync.timer = scheduleRecoveryTimer(() => { docResync.timer = null; pumpDocResync(); }, wait);
    }
    return;
  }
  if (docResync.timer !== null) clearTimeout(docResync.timer);
  docResync.timer = null;
  const epoch = documentReset.adoptedEpoch;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const request = docResync.request = { controller, deadline: null, cancel: null };
  const read = Promise.resolve().then(() => docResync.request === request
    ? fetch('/doc', { cache: 'no-store', signal: controller?.signal }) : null)
    .then(response => !response || response.ok === false ? null : response.json());
  const result = typeof setTimeout === 'function' ? Promise.race([read, new Promise(resolve => {
    request.cancel = () => resolve(null);
    request.deadline = scheduleRecoveryTimer(() => { controller?.abort(); resolve(null); }, DOC_RESYNC_TIMEOUT);
  })]) : read;
  void result.then(doc => {
    if (doc && docResync.request === request && !documentReset.pending && documentReset.adoptedEpoch === epoch) {
      adoptResyncDoc(doc);
    }
  }).catch(() => {}).finally(() => {
    if (docResync.request !== request) return;
    if (request.deadline !== null) clearTimeout(request.deadline);
    docResync.request = null;
    if (docResyncNeeded()) {
      docResync.at = viewClock() + docResync.delay;
      docResync.delay = Math.min(DOC_RESYNC_MAX_DELAY, docResync.delay * 2);
      pumpDocResync();
    }
  });
}
function clearDocResync() {
  docResync.unknown = false;
  docResync.wanted = false;
  docResync.pages.clear();
  docResync.covered.clear();
  docResync.coverageSource = null;
  docResync.at = -Infinity;
  docResync.delay = HELD_PATCH_MS;
  pauseDocResync();
}
function pauseDocResync() {
  if (docResync.timer !== null) clearTimeout(docResync.timer);
  docResync.timer = null;
  const request = docResync.request;
  docResync.request = null;
  if (request?.deadline != null) clearTimeout(request.deadline);
  request?.cancel?.();
  request?.controller?.abort();
}
function teardownDocRecovery() {
  docResync.stopped = true;
  dropHeldPatches();
  clearDocResync();
}
function adoptResyncDoc(doc) {
  // (the hold every deferred event uses: while the opening editor only
  // waits for the shipping map, a held /doc would be deferred again and
  // again by the flush that replays it, flushDirectPresentationUpdates)
  if (holdingDirectOpeningPaper()) {
    deferredDirectPresentationEvents.push(() => adoptResyncDoc(doc));
    return;
  }
  const report = doc?.report;
  const srcRev = Number(report?.srcRev ?? report?.rev);
  const layoutRev = doc?.layoutRev;
  if (Number(doc?.documentEpoch) !== documentReset.adoptedEpoch || !Array.isArray(doc.pages) ||
      !Number.isSafeInteger(srcRev) || !Number.isSafeInteger(layoutRev) || !Number.isSafeInteger(report.rev)) return;
  if (typeof doc.boot === 'string' && typeof adoptedDocBoot === 'string' && doc.boot !== adoptedDocBoot) return;
  // (lists of a source with no report yet; or a snapshot the viewer has passed)
  if (Number(doc.layoutSrcRev) !== srcRev || report.rev < appliedReportRev || srcRev < appliedSrcRev) return;
  const newer = report.rev > appliedReportRev;
  if (!newer && (srcRev !== appliedSrcRev || lastReportFrozen)) return;
  // (held patches the snapshot has are in its lists)
  heldPatchEvents = heldPatchEvents.filter((msg) => msg.srcRev > srcRev || msg.rev > layoutRev);
  if (!heldPatchEvents.length && heldPatchTimer !== null) {
    clearTimeout(heldPatchTimer);
    heldPatchTimer = null;
  }
  // The pages whose list differs from the one held, whose stage a report did
  // not carry (`pages`), and those still staged: under this source, with its map.
  const sameList = (dl) => {
    const held = provisionalDisplayLists.get(dl.page);
    return held === dl || Boolean(held) && held.body === dl.body && JSON.stringify(held.commands) === JSON.stringify(dl.commands);
  };
  const owedPages = [...docResync.pages];
  const unknown = docResync.unknown;
  const patches = doc.pages.filter((dl) => docResync.pages.has(dl.page) || provisionalStages.has(dl.page) || !sameList(dl))
    .map((displayList) => ({ type: 'replace-page', displayList }));
  const wasWanted = docResync.wanted;
  docResync.unknown = false;
  docResync.wanted = false;
  docResync.pages.clear();
  if (newer) {
    // the report the stream did not bring, with the snapshot's lists
    injectFonts(doc.fonts);
    const canonicalNow = Number(canonical?.id) >= Number(doc.canonical?.id) ? canonical : doc.canonical ?? report.canonical;
    applyReport({ ...report, canonical: canonicalNow, patches, resyncLayoutRev: layoutRev,
      stats: { ...(report.stats ?? {}), pageCount: doc.pages.length } });
    renderInspector(report, null);
  } else {
    appliedRev = Math.max(appliedRev, layoutRev);
    if (previewPolicy === 'structured') {
      stageProvisionalPatches(patches, true, doc.pages.length, null, layoutRev);
      for (const patch of patches) updateCanonState(patch.displayList.page);
    }
    releaseHeldPatches(lastReportFrozen);
  }
  // (a frozen report takes no lists: still owed)
  if (lastReportFrozen) {
    docResync.unknown = unknown;
    for (const page of owedPages) docResync.pages.add(page);
    if (docResync.owed) docResync.wanted = true;
  }
  if (wasWanted && heldPatchEvents.length) docResync.wanted = true;
  if (!docResyncNeeded()) {
    clearDocResync();
    armHeldPatchTimer();
  }
}

function removeCanonicalDeltaLayers() {
  for (const [key, ink] of pendingFormulas) if (ink.slot.anchorRev) forgetPendingFormula(key);
  pagesEl.querySelectorAll('svg.tdom-canonical-delta').forEach((node) => node.remove());
}

function clearCanonicalAnchorPreview() {
  removeCanonicalDeltaLayers();
  canonicalAnchorPreview = null;
  canonicalAnchorPendingPatch = null;
}

/** A new anchor that fails (proof not ready, background unproven, deadline
 * passed) is dropped alone: the certified overlay already on paper stays the
 * last good presentation. */
function discardPendingCanonicalAnchor() {
  canonicalAnchorPendingPatch = null;
}

/** Called in the same DOM step that puts a canonical image on a page: a
 * retiring overlay leaves with the base image it was addressed against.
 * Only the committed delta goes; a newer anchor still pending (addressed to
 * this very image) is retried instead of being dropped with it. */
function retireCanonicalAnchorOnPage(div, presentedRev) {
  retirePendingFormulas(div);
  const anchor = canonicalAnchorPreview;
  if (!anchor?.retiring || !(Number(presentedRev) >= Number(anchor.targetSrcRev ?? anchor.srcRev))) return;
  div.querySelectorAll('svg.tdom-canonical-delta').forEach((node) => node.remove());
  if (pagesEl.querySelector('svg.tdom-canonical-delta')) return;
  canonicalAnchorPreview = null;
  if (canonicalAnchorPendingPatch) queueMicrotask(() => tryApplyPendingCanonicalAnchor());
}

function canonicalAnchorForPage(pageNumber) {
  const candidate = canonicalAnchorPendingPatch ?? canonicalAnchorPreview;
  const pagePatch = canonicalAnchorPages(candidate).find((page) => Number(page.page) === Number(pageNumber));
  if (!candidate || !pagePatch || candidate.retiring) return null;
  if (Number(candidate.targetSrcRev ?? candidate.srcRev) !== Number(appliedSrcRev)) return null;
  return { ...candidate, ...pagePatch };
}

/** A lazy canonical page may decode only after a distant toolbar jump. Keep
 * that certified last-good paper visible when this shell has never committed
 * provisional ink. The marker prevents the embed readiness contract from
 * mistaking the fallback for current-source pixels. */
function emptyStructuredCanonicalFallback(pageNumber, page, image) {
  if (!page || !image || usesCanonicalSurface() || documentReset.pending ||
      page.canonRetired || 'prov' in page.dataset || !Number.isInteger(pageNumber) || pageNumber < 1 ||
      pageNumber > Number(canonical?.pageCount)) return false;
  const presented = presentedPageState(page);
  const expectedSrc = `/canonical/${pageNumber}.svg?c=${Number(canonical?.id)}`;
  return Boolean(
    presented && presented.image === image && presented.src === expectedSrc &&
    image.complete && image.naturalWidth > 0 &&
    presented.id === Number(canonical?.id) && presented.rev === Number(canonical?.rev) &&
    Number(presented.snapshot?.srcRev) === presented.rev &&
    Number(presented.snapshot?.documentEpoch) === documentReset.adoptedEpoch
  );
}

function retainCanonicalFallbackMarker({ newlyEligible, previouslyMarked,
  canonicalSurface, final, freshTargetPresented }) {
  return newlyEligible || previouslyMarked && !canonicalSurface && final && !freshTargetPresented;
}

function tryApplyPendingCanonicalAnchor() {
  if (directPresentationBlocked()) return false;
  const patch = canonicalAnchorPendingPatch;
  if (!patch || patch.srcRev !== appliedSrcRev || !canonicalAnchorWithinDeadline(patch)) return false;
  const pagePatches = canonicalAnchorPages(patch);
  const transactions = [];
  for (const pagePatch of pagePatches) {
    if (patch.visualCut === true &&
        !globalThis.TdomCanonicalAnchorRaster?.validateVisualCutPage(pagePatch)) {
      discardPendingCanonicalAnchor();
      return false;
    }
    const pageNumber = Number(pagePatch.page);
    const page = pageDivs.get(pageNumber);
    const presented = page?.isConnected ? presentedPageState(page) : null;
    if (!page?.classList.contains('is-final') ||
        presented?.id !== Number(patch.baseGeneration) ||
        presented?.rev !== Number(patch.baseRev)) return false;
    const rules = [];
    for (let index = 0; index < (pagePatch.masks ?? []).length; index++) {
      const mask = pagePatch.masks[index];
      if (!mask || ![mask.left, mask.top, mask.right, mask.bottom].every(Number.isFinite)) return false;
      const baseMask = patch.visualCut === true ? pagePatch.baseMasks[index] : null;
      const tail = pagePatch.commands?.find(command => command.op === 'canonical-tail' &&
        command.y === baseMask?.top && command.x >= baseMask.left && command.x + command.w <= baseMask.right);
      const background = canonicalAnchorBackground(page, mask, baseMask, tail);
      if (!background) {
        // A solid mask is exact only when the canonical ink sits on a locally
        // uniform background. Gradients, artwork, and frames fail closed.
        discardPendingCanonicalAnchor();
        return false;
      }
      rules.push({
        op: 'rule',
        x: mask.left,
        y: mask.top,
        w: mask.right - mask.left,
        h: mask.bottom - mask.top,
        color: background,
        src: patch.blockId,
      });
    }
    const ink = pagePatch.commands ?? [];
    transactions.push({ pageNumber, page, masks: pagePatch.masks, ink, commands: [...rules, ...ink] });
  }
  // The deadline is checked again immediately before the atomic DOM commit;
  // image decode or background probing is not allowed to publish a stale win.
  if (!canonicalAnchorWithinDeadline(patch)) {
    discardPendingCanonicalAnchor();
    return false;
  }
  removeCanonicalDeltaLayers();
  const clickSnapshot = loadProvisionalSnapshot(patch.srcRev).catch(() => null);
  for (const transaction of transactions) {
    for (const [key, ink] of pendingFormulas) if (ink.sourceSnapshot && ink.page === transaction.page) forgetPendingFormula(key);
    transaction.page.insertAdjacentHTML(
      'beforeend',
      svgFor({ page: transaction.pageNumber, commands: transaction.commands }, 'tdom-canonical-delta')
    );
    transaction.page.lastElementChild.sourceClickPaint = {
      masks: transaction.masks, commands: transaction.ink, snapshot: clickSnapshot,
    };
  }
  const committedAt = performance.now();
  canonicalAnchorPreview = {
    blockId: patch.blockId,
    blockIds: Array.isArray(patch.blockIds) ? [...patch.blockIds] : [patch.blockId],
    srcRev: patch.srcRev,
    targetSrcRev: patch.srcRev,
    baseGeneration: patch.baseGeneration,
    baseRev: patch.baseRev,
    visualCut: patch.visualCut === true,
    pages: pagePatches.map(page => ({ page: page.page, tails: page.commands?.filter(c => c.op === 'canonical-tail') ?? [] })),
  };
  canonicalAnchorPendingPatch = null;
  for (const { page } of transactions) {
    page.classList.remove('fading');
    page.classList.add('patched');
    requestAnimationFrame(() => page.classList.add('fading'));
    setTimeout(() => page.classList.remove('patched', 'fading'), 1200);
  }
  if (directEditor?.committedIme) paintDirectSelection();
  updateBadge();
  reportCanonicalAnchorPresented(patch, pagePatches, committedAt);
  const session = directEditor;
  const editorPage = pagePatches.find(p => p.page === session?.pageNumber);
  if (session?.sentEdit && session.kind === 'text' && editorPage && session.geometryValue !== session.readValue()) {
    void followTextAnchor(session, patch, editorPage).catch(() => false).then(followed => {
      if (directEditor !== session || appliedSrcRev !== patch.srcRev) return;
      if (followed) fulfillCanonicalDisplay();
      else requestCanonicalDisplay({ residentImpossible: usesCanonicalSurface() });
    });
  } else fulfillCanonicalDisplay();
  return true;
}

// An anchor redraw may arrive long before the next PDF. The focused
// editor needs the geometry of the text the user actually sees, including
// untouched lines from the immutable PDF underneath the printed delta.
async function followTextAnchor(session, patch, pagePatch) {
  const page = pageDivs.get(session.pageNumber);
  const svg = page?.querySelector(':scope > svg.tdom-canonical-delta');
  const base = session.printedTextMap;
  if (!svg || !base || base.id !== patch.baseGeneration || patch.visualCut) return false;
  const snapshot = await loadProvisionalSnapshot(patch.srcRev).catch(() => null);
  if (!snapshot || Number(snapshot.srcRev) !== patch.srcRev || !svg.isConnected || directEditor !== session ||
      documentReset.pending || Number(snapshot.documentEpoch) !== documentReset.adoptedEpoch ||
      appliedSrcRev !== patch.srcRev || Number(page.dataset.canonPresentedId) !== base.id) return false;
  const region = directEditorRegionInSnapshot(snapshot, session);
  if (!region) return false;
  const owner = snapshot.blocks.find(block => block.editRegions?.some(r => r.id === region.id &&
    directSourceRangeKey(r) === directSourceRangeKey(region)));
  if (!owner || !(patch.blockIds ?? [patch.blockId]).includes(owner.id) ||
      owner.editRegions.filter(item => item.kind === 'text' && printedKey(item.value) === printedKey(region.value)).length !== 1) return false;
  const nodes = [...svg.querySelectorAll('text[data-src]')].filter(node => node.dataset.src === owner.id &&
    node.dataset.math !== '1' && !node.hasAttribute('data-font-pending'));
  if (!nodes.length) return false;
  const original = base.map.filter(g => !pagePatch.masks.some(box => {
    const x = (g.left + g.right) / 2;
    return x >= box.left && x <= box.right && g.baseline >= box.top && g.baseline <= box.bottom;
  }));
  // A single horizontal run per baseline gives a unique reading order.
  // A column break or a repeated phrase falls back to the full PDF map.
  if (base.map.some((g, i, a) => i && g.baseline < a[i - 1].baseline - 0.25)) return false;
  const { glyphs } = directSvgGeometry(page, nodes);
  if (!glyphs.length) return false;
  const combined = [...original, ...glyphs.map(g => ({ ...g, fromAnchor: true }))].sort((a, b) =>
    Math.abs(a.baseline - b.baseline) <= 0.25 ? a.left - b.left : a.baseline - b.baseline);
  const matches = window.TdomDirectEditGeometry.textMaps(region.value, combined);
  if (matches.length !== 1 || !matches[0].map.some(g => g.fromAnchor)) return false;
  session.glyphMap = matches[0].map;
  session.geometryValue = region.value;
  paintDirectSelection();
  alignOpaqueNativeCaretAnchor();
  return true;
}

function reportCanonicalAnchorPresented(patch, pagePatches, committedAt) {
  const startedAt = canonicalAnchorEditStartedAt.get(Number(patch?.srcRev));
  if (!Number.isFinite(startedAt)) return;
  window.requestAnimationFrame(() => {
    const firstFrameAt = performance.now();
    window.requestAnimationFrame(() => {
      const active = canonicalAnchorPreview;
      if (!active || Number(active.srcRev) !== Number(patch.srcRev) ||
          Number(active.baseGeneration) !== Number(patch.baseGeneration)) return;
      const secondFrameAt = performance.now();
      const clientEditAt = patch.clientEditAtEpochMs == null
        ? Number.NaN
        : Number(patch.clientEditAtEpochMs);
      void fetch('/anchor-presented', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          srcRev: patch.srcRev,
          baseGeneration: patch.baseGeneration,
          baseRev: patch.baseRev,
          proofMs: patch.proofMs,
          commitMs: committedAt - startedAt,
          firstFrameMs: firstFrameAt - startedAt,
          secondFrameMs: secondFrameAt - startedAt,
          inputToSecondFrameMs: Number.isFinite(clientEditAt) ? Date.now() - clientEditAt : null,
          pages: pagePatches.map((page) => Number(page.page)),
        }),
        keepalive: true,
      }).catch(() => {});
    });
  });
}

function canonicalAnchorPages(patch) {
  if (!patch) return [];
  if (Array.isArray(patch.pages)) return patch.pages;
  return Number.isInteger(Number(patch.page))
    ? [{ page: Number(patch.page), masks: patch.mask ? [patch.mask] : [],
        ...(patch.visualCut === true ? { baseMasks: patch.baseMask ? [patch.baseMask] : [] } : {}),
        commands: patch.commands ?? [] }]
    : [];
}

function canonicalAnchorWithinDeadline(patch) {
  const startedAt = canonicalAnchorEditStartedAt.get(Number(patch?.srcRev));
  const limit = Number(patch?.publishWithinMs ?? 850);
  return Number.isFinite(startedAt) && Number.isFinite(limit) &&
    performance.now() - startedAt < limit;
}

function canonicalAnchorBackground(page, mask, baseMask = null, tail = null) {
  const image = page?.querySelector('img.canon');
  if (!image?.naturalWidth || !image?.naturalHeight) return null;
  let cached = canonicalAnchorCanvasCache.get(image);
  if (!cached) {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    try {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    } catch {
      return null;
    }
    cached = { canvas, context };
    canonicalAnchorCanvasCache.set(image, cached);
  }
  const paper = activePaperGeometry(page);
  if (!(paper.width > 0 && paper.height > 0)) return null;
  const sx = cached.canvas.width / paper.width;
  const sy = cached.canvas.height / paper.height;
  const xs = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
    mask.left + (mask.right - mask.left) * ratio
  );
  const ys = [0, 0.5, 1].map((ratio) =>
    mask.top + (mask.bottom - mask.top) * ratio
  );
  const points = [
    ...xs.flatMap((x) => [[x, mask.top - 1], [x, mask.bottom + 1]]),
    ...ys.flatMap((y) => [[mask.left - 1, y], [mask.right + 1, y]]),
  ];
  const pageBackground = cssColor(getComputedStyle(page).backgroundColor) ?? [255, 255, 255];
  const samples = [];
  try {
    for (const [x, y] of points) {
      const px = Math.max(0, Math.min(cached.canvas.width - 1, Math.round(x * sx)));
      const py = Math.max(0, Math.min(cached.canvas.height - 1, Math.round(y * sy)));
      const data = cached.context.getImageData(px, py, 1, 1).data;
      const alpha = data[3] / 255;
      samples.push([
        Math.round(data[0] * alpha + pageBackground[0] * (1 - alpha)),
        Math.round(data[1] * alpha + pageBackground[1] * (1 - alpha)),
        Math.round(data[2] * alpha + pageBackground[2] * (1 - alpha)),
      ]);
    }
  } catch {
    return null;
  }
  const channelRange = (channel) => {
    const values = samples.map((sample) => sample[channel]);
    return Math.max(...values) - Math.min(...values);
  };
  if (!samples.length || [0, 1, 2].some((channel) => channelRange(channel) > 8)) return null;
  const rgb = [0, 1, 2].map((channel) =>
    Math.round(samples.reduce((sum, sample) => sum + sample[channel], 0) / samples.length)
  );
  if (baseMask) {
    const raster = globalThis.TdomCanonicalAnchorRaster;
    if (!raster?.ringPixelsUniform || !raster.validateVisualCutPage({ masks: [mask], baseMasks: [baseMask] })) {
      return null;
    }
    const pixelLeft = Math.floor(mask.left * sx);
    const pixelTop = Math.floor(mask.top * sy);
    const pixelRight = Math.ceil(mask.right * sx);
    const pixelBottom = Math.ceil(mask.bottom * sy);
    if (pixelLeft < 0 || pixelTop < 0 || pixelRight > cached.canvas.width ||
        pixelBottom > cached.canvas.height || pixelRight <= pixelLeft || pixelBottom <= pixelTop ||
        (pixelRight - pixelLeft) * (pixelBottom - pixelTop) > raster.DEFAULT_MAX_PIXELS) return null;
    let imageData;
    try {
      imageData = cached.context.getImageData(
        pixelLeft,
        pixelTop,
        pixelRight - pixelLeft,
        pixelBottom - pixelTop
      );
    } catch {
      return null;
    }
    const pixels = {
      data: imageData.data, width: imageData.width, height: imageData.height,
      originX: pixelLeft, originY: pixelTop, sx, sy, background: rgb,
    };
    if (!raster.ringPixelsUniform({ ...pixels, mask, baseMask })) return null;
    if (tail) {
      // A PDF advance is not an ink boundary (italic overhang, punctuation).
      // Copy the printed tail only when its four cutting edges are blank.
      const crop = { left: tail.x, right: tail.x + tail.w, top: tail.y, bottom: tail.y + tail.h };
      const interior = { left: crop.left + 0.4, right: crop.right - 0.4,
        top: crop.top + 0.4, bottom: crop.bottom - 0.4 };
      if (!raster.ringPixelsUniform({ ...pixels, mask: crop, baseMask: interior })) return null;
    }
  }
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function cssColor(value) {
  const match = String(value ?? '').match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function applyCanonicalAnchorPatch(patch, { allowVisualCut = false } = {}) {
  if (!patch || patch.srcRev !== appliedSrcRev) return;
  if (patch.visualCut === true && (!allowVisualCut || patch.authoritative !== false)) return;
  if (patch.baseGeneration !== canonical?.id || patch.baseRev !== canonical?.rev) return;
  if (patch.status !== 'ready') {
    discardPendingCanonicalAnchor();
    return;
  }
  if (!canonicalAnchorWithinDeadline(patch)) return;
  const pagePatches = canonicalAnchorPages(patch);
  if (!pagePatches.length || pagePatches.some((page) =>
    !Number.isInteger(Number(page.page)) || Number(page.page) < 1 ||
    !Array.isArray(page.masks) || !page.masks.length ||
    page.masks.some((mask) => !mask || ![mask.left, mask.top, mask.right, mask.bottom].every(Number.isFinite))
  )) return;
  if (patch.visualCut === true && pagePatches.some((page) =>
    !globalThis.TdomCanonicalAnchorRaster?.validateVisualCutPage(page)
  )) return;
  canonicalAnchorPendingPatch = patch;
  for (const pagePatch of pagePatches) {
    const pageNumber = Number(pagePatch.page);
    const page = ensureShell(pageNumber);
    const targetSrc = `/canonical/${pageNumber}.svg?c=${patch.baseGeneration}`;
    if (page.dataset.canonPresentedSrc !== targetSrc) page.dataset.canonStage = targetSrc;
    updateCanonState(pageNumber);
  }
  tryApplyPendingCanonicalAnchor();
}

// ------------------------------------------------- canonical (exact) layer

// The first visible page can be only a strip above the page the reader is
// using. Keep that first page for viewport handoff; the toolbar follows a
// visible edit, then the page with the largest fraction in view.
function activePaperPage(first, last, pageAt, viewport, editor) {
  const editBox = editor?.element?.matches(':focus-within') ? editor.element.getBoundingClientRect() : null;
  const editingInView = editBox && editBox.bottom > viewport.top && editBox.top < viewport.bottom;
  let best = first, fraction = 0;
  for (let n = first; n <= last; n++) {
    const page = pageAt(n);
    if (!page) continue;
    const rect = page.getBoundingClientRect();
    if (rect.top >= viewport.bottom) break;
    const overlap = Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top);
    if (overlap <= 0 || rect.height <= 0) continue;
    if (editingInView && editor.element.parentElement === page) return n;
    const visible = overlap / Math.min(rect.height, viewport.bottom - viewport.top);
    if (visible > fraction) { best = n; fraction = visible; }
  }
  return best;
}

function activePaperGeometry(page = null) {
  const displayedWidth = Number(page?.dataset?.canonPaperW);
  const displayedHeight = Number(page?.dataset?.canonPaperH);
  const displayedRotation = Number(page?.dataset?.canonPaperRotation) || 0;
  // The dimensions attached to a committed canonical image belong to the
  // immutable generation whose pixels are actually on screen. They outrank
  // both the newest compile metadata and the resident renderer's one global
  // geometry. Only use them while that image is visible: a dirty structured
  // page falls back to its provisional SVG until the next exact image lands.
  const displaysCanonical = page?.classList?.contains('is-final') &&
    page?.querySelector?.('img.canon');
  if (displaysCanonical && displayedWidth > 0 && displayedHeight > 0) {
    return { width: displayedWidth, height: displayedHeight, rotation: displayedRotation };
  }
  const pageNumber = Number(page?.dataset?.page);
  const exactPaper = Number.isInteger(pageNumber)
    ? canonical?.papers?.[pageNumber - 1] ?? canonical?.paper
    : canonical?.paper;
  const exactWidth = Number(exactPaper?.w);
  const exactHeight = Number(exactPaper?.h);
  if (usesCanonicalSurface() && exactWidth > 0 && exactHeight > 0) {
    return { width: exactWidth, height: exactHeight, rotation: Number(exactPaper?.rotation) || 0 };
  }
  return {
    width: Number(geometry?.paperwidth) || exactWidth || 612,
    height: Number(geometry?.paperheight) || exactHeight || 792,
    rotation: Number(exactPaper?.rotation) || 0,
  };
}

function prepareOpaqueShell(div) {
  if (!div || !usesCanonicalSurface()) return;
  div.querySelector(':scope > svg:not(.tdom-canonical-delta)')?.remove();
  div.querySelectorAll('.chunkwin, .tdom-staged-furniture').forEach((element) => element.remove());
  delete div.stagedFurniture;
  div.classList.remove('patched', 'fading', 'withdrawn-slot-h', 'withdrawn-slot-f');
  delete div.dataset.prov;
  delete div.dataset.provNativeHold;
  div.paintedResidentPage = null;
  const current = div.querySelector('img.canon');
  div.classList.toggle('awaiting-canonical', !current);
  // Never stretch old exact pixels to a new compile's paper size. Existing
  // images carry their committed dimensions; a brand-new shell may use the
  // current canonical size until its first image arrives.
  if (!current || (Number(div.dataset.canonPaperW) > 0 && Number(div.dataset.canonPaperH) > 0)) {
    const paper = activePaperGeometry(div);
    div.style.aspectRatio = `${paper.width} / ${paper.height}`;
  }
}

function setMode(newMode, reasons) {
  modeReasons = reasons ?? modeReasons;
  if (newMode === mode) return;
  mode = newMode;
  document.body.classList.toggle('is-opaque-document', usesCanonicalSurface());
  directEditClickEpoch++;
  directEditor?.element?.classList.add('is-opaque');
  if (!usesCanonicalSurface() && directEditor?.control) directEditor.control.style.transform = '';
  if (usesCanonicalSurface()) {
    // A structured editor is anchored to provisional SVG geometry. Once the
    // document demotes, that coordinate system no longer exists; retaining
    // its WYSIWYG/IME surface above an old canonical page would be a visible
    // mixed-generation UI. Input events are sent eagerly, so only the
    // transient surface is closed here.
    closeDirectEditor();
    // the provisional layers are dead weight now — every page is canonical
    if (shipWaveBatch) cancelShipWaveBatch(shipWaveBatch);
    shipPages.clear();
    pagesEl.querySelectorAll('.tdom-search-marker').forEach((marker) => marker.remove());
    liveSearch = { query: liveSearch.query, results: [], current: -1 };
    for (const div of pageDivs.values()) prepareOpaqueShell(div);
    pageDirtyRev.clear();
    for (const pageNumber of pageDivs.keys()) updateCanonState(pageNumber);
    if (canonical?.id && canonical.rev === appliedSrcRev) {
      void ensurePresentedDomSnapshot(canonical.id, canonical.rev);
    }
  }
}

function usesDirectEditSurface(page = null) {
  return usesCanonicalSurface() || (page
    ? Boolean(page.classList.contains('is-final') && canonicalIdFromSrc(page.querySelector('img.canon')?.dataset.src) != null)
    : directEditor?.canonicalInput === true);
}

function usesCanonicalSurface() {
  // shipping-exact retains the incremental source/checkpoint machinery, but
  // its physical pages have to come from a complete TeX replay.  Keep the
  // last exact generation visible until a certified ship wave atomically
  // replaces it; resident JS pages remain internal witnesses only.
  return mode === 'opaque' || previewPolicy === 'canonical-anchor' || previewPolicy === 'shipping-exact';
}

function createCanonicalImage(src) {
  const image = document.createElement('img');
  image.className = 'canon';
  image.loading = 'eager';
  image.decoding = 'async';
  image.draggable = false;
  image.dataset.src = src;
  return image;
}

function canonicalIdFromSrc(src) {
  if (!src || !String(src).startsWith('/canonical/')) return null;
  try {
    const value = Number(new URL(src, location.href).searchParams.get('c'));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function presentedPageState(page, requireSnapshot = true) {
  const image = page?.querySelector?.('img.canon');
  const id = Number(page?.dataset?.canonPresentedId);
  const rev = Number(page?.dataset?.canonPresentedRev);
  if (!image || image.dataset.src !== page?.dataset?.canonPresentedSrc ||
      !Number.isFinite(id) || !Number.isFinite(rev)) return null;
  const snapshot = presentedDomSnapshots.get(presentedSnapshotKey(id, rev));
  return snapshot || !requireSnapshot ? { image, id, rev, snapshot, src: image.dataset.src } : null;
}

function presentedShippingPageState(page) {
  const image = page?.querySelector?.('img.canon');
  const src = page?.dataset?.canonPresentedSrc;
  const rev = Number(page?.dataset?.canonPresentedRev);
  if (!image || image.dataset.src !== src || !String(src).startsWith('/ship/') ||
      !Number.isFinite(rev) || !image.complete || image.naturalWidth <= 0) return null;
  return { image, rev, src };
}

function opaqueCanonicalBatchKey(generation) {
  const id = Number(generation?.id);
  const rev = Number(generation?.rev);
  return Number.isFinite(id) && Number.isFinite(rev) ? `${id}:${rev}` : null;
}

function cancelObsoleteOpaqueBatches(keepKey = null) {
  for (const [key, batch] of [...opaqueCanonicalBatches]) {
    if (key === keepKey) continue;
    if (batch.viewAnchorTarget?.timer != null) clearTimeout(batch.viewAnchorTarget.timer);
    for (const entry of batch.expected.values()) {
      if (entry.page?.dataset?.canonPending === entry.src) {
        delete entry.page.dataset.canonPending;
      }
    }
    opaqueCanonicalBatches.delete(key);
  }
}

function directRevisitTokens(session, ids = []) {
  if (session.kind !== 'math' || typeof session.control.getElementInfo !== 'function') {
    return String(session.readValue()).split('');
  }
  const tokens = [];
  const metadata = typeof session.control.getModelMetadata === 'function'
    ? session.control.getModelMetadata()
    : Array.from({ length: Number(session.control.lastOffset) + 1 }, (_, offset) => session.control.getElementInfo(offset) ?? {});
  for (let offset = 1; offset < metadata.length; offset++) {
    const info = metadata[offset];
    ids.push(info.modelId);
    tokens.push(JSON.stringify([info.type, info.symbol ?? '',
      info.depth, info.parentBranch]));
  }
  return tokens;
}

function directRevisitOffsets(before, after, offsets, change = null) {
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  if (prefix === before.length && prefix === after.length) return [...offsets];
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  let oldEnd = before.length - suffix, newEnd = after.length - suffix;
  if (change && Number.isInteger(change.start) && Number.isInteger(change.end)) {
    const inserted = after.length - before.length + change.end - change.start;
    if (inserted >= 0 && before.slice(0, change.start).join('') === after.slice(0, change.start).join('') &&
        before.slice(change.end).join('') === after.slice(change.start + inserted).join('')) {
      prefix = change.start; oldEnd = change.end; newEnd = change.start + inserted;
    } else change = null;
  }
  // Without an actual input range, identical adjacent tokens do not prove
  // which occurrence changed. Retain only boundaries outside every possible splice.
  if (!change) {
    const removed = oldEnd - prefix, inserted = newEnd - prefix;
    let fullSuffix = suffix;
    while (fullSuffix < before.length && fullSuffix < after.length &&
      before[before.length - fullSuffix - 1] === after[after.length - fullSuffix - 1]) fullSuffix++;
    const first = Math.max(0, before.length - removed - fullSuffix);
    const last = Math.min(prefix, before.length - removed);
    // All valid starts form one interval. Compare its endpoints and the
    // finite branch transitions instead of slicing the whole text per start.
    if (first < last) return offsets.map(offset => {
      if (offset === null) return null;
      const at = start => offset < start ? offset
        : offset > start + removed ? offset + inserted - removed
        : offset === start && removed > 0 ? start : start + inserted;
      const expected = at(first);
      return [last, offset - removed - 1, offset - removed, offset - removed + 1,
        offset - 1, offset, offset + 1].every(start => start < first || start > last || at(start) === expected)
        ? expected : null;
    });
  }
  return offsets.map(offset => offset === null ? null : offset < prefix ? offset : offset > oldEnd ? offset + newEnd - oldEnd
    : offset === prefix && oldEnd > prefix ? prefix : newEnd);
}

function directRevisitAtomOffsets(before, after, offsets) {
  const next = new Map(after.map((id, index) => [id, index]));
  return offsets.map(offset => {
    if (!Number.isInteger(offset)) return null;
    const left = offset > 0 ? next.get(before[offset - 1]) : null;
    const right = offset < before.length ? next.get(before[offset]) : null;
    if (Number.isInteger(left) && Number.isInteger(right) && left >= right) return null;
    if (Number.isInteger(right)) return right;
    return Number.isInteger(left) ? left + 1 : after.length === 0 ? 0 : null;
  });
}

function updateDirectRevisitOffsets(session) {
  if (!session?.revisitTokens) return;
  const ids = [], next = directRevisitTokens(session, ids);
  if (session.kind === 'math' && ids.length && ids.every(Number.isInteger)) {
    session.revisitOffsets = directRevisitAtomOffsets(session.revisitBasisIds, ids, session.revisitBasisOffsets);
  } else session.revisitOffsets = directRevisitOffsets(session.revisitTokens, next, session.revisitOffsets, session.revisitInputRange);
  session.revisitInputRange = null;
  session.revisitTokens = next;
  session.revisitModelIds = ids;
}

function directRevisitMatches(record, region, sourceText) {
  const original = record.displayRegion;
  return record.epoch === documentReset.adoptedEpoch && record.displaySourceText === sourceText &&
    original.kind === region.kind && original.source.file === region.source.file &&
    original.source.start.line === region.source.start.line && original.source.start.column === region.source.start.column &&
    original.source.end.line === region.source.end.line && original.source.end.column === region.source.end.column &&
    (original.sourceValue ?? original.value) === (region.sourceValue ?? region.value);
}

function rememberDirectEditorRevisit(session) {
  if (!embeddedHost || !session.sentEdit || session.revisitCancelled || typeof session.sourceText !== 'string') return;
  updateDirectRevisitOffsets(session);
  const displayRegion = session.revisitDisplayRegion, displaySourceText = session.revisitDisplaySourceText;
  const old = directEditRevisits.findIndex(record => directRevisitMatches(record, displayRegion, displaySourceText));
  if (old >= 0) directEditRevisits.splice(old, 1);
  directEditRevisits.push({ epoch: documentReset.adoptedEpoch, sessionId: session.sessionId,
    displayRegion, displaySourceText, sourceRegion: session.sourceRegion, sourceText: session.sourceText,
    value: String(session.readValue()), fieldValue: session.kind === 'math' ? session.control.value : null,
    replacement: session.kind === 'math'
      ? session.formattedSource : latexEscapeText(session.readValue()),
    tokens: session.revisitTokens, offsets: session.revisitOffsets });
  let cost = directEditRevisits.reduce((sum, item) => sum + item.sourceText.length + item.displaySourceText.length, 0);
  while (directEditRevisits.length > 32 || cost > 8 * 1024 * 1024) {
    const removed = directEditRevisits.shift();
    cost -= removed.sourceText.length + removed.displaySourceText.length;
  }
}

async function restoreDirectEditorRevisit(session, opening, offset, pendingHit = null) {
  const record = session.revisit;
  if (!record) return offset;
  const reply = await session.presentationAnchorDone;
  if (directEditor !== session || opening && openingDirectInput !== opening) return null;
  const editedOffset = pendingHit?.sessionId === record.sessionId && pendingHit.value === record.value
    ? pendingHit.offset : record.offsets[offset];
  if (!reply || reply.baseValue !== record.replacement || !Number.isInteger(editedOffset)) return null;
  const region = { ...session.sourceRegion, value: record.value, sourceValue: reply.baseValue,
    source: { file: reply.file, start: reply.start, end: reply.end } };
  // Parsing the retained model must preserve every logical boundary before
  // using the old paper's caret map. The host has independently proven its
  // current source range and complete replacement above.
  session.writeValue(record.value);
  const ids = [], tokens = directRevisitTokens(session, ids);
  if (tokens.length !== record.tokens.length || tokens.some((token, at) => token !== record.tokens[at])) return null;
  session.sourceRegion = region;
  session.sourceText = reply.sourceText;
  session.presentationSourceRegion = region;
  session.presentationSourceText = reply.sourceText;
  session.lastVisibleValue = String(session.readValue());
  session.formattedSource = reply.baseValue;
  session.serializedValue = session.kind === 'math' ? preserveMathAuxCommands(reply.baseValue, session.readSourceValue()) : null;
  session.revisitTokens = tokens;
  session.revisitModelIds = ids;
  session.revisitOffsets = [...record.offsets];
  session.revisitBasisIds = [...ids];
  session.revisitBasisOffsets = [...record.offsets];
  session.glyphMap = (session.glyphMap ?? []).map(glyph => ({ ...glyph,
    start: record.offsets[glyph.start], end: record.offsets[glyph.end] }))
    .filter(glyph => Number.isInteger(glyph.start) && Number.isInteger(glyph.end) && glyph.end > glyph.start);
  session.geometryValue = session.lastVisibleValue;
  const ink = pendingHit?.ink ?? [...pendingFormulas.values()].find(item => item.sessionId === record.sessionId);
  if (ink) {
    session.formulaSlot = ink.slot;
    session.formulaBasis = ink.basis;
  }
  return editedOffset;
}

function requestDirectEditorPresentationAnchor(session) {
  if (!embeddedHost || !session || typeof session.sourceText !== 'string' ||
      session.presentationAnchorRequest) return;
  const region = session.revisit?.sourceRegion ?? session.sourceRegion;
  session.presentationAnchorRequest = `${session.sessionId}:presentation`;
  session.presentationAnchorPending = true;
  session.presentationAnchorDone = new Promise(resolve => { session.resolvePresentationAnchor = resolve; });
  window.parent.postMessage({
    source: 'tdom-embed', action: 'edit-anchor', activationId: embedActivationId,
    documentEpoch: documentReset.adoptedEpoch, sessionId: session.sessionId,
    requestId: session.presentationAnchorRequest, sourceRev: session.sourceRev,
    previousSessionId: session.revisit?.sessionId,
    file: region.source.file, start: region.source.start, end: region.source.end,
    baseValue: region.sourceValue ?? region.value, sourceText: session.revisit?.sourceText ?? session.sourceText,
  }, '*');
}

function receiveDirectEditorPresentationAnchor(data) {
  const session = directEditor;
  if (!session?.presentationAnchorPending || data.sessionId !== session.sessionId ||
      data.requestId !== session.presentationAnchorRequest ||
      data.activationId !== embedActivationId || documentReset.pending ||
      Number(data.documentEpoch) !== documentReset.adoptedEpoch ||
      Number(data.sourceRev) !== Number(session.sourceRev) ||
      data.file !== session.sourceRegion.source.file) return;
  session.presentationAnchorPending = false;
  let reply = null;
  const validPosition = position => Number.isInteger(position?.line) && position.line > 0 &&
    Number.isInteger(position?.column) && position.column > 0;
  if (data.ok === true && typeof data.sourceText === 'string' && typeof data.baseValue === 'string' &&
      validPosition(data.start) && validPosition(data.end)) {
    const region = { ...session.sourceRegion, sourceValue: data.baseValue,
      source: { file: data.file, start: data.start, end: data.end } };
    const sourceText = sourceTextForRegion({ sources: [{ file: data.file, text: data.sourceText }] }, region);
    if (sourceText !== undefined) {
      reply = data;
      // Only presentation changes basis. Edit payloads keep their immutable
      // original anchor, which the host already tracks through its history.
      session.presentationSourceRegion = region;
      session.presentationSourceText = sourceText;
    }
  }
  session.resolvePresentationAnchor?.(reply);
  session.resolvePresentationAnchor = null;
  for (const batch of opaqueCanonicalBatches.values()) restageOpaqueBatchEditor(batch);
  tryCommitProvisionalStages();
}

function directEditorSourceRange(snapshot, session) {
  const region = session?.presentationSourceRegion ?? session?.sourceRegion;
  const initial = session?.presentationSourceText ?? session?.sourceText;
  const current = snapshot?.sources?.find(item => item.file === region?.source?.file)?.text;
  if (!region || typeof initial !== 'string' || typeof current !== 'string') return null;
  const start = lineColToOffset(initial, region.source.start.line, region.source.start.column);
  const end = lineColToOffset(initial, region.source.end.line, region.source.end.column);
  const prefix = initial.slice(0, start), suffix = initial.slice(end);
  if (current.length < prefix.length + suffix.length ||
      !current.startsWith(prefix) || !current.endsWith(suffix)) return null;
  const visible = String(session.readValue?.() ?? region.value ?? '');
  const replacement = session.kind === 'math'
    ? String(session.formattedSource ?? region.sourceValue ?? region.value)
    : latexEscapeText(visible);
  const contentEnd = current.length - suffix.length;
  const lines = current.slice(0, contentEnd).split('\n');
  return {
    source: { file: region.source.file, start: region.source.start,
      end: { line: lines.length, column: lines.at(-1).length + 1 } },
    replacement,
    matches: current.slice(start, contentEnd) === replacement &&
      directEditValuesEqual(session.kind, session.lastVisibleValue ?? region.value, visible),
  };
}

function directEditorRegionInSnapshot(snapshot, session) {
  if (!snapshot || !session) return null;
  const regions = (snapshot.blocks ?? []).flatMap((block) =>
    (block.editRegions ?? []).map((region) => ({ ...region, blockSource: block.source ?? null }))
  );
  const visible = String(session.readValue?.() ?? session.region?.value ?? '');
  const sameValueAs = value => directEditValuesEqual(session.kind, value, visible);
  const sourceRange = directEditorSourceRange(snapshot, session);
  if (sourceRange) {
    // An intermediate compile must not borrow another occurrence of the
    // newly typed value elsewhere in this same block.
    if (!sourceRange.matches) return null;
    const atSource = regions.filter(region => region.kind === session.kind &&
      region.source?.file === sourceRange.source.file &&
      region.source.start.line === sourceRange.source.start.line &&
      region.source.start.column === sourceRange.source.start.column &&
      region.source.end.line === sourceRange.source.end.line &&
      region.source.end.column === sourceRange.source.end.column && sameValueAs(region.value));
    if (atSource.length === 1) return atSource[0];
    if (atSource.length > 1) return null;
    // Escaped text can split into several lexical regions. Only the proven
    // replacement span may supply their combined geometry.
    return { ...session.sourceRegion, value: visible, sourceValue: sourceRange.replacement,
      source: sourceRange.source };
  }
  // With an immutable source anchor, a unique surviving value still cannot
  // prove identity: the edited occurrence may have been changed or deleted.
  if (typeof session.sourceText === 'string') return null;
  const sameKindAndFile = regions.filter((region) =>
    region.kind === session.kind && sameSourceFile(region.source?.file, session.region?.source?.file)
  );
  const sameValue = sameKindAndFile.filter((region) => sameValueAs(region.value));
  // Region ids can be reassigned during resegmentation. Neither an id nor
  // a nearest-line tie proves which identical occurrence owns this session.
  return sameValue.length === 1 ? sameValue[0] : null;
}

function directEditorSnapshotPending(snapshot, session, revision, region) {
  if (region || !session) return null;
  if (session.presentationAnchorPending) return 'anchorPending';
  const sentFromSrcRev = Number(session.sentFromSrcRev ?? session.presentedRev);
  // The native control can be ahead of both the engine and host debounce.
  if (revision <= sentFromSrcRev || directEditorSourceRange(snapshot, session)?.matches === false) return 'localAhead';
  return null;
}

async function stageDirectEditorForOpaqueBatch(batch) {
  const session = directEditor;
  if (!session) return { sessionId: null };
  const snapshot = await batch.snapshotReady;
  if (!snapshot || directEditor?.sessionId !== session.sessionId) return { sessionId: session.sessionId, mapping: null };
  let region = directEditorRegionInSnapshot(snapshot, session);
  const pending = directEditorSnapshotPending(snapshot, session, batch.rev, region);
  if (pending) return { sessionId: session.sessionId, [pending]: true, mapping: null };
  if (!region) {
    return { sessionId: session.sessionId, mapping: null };
  }
  const near = session.printBounds
    ? {
        page: session.pageNumber,
        x: (session.printBounds.left + session.printBounds.right) / 2,
        y: (session.printBounds.top + session.printBounds.bottom) / 2,
      }
    : { page: session.pageNumber };
  let bounds = session.kind === 'text'
    ? await canonicalTextRegionBounds(region, snapshot, batch.id, session.pageNumber)
    : await canonicalSourceBounds(region, null, batch.id, near);
  // (an inline formula SyncTeX cannot place, opened by its ink, is followed
  // into the new generation the same way: resolveOpaqueEditRegion, inlineMathUnderPoint)
  if (!bounds && session.kind === 'math' && session.openedByInk) {
    bounds = await inlineMathBoundsByInk(region, snapshot, batch.id, near);
    if (directEditor?.sessionId !== session.sessionId) return { sessionId: session.sessionId, mapping: null };
  }
  if (!bounds || !Number.isInteger(Number(bounds.page))) {
    return { sessionId: session.sessionId, mapping: null };
  }
  const Coordinator = window.TdomOpaqueEditorCoordinator;
  const canonicalAnchorPoint = Coordinator?.caretAnchorPoint?.(
    bounds,
    session.caretAnchorRatio
  ) ?? {
    x: (Number(bounds.left) + Number(bounds.right)) / 2,
    y: (Number(bounds.top) + Number(bounds.bottom)) / 2,
  };
  return {
    sessionId: session.sessionId,
    mapping: {
      region,
      bounds,
      canonicalAnchorPoint,
      pageNumber: Number(bounds.page),
      id: batch.id,
      rev: batch.rev,
    },
  };
}

function getOpaqueCanonicalBatch(generation) {
  const key = opaqueCanonicalBatchKey(generation);
  // The same generation barrier serves structured pages as well: canonical
  // pagination can move ink between two visible pages in either mode.
  if (!key || generation?.id == null || documentReset.pending ||
      Number(generation.id) !== Number(canonical?.id) ||
      Number(generation.rev) !== Number(canonical?.rev) ||
      Number(generation.rev) !== Number(appliedSrcRev)) return null;
  let batch = opaqueCanonicalBatches.get(key);
  const previous = batch ?? opaqueCanonicalBatches.values().next().value;
  cancelObsoleteOpaqueBatches(key);
  if (!batch) {
    const id = Number(generation.id);
    const rev = Number(generation.rev);
    batch = {
      key,
      id,
      rev,
      documentEpoch: documentReset.adoptedEpoch,
      pageCount: Number(generation.pageCount),
      expected: new Map(),
      sealed: false,
      committing: false,
      snapshot: undefined,
      editorStage: undefined,
      editorStageToken: 0,
      // (the reader's place on the new pages: restageViewAnchor)
      viewStage: undefined,
      viewStageToken: 0,
    };
    opaqueCanonicalBatches.set(key, batch);
    batch.snapshotReady = ensurePresentedDomSnapshot(id, rev).then((snapshot) => {
      if (opaqueCanonicalBatches.get(key) !== batch) return null;
      batch.snapshot = snapshot;
      tryCommitOpaqueCanonicalBatch(batch);
      return snapshot;
    });
    restageOpaqueBatchEditor(batch);
    restageViewAnchor(batch, previous);
  } else if (Number.isInteger(Number(generation.pageCount))) {
    batch.pageCount = Number(generation.pageCount);
  }
  batch.sealed = false;
  queueMicrotask(() => {
    if (opaqueCanonicalBatches.get(key) !== batch) return;
    batch.sealed = true;
    tryCommitOpaqueCanonicalBatch(batch);
  });
  return batch;
}

function restageOpaqueBatchEditor(batch) {
  if (!batch || opaqueCanonicalBatches.get(batch.key) !== batch) return;
  const token = ++batch.editorStageToken;
  batch.editorStage = undefined;
  batch.editorReady = stageDirectEditorForOpaqueBatch(batch).then((stage) => {
    if (opaqueCanonicalBatches.get(batch.key) !== batch || batch.editorStageToken !== token) return null;
    batch.editorStage = stage;
    tryCommitOpaqueCanonicalBatch(batch);
    return stage;
  });
}

// The reader's place on a canonical generation's pages, found before it is
// committed (beside the editor's stage): the canonical's page breaks are not
// the resident ones, so the line the reader had at the centre can stand
// elsewhere on the new pages. Resident ink names its line (a block and a line
// of it, the block's source in the snapshot of this revision); exact pixels
// are asked for it (SyncTeX of the generation on screen). Where that line
// stands on the new generation comes from /synctex/jump. Not in time
// (VIEW_ANCHOR_MAP_MS), or no answer: the commit goes without it.
const VIEW_ANCHOR_MAP_MS = 800;
function restageViewAnchor(batch, previous = null) {
  if (!batch || opaqueCanonicalBatches.get(batch.key) !== batch) return;
  const token = ++batch.viewStageToken;
  const now = viewClock();
  const anchor = captureViewAnchor();
  batch.viewStageAnchor = anchor;
  const same = previous?.documentEpoch === batch.documentEpoch && previous.viewStageAnchor &&
    viewAnchorStageMatches(anchor, { anchor: previous.viewStageAnchor });
  batch.viewStageDeadline = same ? previous.viewStageDeadline : now + VIEW_ANCHOR_MAP_MS;
  batch.viewStage = undefined;
  const settle = (stage) => {
    if (opaqueCanonicalBatches.get(batch.key) !== batch || batch.viewStageToken !== token) return;
    batch.viewStage = stage ?? null;
    tryCommitOpaqueCanonicalBatch(batch);
  };
  // (a page already showing this generation stays as it is: nothing to find)
  const shown = anchor?.kind === 'page' && Number(pageDivs.get(anchor.page)?.dataset.canonPresentedId) === batch.id;
  const wait = batch.viewStageDeadline - now;
  if (!anchor || shown || wait <= 0 || typeof fetch !== 'function' || typeof setTimeout !== 'function') {
    Promise.resolve().then(() => settle(null));
    return;
  }
  const late = new Promise((resolve) => setTimeout(() => resolve(null), wait));
  Promise.race([viewAnchorCanonicalPlace(anchor, batch), late]).catch(() => null).then(settle);
}
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then((response) => (response.ok ? response.json() : null));
// The reader's row (a block and its row, stream.js `li`: not a source line)
// is found on the new generation's pages by its text (exactLinePlace on
// /canonical/glyphs). Its source line was taken as the block's start plus the
// row and asked of SyncTeX: a paragraph's fifth row named another paragraph,
// and the commit moved the paper by it (app measurements: +45 px after the
// first open, a Jump's 29 px second move). A page anchor (no list for the
// pixels on screen) has no row: none is looked for.
async function viewAnchorCanonicalPlace(anchor, batch) {
  if (anchor.kind === 'page') return null;
  const pages = [anchor.page, anchor.page + 1, anchor.page - 1, anchor.page + 2, anchor.page - 2, anchor.page + 3]
    .filter((n) => n >= 1 && n <= batch.pageCount)
    .map((n) => ({ page: n, glyphs: () => canonicalGlyphs(n, batch.id) }));
  return exactLinePlace(anchor, pages);
}
function registerOpaqueCanonicalBatchPage(batch, div, src) {
  if (!batch) return null;
  const pageNumber = Number(div.dataset.page);
  const existing = batch.expected.get(pageNumber);
  if (!existing || existing.src !== src || existing.page !== div) {
    batch.expected.set(pageNumber, { page: div, src, apply: null });
  }
  return { batch, pageNumber, src };
}

function readyOpaqueCanonicalBatchPage(registration, apply) {
  const { batch, pageNumber, src } = registration ?? {};
  if (!batch || opaqueCanonicalBatches.get(batch.key) !== batch) return;
  const entry = batch.expected.get(pageNumber);
  if (!entry || entry.src !== src) return;
  entry.apply = apply;
  tryCommitOpaqueCanonicalBatch(batch);
}

function dropOpaqueCanonicalBatchPage(registration) {
  const { batch, pageNumber, src } = registration ?? {};
  if (!batch || opaqueCanonicalBatches.get(batch.key) !== batch) return;
  const entry = batch.expected.get(pageNumber);
  if (entry?.src === src) batch.expected.delete(pageNumber);
  tryCommitOpaqueCanonicalBatch(batch);
}

function reconcilePageCount(pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 0) return;
  for (const [pageNumber, page] of [...pageDivs]) {
    if (pageNumber <= pageCount) continue;
    canonicalStageObserver?.unobserve(page);
    page.remove();
    pageDivs.delete(pageNumber);
    committedPageSrcs.delete(pageNumber);
    pageEditGroup.delete(pageNumber);
    pageDirtyRev.delete(pageNumber);
    shipPages.delete(pageNumber);
    provisionalStages.delete(pageNumber);
  }
}

function moveDirectEditorToPage(session, targetPage) {
  if (session.element.parentNode === targetPage) return;
  if (typeof targetPage.moveBefore === 'function') {
    // Preserve the live DOM, including native focus/selection and IME.
    // MathLive opts into this move through connectedMoveCallback.
    targetPage.moveBefore(session.element, null);
    return;
  }
  // Older browsers cannot move a connected node atomically. Composition
  // waits at the generation barrier; restore ordinary input synchronously
  // before the deferred blur handler can close the session.
  const focused = session.element.contains(document.activeElement);
  const selection = directSelection(session);
  const mathSelection = session.kind === 'math' && session.control.selection
    ? { ...session.control.selection,
      ranges: session.control.selection.ranges?.map(range => [...range]) } : null;
  const scrollTop = pagesEl.scrollTop, scrollLeft = pagesEl.scrollLeft;
  targetPage.appendChild(session.element);
  if (focused) {
    try { session.control.focus({ preventScroll: true }); } catch { session.control.focus(); }
    session.control.shadowRoot?.querySelector('.ML__keyboard-sink')?.focus({ preventScroll: true });
  }
  if (mathSelection) session.control.selection = mathSelection;
  else if (selection) setDirectSelection(session, selection[0], selection[1]);
  pagesEl.scrollTop = scrollTop;
  pagesEl.scrollLeft = scrollLeft;
}

function directEditorCaretClientBounds(session, point = null) {
  const page = pageDivs.get(session.pageNumber);
  if (!page) return null;
  const caret = point ?? session.lastPaintedCaret ?? session.canonicalAnchorPoint;
  if (!caret) return null;
  const top = Number(caret.top ?? caret.y), bottom = Number(caret.bottom ?? caret.y);
  return clientBoundsForDisplayedPaperBounds({
    left: Number(caret.x), right: Number(caret.x), top, bottom,
  }, page);
}

function captureDirectEditorPageScroll(stage) {
  const session = directEditor;
  if (!session || stage?.sessionId !== session.sessionId || !stage.mapping ||
      stage.mapping.pageNumber === session.pageNumber ||
      !session.element.contains(document.activeElement)) return null;
  const caret = directEditorCaretClientBounds(session) ?? session.element.getBoundingClientRect();
  const viewport = pagesEl.getBoundingClientRect();
  if (![caret.bottom, viewport.top, viewport.bottom].every(Number.isFinite)) return null;
  const margin = Math.min(24, viewport.height / 4);
  return { sessionId: session.sessionId,
    y: Math.max(viewport.top + margin, Math.min(viewport.bottom - margin, caret.bottom)),
    selection: JSON.stringify(directSelection(session)), scrollTop: null, scrollLeft: null };
}

function followDirectEditorPage(session, anchor, point = null) {
  if (!anchor || directEditor !== session || anchor.sessionId !== session.sessionId) return;
  const caret = directEditorCaretClientBounds(session, point);
  if (!caret) return;
  const viewport = pagesEl.getBoundingClientRect();
  const margin = Math.min(24, viewport.height / 4);
  const targetY = Math.max(viewport.top + margin, Math.min(viewport.bottom - margin, anchor.y));
  pagesEl.scrollTop += caret.bottom - targetY;
  if (caret.left < viewport.left + 12) pagesEl.scrollLeft += caret.left - viewport.left - 12;
  else if (caret.right > viewport.right - 12) pagesEl.scrollLeft += caret.right - viewport.right + 12;
  anchor.scrollTop = pagesEl.scrollTop;
  anchor.scrollLeft = pagesEl.scrollLeft;
  // A key's two-frame native-scroll guard may still be pending when the
  // canonical page moves. Preserve the new paper position in that guard.
  if (session.scrollLock) {
    session.scrollLock.top = anchor.scrollTop;
    session.scrollLock.left = anchor.scrollLeft;
  }
}

function applyStagedDirectEditor(stage, batch, scrollAnchor = null) {
  const session = directEditor;
  if (!session || stage?.sessionId !== session.sessionId) return;
  const mapping = stage.mapping;
  const targetPage = mapping ? pageDivs.get(mapping.pageNumber) : null;
  if (!mapping || !targetPage?.isConnected) {
    // Keeping an input surface anchored to an obsolete generation would make
    // its IME/candidate UI point at unrelated printed ink. The edit has
    // already been sent on input, so close only the transient surface.
    closeDirectEditor();
    return;
  }
  moveDirectEditorToPage(session, targetPage);
  session.pageNumber = mapping.pageNumber;
  session.region = mapping.region;
  session.canonicalInput = true;
  session.printBounds = mapping.bounds;
  session.presentedId = batch.id;
  session.presentedRev = batch.rev;
  session.canonicalAnchorPoint = mapping.canonicalAnchorPoint;
  session.anchor = null;
  session.anchorOffset = null;
  repositionDirectEditor();
  if (session.inkLayer && session.inkLayer.parentNode !== targetPage) targetPage.appendChild(session.inkLayer);
  followDirectEditorPage(session, scrollAnchor, mapping.canonicalAnchorPoint);
  const previousMap = session.glyphMap;
  void refreshDirectEditGeometry(session).then(() => {
    // Refine the initial source-box position with the new actual glyph caret.
    // A later user scroll/selection or generation takes precedence.
    if (!scrollAnchor || directEditor !== session || session.presentedId !== batch.id ||
        session.presentedRev !== batch.rev || session.glyphMap === previousMap ||
        !session.element.contains(document.activeElement) ||
        JSON.stringify(directSelection(session)) !== scrollAnchor.selection ||
        Math.abs(pagesEl.scrollTop - scrollAnchor.scrollTop) > 1 ||
        Math.abs(pagesEl.scrollLeft - scrollAnchor.scrollLeft) > 1) return;
    followDirectEditorPage(session, scrollAnchor);
  });
}

function ensureOpaqueBatchEditorTargetPage(batch) {
  const mapping = batch.editorStage?.mapping;
  const mappingMatchesBatch = Number(mapping?.id) === batch.id && Number(mapping?.rev) === batch.rev;
  const pageNumber = mappingMatchesBatch ? Number(mapping?.pageNumber) : NaN;
  const targetPage = Number.isInteger(pageNumber) ? pageDivs.get(pageNumber) : null;
  const targetSrc = Number.isInteger(pageNumber)
    ? `/canonical/${pageNumber}.svg?c=${batch.id}`
    : '';
  const expected = batch.expected.get(pageNumber);
  const expectedActive = expected?.page === targetPage &&
    targetPage?.dataset?.canonWanted === expected?.src;
  const presented = targetPage?.isConnected ? presentedPageState(targetPage) : null;
  const Coordinator = window.TdomOpaqueEditorCoordinator;
  if (typeof Coordinator?.planGenerationBarrier !== 'function') return false;
  const plan = Coordinator.planGenerationBarrier({
    pageNumber,
    pageConnected: targetPage?.isConnected === true,
    targetSrc,
    wantedSrc: targetPage?.dataset?.canonWanted ?? null,
    expectedSrc: expectedActive ? expected.src : null,
    expectedReady: expectedActive && typeof expected.apply === 'function',
    presentedSrc: presented?.src ?? null,
    presentedId: presented?.id ?? null,
    presentedRev: presented?.rev ?? null,
    generationId: batch.id,
    generationRev: batch.rev,
  });
  if (plan.action === 'stage') {
    // The editor may reflow to an offscreen page that lazy canonical staging
    // did not include. Release that exact page explicitly and make it a
    // member of this document-generation batch before moving any input,
    // caret, selection, or candidate UI to its new bounds.
    targetPage.dataset.canonStage = plan.targetSrc;
    updateCanonState(plan.pageNumber);
    return false;
  }
  if (plan.action === 'register') {
    // The page may already have committed this exact immutable generation
    // before the editor's asynchronous SyncTeX mapping resolved. Record a
    // no-op participant so the target is still explicit in this barrier.
    const registration = registerOpaqueCanonicalBatchPage(batch, targetPage, plan.targetSrc);
    const entry = batch.expected.get(registration.pageNumber);
    if (entry?.page === targetPage && entry.src === plan.targetSrc) entry.apply = () => {};
  }
  return plan.action !== 'wait';
}

function tryCommitOpaqueCanonicalBatch(batch) {
  if (directPresentationBlocked()) return;
  if (!batch || batch.committing || !batch.sealed || batch.snapshot === undefined ||
      batch.editorStage === undefined || batch.viewStageToken !== undefined && batch.viewStage === undefined) return;
  if (opaqueCanonicalBatches.get(batch.key) !== batch || documentReset.pending ||
      batch.documentEpoch !== documentReset.adoptedEpoch ||
      Number(canonical?.id) !== batch.id || Number(canonical?.rev) !== batch.rev ||
      batch.rev !== Number(appliedSrcRev) || !batch.snapshot) {
    return;
  }
  const currentEditorSessionId = directEditor?.sessionId ?? null;
  if ((batch.editorStage?.sessionId ?? null) !== currentEditorSessionId) {
    restageOpaqueBatchEditor(batch);
    return;
  }
  if ((batch.editorStage?.localAhead || batch.editorStage?.anchorPending) &&
      directEditor?.sessionId === batch.editorStage.sessionId) return;
  if (batch.editorStage?.mapping &&
      directEditor?.sessionId === batch.editorStage.sessionId &&
      !directEditValuesEqual(directEditor.kind, directEditor.readValue?.(), batch.editorStage.mapping.region?.value)) return;
  if (!ensureOpaqueBatchEditorTargetPage(batch)) return;
  if (!ensureViewAnchorTargetPage(batch)) return;
  const editorTarget = pageDivs.get(Number(batch.editorStage?.mapping?.pageNumber));
  if (directEditor?.imeComposing && editorTarget &&
      directEditor.element.parentNode !== editorTarget && typeof editorTarget.moveBefore !== 'function') return;
  for (const [pageNumber, entry] of [...batch.expected]) {
    if (!entry.page?.isConnected || entry.page.dataset.canonWanted !== entry.src) {
      batch.expected.delete(pageNumber);
      continue;
    }
    if (typeof entry.apply !== 'function') return;
  }
  const editorScrollAnchor = captureDirectEditorPageScroll(batch.editorStage);
  // (the reader's place, put back once the generation is on paper)
  const viewAnchor = captureViewAnchor();
  batch.committing = true;
  if (batch.viewAnchorTarget?.timer != null) clearTimeout(batch.viewAnchorTarget.timer);
  opaqueCanonicalBatches.delete(batch.key);
  // All mutations below are synchronous. The browser cannot paint a frame
  // with page 1 from generation N+1 and page 2 from N, nor with an editor
  // candidate panel still anchored to the old generation.
  for (const [, entry] of [...batch.expected].sort((a, b) => a[0] - b[0])) {
    entry.apply();
  }
  if (directEditor?.committedIme) paintDirectSelection();
  committedCanonicalGeneration = { id: batch.id, rev: batch.rev, epoch: batch.documentEpoch, pageCount: batch.pageCount,
    residentLayoutCompatible: provisionalDisplayLists.size === batch.pageCount && !provisionalPendingLayout.size };
  resyncPendingLayout();
  for (const [page, dl] of provisionalDisplayLists) {
    committedPageSrcs.set(page, displayListSrcs(dl));
    const div = pageDivs.get(page);
    if (div) {
      delete div.dataset.provNativeHold;
      div.paintedResidentPage = committedCanonicalGeneration.residentLayoutCompatible && !usesCanonicalSurface()
        ? { dl, width: geometry.paperwidth, height: geometry.paperheight } : null;
    }
  }
  pageEditGroup.clear();
  provisionalStages.clear();
  provisionalRemovedPages.clear();
  residentPageCountAuthoritative = true;
  for (const [n, rev] of pageDirtyRev) if (rev <= batch.rev) pageDirtyRev.delete(n);
  directEditClickEpoch++;
  opaqueBatchCommitDepth++;
  try {
    for (const pageNumber of pageDivs.keys()) updateCanonState(pageNumber);
  } finally {
    opaqueBatchCommitDepth--;
  }
  // The editor's geometry refresh must see the newly selected exact layer,
  // including when a structured page was provisional before this commit.
  applyStagedDirectEditor(batch.editorStage, batch, editorScrollAnchor);
  // The editor can move from a removed tail page to a surviving page.
  // Transfer it while both ancestors are still connected.
  reconcilePageCount(batch.pageCount);
  restoreCanonicalViewAnchor(viewAnchor, batch.viewStage);
  scheduleViewportWarm();
  updateBadge();
}

// Exact pixels with no SyncTeX of their own (a shipping page) or a single
// page put on paper alone: the reader's line is found on them by its text.
// The rows of the line's glyph runs on its resident page, and the rows of the
// exact page's glyphs (/ship-glyphs, /canonical/glyphs), compared without
// spaces: the row that holds the line's first row (once on the page, else
// nothing is found) down to the one that holds its last.
function residentLineTexts(anchor) {
  const dl = anchor?.boxes?.find((p) => p.page === anchor.page)?.dl;
  if (!dl || anchor.kind === 'page') return [];
  const rows = new Map();
  for (const cmd of dl.commands ?? []) {
    if (cmd.op !== 'glyphs' || cmd.ov || cmd.math || String(cmd.src) !== String(anchor.src) || cmd.line !== anchor.line) continue;
    const y = Math.round(Number(cmd.y));
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(cmd);
  }
  return [...rows].sort((a, b) => a[0] - b[0])
    .map(([, cmds]) => cmds.sort((a, b) => a.x - b.x).map((cmd) => cmd.text ?? '').join('').replace(/\s+/gu, ''));
}
function exactGlyphRows(glyphs) {
  const rows = [];
  for (const g of (glyphs ?? []).filter((g) => g?.text && Number.isFinite(g.top) && Number.isFinite(g.bottom))
    .sort((a, b) => (a.top + a.bottom) - (b.top + b.bottom))) {
    const mid = (g.top + g.bottom) / 2, row = rows.at(-1);
    if (row && mid >= row.top && mid <= row.bottom) {
      row.glyphs.push(g);
      row.top = Math.min(row.top, g.top);
      row.bottom = Math.max(row.bottom, g.bottom);
    } else rows.push({ top: g.top, bottom: g.bottom, glyphs: [g] });
  }
  return rows.map((row) => ({ top: row.top, bottom: row.bottom,
    text: row.glyphs.sort((a, b) => a.left - b.left).map((g) => g.text).join('').replace(/\s+/gu, '') }));
}
// pages: [{ page, glyphs: () => Promise<glyphs> }], nearest first
async function exactLinePlace(anchor, pages) {
  if (anchor.content) {
    const Anchor = globalThis.TdomViewAnchor;
    let best = null;
    for (const { page, glyphs } of pages) {
      const list = Anchor.exactDisplayList('exact:' + page, await glyphs().catch(() => []));
      const row = Anchor.contentPlace(anchor.content, list, anchor.content.y);
      if (row && (!best || row.score > best.score)) {
        best = { anchor, page, baseline: row.y, top: row.y, bottom: row.y, score: row.score };
      }
      if (best?.score >= anchor.content.text.length * 2 + 85) break;
    }
    return best;
  }
  const texts = residentLineTexts(anchor).filter(Boolean);
  if (!texts.length || texts[0].length < 4) return null;
  const head = (text) => text.slice(0, 16);
  for (const { page, glyphs } of pages) {
    const rows = exactGlyphRows(await glyphs().catch(() => null));
    const first = rows.findIndex((row) => row.text.includes(head(texts[0])));
    if (first < 0) continue;
    if (rows.some((row, i) => i > first && row.text.includes(head(texts[0])))) return null;
    let last = first;
    for (const text of texts.slice(1)) {
      const at = rows.findIndex((row, i) => i > last && i <= last + 2 && row.text.includes(head(text)));
      if (at < 0) break;
      last = at;
    }
    return { anchor: { kind: anchor.kind, src: anchor.src, line: anchor.line, page: anchor.page },
      fraction: anchor.fraction, page, top: rows[first].top, bottom: rows[last].bottom };
  }
  return null;
}
// (a shipping wave: the reader's line on its pages, found while they decode;
// a commit before it is found goes without it, tryCommitShipWaveBatch)
function stageShipViewAnchor(batch) {
  const anchor = captureViewAnchor();
  if (!anchor || anchor.kind === 'page' || typeof fetch !== 'function') return;
  const pages = [anchor.page, anchor.page + 1, anchor.page - 1].filter((n) => batch.allPages?.has(n))
    .map((n) => ({ page: n, glyphs: () => displayedShipGlyphs(n, `/ship/${n}.svg?g=${batch.gen}&r=${batch.srcRev}`) }));
  void exactLinePlace(anchor, pages).catch(() => null).then((stage) => {
    if (shipWaveBatch === batch) batch.viewStage = stage;
  });
}

// The page the reader's line goes to is in the same generation commit: the
// reader is never shown that page's old pixels at the line's new place.
function ensureViewAnchorTargetPage(batch) {
  const page = Number(batch.viewStage?.page);
  const div = Number.isInteger(page) ? pageDivs.get(page) : null;
  if (!div?.isConnected || page > batch.pageCount || (pageDirtyRev.get(page) ?? 0) > batch.rev) return true;
  const src = `/canonical/${page}.svg?c=${batch.id}`;
  if (div.dataset.canonPresentedSrc === src) return true;
  const entry = batch.expected.get(page);
  const optional = batch.viewAnchorTarget;
  if (entry?.page === div && entry.src === src) {
    if (optional?.entry !== entry || entry.apply || !optional.expired && viewClock() < batch.viewStageDeadline) return true;
    batch.expected.delete(page);
    delete div.dataset.canonPending;
    div.dataset.canonWanted = '';
    batch.viewStage = null;
    return true;
  }
  const wait = batch.viewStageDeadline - viewClock();
  if (!(wait > 0) || !viewAnchorStageMatches(captureViewAnchor(), batch.viewStage)) return true;
  div.dataset.canonStage = src;
  updateCanonState(page);
  const staged = batch.expected.get(page);
  if (staged?.page !== div || staged.src !== src) return true;
  // An offscreen page staged only for the anchor has the same budget as
  // the lookup. Visible pages already in the batch keep their normal barrier.
  const target = batch.viewAnchorTarget = { entry: staged, timer: null };
  target.timer = setTimeout(() => {
    target.expired = true;
    tryCommitOpaqueCanonicalBatch(batch);
  }, wait);
  return false;
}
function viewAnchorStageMatches(anchor, stage) {
  if (!anchor || stage?.anchor.kind !== anchor.kind || stage.anchor.page !== anchor.page) return false;
  if (Math.abs(stage.anchor.readerScroll - anchor.readerScroll) > 1) return false;
  return anchor.kind === 'page' || stage.anchor.src === anchor.src && stage.anchor.line === anchor.line &&
    stage.anchor.content?.text === anchor.content?.text;
}
// After the generation is on paper: the reader's line where it was (its place
// on the new pages from the stage, when the stage is still the reader's
// line), else the place measured again (a page and a fraction of it).
// (taken just before the commit, in its task: the stage is checked against
// it, a stage taken before a scroll of the reader's names another line)
function restoreCanonicalViewAnchor(anchor, stage) {
  if (!anchor || viewAnchorHeld()) return 0;
  // A source line set across a page break (a long paragraph written as one
  // line) has ink on two pages: the place found for it on the new pages is
  // one of its pieces, not the reader's point of it (seen in the app: a Jump
  // centred the line, the commit moved the paper 455 px to the other piece).
  // Its page and fraction stand instead.
  const split = !Number.isFinite(stage?.baseline) && anchor.kind !== 'page' && anchor.boxes.some((p) => p.page !== anchor.page && p.dl &&
    globalThis.TdomViewAnchor?.lineExtent(p.dl, anchor.src, anchor.line));
  const same = !split && viewAnchorStageMatches(anchor, stage);
  const div = same ? pageDivs.get(stage.page) : null;
  if (div?.isConnected && div.classList.contains('is-final') && div.querySelector('img.canon')) {
    const rect = div.getBoundingClientRect();
    const scale = rect.height / Math.max(1, Number(activePaperGeometry(div).height));
    const top = rect.top + stage.top * scale, bottom = rect.top + stage.bottom * scale;
    const placed = anchor.kind === 'page' ? { ...anchor, kind: 'reading', fraction: stage.fraction } : anchor;
    const baseline = Number.isFinite(stage.baseline) ? rect.top + stage.baseline * scale : undefined;
    return scrollViewAnchor(placed, { top, bottom, baseline });
  }
  // No place found for this line on the new pages (none staged, or staged for
  // a line the reader has since scrolled from): the line itself if it is still
  // on resident ink, else the page and the fraction of it the reader had at
  // the commit (its box measured again: a page of another size keeps the
  // same part of it in view).
  return restoreViewAnchor(anchor, { measure: true });
}

function cancelShipWaveBatch(batch) {
  if (!batch || shipWaveBatch !== batch) return;
  shipWaveBatch = null;
  window.clearTimeout(batch.cutoffTimer);
  for (const page of batch.allPages ?? batch.pages) {
    if (shipPages.get(page)?.batchKey === batch.key) shipPages.delete(page);
  }
  for (const page of batch.pages) {
    const div = pageDivs.get(page);
    if (!div) continue;
    if (div.dataset.canonWanted?.includes(`/ship/${page}.svg?g=${batch.gen}`)) {
      div.dataset.canonWanted = '';
      delete div.dataset.canonPending;
    }
    updateCanonState(page);
  }
}

function registerShipWavePage(batch, div, src) {
  if (!batch || shipWaveBatch !== batch) return null;
  const pageNumber = Number(div.dataset.page);
  if (!batch.pages.has(pageNumber)) return null;
  batch.expected.set(pageNumber, { page: div, src, apply: null });
  return { batch, pageNumber, src };
}

function readyShipWavePage(registration, apply) {
  const { batch, pageNumber, src } = registration ?? {};
  if (!batch || shipWaveBatch !== batch) return;
  const entry = batch.expected.get(pageNumber);
  if (!entry || entry.src !== src) return;
  entry.apply = apply;
  tryCommitShipWaveBatch(batch);
}

function failShipWavePage(registration) {
  if (registration?.batch) cancelShipWaveBatch(registration.batch);
}

function tryCommitShipWaveBatch(batch) {
  if (shippingPresentationBlocked()) {
    cancelShipWaveBatch(batch);
    if (usesCanonicalSurface()) requestCanonicalDisplay({ residentImpossible: true });
    return;
  }
  if (!batch || shipWaveBatch !== batch || batch.documentEpoch !== documentReset.adoptedEpoch ||
      Date.now() >= batch.deadlineAt ||
      Number(appliedSrcRev) !== batch.srcRev || batch.expected.size !== batch.pages.size) {
    if (batch && Date.now() >= batch.deadlineAt) cancelShipWaveBatch(batch);
    return;
  }
  for (const [page, entry] of batch.expected) {
    if (!entry.page?.isConnected || entry.page.dataset.canonWanted !== entry.src ||
        typeof entry.apply !== 'function' || !batch.pages.has(page)) return;
  }
  // All pages were fetched and decoded off-DOM. One synchronous loop makes
  // the affected set visible as a single renderer transaction.
  shipWaveBatch = null;
  window.clearTimeout(batch.cutoffTimer);
  // (the reader's place: its line on the new pages when stageShipViewAnchor found it in time)
  const viewAnchor = captureViewAnchor();
  for (const [, entry] of [...batch.expected].sort((a, b) => a[0] - b[0])) entry.apply();
  restoreCanonicalViewAnchor(viewAnchor, batch.viewStage ?? null);
  directEditClickEpoch++;
  fulfillCanonicalDisplay();
  updateBadge();
  // A DOM mutation is not yet a painted frame.  Report the certificate only
  // after two animation frames so the measurement is a conservative upper
  // bound for what the user actually saw, not merely JavaScript completion.
  const certificate = {
    gen: batch.gen,
    srcRev: batch.srcRev,
    acceptedAt: batch.acceptedAt,
    receivedAt: batch.receivedAt,
    engineElapsedMs: batch.engineElapsedMs,
    pages: [...batch.pages].sort((a, b) => a - b),
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    void fetch('/ship-presented', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...certificate, presentedAt: Date.now() }),
      keepalive: true,
    }).catch(() => {});
  }));
}

/**
 * Decode the next exact page off-DOM and replace the current exact bitmap in
 * one DOM operation. Assigning a new URL to an in-DOM <img> is not an atomic
 * presentation contract: a browser may clear or partially paint it while the
 * SVG is fetched/decoded. The detached candidate makes every painted frame
 * either the complete previous LuaLaTeX page or the complete next one.
 */
function queueCanonicalImageSwap(div, src, paper = null, generation = null) {
  const current = div.querySelector('img.canon');
  const retry = canonicalPageRetries.get(div);
  if (retry && (retry.src !== src || retry.rev !== generation?.rev || current?.dataset.src === src)) {
    clearTimeout(retry.timer);
    canonicalPageRetries.delete(div);
    delete div.dataset.canonRetries;
  }
  const activeShipBatch = generation?.shipWaveKey && shipWaveBatch?.key === generation.shipWaveKey
    ? shipWaveBatch
    : null;
  const shipRegistration = activeShipBatch
    ? registerShipWavePage(activeShipBatch, div, src)
    : null;
  const readOnlyShipping = Boolean(generation?.shipWaveKey);
  const batch = !activeShipBatch && opaqueBatchCommitDepth === 0
    ? getOpaqueCanonicalBatch(generation)
    : null;
  const batchRegistration = batch ? registerOpaqueCanonicalBatchPage(batch, div, src) : null;
  if (current?.dataset.src === src) {
    div.dataset.canonWanted = src;
    delete div.dataset.canonPending;
    delete div.dataset.canonRetries;
    const currentId = generation?.id ?? canonicalIdFromSrc(src);
    const currentRev = generation?.rev;
    if (currentId != null && currentRev != null) {
      void ensurePresentedDomSnapshot(currentId, currentRev).then((snapshot) => {
        if (!snapshot || !div.isConnected || div.dataset.canonWanted !== src ||
            div.querySelector('img.canon') !== current) {
          dropOpaqueCanonicalBatchPage(batchRegistration);
          return;
        }
        if (div.dataset.canonPresentedSrc === src &&
            Number(div.dataset.canonPresentedId) === Number(currentId) &&
            Number(div.dataset.canonPresentedRev) === Number(currentRev)) {
          readyOpaqueCanonicalBatchPage(batchRegistration, () => {});
          return;
        }
        // Hash reuse (A -> B -> A) keeps the exact same PDF/id and advances
        // only the source revision. Promote every exposed page's immutable
        // mapping in the same document-generation commit.
        const promote = () => {
          div.dataset.canonPresentedSrc = src;
          div.dataset.canonPresentedId = String(currentId);
          div.dataset.canonPresentedRev = String(currentRev);
          current.dataset.canonId = String(currentId);
          current.dataset.canonRev = String(currentRev);
          div.classList.remove('awaiting-canonical');
          retireCanonicalAnchorOnPage(div, currentRev);
        };
        if (batchRegistration) readyOpaqueCanonicalBatchPage(batchRegistration, promote);
        else if (Number(currentId) === Number(canonical?.id) && Number(currentRev) === Number(appliedSrcRev)) promote();
      });
    } else if (shipRegistration) {
      readyShipWavePage(shipRegistration, () => {});
    } else if (batchRegistration) {
      readyOpaqueCanonicalBatchPage(batchRegistration, () => {});
    }
    return current;
  }
  div.dataset.canonWanted = src;
  if (div.dataset.canonPending && div.dataset.canonPending !== src) {
    delete div.dataset.canonPending;
  }
  const rootRect = pagesEl.getBoundingClientRect();
  const pageRect = div.getBoundingClientRect();
  const nearViewport = pageRect.bottom >= rootRect.top - rootRect.height * 2 &&
    pageRect.top <= rootRect.bottom + rootRect.height * 2;
  const observerReleased = div.dataset.canonStage === src;
  if (observerReleased) delete div.dataset.canonStage;
  if (!activeShipBatch && !nearViewport && !observerReleased && canonicalStageObserver) {
    dropOpaqueCanonicalBatchPage(batchRegistration);
    canonicalStageObserver.observe(div);
    return current;
  }
  canonicalStageObserver?.unobserve(div);
  // Layout updates still register their visible pages with the generation
  // barrier, but only the retry timer may start the next image request.
  if (!activeShipBatch && canonicalPageRetries.get(div)?.timer) return current;
  if (div.dataset.canonPending === src) return current;
  div.dataset.canonPending = src;

  const candidate = createCanonicalImage(src);
  candidate.sourceClickBoot = serverBootId;
  const rawPresentationId = generation?.id ?? canonicalIdFromSrc(src);
  const rawPresentationRev = generation?.rev;
  const presentationId = rawPresentationId == null ? NaN : Number(rawPresentationId);
  const presentationRev = rawPresentationRev == null ? NaN : Number(rawPresentationRev);
  const requiresSnapshot =
    Number.isFinite(presentationId) && Number.isFinite(presentationRev);
  const snapshotReady = requiresSnapshot
    ? ensurePresentedDomSnapshot(presentationId, presentationRev)
    : Promise.resolve(true);
  const anchorGeometry = (!openingPreview || openingEdited) && typeof fetch === 'function' && globalThis.TdomViewAnchor?.exactDisplayList
    ? (src.startsWith('/ship/') && typeof displayedShipGlyphs === 'function' ? displayedShipGlyphs(Number(div.dataset.page), src)
      : Number.isFinite(presentationId) && typeof canonicalGlyphs === 'function' ? canonicalGlyphs(Number(div.dataset.page), presentationId) : null)
    : null;
  const anchorPrepared = anchorGeometry?.then(glyphs => {
    if (glyphs.length) candidate.viewAnchorDl = globalThis.TdomViewAnchor.exactDisplayList(src, glyphs);
  });
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    if (div.dataset.canonPending === src) delete div.dataset.canonPending;
    if (shipRegistration) {
      failShipWavePage(shipRegistration);
      return;
    }
    // Opaque mode deliberately retains the previous known-good exact page.
    // Structured mode can safely reveal its coherent provisional page.
    if (div.dataset.canonWanted === src && !usesCanonicalSurface() &&
        div.dataset.provPending !== '1' && !div.querySelector('img.canon')) {
      div.classList.remove('is-final', 'is-partial');
    }
    if (div.dataset.canonWanted === src && div.isConnected) {
      const attempts = Number(div.dataset.canonRetries ?? 0) + 1;
      div.dataset.canonRetries = String(attempts);
      const next = { src, rev: generation?.rev, timer: null };
      canonicalPageRetries.set(div, next);
      next.timer = window.setTimeout(() => {
        next.timer = null;
        if (div.isConnected && canonicalPageRetries.get(div) === next &&
            div.dataset.canonWanted === src && !div.dataset.canonPending) {
          updateCanonState(Number(div.dataset.page));
        }
      }, Math.min(3000, 150 * 2 ** Math.min(attempts - 1, 5)));
    }
  };
  const commit = async () => {
    if (settled) return;
    const snapshot = await snapshotReady;
    if (anchorPrepared && typeof setTimeout === 'function') {
      await Promise.race([anchorPrepared, new Promise(resolve => setTimeout(resolve, 300))]);
    }
    if (settled) return;
    if (requiresSnapshot && !snapshot) {
      fail();
      return;
    }
    settled = true;
    if (div.dataset.canonWanted !== src || !div.isConnected) {
      dropOpaqueCanonicalBatchPage(batchRegistration);
      return;
    }
    const applyCandidate = () => {
      const previous = div.querySelector('img.canon');
      if (previous) previous.replaceWith(candidate);
      else div.appendChild(candidate);
      div.classList.remove('awaiting-canonical');
      div.dataset.canonPresentedSrc = src;
      if (Number.isFinite(presentationId)) {
        div.dataset.canonPresentedId = String(presentationId);
        candidate.dataset.canonId = String(presentationId);
      } else {
        delete div.dataset.canonPresentedId;
      }
      if (Number.isFinite(presentationRev)) {
        div.dataset.canonPresentedRev = String(presentationRev);
        candidate.dataset.canonRev = String(presentationRev);
        retireCanonicalAnchorOnPage(div, presentationRev);
      } else {
        delete div.dataset.canonPresentedRev;
      }
      const paperWidth = Number(paper?.w ?? paper?.width);
      const paperHeight = Number(paper?.h ?? paper?.height);
      if (paperWidth > 0 && paperHeight > 0) {
        div.dataset.canonPaperW = String(paperWidth);
        div.dataset.canonPaperH = String(paperHeight);
        div.dataset.canonPaperRotation = String(Number(paper?.rotation) || 0);
        div.style.aspectRatio = `${paperWidth} / ${paperHeight}`;
      }
      if (div.dataset.canonPending === src) delete div.dataset.canonPending;
      delete div.dataset.canonRetries;
    };
    if (shipRegistration) {
      readyShipWavePage(shipRegistration, applyCandidate);
    } else if (batchRegistration) {
      readyOpaqueCanonicalBatchPage(batchRegistration, applyCandidate);
    } else {
      const documentEpoch = documentReset.adoptedEpoch;
      // (the reader's line, when this page's resident ink holds it, found on
      // the page's exact pixels by its text first: at most 300 ms)
      const pageNumber = Number(div.dataset.page);
      const near = captureViewAnchor();
      const viewStage = near && near.kind !== 'page' && near.page === pageNumber && typeof setTimeout === 'function'
        ? await Promise.race([
          exactLinePlace(near, [{ page: pageNumber, glyphs: () => (src.startsWith('/ship/')
            ? displayedShipGlyphs(pageNumber, src) : canonicalGlyphs(pageNumber, presentationId)) }]),
          new Promise((resolve) => setTimeout(() => resolve(null), 300)),
        ]).catch(() => null)
        : null;
      const publish = () => {
        if (documentReset.pending || documentReset.adoptedEpoch !== documentEpoch ||
            !div.isConnected || div.dataset.canonWanted !== src) return;
        if (readOnlyShipping && shippingPresentationBlocked()) {
          if (div.dataset.canonPending === src) delete div.dataset.canonPending;
          requestCanonicalDisplay({ residentImpossible: true });
          return;
        }
        if (directPresentationBlocked()) {
          deferredDirectPresentationCommits.set(div, publish);
          return;
        }
        const viewAnchor = captureViewAnchor();
        applyCandidate();
        directEditClickEpoch++;
        updateCanonState(Number(div.dataset.page));
        restoreCanonicalViewAnchor(viewAnchor, viewStage);
        if (directEditor?.pageNumber === Number(div.dataset.page)) {
          void refreshDirectEditorExactBounds(Number(div.dataset.page));
        }
        updateBadge();
      };
      publish();
    }
  };
  const decodeAndCommit = () => {
    if (settled) return;
    if (typeof candidate.decode === 'function') {
      candidate.decode().then(commit).catch(() => {
        if (candidate.complete && candidate.naturalWidth > 0) commit();
        else fail();
      });
    } else {
      commit();
    }
  };
  candidate.addEventListener('load', decodeAndCommit, { once: true });
  candidate.addEventListener('error', fail, { once: true });
  candidate.src = src;
  if (candidate.complete) queueMicrotask(() => {
    if (candidate.naturalWidth > 0) decodeAndCommit();
    else fail();
  });
  return current;
}

/** A page shell with no provisional content (canonical-only pages). */
function ensureShell(n) {
  let div = pageDivs.get(n);
  if (div) return div;
  div = document.createElement('div');
  div.className = 'page';
  div.classList.add('awaiting-canonical');
  div.dataset.page = n;
  const exactPaper = canonical?.papers?.[n - 1] ?? canonical?.paper;
  const paper = usesCanonicalSurface() && exactPaper
    ? { width: Number(exactPaper.w), height: Number(exactPaper.h) }
    : activePaperGeometry();
  if (paper.width && paper.height) {
    div.style.aspectRatio = `${paper.width} / ${paper.height}`;
  }
  const no = document.createElement('span');
  no.className = 'pageno';
  no.textContent = `page ${n}`;
  div.appendChild(no);
  const after = [...pageDivs.entries()].filter(([k]) => k > n).sort((a, b) => a[0] - b[0])[0];
  pagesEl.insertBefore(div, after ? after[1] : outerAfterEl);
  pageDivs.set(n, div);
  const stage = provisionalStages.get(n);
  if (stage && !usesCanonicalSurface()) updateOwedFurnitureClip(div, null, stage);
  return div;
}

/** Reconcile shells + per-page overlays after a canonical compile lands. */
function syncCanonical() {
  let opaqueBatch = null;
  if (canonical && canonical.id) {
    // Dirty marks are retired with the actual generation commit. Metadata
    // can precede image decode and a newer edit by several event turns.
    // On an empty viewport the opening revision identifies the first PDF
    // belonging to this document. Later page-count changes wait for the
    // current source, so older layouts cannot bring deleted pages back.
    const firstPaper = !pageDivs.size && Number.isSafeInteger(documentStartSrcRev) &&
      canonical.rev >= documentStartSrcRev && !documentReset.pending;
    if (firstPaper || (canonical.rev >= appliedSrcRev && canonical.rev >= lastRemoveRev)) {
      for (let n = 1; n <= canonical.pageCount; n++) {
        if (!pageDivs.has(n)) ensureShell(n);
      }
    }
    if (canonical.rev === appliedSrcRev) {
      opaqueBatch = getOpaqueCanonicalBatch({
        id: canonical.id,
        rev: canonical.rev,
        pageCount: canonical.pageCount,
      });
    }
    if (usesCanonicalSurface()) {
      for (const div of pageDivs.values()) prepareOpaqueShell(div);
    }
  }
  for (const n of pageDivs.keys()) updateCanonState(n);
  if (opaqueBatch && canonical.pageCount > 0 && (opaqueBatch.expected.size === 0 ||
      [...pageDivs.keys()].some(n => n > canonical.pageCount))) {
    // A page-count shrink can leave only an obsolete last page in view. Its
    // replacement has no page number to fetch, so force the nearest surviving
    // page into this generation barrier before removing the obsolete shell.
    const survivor = pageDivs.get(canonical.pageCount) ?? pageDivs.get(1);
    if (survivor) {
      survivor.dataset.canonStage = `/canonical/${Number(survivor.dataset.page)}.svg?c=${canonical.id}`;
      updateCanonState(Number(survivor.dataset.page));
    }
  }
  updateBadge();
}

/**
 * Decide, for one page, whether the canonical overlay wins right now:
 *   final       — canonical covers the page's current source: full overlay
 *   provisional — the page was edited since the last covering compile (or
 *                 no usable canonical exists): the provisional layer owns
 *                 the WHOLE page until a fresh compile lands
 */
function updateCanonState(n) {
  if (directPresentationBlocked()) return;
  const div = pageDivs.get(n);
  if (!div) return;
  // Starting a paper edit pauses new replay waves. Keep the visible PDF
  // until the replacement also covers the source under the user's caret.
  if ((shippingPresentationBlocked() || openingDirectInput?.waitingForShipMap) &&
      presentedShippingPageState(div)?.rev > (canonical?.rev ?? 0)) return;
  const anchorCanonical = div.canonRetired ? null : canonicalAnchorForPage(n);
  if (anchorCanonical) {
    // A canonical compile for an intermediate keystroke may arrive while a
    // newer terminal overlay is already visible. Do not regress to that
    // one-revision-old PDF: retain the immutable base page used to address
    // the cumulative overlay until a canonical covers targetSrcRev.
    const src = `/canonical/${n}.svg?c=${anchorCanonical.baseGeneration}`;
    const paperWidth = Number(div.dataset.canonPaperW) || Number(geometry.paperwidth);
    const paperHeight = Number(div.dataset.canonPaperH) || Number(geometry.paperheight);
    const img = queueCanonicalImageSwap(
      div,
      src,
      { w: paperWidth, h: paperHeight },
      { id: anchorCanonical.baseGeneration, rev: anchorCanonical.baseRev, pageCount: canonical?.pageCount }
    );
    const targetPresented = Boolean(
      img?.dataset.src === src && div.dataset.canonPresentedSrc === src
    );
    div.classList.toggle('is-final', targetPresented);
    div.classList.remove('is-partial', 'phantom');
    if (targetPresented) tryApplyPendingCanonicalAnchor();
    return;
  }
  noteCanonicalGeneration(canonical);
  const canonAvail = canonical && canonical.id && n <= canonical.pageCount;
  const coldFresh = canonAvail && (pageDirtyRev.get(n) ?? 0) <= canonical.rev;
  const ship = shipPages.get(n);
  const shipOk = !!ship && (pageDirtyRev.get(n) ?? 0) <= ship.srcRev;
  // prefer the freshest real-pixels source for THIS page
  const useShip = mode !== 'opaque' && shipOk && (!embeddedHost || !shippingPresentationBlocked()) &&
    (!coldFresh || ship.srcRev > Number(canonical?.rev ?? -1));
  // A page keeps a canonical page on the paper while that page shows the
  // body of the list it has now, staged or committed (canonicalShowsBody): a
  // keystroke elsewhere stages it again, and its owed picture drawn completes
  // its resident list, and neither takes that right paper away from it for
  // the older paper, an empty page or a resident body without what only the
  // page draws (round 11 fix 4: the booklet's writing rules). Its head and
  // foot get their own decision on top (updateOwedFurnitureClip).
  const stage = provisionalStages.get(n);
  // (the list the page has now: staged, or on the paper)
  const current = stage?.dl ?? (div.dataset.prov === '1' ? div.provisionalDl : null);
  // (an exact page whose head or foot is no longer the page's, its bands unknown)
  if (!usesCanonicalSurface()) retireStaleFurniturePaper(div, current, n);
  const kept = !coldFresh && !useShip && canonAvail && !usesCanonicalSurface() ? current : null;
  // (the generation that shows it, its hit map in hand: keptGeneration)
  const keptGen = kept ? keptGeneration(div, n, kept) : null;
  const unchangedFresh = Boolean(keptGen) && canonicalShowsBody(div, kept, keptGen.rev) &&
    furnitureHolds(div, kept, keptGen.rev);
  const fresh = coldFresh || useShip || unchangedFresh;
  const shownGen = unchangedFresh ? keptGen : canonical;
  let img = div.querySelector('img.canon');
  const stageCanonical = canonAvail && (
    usesCanonicalSurface() || coldFresh || unchangedFresh || !img && !div.canonRetired
  );
  let targetSrc = null;
  if (stageCanonical || useShip) {
    const src = useShip
      ? `/ship/${n}.svg?g=${ship.gen}&r=${ship.srcRev}`
      : `/canonical/${n}.svg?c=${shownGen.id}`;
    targetSrc = src;
    img = queueCanonicalImageSwap(
      div,
      src,
      useShip
        ? ship.paper ?? { w: geometry.paperwidth, h: geometry.paperheight }
        : shownGen.papers?.[n - 1] ?? shownGen.paper,
      useShip
        ? {
            id: null,
            rev: ship.srcRev,
            pageCount: canonical?.pageCount,
            shipWaveKey: ship.batchKey,
          }
        : { id: shownGen.id, rev: shownGen.rev, pageCount: shownGen.pageCount }
    );
  } else {
    div.dataset.canonWanted = '';
    delete div.dataset.canonPending;
  }

  // Binary per page: canonical pixels only when a compile of the CURRENT
  // source covers this page; otherwise the provisional layer owns the whole
  // page. A retained image can have its withdrawn bands clipped while a
  // provisional body picture is still pending.
  const targetPresented = Boolean(
    targetSrc && img?.dataset.src === targetSrc && div.dataset.canonPresentedSrc === targetSrc
  );
  const retainingCanonical = img && div.classList.contains('is-final') && (
    div.dataset.provPending === '1' || div.dataset.provNativeHold === '1' || provisionalStages.has(n) || targetSrc ||
      canonical?.id && n > canonical.pageCount
  );
  const emptyCanonicalFallback = !fresh &&
    emptyStructuredCanonicalFallback(n, div, img);
  const state = usesCanonicalSurface()
    ? (img ? 'final' : 'provisional')
    : ((fresh && targetPresented || retainingCanonical || emptyCanonicalFallback)
        ? 'final' : 'provisional');
  const previousFinal = div.classList.contains('is-final');
  div.classList.toggle('is-final', state === 'final');
  // Bind the list to the mounted image. A wanted image that is still
  // decoding cannot describe the paper that's already on screen.
  if (state === 'final' && fresh && targetPresented) {
    const rev = useShip ? ship.srcRev : shownGen.rev;
    const list = stage?.dl ?? provisionalDisplayLists.get(n);
    const committed = committedCanonicalGeneration;
    // On boot a list can arrive before its shell. The accepted revision's
    // resident layout supplies provenance even without per-shell history.
    const acceptedLayout = !useShip && !usesCanonicalSurface() && committed?.residentLayoutCompatible &&
      committed.epoch === documentReset.adoptedEpoch && committed.id === canonical.id && committed.rev === rev;
    if (div.exactListSrc !== targetSrc || div.exactListRev !== rev) {
      div.exactListDl = null;
      div.exactListGeometry = null;
      div.exactFurniture = null;
    }
    const own = div.listHistory?.get(rev);
    if (own && !useShip && !usesCanonicalSurface()) {
      div.exactListDl = own.dl;
      div.exactListGeometry = own.geometry;
    } else if (!div.exactListDl && list && (acceptedLayout && appliedSrcRev === rev ||
        coldFresh && stage?.sourceRev === rev || canonicalShowsList(div, list, rev) && div.listContent.rev <= rev)) {
      div.exactListDl = list;
      div.exactListGeometry = geometry;
    } else if (!div.exactListDl && Number(div.dataset.provRev) === rev) {
      div.exactListDl = div.provisionalDl;
      div.exactListGeometry = geometry;
    }
    div.exactListSrc = targetSrc;
    div.exactListRev = rev;
    div.canonRetired = false;
  }
  // An exact page may accept a list without mounting its resident body.
  // Its late cuts still describe the pixels already on that image.
  const latest = usesCanonicalSurface() ? null : provisionalDisplayLists.get(n) ?? current;
  const changedSlots = updateOwedFurnitureClip(div, img, stage ?? (latest
    ? { dl: latest, sourceRev: latest === current ? Number(div.dataset.provRev) : appliedSrcRev } : null));
  const keepCanonicalFallback = retainCanonicalFallbackMarker({
    newlyEligible: emptyCanonicalFallback || unchangedFresh && targetPresented &&
      (changedSlots || Boolean(stage) && owesExactInkAnywhere(stage.dl)),
    previouslyMarked: div.dataset.canonFallback === '1',
    canonicalSurface: usesCanonicalSurface(),
    final: state === 'final',
    freshTargetPresented: fresh && targetPresented,
  });
  if (keepCanonicalFallback) div.dataset.canonFallback = '1';
  else delete div.dataset.canonFallback;
  // (a page whose paper went waits hidden, its box kept, until a canonical page shows)
  if (div.provisionalDropped) div.classList.toggle('awaiting-canonical', state !== 'final');
  if (directEditor?.pageNumber === n && previousFinal !== (state === 'final')) {
    requestAnimationFrame(() => { void refreshDirectEditGeometry(); });
  }
  div.classList.remove('is-partial');
  // Page-count metadata alone cannot retire ink. The canonical generation
  // barrier removes surplus pages only after its surviving pages commit.
  div.classList.remove('phantom');
}

function updateBadge() {
  if (!docStateEl) return;
  const err = canonical?.error;
  const parts = [];
  let cls = 'state-preview';
  let text;
  if (usesCanonicalSurface()) {
    const viewport = pagesEl.getBoundingClientRect();
    const visible = [...pageDivs.values()].filter((page) => {
      const rect = page.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const required = visible.length ? visible : [...pageDivs.values()].slice(0, 1);
    const exactPresented = required.length > 0 && required.every((page) => {
      const state = presentedPageState(page);
      return state?.id === Number(canonical?.id) && state?.rev === Number(appliedSrcRev);
    });
    if (canonical?.id && !canonical.inFlight && !err && canonical.rev >= appliedSrcRev && exactPresented) {
      cls = 'state-exact';
      text = 'LuaLaTeX 直描画';
    } else {
      text = err ? 'TeXエラー（前回の表示を保持）' : 'コンパイル中';
      if (err) cls = 'state-error';
    }
    parts.push(text);
  } else if (err && canonical.errorRev >= appliedSrcRev) {
    cls = 'state-error';
    parts.push('TeXエラー（検証コンパイル失敗）');
  } else if (canonical?.id && canonical.rev >= appliedSrcRev && pageDirtyRev.size === 0 && !canonical.inFlight) {
    cls = 'state-exact';
    parts.push('LuaLaTeX 出力と一致');
  } else {
    parts.push('照合待ち');
  }
  docStateEl.className = cls;
  docStateEl.textContent = parts.join(' ');
  docStateEl.title =
    (modeReasons?.length ? `opaque理由: ${modeReasons.join('; ')}\n` : '') + (err ? `TeX: ${err}` : '');
}

// ---------------------------------------------------------------- editing

function diffText(oldStr, newStr) {
  if (oldStr === newStr) return null;
  let start = 0;
  const maxStart = Math.min(oldStr.length, newStr.length);
  while (start < maxStart && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { start, end: endOld, text: newStr.slice(start, endNew) };
}

function scheduleSync() {
  scheduleHighlight();
  pendingEditorInputAtEpochMs = Date.now();
  // Short debounce: the resident engine absorbs keystrokes in
  // milliseconds, but one POST per keystroke is still one full engine
  // update per keystroke — 80ms coalesces a fast burst into a single
  // diff without being perceptible (the serialized `sending` chain
  // additionally coalesces whatever lands while a POST is in flight).
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushSync, 80);
}

function flushSync() {
  sending = sending.then(async () => {
    const current = editor.value;
    const d = diffText(serverText, current);
    if (!d) return;
    const clientEditAtEpochMs = pendingEditorInputAtEpochMs;
    const t0 = performance.now();
    inFlight = true;
    noteEditStart(); // status pill: computing, instantly
    try {
      const res = await fetch('/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // rev: optimistic-concurrency token — the server 409s instead of
        // silently applying our offsets to a source that moved under us
        body: JSON.stringify({ ...d, rev: appliedSrcRev, clientEditAtEpochMs }),
      });
      if (res.status === 409) {
        // the source moved (another client/tab): resync our base text and
        // let the next flush recompute the diff against the fresh source
        const doc = await fetch('/doc').then((r) => r.json());
        serverText = doc.source;
        if (document.activeElement !== editor) {
          editor.value = doc.source;
          syncEditorHighlight();
        }
        flushSync();
        return;
      }
      const report = await res.json();
      if (report.error) throw new Error(report.error);
      serverText = current;
      if (pendingEditorInputAtEpochMs === clientEditAtEpochMs) pendingEditorInputAtEpochMs = null;
      const rtt = performance.now() - t0;
      if (Number.isInteger(Number(report.srcRev))) {
        canonicalAnchorEditStartedAt.set(Number(report.srcRev), t0);
        for (const rev of canonicalAnchorEditStartedAt.keys()) {
          if (rev < Number(report.srcRev) - 4) canonicalAnchorEditStartedAt.delete(rev);
        }
      }
      applyReport(report);
      renderInspector(report, rtt);
      const engineMs =
        report.mode === 'opaque'
          ? `opaque（canonical 再コンパイル待ち）/ ${fmtUs(report.stats.totalUs)}`
          : `組版 ${report.stats.typesetMs ?? 0} ms / 全体 ${fmtUs(report.stats.totalUs)}`;
      statusEl.textContent =
        `update #${report.rev} / ${engineMs} / 往復 ${rtt.toFixed(0)} ms` +
        (report.dirtyPages.length
          ? ` / 再描画 page ${report.dirtyPages.join(', ')}`
          : report.mode === 'opaque'
            ? ''
            : ' / 表示差分なし');
    } catch (err) {
      statusEl.textContent = `エラー: ${err.message}`;
    } finally {
      inFlight = false;
      noteEditEnd();
    }
  });
}

// ------------------------------------------------------- liveness pill
//
// One glanceable answer to "is it computing, or is the server dead?".
// Sources: the client's own in-flight /edit POST (instant), plus a 1s poll
// of /status (cheap, engine-queue-free — a hung or killed server simply
// stops answering it). While the engine grinds, the pill shows the phase
// and elapsed seconds; a full rebuild shows block progress.

const pillEl = document.getElementById('livestatus');
let pillEdits = 0;
let pillBusySince = 0;

function pill(state, text) {
  if (!pillEl) return;
  pillEl.className = 'pill ' + state;
  pillEl.textContent = text;
}

function noteEditStart() {
  pillEdits++;
  if (!pillBusySince) pillBusySince = Date.now();
  pill('busy', '組版中');
}

function noteEditEnd() {
  pillEdits = Math.max(0, pillEdits - 1);
  pollStatus();
}

async function pollStatus() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('/status', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    lastEngineStatus = s;
    if (typeof s.boot === 'string') serverBootId = s.boot;
    applyOuterPaper(s.outer ?? null);
    const statusDocumentEpoch = Number(s.documentEpoch);
    const mutationsPending = s.queued == null ? s.busy : s.queued > 0;
    if (documentReset.adoptedEpoch > 0 &&
        Number.isInteger(statusDocumentEpoch) && statusDocumentEpoch > documentReset.adoptedEpoch) {
      beginClientDocumentReset(statusDocumentEpoch);
      if (!mutationsPending) completeClientDocumentReset(statusDocumentEpoch);
    } else if (documentReset.pending?.epoch === statusDocumentEpoch && !mutationsPending) {
      completeClientDocumentReset(statusDocumentEpoch);
    }
    if (pillEdits > 0 || s.busy) {
      if (!pillBusySince) pillBusySince = Date.now() - (s.busyMs || 0);
      const secs = Math.floor((Date.now() - pillBusySince) / 1000);
      const prog =
        s.progress?.phase === 'typeset' && s.progress.total
          ? ` ${s.progress.at}/${s.progress.total} ブロック`
          : s.progress?.phase === 'boot'
            ? '（プリアンブル再構築）'
            : '';
      pill('busy', `組版中${prog}${secs >= 2 ? ` ${secs}秒` : ''}`);
    } else if (s.canonical?.inFlight) {
      pillBusySince = 0;
      pill('busy', 'canonical コンパイル中');
    } else {
      pillBusySince = 0;
      pill('ok', '待機中');
    }
  } catch {
    lastEngineStatus = { up: false };
    pillBusySince = 0;
    pill('down', 'サーバー応答なし');
  }
}

setInterval(pollStatus, 1000);
pollStatus();

editor.addEventListener('compositionstart', () => (composing = true));
editor.addEventListener('compositionend', () => {
  composing = false;
  scheduleHighlight();
  scheduleSync();
});
editor.addEventListener('input', () => {
  scheduleHighlight();
  if (!composing) scheduleSync();
});
// scroll only moves the overlay — it must never re-render the highlight
editor.addEventListener('scroll', syncHighlightScroll);

// Embedded: a place the reader marks on the page — a text selection in the
// structured view, or a right-click anywhere — goes to the host with its
// source position and its rectangle on screen, so the host can put that spot
// in front of its assistant.  Nothing here changes the document.
let placeOffered = false;
const postPlaceToHost = async (kind, ev, page, text, rect) => {
  if (!embeddedHost || !page) return;
  const clickEpoch = directEditClickEpoch;
  const pageNumber = Number(page.dataset.page);
  let location = null;
  const src = srcOf(ev.target);
  if (src) {
    try {
      const dom = await fetch('/dom').then((r) => r.json());
      const block = dom.blocks.find((b) => b.id === src);
      if (block) location = block.source;
    } catch {
      location = null;
    }
  }
  if (!location) location = await syncLocationForClick(ev, page);
  if (kind === 'selection' && (directEditor || clickEpoch !== directEditClickEpoch)) return;
  placeOffered = true;
  window.parent.postMessage({
    source: 'tdom-embed',
    activationId: embedActivationId,
    documentEpoch: documentReset.adoptedEpoch,
    action: 'place',
    kind,
    pageNumber: Number.isFinite(pageNumber) ? pageNumber : null,
    text,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    file: location?.file ?? null,
    line: location?.start?.line ?? location?.line ?? null,
    column: location?.start?.column ?? location?.column ?? null,
  }, '*');
};
const clearPlaceForHost = () => {
  if (!embeddedHost || !placeOffered) return;
  placeOffered = false;
  window.parent.postMessage({
    source: 'tdom-embed',
    activationId: embedActivationId,
    documentEpoch: documentReset.adoptedEpoch,
    action: 'place',
    kind: 'clear',
  }, '*');
};
pagesEl.addEventListener('mouseup', (ev) => {
  if (!embeddedHost || ev.button !== 0 || ev.metaKey || ev.ctrlKey) return;
  if (ev.target?.closest?.('.tdom-direct-editor')) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const text = selection.toString().replace(/\s+/g, ' ').trim();
  if (!text) return;
  const range = selection.getRangeAt(0);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
  if (rects.length === 0) return;
  const startNode = range.startContainer instanceof Element
    ? range.startContainer
    : range.startContainer?.parentElement;
  const first = rects[0];
  const last = rects[rects.length - 1];
  const at = { target: startNode, clientX: first.left + 1, clientY: first.top + first.height / 2 };
  const page = pageAtClientPoint(at, startNode);
  void postPlaceToHost('selection', at, page, text,
    { left: first.left, top: first.top, right: last.right, bottom: last.bottom });
});
document.addEventListener('selectionchange', () => {
  if (!embeddedHost) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) clearPlaceForHost();
});
pagesEl.addEventListener('contextmenu', (ev) => {
  if (!embeddedHost) return;
  if (ev.target?.closest?.('.tdom-direct-editor')) return;
  const page = pageAtClientPoint(ev, ev.target);
  if (!page) return;
  ev.preventDefault();
  void postPlaceToHost('point', ev, page, '',
    { left: ev.clientX, top: ev.clientY, right: ev.clientX, bottom: ev.clientY });
});
document.addEventListener('scroll', () => clearPlaceForHost(), true);
// Copying from the paper: the selected glyph runs in their order, joined on a
// baseline (a space where the runs leave a word's gap), a line break where the
// baseline changes. The browser put every run of the SVG on its own line: a
// Japanese paragraph, set a character a run, came out a character a line.
document.addEventListener('copy', (event) => {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !event.clipboardData) return;
  const range = selection.getRangeAt(0);
  if (!pagesEl.contains(range.commonAncestorContainer)) return;
  const scope = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const runs = [...(scope?.closest?.('.page') ?? pagesEl).querySelectorAll('svg text')]
    .filter((node) => !node.hasAttribute('data-ov') && range.intersectsNode(node));
  if (!runs.length) return;
  let text = '', last = null;
  for (const node of runs) {
    let value = node.textContent ?? '';
    if (node.contains(range.endContainer)) value = value.slice(0, range.endContainer === node.firstChild ? range.endOffset : value.length);
    if (node.contains(range.startContainer)) value = value.slice(range.startContainer === node.firstChild ? range.startOffset : 0);
    const run = { y: Number(node.getAttribute('y')), x: Number(node.getAttribute('x')),
      w: Number(node.getAttribute('data-width')) || 0, size: Number(node.getAttribute('font-size')) || 10 };
    if (last) {
      if (Math.abs(run.y - last.y) > run.size * 0.5 || node.closest('.page') !== last.page) text += '\n';
      else if (run.x - (last.x + last.w) > run.size * 0.2) text += ' ';
    }
    text += value;
    last = { ...run, page: node.closest('.page') };
  }
  event.clipboardData.setData('text/plain', text);
  event.preventDefault();
});

// Preview interaction: Cmd/Ctrl+click mirrors the static PDF viewer's
// SyncTeX gesture.  In embedded mode the real editor owns navigation; the
// standalone TDOM workbench keeps Alt+click for its internal textarea.
let sourceClickSeq = 0;
pagesEl.addEventListener('click', async (ev) => {
  if (embeddedHost ? !(ev.metaKey || ev.ctrlKey) : !ev.altKey) return;
  if (ev.target?.closest?.('.tdom-direct-editor')) return;
  directEditClickEpoch++;
  const clickSeq = ++sourceClickSeq;
  const clickedPage = pageAtClientPoint(ev, ev.target);
  if (!clickedPage) return;
  const exact = clickedPage.classList.contains('is-final');
  const presented = exact ? presentedPageState(clickedPage, false) ?? presentedShippingPageState(clickedPage) : null;
  const paintedPoint = paperPointForClick(ev, clickedPage);
  const covers = ({ left, top, right, bottom }) => paintedPoint &&
    left <= paintedPoint.x && paintedPoint.x <= right && top <= paintedPoint.y && paintedPoint.y <= bottom;
  const overlay = exact ? clickedPage.querySelector('svg.tdom-canonical-delta')?.sourceClickPaint : null;
  const delta = overlay?.masks.some(covers) ? overlay : null;
  const clipped = presented?.image?.sourceClickCuts?.some(([left, top, right, bottom]) =>
    covers({ left, top, right, bottom }));
  const paintedList = delta || (exact
    ? clickedPage.exactListSrc === presented?.src && clickedPage.exactListRev === presented?.rev && clickedPage.exactListDl
    : clickedPage.provisionalDl);
  const heldChunk = !exact && paintedPoint && paintedList?.commands?.find(cmd =>
    cmd.op === 'chunk' && (cmd.held || cmd.st) && chunkInkOpenings(cmd).some(([left, top, right, bottom]) =>
      covers({ left: cmd.x + left, top: cmd.y + top, right: cmd.x + right, bottom: cmd.y + bottom })));
  const snapshot = exact ? presented?.snapshot : clickedPage.provisionalSnapshot;
  const epoch = documentReset.adoptedEpoch;
  const boot = presented?.image?.sourceClickBoot ?? serverBootId;
  // A later image swap does not change which paper this gesture addressed.
  const stillCurrent = () => clickSeq === sourceClickSeq && epoch === documentReset.adoptedEpoch && !documentReset.pending;
  const src = exact ? null : heldChunk?.src ?? srcOf(ev.target);
  ev.preventDefault();
  ev.stopPropagation();
  let location = null;
  let block = null;
  if (src && snapshot) {
    block = snapshot.blocks.find((b) => b.id === src);
    if (block) {
      location = block.source;
      // Preserve the current resident page's row-based navigation.
      const relative = Number(ev.target?.closest?.('[data-line]')?.dataset?.line);
      const start = Number(block.source?.start?.line);
      const end = Number(block.source?.end?.line);
      if (!heldChunk && Number.isInteger(relative) && relative >= 0 && Number.isFinite(start) &&
          (!Number.isFinite(end) || start + relative <= end)) {
        location = { file: block.source.file, line: start + relative, column: 1 };
      }
    }
    if (location && Number(snapshot.srcRev) < appliedSrcRev) {
      location = await snapshotLocationForInk(snapshot, block, heldChunk ? null : ev, stillCurrent);
    }
  }
  if (!location?.file) location = null;
  if (!location) {
    if (presented?.id && !delta && !clipped) {
      location = await syncLocationForClick(ev, clickedPage, presented, presented?.rev, paintedPoint);
      if (location && !location.unmapped && (location.mappedSourceRev ?? presented.rev) < appliedSrcRev && stillCurrent()) {
        location = await syncLocationForClick(ev, clickedPage, presented, presented.rev, paintedPoint);
      }
      if (location?.unmapped || location && (location.mappedSourceRev ?? presented.rev) < appliedSrcRev) location = null;
    }
    if (!location && stillCurrent()) {
      location = await currentLocationForPaperClick(delta ? await delta.snapshot : snapshot,
        paintedList, paintedPoint, stillCurrent, delta ? ev : null);
    }
    if (!location && stillCurrent()) location = await sourceClickFallback(epoch, boot);
  }
  if (!location || !stillCurrent()) return;
  if (embeddedHost) {
    window.parent.postMessage({
      source: 'tdom-embed',
      activationId: embedActivationId,
      documentEpoch: documentReset.adoptedEpoch,
      action: 'source',
      file: location.file,
      line: location.start?.line ?? location.line,
      column: location.start?.column ?? location.column ?? 1,
    }, '*');
    return;
  }
  const currentBlockStart = snapshot?.srcRev === appliedSrcRev ? block?.source?.start : null;
  const start = currentBlockStart ?? location.start ?? location;
  const offset = lineColToOffset(editor.value, start.line, start.column ?? 1);
  editor.focus();
  editor.setSelectionRange(offset, offset);
  const lineTop = editor.value.slice(0, offset).split('\n').length - 1;
  editor.scrollTop = Math.max(0, lineTop * 19 - editor.clientHeight / 2);
  if (block) statusEl.textContent = `ソース対応 ${src} → main.tex:${start.line} (${block.type})`;
});

function latexEscapeText(value) {
  return String(value ?? '').replace(/[\\{}$&#_%^~]/g, (char) => ({
    '\\': '\\textbackslash{}',
    '{': '\\{',
    '}': '\\}',
    '$': '\\$',
    '&': '\\&',
    '#': '\\#',
    '_': '\\_',
    '%': '\\%',
    '^': '\\^{}',
    '~': '\\~{}',
  })[char]);
}

function mathRowAt(value, limit) {
  let row = 0;
  for (let i = 0; i + 1 < Math.min(value.length, limit); i++) {
    if (value[i] !== '\\' || value[i + 1] !== '\\') continue;
    let preceding = 0;
    for (let j = i - 1; j >= 0 && value[j] === '\\'; j--) preceding++;
    if ((preceding & 1) === 0) {
      row++;
      i++;
    }
  }
  return row;
}

function mathRowEnd(value, wantedRow) {
  let row = 0;
  for (let i = 0; i + 1 < value.length; i++) {
    if (value[i] !== '\\' || value[i + 1] !== '\\') continue;
    let preceding = 0;
    for (let j = i - 1; j >= 0 && value[j] === '\\'; j--) preceding++;
    if ((preceding & 1) !== 0) continue;
    if (row === wantedRow) return i;
    row++;
    i++;
  }
  return value.length;
}

function preserveMathAuxCommands(baseValue, nextValue) {
  const base = window.TdomMathMacros.withoutComments(String(baseValue ?? ''));
  let next = String(nextValue ?? '');
  const auxiliaries = [];
  const pattern = /(\\(?:label\{(?:[^{}]|\\.)*\}|(?:notag|nonumber)\b))|\\(?:[A-Za-z@]+|[\s\S])|%[^\n]*/g;
  let match;
  while ((match = pattern.exec(base))) {
    if (match[1] && !next.includes(match[0])) {
      auxiliaries.push({ command: match[0], row: mathRowAt(base, match.index) });
    }
  }
  // Insert from the final row backwards so earlier offsets stay stable.
  auxiliaries.sort((a, b) => b.row - a.row);
  for (const auxiliary of auxiliaries) {
    const offset = mathRowEnd(next, auxiliary.row);
    next = next.slice(0, offset) + auxiliary.command + next.slice(offset);
  }
  return next;
}

function mathSourceTokens(value, comments = null) {
  const text = String(value ?? ''), tokens = [], textModes = [false];
  for (const match of text.matchAll(/\\(?:[A-Za-z@]+|[\s\S])|%[^\n]*(?:\n[ \t]*)?|[\s\S]/gu)) {
    const token = match[0], at = match.index;
    if (token[0] === '%') {
      comments?.push({ tokenIndex: tokens.length, index: at, text: token });
      continue;
    }
    if (token === '{') textModes.push(textModes.at(-1) || /\\(?:text(?:normal|rm|sf|tt|bf|it|sl|sc|up)?|operatorname|begin|end)\*?\s*$/.test(text.slice(0, at)));
    if (!/\s/u.test(token) || token.startsWith('\\') || textModes.at(-1)) tokens.push(match);
    if (token === '}' && textModes.length > 1) textModes.pop();
  }
  return tokens;
}

function directEditValuesEqual(kind, a, b) {
  if (kind !== 'math') return String(a ?? '') === String(b ?? '');
  const printedTokens = value => {
    const tokens = mathSourceTokens(value).map(token => token[0]), printed = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] === '\\placeholder' && tokens[index + 1] === '{' && tokens[index + 2] === '}') index += 2;
      else printed.push(tokens[index]);
    }
    return printed;
  };
  return JSON.stringify(printedTokens(a)) === JSON.stringify(printedTokens(b));
}

// If MathLive renames a command or normalizes braces, the original tokens
// may no longer provide splice offsets. Keep comments at token boundaries so
// they cannot split a new control word or swallow the unchanged suffix.
function restoreMathComments(next, original, after, comments) {
  if (!comments.length) return next;
  let head = 0, tail = 0;
  while (head < original.length && head < after.length && original[head][0] === after[head][0]) head++;
  while (tail < original.length - head && tail < after.length - head &&
      original[original.length - tail - 1][0] === after[after.length - tail - 1][0]) tail++;
  let result = '', cursor = 0;
  for (const note of comments) {
    const slot = note.tokenIndex <= head ? note.tokenIndex :
      note.tokenIndex >= original.length - tail ? after.length - (original.length - note.tokenIndex) : after.length - tail;
    const at = slot ? after[slot - 1].index + after[slot - 1][0].length : 0;
    result += next.slice(cursor, at) + note.text;
    if (at < next.length && !note.text.includes('\n')) result += '\n';
    cursor = at;
  }
  return result + next.slice(cursor);
}

// Keep source line breaks/spacing when MathLive only changes a local span.
// Its initial serialization often removes all display-environment newlines;
// sending that normalization as an edit invalidates unrelated source lines.
function preserveMathSourceLayout(raw, previous, next) {
  raw = String(raw ?? ''); previous = String(previous ?? ''); next = String(next ?? '');
  const comments = [], before = mathSourceTokens(previous), after = mathSourceTokens(next), original = mathSourceTokens(raw, comments);
  // This splice needs identical source tokens, including virtual markers.
  // Printed-value equality intentionally ignores empty MathLive placeholders.
  if (JSON.stringify(before.map(token => token[0])) !== JSON.stringify(original.map(token => token[0]))) return restoreMathComments(next, original, after, comments);
  if (previous === next) return raw;
  let start = 0, end = before.length, newEnd = after.length;
  while (start < end && start < newEnd && before[start][0] === after[start][0]) start++;
  while (end > start && newEnd > start && before[end - 1][0] === after[newEnd - 1][0]) { end--; newEnd--; }
  // MathLive's first mutation also normalizes cached verbatim whitespace.
  // Compare painted tokens so that normalization is not a source edit.
  if (start === end && start === newEnd) return raw;
  const rawStart = end === start && start > 0
    ? original[start - 1].index + original[start - 1][0].length
    : original[start]?.index ?? (original.at(-1)?.index ?? -1) + (original.at(-1)?.[0].length ?? 1);
  const rawEnd = end > start ? original[end - 1].index + original[end - 1][0].length : rawStart;
  let inserted = newEnd > start
    ? next.slice(after[start].index, after[newEnd - 1].index + after[newEnd - 1][0].length) : '';
  const prefix = raw.slice(0, rawStart), suffix = raw.slice(rawEnd);
  if (inserted && start > 0 && /\\[A-Za-z]+$/.test(prefix) && /^[A-Za-z]/.test(inserted) &&
      /\s/u.test(next.slice(after[start - 1].index + after[start - 1][0].length, after[start].index))) inserted = ' ' + inserted;
  if (inserted && newEnd < after.length && /\\[A-Za-z]+$/.test(inserted) && /^[A-Za-z]/.test(suffix) &&
      /\s/u.test(next.slice(after[newEnd - 1].index + after[newEnd - 1][0].length, after[newEnd].index))) inserted += ' ';
  if (!inserted && start > 0 && start < after.length && /\\[A-Za-z]+$/.test(prefix) && /^[A-Za-z]/.test(suffix) &&
      /\s/u.test(next.slice(after[start - 1].index + after[start - 1][0].length, after[start].index))) inserted = ' ';
  const inside = comments.filter(note => note.index >= rawStart && note.index < rawEnd);
  const notes = inside.map(note => note.text).join('');
  // A swallowed end-of-line followed by the old closing line can become a
  // blank paragraph inside display math. Keep the replacement on that line.
  const beforeClosingLine = notes && /^[ \t]*[\r\n]/.test(suffix);
  const candidate = beforeClosingLine && inserted
    ? prefix + notes + inserted + suffix
    : prefix + inserted + notes + (beforeClosingLine ? suffix.replace(/^[ \t]*\r?\n/, '') : suffix);
  // A structural edit can pair unrelated braces as a common suffix, moving
  // harmless outer whitespace into an environment name or text argument.
  // Preserve formatting only when the resulting source still tokenizes as
  // the requested value; otherwise use the unchanged MathLive serialization.
  return JSON.stringify(mathSourceTokens(candidate).map(token => token[0])) ===
    JSON.stringify(after.map(token => token[0])) ? candidate : restoreMathComments(next, original, after, comments);
}

function shouldWrapAligned(value) {
  const text = String(value ?? '');
  if (!text || text.includes('\\begin{') || text.includes('\\end{')) return false;
  let slashRun = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\') {
      slashRun++;
      if (slashRun === 2) return true;
      continue;
    }
    if (char === '&' && (slashRun & 1) === 0) return true;
    slashRun = 0;
  }
  return false;
}

function wrapAligned(value) {
  return '\\begin{aligned}\n' + value + '\n\\end{aligned}';
}

function unwrapAligned(value) {
  const text = String(value ?? '');
  const begin = '\\begin{aligned}';
  const end = '\\end{aligned}';
  const start = text.indexOf(begin);
  const finish = text.lastIndexOf(end);
  if (start < 0 || finish < 0 || text.slice(0, start).trim() || text.slice(finish + end.length).trim()) {
    return { value: text, unwrapped: false };
  }
  let inner = text.slice(start + begin.length, finish);
  if (inner.startsWith('\n')) inner = inner.slice(1);
  if (inner.endsWith('\n')) inner = inner.slice(0, -1);
  return { value: inner, unwrapped: true };
}

function mathSourceOffsetFromClick(value, clickedWord, bounds, point) {
  const Coordinator = window.TdomOpaqueEditorCoordinator;
  if (typeof Coordinator?.mathSourceOffset !== 'function') return null;
  return Coordinator.mathSourceOffset({
    value,
    clickedWord,
    words: clickedWord?.pageWords ?? [],
    bounds,
    point,
  });
}

function mathCaretStructure(field, offset, markerId = '') {
  const clean = (value) => String(value ?? '')
    .replaceAll(`\\placeholder[${markerId}]{}`, '')
    .replaceAll(`\\placeholder[${markerId}]`, '');
  const info = field.getElementInfo?.(offset) ?? {};
  const context = field.getEnvironmentContext?.(offset) ?? {};
  return JSON.stringify({
    depth: info.depth ?? null,
    mode: info.mode ?? context.mode ?? null,
    latex: clean(info.latex),
    branchPath: context.branchPath ?? [],
    environments: context.environments ?? [],
    array: context.nearestArray ? {
      environmentName: context.nearestArray.environmentName,
      row: context.nearestArray.row,
      column: context.nearestArray.column,
    } : null,
  });
}

function ensureMathCaretProbe(control) {
  if (mathCaretProbe?.constructor === control.constructor && mathCaretProbe.isConnected) return mathCaretProbe;
  mathCaretProbe?.remove?.();
  mathCaretProbe = new control.constructor();
  mathCaretProbe.setAttribute('aria-hidden', 'true');
  Object.assign(mathCaretProbe.style, {
    position: 'fixed',
    left: '-10000px',
    top: '-10000px',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    opacity: '0',
    pointerEvents: 'none',
  });
  document.body.appendChild(mathCaretProbe);
  try {
    mathCaretProbe.setOptions?.({
      smartFence: false,
      smartMode: false,
      inlineShortcuts: {},
      popoverPolicy: 'off',
      mathVirtualKeyboardPolicy: 'manual',
      removeExtraneousParentheses: false,
    });
    mathCaretProbe.menuItems = [];
  } catch { /* the probe still supports parsing and prompt ranges */ }
  return mathCaretProbe;
}

function mathModelOffsetFromSource(control, latex, estimatedOffset, wrapped = false) {
  const source = String(latex ?? '');
  const estimate = Math.max(0, Math.min(source.length, Math.round(Number(estimatedOffset) || 0)));
  const cacheKey = `${wrapped ? 1 : 0}:${source}:${estimate}`;
  if (mathCaretOffsetCache.has(cacheKey)) return mathCaretOffsetCache.get(cacheKey);
  const probe = ensureMathCaretProbe(control);
  const candidates = [];
  for (let distance = 0; distance <= source.length; distance++) {
    const left = estimate - distance;
    const right = estimate + distance;
    if (left >= 0) candidates.push(left);
    if (distance && right <= source.length) candidates.push(right);
  }
  const safeLexicalBoundary = (offset) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset);
    if (/\\[A-Za-z]*$/.test(before) && /^[A-Za-z]/.test(after)) return false;
    if (/\\[A-Za-z]+$/.test(before) && /^\s*\{/.test(after)) return false;
    return true;
  };
  for (const sourceOffset of candidates) {
    if (!safeLexicalBoundary(sourceOffset)) continue;
    const id = `tdom_caret_${++mathCaretProbeSeq}`;
    const marker = `\\placeholder[${id}]{}`;
    const markedSource = source.slice(0, sourceOffset) + marker + source.slice(sourceOffset);
    const marked = wrapped ? wrapAligned(markedSource) : markedSource;
    try {
      probe.setValue(marked, { format: 'latex', silenceNotifications: true });
      const range = probe.getPromptRange?.(id);
      const modelOffset = Array.isArray(range) ? Number(range[0]) - 1 : NaN;
      if (!Number.isInteger(modelOffset) || modelOffset < 0 || modelOffset > Number(control.lastOffset)) continue;
      if (Number(probe.lastOffset) !== Number(control.lastOffset) + 2) continue;
      let structureMatches = true;
      for (let realOffset = 0; realOffset <= Number(control.lastOffset); realOffset++) {
        const probeOffset = realOffset <= modelOffset ? realOffset : realOffset + 2;
        if (mathCaretStructure(control, realOffset) !== mathCaretStructure(probe, probeOffset, id)) {
          structureMatches = false;
          break;
        }
      }
      if (!structureMatches) continue;
      mathCaretOffsetCache.set(cacheKey, modelOffset);
      while (mathCaretOffsetCache.size > 512) {
        mathCaretOffsetCache.delete(mathCaretOffsetCache.keys().next().value);
      }
      return modelOffset;
    } catch { /* try the next syntax-safe source boundary */ }
  }
  return null;
}

function loadMathWysiwyg() {
  if (!mathWysiwygModulePromise) {
    mathWysiwygModulePromise = import('/host/web/math/wysiwyg/math-wysiwyg.js');
  }
  return mathWysiwygModulePromise;
}

// The newest snapshot received, the base the next one is a change from.
let provisionalSnapshotHeld = null; // { epoch, snapshot }

/** A full snapshot from an earlier one and the server's change list; null when they do not fit. */
function applySnapshotDelta(base, delta) {
  const held = base.blocks ?? [];
  // The list of blocks is the held one with a stretch replaced: its first
  // `head` blocks, the blocks named, its last `tail`.
  if (!Array.isArray(delta.cut)) return null;
  const [head, tail, named] = delta.cut;
  if (!Number.isSafeInteger(head) || !Number.isSafeInteger(tail) || !Array.isArray(named) ||
      head < 0 || tail < 0 || head + tail > held.length) return null;
  const blocks = named.length === 0 && head + tail === held.length
    ? held.slice()
    : [...held.slice(0, head), ...named.map(() => null), ...held.slice(held.length - tail)];
  // the blocks sent whole, each with where it stands
  const at = delta.at ?? [];
  const changed = delta.blocks ?? [];
  if (at.length !== changed.length) return null;
  for (let k = 0; k < changed.length; k++) {
    const i = at[k];
    if (!Number.isSafeInteger(i) || i < 0 || i >= blocks.length) return null;
    const name = i >= head && i < head + named.length ? named[i - head] : blocks[i]?.id;
    if (String(name) !== String(changed[k].id)) return null;
    blocks[i] = changed[k];
  }
  // a named block that was not sent is one of the stretch replaced
  let replaced = null;
  for (let k = 0; k < named.length; k++) {
    if (blocks[head + k]) continue;
    if (!replaced) {
      replaced = new Map();
      for (let j = head; j < held.length - tail; j++) replaced.set(String(held[j].id), held[j]);
    }
    const found = replaced.get(String(named[k]));
    if (!found) return null;
    blocks[head + k] = found;
  }
  // (a block that only stands elsewhere now: its place in the list, its pages, its offsets in the root file)
  for (const [i, index, pages, span] of delta.moved ?? []) {
    if (!Number.isSafeInteger(i) || i < 0 || i >= blocks.length) return null;
    const next = { ...blocks[i], index, pages };
    // (a block of an included file carries no offsets in the root file)
    if (span == null) delete next.span;
    else next.span = span;
    blocks[i] = next;
  }
  // (blocks in a row that moved by the same amount: `by` characters in the root file, `places` in the list)
  for (const run of delta.shift ?? []) {
    const [from, to, by, places] = run;
    if (![from, to, by, places].every(Number.isSafeInteger) || from < 0 || to < from || to > blocks.length) return null;
    for (let i = from; i < to; i++) {
      const block = blocks[i];
      if (by && !block.span) return null;
      blocks[i] = block.span
        ? { ...block, index: block.index + places, span: { start: block.span.start + by, end: block.span.end + by } }
        : { ...block, index: block.index + places };
    }
  }
  // (blocks in a row that stand `down` lines further in their file, the same otherwise: a line was added above them)
  for (const run of delta.lines ?? []) {
    const [from, to, down] = run;
    if (![from, to, down].every(Number.isSafeInteger) || from < 0 || to < from || to > blocks.length) return null;
    const lower = (source) => ({ ...source,
      start: { ...source.start, line: source.start.line + down }, end: { ...source.end, line: source.end.line + down } });
    for (let i = from; i < to; i++) {
      const block = blocks[i];
      if (!block.source?.start || !block.source.end || !Array.isArray(block.editRegions) ||
          block.editRegions.some(region => !region.source?.start || !region.source.end)) return null;
      blocks[i] = { ...block, source: lower(block.source),
        editRegions: block.editRegions.map(region => ({ ...region, source: lower(region.source) })) };
    }
  }
  const sourceByFile = new Map((base.sources ?? []).map(source => [source.file, source]));
  for (const source of delta.sources ?? []) {
    if (!Array.isArray(source.splice)) { sourceByFile.set(source.file, source); continue; }
    // (the file's text as a change of the text held: where, how many characters go, what comes)
    const before = sourceByFile.get(source.file);
    const [at, gone, came] = source.splice;
    if (typeof before?.text !== 'string' || typeof came !== 'string' || !Number.isSafeInteger(at) || !Number.isSafeInteger(gone) ||
        at < 0 || gone < 0 || at + gone > before.text.length) return null;
    sourceByFile.set(source.file, { ...before, text: before.text.slice(0, at) + came + before.text.slice(at + gone) });
  }
  // (the files in the order held, when no list of them came)
  const sources = [];
  for (const file of delta.files ?? (base.sources ?? []).map(source => source.file)) {
    const source = sourceByFile.get(file);
    if (!source) return null;
    sources.push(source);
  }
  const { delta: _delta, cut: _cut, files: _files, moved: _moved, shift: _shift, lines: _lines, at: _at, ...rest } = delta;
  return { ...rest, blocks, sources };
}

// The update that brings a revision also brings its source map, as a change
// from the one before (server.js updateDomPush). Applied when this viewer
// holds that one; otherwise loadProvisionalSnapshot asks as usual.
function adoptPushedSnapshot(delta, eventEpoch) {
  const epoch = documentReset.adoptedEpoch;
  const held = provisionalSnapshotHeld?.epoch === epoch ? provisionalSnapshotHeld.snapshot : null;
  if (!held || Number(eventEpoch) !== epoch || !Number.isSafeInteger(held.domStamp) ||
      Number(delta?.delta?.base) !== Number(held.domStamp)) return;
  const snapshot = applySnapshotDelta(held, delta);
  if (!snapshot || snapshot.sourceCurrent === false || Number(snapshot.documentEpoch) !== epoch ||
      !Number.isSafeInteger(Number(snapshot.srcRev)) || Number(snapshot.srcRev) < Number(held.srcRev)) return;
  provisionalSnapshotHeld = { epoch, snapshot };
  provisionalSnapshotCache.set(`${epoch}:${Number(snapshot.srcRev)}`, Promise.resolve(snapshot));
  while (provisionalSnapshotCache.size > 4) provisionalSnapshotCache.delete(provisionalSnapshotCache.keys().next().value);
}

async function loadProvisionalSnapshot(sourceRev) {
  const epoch = documentReset.adoptedEpoch;
  const key = `${epoch}:${sourceRev}`;
  if (!provisionalSnapshotCache.has(key)) {
    // the snapshot of this very revision (server.js domCache): a request
    // queued behind the next keystroke would come back one revision newer
    // The snapshot is the whole document. With an earlier revision of it in
    // hand, ask only for what changed since (server.js domDeltaBody).
    const held = provisionalSnapshotHeld?.epoch === epoch && Number.isSafeInteger(provisionalSnapshotHeld.snapshot.domStamp)
      ? provisionalSnapshotHeld.snapshot : null;
    const request = (base) => fetch(`/dom?srcRev=${encodeURIComponent(sourceRev)}${base ? `&base=${encodeURIComponent(base.domStamp)}` : ''}`,
      { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('Unready source mapping');
      let snapshot = await response.json();
      if (snapshot.delta) {
        snapshot = base && Number(snapshot.delta.base) === Number(base.domStamp) ? applySnapshotDelta(base, snapshot) : null;
        if (!snapshot) return request(null);
      }
      if (snapshot.sourceCurrent === false || Number(snapshot.srcRev) !== Number(sourceRev) ||
          Number(snapshot.documentEpoch) !== epoch || documentReset.adoptedEpoch !== epoch) {
        throw new Error('Superseded source mapping');
      }
      if (!provisionalSnapshotHeld || provisionalSnapshotHeld.epoch !== epoch ||
          Number(provisionalSnapshotHeld.snapshot.srcRev) <= Number(snapshot.srcRev)) {
        provisionalSnapshotHeld = { epoch, snapshot };
      }
      return snapshot;
    });
    const pending = request(held);
    provisionalSnapshotCache.set(key, pending);
    pending.catch(() => {
      if (provisionalSnapshotCache.get(key) === pending) provisionalSnapshotCache.delete(key);
    });
    while (provisionalSnapshotCache.size > 4) provisionalSnapshotCache.delete(provisionalSnapshotCache.keys().next().value);
  }
  return provisionalSnapshotCache.get(key);
}

async function editSnapshotForPage(page) {
  // A last-good provisional page may outlive the source that produced it.
  // Its click targets must retain that same source mapping, like canonical.
  if (page?.provisionalSnapshot && !usesDirectEditSurface(page)) return page.provisionalSnapshot;
  if (!editDomCache || editDomCache.rev !== appliedRev) {
    editDomCache = await fetch('/dom', { cache: 'no-store' }).then((r) => r.json());
  }
  return editDomCache;
}

function sourceTextForRegion(snapshot, region) {
  const source = snapshot?.sources?.find(item => item.file === region.source?.file);
  if (typeof source?.text !== 'string') return undefined;
  const start = lineColToOffset(source.text, region.source.start.line, region.source.start.column);
  const end = lineColToOffset(source.text, region.source.end.line, region.source.end.column);
  return source.text.slice(start, end) === String(region.sourceValue ?? region.value)
    ? source.text : undefined;
}

async function editRegionById(id, page = null) {
  const snapshot = await editSnapshotForPage(page);
  for (const block of snapshot.blocks ?? []) {
    const region = (block.editRegions ?? []).find((item) => item.id === id);
    if (region) return page && !usesDirectEditSurface(page) && snapshot.rejectedBlocks?.includes(block.id)
      ? null : { ...region, blockSource: block.source ?? null };
  }
  return null;
}

async function editBlockBySourceId(id, page = null) {
  const snapshot = await editSnapshotForPage(page);
  if (page && !usesDirectEditSurface(page) && snapshot.rejectedBlocks?.includes(id)) return null;
  return (snapshot.blocks ?? []).find((block) => block.id === id) ?? null;
}

function sourceContainsPosition(region, location) {
  const line = Number(location?.line);
  const column = Number(location?.column);
  if (!Number.isFinite(line)) return true;
  const start = region.source?.start;
  const end = region.source?.end;
  if (!start || !end || line < start.line || line > end.line) return false;
  // SyncTeX frequently reports column 1 as a line-only location (not the
  // literal first source character), especially for caption/section boxes.
  if (!Number.isFinite(column) || column <= 1) return true;
  if (line === start.line && column < start.column) return false;
  if (line === end.line && column > end.column) return false;
  return true;
}

function sameSourceFile(a, b) {
  const left = String(a ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const right = String(b ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return Boolean(left && right) && (
    left === right || left.endsWith('/' + right) || right.endsWith('/' + left)
  );
}

function paperPointForClick(event, page) {
  const rect = page?.getBoundingClientRect?.();
  if (!rect?.width || !rect?.height) return null;
  const paper = activePaperGeometry(page);
  // `paper.width/height` are the final pdftocairo SVG viewport dimensions.
  // The canonical API accepts this same displayed coordinate space and owns
  // the inverse `/Rotate`/PDF-content transform before invoking SyncTeX.
  return window.TdomOpaqueEditorCoordinator?.paperPoint?.({
    clientX: event.clientX,
    clientY: event.clientY,
    pageRect: rect,
    paper,
  }) ?? null;
}

function clientBoundsForDisplayedPaperBounds(bounds, page) {
  const rect = page?.getBoundingClientRect?.();
  const paper = activePaperGeometry(page);
  return window.TdomOpaqueEditorCoordinator?.clientBounds?.({ bounds, pageRect: rect, paper }) ?? null;
}

function pageAtClientPoint(event, target = null) {
  const direct = target?.closest?.('#pages > .page');
  if (direct) return direct;
  for (const element of document.elementsFromPoint?.(event.clientX, event.clientY) ?? []) {
    const page = element?.closest?.('#pages > .page');
    if (page) return page;
  }
  return [...pageDivs.values()].find((page) => {
    const rect = page.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      event.clientX >= rect.left && event.clientX <= rect.right &&
      event.clientY >= rect.top && event.clientY <= rect.bottom;
  }) ?? null;
}

function sourceColumnForOpaqueClick(location, point) {
  const syncedColumn = Number(location?.column);
  // SyncTeX's returned column is authoritative when available. Column 1
  // means “line only”; inventing a character offset from x/line-width mixes
  // proportional TeX glyph metrics with source character counts. Spatial
  // text/math boxes below handle that case instead.
  return syncedColumn >= 1 ? syncedColumn : 1;
}

function caretOffsetForOpaqueRegion(region, location, clickedWord = null, bounds = null, point = null) {
  const value = String(region?.value ?? '');
  if (region?.kind === 'math') {
    return mathSourceOffsetFromClick(value, clickedWord, bounds, point);
  }
  const start = region?.source?.start;
  const line = Number(location?.line);
  const column = Number(location?.column);
  if (start && sourceContainsPosition(region, { line, column }) &&
      Number.isInteger(line) && Number.isInteger(column) && column > 1) {
    const lines = value.split('\n');
    const relativeLine = line - start.line;
    if (relativeLine >= 0 && relativeLine < lines.length) {
      let offset = 0;
      for (let index = 0; index < relativeLine; index++) offset += lines[index].length + 1;
      const baseColumn = relativeLine === 0 ? start.column : 1;
      offset += Math.max(0, column - baseColumn);
      return Math.max(0, Math.min(value.length, offset));
    }
  }
  const printed = String(clickedWord?.text ?? '');
  const group = Array.isArray(bounds?.words) ? bounds.words : [];
  const clickedIndex = group.findIndex((word) => word === clickedWord || (
    word.text === clickedWord?.text && Math.abs(word.left - Number(clickedWord?.left)) < 0.01 &&
    Math.abs(word.top - Number(clickedWord?.top)) < 0.01
  ));
  if (printed && clickedIndex >= 0) {
    let cursor = 0;
    let at = -1;
    for (let index = 0; index <= clickedIndex; index++) {
      const token = String(group[index]?.text ?? '');
      at = value.indexOf(token, cursor);
      if (at < 0) break;
      cursor = at + token.length;
    }
    if (at >= 0) {
      const wordBox = group[clickedIndex];
      const midpoint = (wordBox.left + wordBox.right) / 2;
      // PDF extraction exposes exact word rectangles, not per-glyph
      // advances. Choose an exact source boundary rather than inventing an
      // equal-width character metric for proportional fonts and ligatures.
      return Math.max(0, Math.min(value.length, point?.x < midpoint ? at : at + printed.length));
    }
  }
  return null;
}

async function canonicalSourceBounds(region, pageNumber = null, requestedId = canonical?.id, near = null) {
  const id = Number(requestedId);
  if (!region?.source || !Number.isFinite(id)) return null;
  const key = `${id}:${region.id ?? ''}:${region.source.file ?? ''}:` +
    `${region.source.start?.line}:${region.source.start?.column}:` +
    `${region.source.end?.line}:${region.source.end?.column}`;
  let candidates = canonicalRegionBoundsCache.get(key);
  if (!candidates) try {
    const Coordinator = window.TdomOpaqueEditorCoordinator;
    const probeLocations = Coordinator?.sourceProbeLocations?.(region) ??
      [region.source.start, region.source.end].filter(Boolean).map((position) => ({
        file: region.source.file,
        line: position?.line,
        column: position?.column,
      }));
    if (!probeLocations.length) return null;
    const response = await fetch('/synctex/forward', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id,
        locations: probeLocations,
      }),
    });
    const all = response.ok ? (await response.json()).results?.filter(Boolean) ?? [] : [];
    // Forward SyncTeX results are normalized by canonical.js into the same
    // displayed SVG coordinates used by `near`, pdftotext word boxes, and
    // the direct-editor overlay (including rotated/mixed-size pages).
    // Never union the region boundaries. In a display environment those
    // positions are usually the newline after `\\begin` and the `\\end`
    // line; SyncTeX legitimately maps them to the preceding paragraph and
    // the whole column. The coordinator selects one compact raw TeX box near
    // the clicked canonical point from structural + visible-content probes.
    if (region.kind === 'math' && region.display) {
      // The first/last region offsets can be the empty lines bordering a
      // display. SyncTeX maps those to a nearby fraction or paragraph. Only
      // actual formula source lines define the editable expression's extent.
      const contentLines = new Set(String(region.sourceValue ?? region.value).split(/\r?\n/)
        .flatMap((text, index) => text.trim() ? [Number(region.source.start.line) + index] : []));
      const content = all.filter(box => contentLines.has(Number(probeLocations[box.locationIndex]?.line)));
      const byPage = new Map();
      for (const box of content) {
        if (!byPage.has(box.page)) byPage.set(box.page, []);
        byPage.get(box.page).push(box);
      }
      candidates = [...byPage].map(([page, entries]) => ({ page, sourceRows: entries.map(entry => ({
        ...entry.box, baseline: entry.y,
      })), box: {
        left: Math.min(...entries.map(b => b.box.left)), right: Math.max(...entries.map(b => b.box.right)),
        top: Math.min(...entries.map(b => b.box.top)), bottom: Math.max(...entries.map(b => b.box.bottom)),
      } }));
    } else candidates = all;
    if (!candidates.length) return null;
    canonicalRegionBoundsCache.set(key, candidates);
    while (canonicalRegionBoundsCache.size > 512) {
      canonicalRegionBoundsCache.delete(canonicalRegionBoundsCache.keys().next().value);
    }
  } catch {
    return null;
  }
  const selected = window.TdomOpaqueEditorCoordinator?.selectSourceBounds?.({
    results: candidates,
    pageNumber,
    near,
  }) ?? null;
  if (!selected) return null;
  const sourceRows = candidates.find(candidate => candidate.page === selected.page &&
    ['left', 'right', 'top', 'bottom'].every(key => candidate.box[key] === selected[key]))?.sourceRows;
  return sourceRows ? { ...selected, sourceRows } : selected;
}

async function canonicalTextBoxes(requestedId = canonical?.id, page = null) {
  const id = Number(requestedId);
  if (!Number.isFinite(id)) return [];
  const full = canonicalTextBoxesCache.get(id);
  if (full) return page === null ? full : full.slice(page - 1, page);
  const cache = page === null ? canonicalTextBoxesCache : canonicalPageWordsCache;
  const key = page === null ? id : id + ':' + page;
  if (cache.has(key)) return cache.get(key);
  try {
    const response = await fetch(`/canonical/boxes?c=${id}${page === null ? '' : '&page=' + page}`, { cache: 'no-store' });
    if (!response.ok) return [];
    // Poppler already returns word rectangles after page `/Rotate`; do not
    // rotate them again. Their space is the canonical SVG viewport.
    const pages = (await response.json()).pages ?? [];
    // Cache under the ID that was actually requested, never whichever
    // canonical happened to become global while the request was awaiting.
    cache.set(key, pages);
    while (cache.size > (page === null ? 4 : 16)) {
      cache.delete(cache.keys().next().value);
    }
    return pages;
  } catch {
    return [];
  }
}

function textMatchesOnPage(wanted, words, pageNumber) {
  const matches = [];
  for (let start = 0; start < words.length; start++) {
    let joined = '';
    for (let end = start; end < words.length && joined.length <= wanted.length; end++) {
      joined += printedKey(words[end].text);
      if (joined === wanted) {
        const group = words.slice(start, end + 1);
        matches.push({
          page: pageNumber,
          left: Math.min(...group.map((item) => item.left)),
          top: Math.min(...group.map((item) => item.top)),
          right: Math.max(...group.map((item) => item.right)),
          bottom: Math.max(...group.map((item) => item.bottom)),
          words: group,
        });
        break;
      }
      if (!wanted.startsWith(joined)) break;
    }
  }
  return matches;
}

async function canonicalTextMatches(value, pageNumber = null, requestedId = canonical?.id) {
  const wanted = printedKey(value);
  if (!wanted) return [];
  const pages = await canonicalTextBoxes(requestedId, pageNumber);
  return pages.flatMap((words, index) => textMatchesOnPage(wanted, words, pageNumber ?? index + 1));
}

async function canonicalTextBounds(value, pageNumber = null, near = null, requestedId = canonical?.id) {
  const matches = await canonicalTextMatches(value, pageNumber, requestedId);
  if (!matches.length) return null;
  if (!near) return matches[0];
  const pageMatches = Number.isInteger(Number(near.page))
    ? matches.filter((match) => match.page === Number(near.page))
    : matches;
  const available = pageMatches.length ? pageMatches : matches;
  return available.sort((a, b) => {
    const acx = (a.left + a.right) / 2;
    const acy = (a.top + a.bottom) / 2;
    const bcx = (b.left + b.right) / 2;
    const bcy = (b.top + b.bottom) / 2;
    return (acx - near.x) ** 2 + (acy - near.y) ** 2 -
      ((bcx - near.x) ** 2 + (bcy - near.y) ** 2);
  })[0];
}

function directSourceRangeKey(region) {
  return JSON.stringify([region.source?.file, region.source?.start, region.source?.end]);
}

async function canonicalTextRegionMappings(selected, snapshot, requestedId) {
  if (!selected?.source || !snapshot || !printedKey(selected.value)) return [];
  const epoch = documentReset.adoptedEpoch;
  if (documentReset.pending || Number(snapshot.documentEpoch) !== epoch) return [];
  const valueKey = printedKey(selected.value);
  const identical = new Map();
  const mixedOwner = new Map();
  let sourceCopies = 0, soleOwner = null;
  for (const block of snapshot.blocks ?? []) {
    const mixed = block.type === 'paragraph' &&
      block.sourceRanges?.some(range => sameSourceFile(range.file, selected.source.file)) &&
      block.sourceRanges.some(range => !sameSourceFile(range.file, selected.source.file));
    for (const region of block.editRegions ?? []) {
      if (region.kind !== 'text' || printedKey(region.value) !== valueKey) continue;
      sourceCopies++;
      soleOwner = block;
      if (!mixed && !sameSourceFile(region.source?.file, selected.source.file)) continue;
      const key = directSourceRangeKey(region);
      // A repeated inclusion can put one source span in more than one place.
      // Only a uniquely owned span has a known position in its paragraph.
      if (mixed || mixedOwner.has(key)) mixedOwner.set(key, identical.has(key) ? null : block);
      identical.set(key, { ...region, blockSource: block.source ?? null });
    }
  }
  // Escaped text may be represented by a proven combined source span.
  if (!identical.has(directSourceRangeKey(selected))) identical.set(directSourceRangeKey(selected), selected);
  const regions = [...identical.values()];
  const owners = regions.map(region => mixedOwner.get(directSourceRangeKey(region)));
  const inOneMixedParagraph = choices => Boolean(owners[choices[0]]) &&
    choices.every(index => owners[index] === owners[choices[0]]);
  const key = `text-mapping:${epoch}:${requestedId}:${printedKey(selected.value)}:` + JSON.stringify(regions.map(directSourceRangeKey));
  if (canonicalRegionBoundsCache.has(key)) return canonicalRegionBoundsCache.get(key);
  const matches = await canonicalTextMatches(selected.value, null, requestedId);
  const probeOwners = [];
  const locations = regions.flatMap((region, owner) => {
    const probes = window.TdomOpaqueEditorCoordinator?.sourceProbeLocations?.(region) ??
      [region.source.start, region.source.end].map(position => ({ file: region.source.file, ...position }));
    probeOwners.push(...probes.map(() => owner));
    return probes;
  });
  const forward = await fetch('/synctex/forward', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: requestedId, locations }),
  }).then(response => response.ok ? response.json() : null).catch(() => null);
  if (!forward?.results?.length || documentReset.pending || documentReset.adoptedEpoch !== epoch) return [];
  // A paragraph with inline math can forward-map only to the formula and a
  // continuation line. In that case the inverse blank-line record still
  // supplies the printed paragraph boxes for both text and formula.
  const uniqueParagraph = regions.length === 1 && matches.length === 1 && sourceCopies === 1 &&
    soleOwner.type === 'paragraph';
  const occurrences = [];
  for (const printBounds of matches) {
    const word = printBounds.words[0];
    const x = (word.left + word.right) / 2;
    let choices = regions.flatMap((region, index) => forward.results.some(result =>
      probeOwners[result?.locationIndex] === index && Number(result.page) === printBounds.page &&
      x >= result.box?.left - 2 && x <= result.box?.right + 2 &&
      word.bottom >= result.box?.top - 2 && word.top <= result.box?.bottom + 2) ? [index] : []);
    if (!choices.length && !uniqueParagraph) continue;
    const location = await fetch('/synctex', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: requestedId, page: printBounds.page,
        x, y: (word.top + word.bottom) / 2 }),
    }).then(response => response.ok ? response.json() : null).catch(() => null);
    if (documentReset.pending || documentReset.adoptedEpoch !== epoch) return [];
    if (!choices.length) {
      const region = regions[0];
      const paragraph = region.blockSource;
      if (location?.lineText !== '' || !sameSourceFile(location.file, region.source.file) ||
          !sameSourceFile(paragraph?.file, location.file) || location.line !== region.source.end.line + 1 ||
          !sourceNearLine(paragraph, location, 1) ||
          !sourceNearLine(paragraph, { file: region.source.file, line: region.source.start.line })) continue;
      const anchors = (location.anchors ?? []).filter(a => a.page === printBounds.page && a.box);
      const inParagraph = printBounds.words.every(w => anchors.some(({ box }) =>
        (w.left + w.right) / 2 >= box.left && (w.left + w.right) / 2 <= box.right &&
        (w.top + w.bottom) / 2 >= box.top && (w.top + w.bottom) / 2 <= box.bottom));
      const sharesBox = forward.results.some(r => r.page === printBounds.page && r.box &&
        anchors.some(({ box }) => ['left', 'right', 'top', 'bottom'].every(k => Math.abs(r.box[k] - box[k]) < 0.01)));
      if (!inParagraph || !sharesBox) continue;
      choices = [0];
    }
    // Paragraph-end SyncTeX nodes often report the following blank line.
    // Forward boxes prove the source span; a compatible inverse location
    // can narrow it, but a line-only mismatch must not discard that proof.
    if (location?.file && Number.isInteger(Number(location.line)) && Number(location.line) > 0 &&
        (Number(location.column) > 1 || !inOneMixedParagraph(choices))) {
      const precise = choices.filter(index => sameSourceFile(regions[index].source.file, location.file) &&
        sourceContainsPosition(regions[index], location));
      if (precise.length) choices = precise;
    }
    occurrences.push({ printBounds, location, choices });
  }
  // A repeated header, a missing occurrence or an unrelated copy on the
  // same source line must not be assigned to the old nearest paper point.
  if (occurrences.length !== regions.length) return [];
  const remaining = new Set(regions.map((_, index) => index));
  const assigned = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const occurrence of occurrences) {
      if (assigned.has(occurrence)) continue;
      occurrence.choices = occurrence.choices.filter(index => remaining.has(index));
      if (!occurrence.choices.length) return [];
      if (occurrence.choices.length === 1) {
        const [index] = occurrence.choices;
        assigned.set(occurrence, index);
        remaining.delete(index);
        changed = true;
      }
    }
  }
  for (const occurrence of occurrences) {
    if (assigned.has(occurrence)) continue;
    const choices = occurrence.choices;
    const group = occurrences.filter(item => !assigned.has(item) &&
      JSON.stringify(item.choices) === JSON.stringify(choices));
    if (group.length !== choices.length) return [];
    // The inspector and Poppler both enumerate a paragraph in expanded
    // reading order. Source line numbers restart in each included file.
    let ordered = choices;
    if (!inOneMixedParagraph(choices)) {
      ordered = [...choices].sort((a, b) => regions[a].source.start.column - regions[b].source.start.column);
      const first = regions[ordered[0]].source;
      if (ordered.some((index, at) => !sameSourceFile(regions[index].source.file, first.file) ||
          regions[index].source.start.line !== first.start.line || regions[index].source.end.line !== first.start.line ||
          at > 0 && regions[ordered[at - 1]].source.end.column > regions[index].source.start.column)) return [];
    }
    group.forEach((item, at) => assigned.set(item, ordered[at]));
    choices.forEach(index => remaining.delete(index));
  }
  if (remaining.size) return [];
  const result = occurrences.map(occurrence => ({
    region: regions[assigned.get(occurrence)], printBounds: occurrence.printBounds,
  }));
  canonicalRegionBoundsCache.set(key, result);
  while (canonicalRegionBoundsCache.size > 512) canonicalRegionBoundsCache.delete(canonicalRegionBoundsCache.keys().next().value);
  return result;
}

async function canonicalTextRegionBounds(region, snapshot, requestedId, previousPage) {
  const source = region.source;
  if (source && region.value === (region.sourceValue ?? region.value)) {
    // The same phrase may appear thousands of times throughout a book.
    // When the owner is on one sheet, follow its exact source row through
    // the new generation before asking SyncTeX about every printed copy.
    const owners = snapshot.blocks.filter(block => block.editRegions?.some(item => item.kind === 'text' &&
      item.source?.file === source.file && item.source.start.line === source.start.line &&
      item.source.start.column === source.start.column && item.source.end.line === source.end.line &&
      item.source.end.column === source.end.column));
    const owner = owners.length === 1 ? owners[0] : null;
    if (owner?.type === 'paragraph' && owner.editRegions.filter(item =>
        item.kind === 'text' && item.source.file === source.file && item.source.start.line <= source.end.line && item.source.end.line >= source.start.line &&
        printedKey(item.value) === printedKey(region.value)).length === 1) {
      if (source.start.line === source.end.line && owner.pages?.length === 1) {
        const page = owner.pages[0];
        const [boxes, glyphs, sheets] = await Promise.all([canonicalSourceEditBoxes(page, requestedId, region),
          canonicalGlyphs(page, requestedId), canonicalTextBoxes(requestedId, page)]);
        if (documentReset.pending || snapshot.documentEpoch !== documentReset.adoptedEpoch) return null;
        const found = boxes.filter(row => !row.empty && row.parentKind === 'vbox' && row.line === source.start.line)
          .map(row => textOnNativeRow(region, row, page, glyphs, sheets[0] ?? [])).filter(Boolean);
        if (found.length === 1) return found[0].printBounds;
      }
      if (Number.isInteger(previousPage)) {
        const match = await textAtParagraphEnd(region, snapshot, previousPage, requestedId);
        if (match) return match.printBounds;
      }
    }
  }
  const mappings = await canonicalTextRegionMappings(region, snapshot, requestedId);
  return mappings.find(item => directSourceRangeKey(item.region) === directSourceRangeKey(region))?.printBounds ?? null;
}

async function canonicalWordAtPoint(pageNumber, point, requestedId = canonical?.id) {
  if (!Number.isInteger(pageNumber) || !point) return null;
  const words = (await canonicalTextBoxes(requestedId, pageNumber))[0] ?? [];
  const readingIndex = words.findIndex((word) =>
    point.x >= word.left - 1 && point.x <= word.right + 1 &&
    point.y >= word.top - 2 && point.y <= word.bottom + 2
  );
  return readingIndex < 0 ? null : { ...words[readingIndex], readingIndex, pageWords: words };
}

async function opaquePrintBounds(
  region,
  location,
  point,
  generatedIndex = null,
  generatedCount = null,
  requestedId = canonical?.id
) {
  if (region.kind === 'text') {
    const exact = await canonicalTextBounds(region.value, location?.anchor?.page ?? null, point, requestedId);
    if (exact) return exact;
  }
  const exactSource = await canonicalSourceBounds(
    region,
    location?.anchor?.page ?? null,
    requestedId,
    point
  );
  if (exactSource) return exactSource;
  let box = location?.anchor?.box ?? null;
  if (box && Number.isInteger(generatedIndex) && generatedCount > 1) {
    const height = box.bottom - box.top;
    if (height > generatedCount * 4) {
      const top = box.top + (height * generatedIndex) / generatedCount;
      box = { ...box, top, bottom: box.top + (height * (generatedIndex + 1)) / generatedCount };
    }
  }
  return box;
}

async function refreshDirectEditorExactBounds(pageNumber) {
  const session = directEditor;
  if (!session || session.pageNumber !== pageNumber) return;
  const page = pageDivs.get(pageNumber);
  const presented = page?.classList.contains('is-final') ? presentedPageState(page) : null;
  if (!presented) return;
  const currentRegion = directEditorGeometryRegion(presented.snapshot, session);
  const value = String(session.readValue());
  const printedValue = String(currentRegion?.value ?? '');
  if (!currentRegion || !directEditValuesEqual(session.kind, printedValue, value)) return;
  let bounds = null;
  if (session.kind === 'text') {
    bounds = await canonicalTextRegionBounds(currentRegion, presented.snapshot, presented.id, pageNumber);
    if (bounds?.page !== pageNumber) return;
  } else {
    bounds = await canonicalSourceBounds(currentRegion, pageNumber, presented.id, session.printBounds ? {
      page: pageNumber,
      x: (session.printBounds.left + session.printBounds.right) / 2,
      y: (session.printBounds.top + session.printBounds.bottom) / 2,
    } : null);
  }
  if (directEditor !== session || session.readValue() !== value ||
      presentedPageState(page)?.src !== presented.src) return;
  if (bounds) {
    session.region = currentRegion;
    session.canonicalInput = true;
    session.printBounds = bounds;
    session.presentedId = presented.id;
    session.presentedRev = presented.rev;
    await refreshDirectEditGeometry(session);
  }
  scheduleDirectEditorVisuals(true);
}

async function syncLocationForClick(event, page, presented = usesDirectEditSurface(page) ? presentedPageState(page) : null,
  displayedSourceRev = undefined, displayedPoint = null) {
  const mappingId = presented?.id ?? canonical?.id;
  if (!mappingId || (!presented && !usesDirectEditSurface() && canonical.rev !== appliedSrcRev)) return null;
  const pageNumber = Number(page?.dataset?.page);
  const point = displayedPoint ?? paperPointForClick(event, page);
  if (!point || !Number.isFinite(pageNumber)) return null;
  try {
    const response = await fetch('/synctex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        page: pageNumber,
        x: point.x,
        y: point.y,
        id: mappingId,
        displayedSourceRev,
        ...(Number.isSafeInteger(displayedSourceRev) && {
          documentEpoch: documentReset.adoptedEpoch,
          boot: presented?.image?.sourceClickBoot ?? serverBootId,
        }),
      }),
    });
    if (!response.ok) {
      const error = Number.isSafeInteger(displayedSourceRev) ? await response.json().catch(() => null) : null;
      return error?.reason === 'paper-unavailable' ? { unmapped: true } : null;
    }
    const result = await response.json();
    return { ...result, canonicalId: mappingId, canonicalRev: presented?.rev ?? canonical?.rev };
  } catch {
    return null;
  }
}

function residentWordAtClick(event, node, src) {
  const hit = node?.matches('text') && node.dataset.src === src ? node : document.elementsFromPoint(event.clientX, event.clientY)
    .find(element => element.matches('text[data-src]') && element.dataset.src === src);
  const transform = hit?.getScreenCTM();
  if (!transform) return {};
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
  const character = hit.getCharNumAtPosition(point);
  if (character < 0) return {};
  const baseline = hit.getAttribute('y');
  const runs = [...hit.ownerSVGElement.querySelectorAll('text[data-src]')].filter(run =>
    run.dataset.src === src && run.dataset.line === hit.dataset.line && run.getAttribute('y') === baseline)
    .sort((a, b) => Number(a.getAttribute('x')) - Number(b.getAttribute('x')));
  let text = '', offset = character, right = -Infinity;
  for (const run of runs) {
    const x = Number(run.getAttribute('x'));
    const size = Number(run.getAttribute('font-size')) || 10;
    if (text && x - right > size * 0.2) text += ' ';
    if (run === hit) offset += text.length;
    text += run.textContent;
    right = x + (Number(run.dataset.width) || run.getComputedTextLength());
  }
  const words = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter(span => span.isWordLike);
  const index = words.findIndex(span => span.index <= offset && offset < span.index + span.segment.length);
  return index < 0 ? {} : { word: words[index].segment, prev: words[index - 1]?.segment, next: words[index + 1]?.segment };
}

async function sourceClickFallback(documentEpoch, boot) {
  try {
    const response = await fetch('/synctex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fallback: true, documentEpoch, boot }),
    });
    if (response.ok) return await response.json();
  } catch { /* the document's engine can have stopped */ }
  return null;
}

function clickSourceText(snapshot, file) {
  const sources = snapshot.sources ?? [];
  const exact = sources.find(item => item.file === file);
  if (exact) return exact.text;
  const aliases = sources.filter(item => sameSourceFile(item.file, file));
  return aliases.length === 1 ? aliases[0].text : undefined;
}

async function snapshotLocationForInk(snapshot, block, event, stillCurrent) {
  const node = event?.target?.closest?.('[data-src]');
  const region = node?.dataset.src === block.id && block.editRegions?.find(item => item.id === node.dataset.edit);
  const context = event ? residentWordAtClick(event, node, block.id) : {};
  const { findSourceWord } = await import('/source-line-map.js');
  const spans = region?.source ? [region.source] : block.sourceRanges ?? [block.source];
  const locations = spans.flatMap(span => {
    const hit = span?.start && span?.end && findSourceWord(clickSourceText(snapshot, span.file), span, context);
    return hit ? [{ file: span.file, ...hit }] : [];
  });
  // data-line identifies a typeset row. The retained source span and the
  // printed word together identify which source line produced that row.
  const location = locations.length === 1 ? locations[0] : region?.source ?? block.source;
  return location?.file ? translateSnapshotClick(location, snapshot, stillCurrent, block, context) : null;
}

async function translateSnapshotClick(location, snapshot, stillCurrent, block, context) {
  const line = location.start?.line ?? location.line;
  const column = location.start?.column ?? location.column ?? 1;
  if (Number(snapshot.srcRev) === appliedSrcRev) return { file: location.file, line, column };
  const { mapSourceLines } = await import('/source-line-map.js');
  const before = clickSourceText(snapshot, location.file);
  let current = snapshot;
  while (stillCurrent() && Number(current?.srcRev) !== appliedSrcRev) {
    const targetRev = appliedSrcRev;
    current = await loadProvisionalSnapshot(targetRev).catch(() => null);
    if (!current && targetRev === appliedSrcRev) break;
  }
  if (!stillCurrent()) return null;
  const after = current && clickSourceText(current, location.file);
  const currentBlock = current?.blocks?.find(item => item.id === block?.id)?.source;
  const currentStart = sameSourceFile(currentBlock?.file, location.file) ? currentBlock.start?.line : undefined;
  if (typeof before !== 'string' || typeof after !== 'string') {
    return { file: location.file, line: currentStart ?? line, column: currentStart ? 1 : column };
  }
  const source = (block?.sourceRanges ?? [block?.source]).find(range =>
    range?.file && sameSourceFile(range.file, location.file) && range.start.line <= line && range.end.line >= line);
  const mapped = mapSourceLines(before, after).location(line, {
    column, ...context,
    block: { start: source?.start?.line, end: source?.end?.line, currentStart },
  });
  return { file: location.file, ...mapped };
}

async function currentLocationForPaperClick(snapshot, dl, point, stillCurrent, event) {
  // An exact picture can have no SyncTeX hit (e.g. drawing nodes). Its body
  // list still gives the nearest printed block and a line within that block.
  let hit = null;
  let nearest = Infinity;
  for (const cmd of dl?.commands ?? []) {
    if (!cmd.src || cmd.src.startsWith('_') || !commandDrawsInk(cmd) || !point) continue;
    const left = cmd.x, right = left + (cmd.w ?? 0);
    const top = cmd.y - (cmd.op === 'glyphs' ? cmd.gh ?? cmd.size ?? 0 : 0);
    const bottom = cmd.y + (cmd.h ?? cmd.gd ?? 0);
    const distance = Math.hypot(Math.max(0, left - point.x, point.x - right), Math.max(0, top - point.y, point.y - bottom));
    if (distance < nearest) { hit = cmd; nearest = distance; }
  }
  const block = hit && snapshot?.blocks?.find(({ id }) => id === hit.src);
  return block ? snapshotLocationForInk(snapshot, block, event, stillCurrent) : null;
}

function sourceDistanceToRegion(region, location) {
  if (!location || !sameSourceFile(region.source?.file, location.file)) return Infinity;
  const start = region.source.start, end = region.source.end;
  const line = Number(location.line), column = Number(location.column);
  if (line < start.line) return (start.line - line) * 100000;
  if (line > end.line) return (line - end.line) * 100000;
  if (column > 1) {
    if (line === start.line && column < start.column) return start.column - column;
    if (line === end.line && column > end.column) return column - end.column;
  }
  return 0;
}

function sourceNearLine(source, location, trailingLines = 0) {
  return sameSourceFile(source?.file, location.file) &&
    Number.isInteger(source?.start?.line) && Number.isInteger(source?.end?.line) &&
    source.start.line <= location.line && location.line <= source.end.line + trailingLines;
}

function mixedParagraphsAtLine(snapshot, location, pageNumber) {
  if (!location?.file) return [];
  return (snapshot.blocks ?? []).filter(block => block.type === 'paragraph' && block.pages?.includes(pageNumber) &&
    block.sourceRanges?.some(range => sourceNearLine(range, location)) &&
    block.sourceRanges.some(range => !sameSourceFile(range.file, location.file)));
}

async function inlineSourceLineBoxes(pageNumber, id, block, line) {
  // Explicit \par commands can leave thousands of source lines in one
  // inspector block. The native query accepts ranges spanning at most 512
  // lines. Its enclosing row and child boxes are local to the printed sheet.
  const source = block.source;
  const region = source.end.line - source.start.line > 512
    ? { source: { file: source.file, start: { line }, end: { line } } } : block;
  return inlineSourceRows(await canonicalSourceEditBoxes(pageNumber, id, region), line);
}

function inlineSourceRows(boxes, line) {
  const parents = new Set(boxes.filter(box => box.line === line && box.parentKind === 'hbox').map(box => box.parentId));
  return boxes.filter(box => !box.empty && (box.line === line || parents.has(box.id)));
}

function singleLineInk(map, page, unique) {
  const baseline = map[0]?.baseline;
  if (!Number.isFinite(baseline) || !map.every(g => Math.abs(g.baseline - baseline) < 0.5)) return null;
  return { ...inkBounds(map, page), baseline, unique };
}

// The same ink can have several TeX spellings. A complete inline formula
// between two identified prose runs on one printed line has a source witness
// even when counting copies of the literal formula cannot distinguish them.
function witnessedInlineFormula(group, occurrence, textInk, candidates, snapshot, glyphs) {
  const bounds = inkBounds(occurrence.map, occurrence.pageNumber);
  const centers = occurrence.map.map(atom => (atom.top + atom.bottom) / 2);
  const midline = (bounds.top + bounds.bottom) / 2;
  const regions = group.filter(region => {
    const index = candidates.findIndex(item => item.id === region.id);
    const left = candidates[index - 1], right = candidates[index + 1];
    const before = textInk.get(left), after = textInk.get(right);
    if (region.display || !before || !after || !(before.unique || after.unique) ||
        before.page !== bounds.page || after.page !== bounds.page ||
        Math.abs(before.baseline - after.baseline) > 0.5 ||
        before.right > bounds.left || after.left < bounds.right ||
        midline < before.top || midline > before.bottom || midline < after.top || midline > after.bottom) return false;
    // Both words can repeat elsewhere on a sheet. The interval they
    // identify must contain only this copy, including after a line reflow.
    // Font boxes on tightly spaced lines overlap. Their glyph centers
    // distinguish the neighboring numerator or denominator from this row.
    const rowCenter = (before.top + before.bottom) / 2;
    const top = Math.min(rowCenter, ...centers) - 0.1, bottom = Math.max(rowCenter, ...centers) + 0.1;
    if (glyphs.some(g => {
      const x = (g.left + g.right) / 2, y = (g.top + g.bottom) / 2;
      return x > before.right && x < after.left && y >= top && y <= bottom &&
        !occurrence.map.some(atom => x >= atom.left && x <= atom.right && y >= atom.top && y <= atom.bottom);
    })) return false;
    const source = region.source;
    if (left.source.file !== source.file || right.source.file !== source.file ||
        source.start.line !== source.end.line || left.source.end.line !== source.start.line ||
        right.source.start.line !== source.end.line) return false;
    const text = sourceTextForRegion(snapshot, region);
    if (text === undefined) return false;
    const start = lineColToOffset(text, source.start.line, source.start.column);
    const end = start + String(region.sourceValue ?? region.value).length;
    const open = text.slice(start + left.source.end.column - source.start.column, start).trim();
    const close = text.slice(end, end + right.source.start.column - source.end.column).trim();
    return open === '$' && close === '$' || open === '\\(' && close === '\\)';
  });
  return regions.length === 1 ? regions[0] : null;
}

// Match MathLive's complete expression against the glyphs on SyncTeX's
// source row. Copies correspond in reading order when their counts agree;
// otherwise the adjacent printed prose must identify the source expression.
async function inlineMathCopies(snapshot, location, pageNumber, id, stillCurrent, sourceValue = null, forwardRows = null, requireProse = false, measureStructures = false, printedGlyphs = null) {
  const geometry = window.TdomDirectEditGeometry;
  const Mathfield = customElements.get('math-field');
  const line = Number(location?.line);
  if (!geometry?.mathMaps || !Mathfield || !Number.isFinite(line)) return [];
  // SyncTeX may assign an entire paragraph to the last included file.
  // The inspector emits regions in expanded input order, including when
  // an inclusion returns to an earlier line in its parent file.
  const mixed = mixedParagraphsAtLine(snapshot, location, pageNumber);
  if (mixed.length > 1) return [];
  const blocks = snapshot?.blocks ?? [];
  const exact = blocks.filter(block => block.type === 'paragraph' &&
    block.editRegions?.some(region => region.kind === 'math' && !region.display && sourceNearLine(region.source, location)));
  // SyncTeX can name the blank line ending a paragraph. Only extend the
  // source search onto that line if it names no inline formula itself.
  // Otherwise identical formulas two lines earlier inflate the copy count.
  // Reverse SyncTeX can include a whole-column vbox alongside the real
  // line. In repeated paragraphs that would count unrelated copies too.
  const rows = forwardRows ?? (sourceValue === null && !mixed.length && exact.length === 1
    ? await inlineSourceLineBoxes(pageNumber, id, exact[0], line) : []);
  if (!stillCurrent()) return [];
  const printedLines = (rows.length ? rows : location.anchors ?? []).filter(item => Number(item.page) === pageNumber && item.box &&
    [item.box.left, item.box.right, item.box.top, item.box.bottom].every(Number.isFinite));
  if (!printedLines.length) return [];
  const extent = { left: Math.min(...printedLines.map(item => item.box.left)), right: Math.max(...printedLines.map(item => item.box.right)),
    top: Math.min(...printedLines.map(item => item.box.top)), bottom: Math.max(...printedLines.map(item => item.box.bottom)) };
  const owners = mixed.length ? mixed : exact.length ? exact : blocks;
  const exactRows = !mixed.length && exact.length && (rows.length || sourceValue !== null);
  const regions = owners.flatMap(block => (block.editRegions ?? [])
      .filter(item => item.kind === 'math' && !item.display && (sourceValue === null || item.value === sourceValue) && (mixed.length ||
        sameSourceFile(item.source?.file, location.file) &&
        (exactRows ? sourceNearLine(item.source, location) :
          sourceNearLine(block.source, location, 2) || sourceNearLine(item.source, location, 2))))
      .map(item => ({ ...item, blockSource: block.source ?? null })));
  if (!mixed.length) regions.sort((a, b) => a.source.start.line - b.source.start.line || a.source.start.column - b.source.start.column);
  if (!regions.length || regions.length > 24) return [];
  const glyphs = printedGlyphs ?? await canonicalGlyphs(pageNumber, id);
  if (!stillCurrent() || !glyphs.length) return [];
  const rowGlyphs = glyphs.filter(g => {
    const x = (g.left + g.right) / 2, y = (g.top + g.bottom) / 2;
    return x >= extent.left - 1 && x <= extent.right + 1 && y >= extent.top - 2 && y <= extent.bottom + 2;
  });
  const neighbors = exactRows && exact.length === 1 ? exact[0].editRegions.filter(item =>
    sourceNearLine(item.source, location)) : [];
  let textInk;
  const byValue = new Map();
  for (const region of regions) {
    if (!byValue.has(region.value)) byValue.set(region.value, []);
    byValue.get(region.value).push(region);
  }
  const found = [];
  const probe = new Mathfield();
  try {
    probe.mathVirtualKeyboardPolicy = 'manual';
    probe.setAttribute('aria-hidden', 'true');
    Object.assign(probe.style, { position: 'fixed', left: '-10000px', top: '0', opacity: '0', pointerEvents: 'none' });
    document.body.appendChild(probe);
    for (const [value, same] of byValue) {
      probe.value = shouldWrapAligned(value) ? wrapAligned(value) : value;
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!stillCurrent()) return [];
      const copies = geometry.mathMaps(probe, rowGlyphs, extent, { contiguous: true }).map(({ map }) => ({ map,
        left: Math.min(...map.map(g => g.left)), top: Math.min(...map.map(g => g.top)), bottom: Math.max(...map.map(g => g.bottom)) }));
      const counted = !requireProse && copies.length === same.length;
      if (!counted) {
        if (!copies.length || !neighbors.some(item => item.kind === 'text')) continue;
        if (!textInk) {
          textInk = new Map();
          for (const item of neighbors) {
            if (item.kind !== 'text' || neighbors.some(other => other !== item && other.kind === 'text' && other.value === item.value)) continue;
            const hits = geometry.textMaps(item.value, rowGlyphs);
            const ink = hits.length === 1 && singleLineInk(hits[0].map, pageNumber, true);
            if (ink) textInk.set(item, ink);
          }
        }
      }
      // reading order: by printed line, then from the left
      copies.sort((a, b) => (Math.abs((a.top + a.bottom) - (b.top + b.bottom)) > 8 ? (a.top + a.bottom) - (b.top + b.bottom) : a.left - b.left));
      copies.forEach(({ map }, order) => {
        const region = counted ? same[order] :
          witnessedInlineFormula(same, { map, pageNumber }, textInk, neighbors, snapshot, rowGlyphs);
        if (!region) return;
        const item = { region, map, extent };
        if ((sourceValue !== null || measureStructures) && /\\(?:[dt]?frac|sqrt)\b/.test(value)) {
          if (!geometry.completeDisplayMap(probe, map)) return;
          item.structures = geometry.printedMathStructures(probe, map, glyphs);
          if (!item.structures?.length) return;
        }
        found.push(item);
      });
    }
  } finally { probe.remove(); }
  return found;
}
const inkBounds = (map, pageNumber) => ({ page: pageNumber,
  left: Math.min(...map.map(g => g.left)), right: Math.max(...map.map(g => g.right)),
  top: Math.min(...map.map(g => g.top)), bottom: Math.max(...map.map(g => g.bottom)) });

// The inline formula printed under `point` (a click SyncTeX answered with a
// line no formula holds). Two formulas that cover the point alike leave it
// undecided: null.
async function inlineMathUnderPoint(snapshot, location, pageNumber, point, id, stillCurrent) {
  if (!point) return null;
  const primary = await inlineMathCopies(snapshot, location, pageNumber, id, stillCurrent);
  const hit = inlineFormulaHit(primary, pageNumber, point);
  if (hit || !stillCurrent()) return hit;
  return inlineMathFromForwardRows(snapshot, pageNumber, point, id, stillCurrent);
}

// SyncTeX's native row query accepts a single input file and up to 513
// consecutive source lines. A sheet can contain disjoint chapters.
async function* pageSourceRowGroups(files, pageNumber, id, stillCurrent) {
  for (const [file, uniqueLines] of files) {
    const lines = [...uniqueLines].sort((a, b) => a - b);
    for (let i = 0; i < lines.length;) {
      const first = i++;
      while (i < lines.length && lines[i] - lines[first] <= 512) i++;
      const source = { file, start: { line: lines[first] }, end: { line: lines[i - 1] } };
      const boxes = await canonicalSourceEditBoxes(pageNumber, id, { source });
      if (!stillCurrent()) return;
      yield { file, uniqueLines, boxes };
    }
  }
}

async function inlineMathFromForwardRows(snapshot, pageNumber, point, id, stillCurrent, requireProse = false, owner = null) {
  // A glyph supplied by a macro default can reverse-map to the end of the
  // root document. Query native forward boxes by page and source range, then
  // verify the complete formula at the physical point before selecting it.
  const files = new Map();
  for (const block of owner ? [owner] : snapshot.blocks ?? []) {
    if (block.type !== 'paragraph' || !block.pages?.includes(pageNumber)) continue;
    for (const item of block.editRegions ?? []) {
      const source = item.source;
      if (item.kind !== 'math' || item.display || !source?.file) continue;
      if (!files.has(source.file)) files.set(source.file, new Set());
      files.get(source.file).add(source.start.line);
    }
  }
  const copies = [];
  for await (const { file, uniqueLines, boxes } of pageSourceRowGroups(files, pageNumber, id, stillCurrent)) {
    const candidates = new Set(boxes.filter(({ empty, line, box }) => !empty && uniqueLines.has(line) &&
      point.x >= box.left - 2 && point.x <= box.right + 2 && point.y >= box.top - 2 && point.y <= box.bottom + 2).map(row => row.line));
    for (const line of candidates) {
      const rows = inlineSourceRows(boxes, line);
      const matches = await inlineMathCopies(snapshot, { file, line }, pageNumber, id, stillCurrent, null, rows, requireProse, Boolean(owner));
      if (!stillCurrent()) return null;
      copies.push(...matches);
    }
  }
  return inlineFormulaHit(copies, pageNumber, point);
}

function inlineFormulaHit(copies, pageNumber, point) {
  const geometry = window.TdomDirectEditGeometry;
  const hits = copies.filter(({ map, extent }) => {
    if (point.x < extent.left - 3 || point.x > extent.right + 3 || point.y < extent.top - 3 || point.y > extent.bottom + 3) return false;
    const glyph = geometry.nearest(map, point);
    return glyph && point.x >= glyph.left - 2 && point.x <= glyph.right + 2 && point.y >= glyph.top - 1 && point.y <= glyph.bottom + 1;
  });
  if (!hits.length) return null;
  // A denominator on the preceding line can reach the click tolerance
  // around a numerator. Prefer glyphs which physically contain the point.
  const direct = hits.filter(({ map }) => map.some(g => point.x >= g.left && point.x <= g.right &&
    point.y >= g.top && point.y <= g.bottom));
  const choices = direct.length ? direct : hits;
  // (a formula inside a larger one is not the formula clicked: `2` in `x^2`)
  choices.sort((a, b) => b.map.length - a.map.length);
  if (choices.length > 1 && choices[1].map.length === choices[0].map.length) return null;
  return { ...choices[0], printBounds: inkBounds(choices[0].map, pageNumber) };
}

// Where an inline formula is printed in canonical generation `id`, for a
// formula SyncTeX cannot place: asked of the paragraph printed at `near`
// (where the formula stood in the generation before).
async function inlineMathBoundsByInk(region, snapshot, id, near) {
  if (!region || region.kind !== 'math' || region.display || !Number.isInteger(Number(near?.page)) ||
      ![near.x, near.y].every(Number.isFinite)) return null;
  const location = await fetch('/synctex', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: Number(near.page), x: near.x, y: near.y, id }),
  }).then(response => (response.ok ? response.json() : null)).catch(() => null);
  if (!location?.file) return null;
  const key = JSON.stringify([region.source?.file, region.source?.start, region.source?.end]);
  const copy = (await inlineMathCopies(snapshot, location, Number(near.page), id, () => true))
    .find(item => JSON.stringify([item.region.source?.file, item.region.source?.start, item.region.source?.end]) === key);
  return copy ? inkBounds(copy.map, Number(near.page)) : null;
}

// Hit-test the immutable paper at the inverse translation. Bind the result
// to the new source only if its unchanged suffix identifies the same bytes.
async function editAtPrintedTail(page, event, tail, snapshot, current) {
  const presented = presentedPageState(page), pageNumber = Number(page.dataset.page);
  const scale = page.getBoundingClientRect().width / activePaperGeometry(page).width;
  if (!presented || presented.id !== tail.generation || !(scale > 0)) return null;
  const oldEvent = { clientX: event.clientX - tail.dx * scale, clientY: event.clientY, target: page };
  const owner = presented.snapshot.blocks.find(b => b.id === tail.src);
  const point = paperPointForClick(oldEvent, page);
  if (!owner || !point) return null;
  const math = await inlineMathFromForwardRows(presented.snapshot, pageNumber, point, presented.id, current, false, owner);
  if (!current()) return null;
  const oldHit = math ?? await resolveOpaqueEditRegion(page, oldEvent);
  if (!oldHit || !current()) return null;
  const old = oldHit.region, before = sourceTextForRegion(presented.snapshot, old);
  const after = snapshot.sources.find(source => source.file === old.source.file)?.text;
  if (typeof before !== 'string' || typeof after !== 'string' ||
      !owner?.editRegions?.some(r => directSourceRangeKey(r) === directSourceRangeKey(old))) return null;
  const oldStart = lineColToOffset(before, old.source.start.line, old.source.start.column);
  const newStart = oldStart + after.length - before.length;
  if (newStart < 0 || after.slice(newStart) !== before.slice(oldStart)) return null;
  const regions = snapshot.blocks.find(b => b.id === tail.src)?.editRegions?.filter(r =>
    r.kind === old.kind && r.value === old.value && r.source?.file === old.source.file &&
    lineColToOffset(after, r.source.start.line, r.source.start.column) === newStart &&
    sourceTextForRegion(snapshot, r) === after) ?? [];
  if (regions.length !== 1) return null;
  let map, slot = null;
  if (old.kind === 'math') {
    const copy = math ?? await locateInlineSourceFormula(pageNumber, presented, owner, old, new Map(), current);
    map = copy?.map;
    if (map?.length && current()) {
      const geometry = window.TdomDirectEditGeometry, paper = activePaperGeometry(page);
      const shapes = await geometry.formulaPageShapes(presented.image);
      const original = geometry.isolatedFormulaSlot(shapes, map, paper, copy.structures);
      const rect = original?.rect;
      // The rest of the page was not translated. The edit overlay must
      // stay entirely inside the crop, including room for newly typed ink.
      if (rect && rect.left >= tail.x && rect.top >= tail.y && rect.bottom <= tail.y + tail.h &&
          Math.min(rect.right, tail.x + tail.w) >= Math.max(...map.map(g => g.right))) {
        slot = { ...original, paper, src: presented.src, rev: String(presented.rev), anchorRev: snapshot.srcRev,
          rect: { ...rect, left: rect.left + tail.dx, right: Math.min(rect.right, tail.x + tail.w) + tail.dx },
          color: getComputedStyle(page).backgroundColor,
          key: JSON.stringify([snapshot.documentEpoch, pageNumber, presented.src, snapshot.srcRev, directSourceRangeKey(regions[0])]) };
      }
    }
  } else if (old.kind === 'text' && oldHit.printBounds?.words) {
    const glyphs = await canonicalGlyphs(pageNumber, presented.id);
    map = window.TdomDirectEditGeometry.textMap(old.value, oldHit.printBounds.words, glyphs);
  }
  if (!current() || !map?.length || !map.every(g => g.left >= tail.x - 0.35 && g.right <= tail.x + tail.w + 0.35 &&
      g.top >= tail.y - 0.35 && g.bottom <= tail.y + tail.h + 0.35)) return null;
  map = map.map(g => ({ ...g, left: g.left + tail.dx, right: g.right + tail.dx }));
  return { snapshot, region: regions[0], map, printBounds: inkBounds(map, pageNumber),
    projectedRev: snapshot.srcRev, slot, caretOffset: old.kind === 'text' ? oldHit.caretOffset : null };
}

// A certified delta may be newer than the PDF underneath. Open its text
// against the exact source revision and hit-test the SVG actually on paper.
async function editAtAnchorInk(page, event) {
  const svg = page.querySelector(':scope > svg.tdom-canonical-delta');
  if (!svg) return undefined;
  const underPointer = node => {
    const r = node.getBoundingClientRect();
    return event.clientX >= r.left && event.clientX < r.right && event.clientY >= r.top && event.clientY < r.bottom;
  };
  if (![...svg.querySelectorAll('rect')].some(underPointer)) return undefined;
  const nodes = [...svg.querySelectorAll('text[data-src]')];
  const hit = nodes.find(underPointer);
  const anchor = canonicalAnchorPreview;
  if (!anchor || anchor.srcRev !== appliedSrcRev) return null;
  const point = paperPointForClick(event, page);
  if (!point) return null;
  const tail = anchor.pages.find(p => p.page === Number(page.dataset.page))?.tails?.find(t =>
    point.x >= t.x + t.dx && point.x < t.x + t.dx + t.w && point.y >= t.y && point.y < t.y + t.h);
  if (!hit && !tail) return null;
  const snapshot = await loadProvisionalSnapshot(anchor.srcRev).catch(() => null);
  if (!snapshot || Number(snapshot.srcRev) !== anchor.srcRev || canonicalAnchorPreview !== anchor ||
      !svg.isConnected || appliedSrcRev !== anchor.srcRev || documentReset.pending ||
      Number(snapshot.documentEpoch) !== documentReset.adoptedEpoch) return null;
  if (tail) return editAtPrintedTail(page, event, tail, snapshot, () => svg.isConnected &&
    canonicalAnchorPreview === anchor && anchor.srcRev === appliedSrcRev && !documentReset.pending);
  const block = snapshot.blocks.find(b => b.id === hit.dataset.src);
  const line = nodes.filter(n => n.dataset.src === hit.dataset.src && n.dataset.line === hit.dataset.line);
  const { glyphs } = directSvgGeometry(page, line);
  const geometry = window.TdomDirectEditGeometry;
  const matches = [];
  for (const region of block?.editRegions ?? []) {
    if (region.kind !== 'text') continue;
    for (const { map } of geometry.textMaps(region.value, glyphs, true)) {
      if (!map.some(g => point.x >= g.left && point.x <= g.right && point.y >= g.top && point.y <= g.bottom)) continue;
      matches.push({ region, snapshot, map, printBounds: inkBounds(map, Number(page.dataset.page)),
        caretOffset: geometry.hit(map, point) });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function textOnNativeRow(region, row, pageNumber, glyphs, words) {
  const lineGlyphs = glyphs.filter(g => Math.abs(g.baseline - row.y) <= 0.25 &&
    g.left >= row.box.left - 0.25 && g.right <= row.box.right + 0.25);
  const maps = window.TdomDirectEditGeometry.textMaps(region.value, lineGlyphs);
  if (maps.length !== 1) return null;
  const map = maps[0].map, ink = inkBounds(map, pageNumber);
  const matches = textMatchesOnPage(printedKey(region.value), words, pageNumber).filter(m =>
    Math.abs(m.left - ink.left) <= 1 && Math.abs(m.right - ink.right) <= 1 &&
    m.words.every(w => (w.top + w.bottom) / 2 >= ink.top && (w.top + w.bottom) / 2 <= ink.bottom));
  return matches.length === 1 ? { region, map, printBounds: matches[0] } : null;
}

function textOnParagraphRows(region, rows, page, glyphs, words) {
  // Keep Poppler's reading order, but only inside the native paragraph
  // rows. A Japanese closing punctuation mark may hang half a cell beyond
  // the measure, so test each glyph's center rather than its right edge.
  const inMeasure = (item, box) => {
    const x = (item.left + item.right) / 2;
    return x >= box.left - 0.25 && x <= box.right + 0.25;
  };
  const rowWords = words.filter(word => rows.some(row => row.y >= word.top && row.y <= word.bottom &&
    inMeasure(word, row.box)));
  const matches = textMatchesOnPage(printedKey(region.value), rowWords, page);
  if (matches.length !== 1) return null;
  const printBounds = matches[0];
  const map = window.TdomDirectEditGeometry.textMap(region.value, printBounds.words, glyphs);
  if (!map.length || !map.every(g => rows.some(row => Math.abs(row.y - g.baseline) <= 0.25 &&
      inMeasure(g, row.box)))) return null;
  return { region, map, printBounds };
}

// A line ending at a blank paragraph separator can be tagged with the
// separator in the native hbox tree, including in the second column of
// a sheet. Require both its printed glyphs and an inverse source anchor.
async function textAtParagraphEnd(region, snapshot, page, id, location = null) {
  const source = region.source;
  if (region.value !== (region.sourceValue ?? region.value)) return null;
  const lines = sourceTextForRegion(snapshot, region)?.split('\n');
  if (lines?.[source.end.line]?.trim() !== '') return null;
  const separator = { source: { file: source.file, start: { line: source.end.line + 1 }, end: { line: source.end.line + 1 } } };
  const [rows, glyphs, sheets] = await Promise.all([canonicalSourceEditBoxes(page, id, separator),
    canonicalGlyphs(page, id), canonicalTextBoxes(id, page)]);
  const paragraphRows = rows.filter(row => !row.empty && row.parentKind === 'vbox' && row.line === separator.source.start.line);
  const match = textOnParagraphRows(region, paragraphRows, page, glyphs, sheets[0] ?? []);
  if (!match) return null;
  const word = match.printBounds.words[0];
  const inverse = location ?? await fetch('/synctex', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, page, x: (word.left + word.right) / 2, y: (word.top + word.bottom) / 2 }),
  }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!sameSourceFile(inverse?.file, source.file)) return null;
  const onSource = inverse.line >= source.start.line && inverse.line <= separator.source.start.line;
  return onSource && inverse.lineText === lines[inverse.line - 1]?.replace(/\r$/, '') &&
    !documentReset.pending && Number(snapshot.documentEpoch) === documentReset.adoptedEpoch ? match : null;
}

// Resolve a complete prose run on the displayed sheet. A matching string
// alone is insufficient: its actual PDF glyphs must share the TeX baseline
// and horizontal extent of exactly one source row.
async function textAtNativeRow(snapshot, pageNumber, id, point, word, stillCurrent) {
  const geometry = window.TdomDirectEditGeometry;
  const token = printedKey(word?.text);
  if (!token || point.x < word.left || point.x > word.right || point.y < word.top || point.y > word.bottom) return null;
  const files = new Map(), candidates = [];
  for (const block of snapshot.blocks ?? []) {
    if (block.type !== 'paragraph' || block.pages?.length !== 1 || block.pages[0] !== pageNumber) continue;
    for (const region of block.editRegions ?? []) {
      const source = region.source;
      if (region.kind !== 'text' || !source?.file || source.start.line !== source.end.line ||
          !printedKey(region.value).includes(token)) continue;
      if (!files.has(source.file)) files.set(source.file, new Set());
      files.get(source.file).add(source.start.line);
      candidates.push({ ...region, blockSource: block.source });
    }
  }
  if (!candidates.length) return null;
  const glyphs = await canonicalGlyphs(pageNumber, id);
  if (!stillCurrent()) return null;
  const underPointer = glyphs.filter(g => point.x >= g.left && point.x <= g.right && point.y >= g.top && point.y <= g.bottom);
  if (!underPointer.length) return null;
  const hits = [];
  for await (const { file, boxes } of pageSourceRowGroups(files, pageNumber, id, stillCurrent)) {
    const sourceRows = boxes.filter(row => !row.empty && row.parentKind === 'vbox');
    for (const row of sourceRows) {
      if (point.x < row.box.left || point.x > row.box.right ||
          !underPointer.some(g => Math.abs(g.baseline - row.y) <= 0.25)) continue;
      for (const region of candidates) {
        if (region.source.file !== file || region.source.start.line !== row.line ||
            region.value !== (region.sourceValue ?? region.value)) continue;
        const match = textOnNativeRow(region, row, pageNumber, glyphs, word.pageWords);
        if (!match?.printBounds.words.includes(word.pageWords[word.readingIndex]) ||
            !match.map.some(g => point.x >= g.left && point.x <= g.right && point.y >= g.top && point.y <= g.bottom)) continue;
        // A wrapped line or repeated inclusion can assign multiple physical
        // rows to the same TeX line. Require a single printed occurrence.
        if (sourceRows.some(other => other !== row && other.line === row.line &&
            textOnNativeRow(region, other, pageNumber, glyphs, word.pageWords))) continue;
        hits.push({ region, printBounds: match.printBounds, caretOffset: geometry.hit(match.map, point) });
      }
    }
  }
  return stillCurrent() && hits.length === 1 ? hits[0] : null;
}

// Locate an alignment cell in the displayed generation before matching the
// ink inside it. Repeated headers on a later sheet point to their original
// editable source row; identical formulas in neighboring cells stay distinct.
const tableRowsCache = new WeakMap();
function tableRowsByFile(regions) {
  let files = tableRowsCache.get(regions);
  if (files) return files;
  files = new Map();
  for (const region of regions) {
    const file = region.source?.file;
    if (region.tableRow == null || !file) continue;
    if (!files.has(file)) files.set(file, new Map());
    const rows = files.get(file);
    if (!rows.has(region.tableRow)) rows.set(region.tableRow, []);
    rows.get(region.tableRow).push(region);
  }
  tableRowsCache.set(regions, files);
  return files;
}

async function editAtTableCell(snapshot, pageNumber, id, point, stillCurrent) {
  const geometry = window.TdomDirectEditGeometry;
  let cell;
  for (const block of snapshot.blocks ?? []) {
    if (!block.pages?.includes(pageNumber) || !block.editRegions?.length) continue;
    for (const [file, rows] of tableRowsByFile(block.editRegions)) {
      const boxes = await canonicalSourceEditBoxes(pageNumber, id, { source: { file } }, true);
      if (!stillCurrent()) return null;
      const found = geometry.locateTableCell(rows, boxes, { point });
      if (found && cell) return null;
      if (found) cell = found;
    }
  }
  if (!cell || !stillCurrent()) return null;
  const hits = await tableCellInk(cell, pageNumber, id, stillCurrent);
  const hit = hits && inlineFormulaHit(hits, pageNumber, point);
  return hit && { ...hit, byInk: true, caretOffset: geometry.hit(hit.map, point) };
}

async function tableCellInk({ box, regions }, pageNumber, id, stillCurrent, target = null) {
  const geometry = window.TdomDirectEditGeometry;
  const glyphs = (await canonicalGlyphs(pageNumber, id)).filter(g => {
    const x = (g.left + g.right) / 2, y = (g.top + g.bottom) / 2;
    return x >= box.left && x <= box.right && y >= box.top - 1 && y <= box.bottom + 1;
  });
  if (!glyphs.length || !stillCurrent()) return null;
  const hits = [];
  const values = new Map();
  for (const region of regions) {
    if (target && (region.kind !== target.kind || region.value !== target.value)) continue;
    const key = JSON.stringify([region.kind, region.value]);
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(region);
  }
  let field;
  try {
    for (const same of values.values()) {
      const { kind, value } = same[0];
      let copies;
      if (kind === 'math') {
        const Mathfield = customElements.get('math-field');
        if (!Mathfield) return null;
        if (!field) {
          field = new Mathfield();
          field.readOnly = true;
          field.inert = true;
          field.mathVirtualKeyboardPolicy = 'manual';
          Object.assign(field.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden' });
          document.body.appendChild(field);
        }
        field.value = value;
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!stillCurrent()) return null;
        copies = geometry.mathMaps(field, glyphs, box, { contiguous: true });
      } else copies = geometry.textMaps(value, glyphs);
      if (copies.length !== same.length) continue;
      copies.forEach(({ map }, index) => {
        const hit = { region: same[index], map, extent: box };
        if (target && /\\(?:[dt]?frac|sqrt)\b/.test(value)) {
          if (!geometry.completeDisplayMap(field, map)) return;
          hit.structures = geometry.printedMathStructures(field, map, glyphs);
          if (!hit.structures?.length) return;
        }
        hits.push(hit);
      });
    }
  } finally { field?.remove(); }
  return hits;
}

async function resolveOpaqueEditRegion(page, event) {
  if (!page) page = pageAtClientPoint(event);
  if (!usesDirectEditSurface(page)) return null;
  const pageNumber = Number(page?.dataset?.page);
  const point = paperPointForClick(event, page);
  if (!page || !Number.isInteger(pageNumber) || !point) return null;
  const presented = presentedPageState(page);
  if (!presented) return null;
  const stillPresented = () => {
    const current = presentedPageState(page);
    return current?.id === presented.id && current?.rev === presented.rev && current?.src === presented.src;
  };
  const domSnapshot = presented.snapshot;
  const cell = await editAtTableCell(domSnapshot, pageNumber, presented.id, point, stillPresented);
  if (cell || !stillPresented()) return cell;
  const clickedWord = await canonicalWordAtPoint(pageNumber, point, presented.id);
  if (!stillPresented()) return null;
  // A fraction or script is often smaller than the prose next to it. Try
  // the native source rows on this sheet first. Size only selects a lookup:
  // both neighboring words, the source delimiters and the printed math
  // must prove the same occurrence before the host can edit it.
  if (clickedWord?.pageWords.some(neighbor =>
    neighbor.bottom - neighbor.top > 1.2 * (clickedWord.bottom - clickedWord.top) &&
    neighbor.right >= clickedWord.left - 36 && neighbor.left <= clickedWord.right + 36 &&
    neighbor.bottom >= clickedWord.top && neighbor.top <= clickedWord.bottom)) {
    const ink = await inlineMathFromForwardRows(domSnapshot, pageNumber, point, presented.id, stillPresented, true);
    if (!stillPresented()) return null;
    if (ink) return { ...ink, byInk: true, caretOffset: caretOffsetForOpaqueRegion(ink.region, null, clickedWord, ink.printBounds, point) };
  }
  const prose = await textAtNativeRow(domSnapshot, pageNumber, presented.id, point, clickedWord, stillPresented);
  if (!stillPresented()) return null;
  if (prose) return prose;
  const location = await syncLocationForClick(event, page);
  if (!stillPresented()) return null;
  const word = printedKey(clickedWord?.text);
  if (word && location?.file && Number.isInteger(location.line)) {
    const sourceLine = location.lineText?.trim() === '' ? location.line - 1 : location.line;
    const candidates = (domSnapshot.blocks ?? []).flatMap(block => block.type === 'paragraph'
      ? (block.editRegions ?? []).filter(region => region.kind === 'text' && region.source?.start.line <= sourceLine && region.source.end.line >= sourceLine &&
        sameSourceFile(region.source.file, location.file) && printedKey(region.value).includes(word)) : []);
    if (candidates.length === 1) {
      const match = await textAtParagraphEnd(candidates[0], domSnapshot, pageNumber, presented.id, location);
      if (!stillPresented()) return null;
      if (match?.printBounds.words.includes(clickedWord.pageWords[clickedWord.readingIndex]) &&
          match.map.some(g => point.x >= g.left && point.x <= g.right && point.y >= g.top && point.y <= g.bottom)) {
        return { region: match.region, printBounds: match.printBounds,
          caretOffset: window.TdomDirectEditGeometry.hit(match.map, point) };
      }
    }
  }
  const resolveRepeatedInk = async candidate => {
    const valueKey = region => region.kind === 'math'
      ? JSON.stringify(mathSourceTokens(region.value).map(token => token[0])) : printedKey(region.value);
    const sourceKey = region => JSON.stringify([region.source?.file, region.source?.start, region.source?.end]);
    const selected = candidate.region;
    if (selected.kind === 'text') {
      const mappings = await canonicalTextRegionMappings(selected, domSnapshot, presented.id);
      if (!stillPresented()) return null;
      const hits = mappings.filter(item => item.printBounds.page === pageNumber &&
        item.printBounds.words.some(word => point.x >= word.left - 2 && point.x <= word.right + 2 &&
          point.y >= word.top - 2 && point.y <= word.bottom + 2));
      if (hits.length !== 1) return null;
      const hit = hits[0];
      return { ...hit, caretOffset: caretOffsetForOpaqueRegion(hit.region, location, clickedWord, hit.printBounds, point) };
    }
    const identical = new Map();
    for (const block of domSnapshot.blocks ?? []) {
      for (const region of block.editRegions ?? []) {
        if (region.kind === selected.kind && valueKey(region) === valueKey(selected) &&
            sameSourceFile(region.source?.file, selected.source?.file)) {
          identical.set(sourceKey(region), { ...region, blockSource: block.source ?? null });
        }
      }
    }
    if (identical.size < 2) return candidate;
    if (!location?.file || !sameSourceFile(selected.source?.file, location.file)) return null;
    const sameLine = [...identical.values()].filter(region => sourceContainsPosition(region, { ...location, column: 1 }));
    const precise = Number(location.column) > 1
      ? sameLine.filter(region => sourceContainsPosition(region, location)) : [];
    if (precise.length === 1 || sameLine.length === 1) {
      return { ...candidate, region: precise[0] ?? sameLine[0] };
    }
    if (!sameLine.length) return null;

    // Forward SyncTeX often assigns every column of a source line the same
    // enclosing hbox. In that case each repeated value's nearest lookup
    // would resolve to this same clicked copy. Enumerate the line's copies,
    // including other pages, before assigning their source boundaries.
    const probes = sameLine.flatMap(region =>
      window.TdomOpaqueEditorCoordinator?.sourceProbeLocations?.(region) ??
      [region.source.start, region.source.end].map(position => ({ file: region.source.file, ...position })));
    const response = await fetch('/synctex/forward', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: presented.id, locations: probes }),
    }).catch(() => null);
    const forward = response?.ok ? (await response.json()).results?.filter(Boolean) ?? [] : [];
    if (!stillPresented() || !forward.length) return null;
    const pageNumbers = [...new Set([pageNumber, ...forward.map(item => Number(item.page))])]
      .filter(number => Number.isInteger(number) && number > 0).sort((a, b) => a - b);
    const geometry = window.TdomDirectEditGeometry;
    let probe = null;
    const occurrences = [];
    try {
      if (selected.kind === 'math') {
        const Mathfield = customElements.get('math-field');
        if (!Mathfield) return null;
        probe = new Mathfield();
        probe.mathVirtualKeyboardPolicy = 'manual';
        probe.setAttribute('aria-hidden', 'true');
        Object.assign(probe.style, { position: 'fixed', left: '-10000px', top: '0', opacity: '0', pointerEvents: 'none' });
        document.body.appendChild(probe);
        probe.value = shouldWrapAligned(selected.value) ? wrapAligned(selected.value) : selected.value;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      for (const number of pageNumbers) {
        const glyphs = await canonicalGlyphs(number, presented.id);
        if (!stillPresented()) return null;
        if (!glyphs.length) continue;
        const bounds = { left: Math.min(...glyphs.map(g => g.left)), right: Math.max(...glyphs.map(g => g.right)),
          top: Math.min(...glyphs.map(g => g.top)), bottom: Math.max(...glyphs.map(g => g.bottom)) };
        const maps = selected.kind === 'text'
          ? geometry.textMaps(selected.value, glyphs) : geometry.mathMaps(probe, glyphs, bounds);
        for (const { map } of maps) {
          const glyph = map[0];
          const inverse = await fetch('/synctex', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: presented.id, page: number, x: (glyph.left + glyph.right) / 2, y: (glyph.top + glyph.bottom) / 2 }),
          }).then(result => result.ok ? result.json() : null).catch(() => null);
          if (!stillPresented()) return null;
          if (sameSourceFile(inverse?.file, location.file) && Number(inverse?.line) === Number(location.line)) {
            occurrences.push({ page: number, map, location: inverse });
          }
        }
      }
    } finally { probe?.remove(); }
    if (occurrences.length !== sameLine.length) return null;
    const ordered = sameLine.sort((a, b) => a.source.start.line - b.source.start.line || a.source.start.column - b.source.start.column);
    // Preserve PDF content-stream order within a source line. If a precise
    // inverse column contradicts that order, the layout is not a simple
    // line continuation and must not be assigned by proximity.
    if (occurrences.some((occurrence, index) => Number(occurrence.location.column) > 1 &&
        !sourceContainsPosition(ordered[index], occurrence.location))) return null;
    const hits = occurrences.map((occurrence, index) => {
      if (occurrence.page !== pageNumber) return null;
      const hit = geometry.nearest(occurrence.map, point);
      return hit && point.x >= hit.left - 2 && point.x <= hit.right + 2 &&
        point.y >= hit.top - 1 && point.y <= hit.bottom + 1 ? { ...occurrence, region: ordered[index] } : null;
    }).filter(Boolean);
    if (hits.length !== 1) return null;
    const hit = hits[0];
    const printBounds = hit.region.kind === 'text'
      ? await canonicalTextBounds(hit.region.value, pageNumber, point, presented.id)
      : { page: pageNumber, left: Math.min(...hit.map.map(g => g.left)), right: Math.max(...hit.map.map(g => g.right)),
        top: Math.min(...hit.map.map(g => g.top)), bottom: Math.max(...hit.map.map(g => g.bottom)) };
    if (!printBounds || !stillPresented()) return null;
    return { region: hit.region, printBounds,
      caretOffset: caretOffsetForOpaqueRegion(hit.region, location, clickedWord, printBounds, point) };
  };
  const mixed = mixedParagraphsAtLine(domSnapshot, location, pageNumber);
  const printedCandidates = [];
  for (const block of domSnapshot.blocks ?? []) {
    for (const item of block.editRegions ?? []) {
      if (item.kind !== 'text' ||
          location?.file && !mixed.includes(block) && !sameSourceFile(item.source?.file, location.file) ||
          word && !printedKey(item.value).includes(word)) continue;
      const bounds = await canonicalTextBounds(item.value, pageNumber, point, presented.id);
      if (!bounds || point.x < bounds.left - 2 || point.x > bounds.right + 2 ||
          point.y < bounds.top - 2 || point.y > bounds.bottom + 2) continue;
      printedCandidates.push({
        region: { ...item, blockSource: block.source ?? null },
        printBounds: bounds,
        caretOffset: caretOffsetForOpaqueRegion(item, location, clickedWord, bounds, point),
      });
    }
  }
  if (!stillPresented()) return null;
  if (printedCandidates.length) {
    return resolveRepeatedInk(printedCandidates.sort((a, b) =>
      (sourceDistanceToRegion(a.region, location) - sourceDistanceToRegion(b.region, location)) ||
      (a.printBounds.right - a.printBounds.left) * (a.printBounds.bottom - a.printBounds.top) -
      (b.printBounds.right - b.printBounds.left) * (b.printBounds.bottom - b.printBounds.top)
    )[0]);
  }
  if (!location?.file || !Number.isFinite(Number(location.line))) return null;
  let inkLookup;
  const mathByInk = async () => {
    inkLookup ??= inlineMathUnderPoint(domSnapshot, location, pageNumber, point, presented.id, stillPresented);
    const ink = await inkLookup;
    if (!stillPresented() || !ink) return null;
    return { ...ink, byInk: true,
      caretOffset: caretOffsetForOpaqueRegion(ink.region, location, clickedWord, ink.printBounds, point) };
  };
  if (mixed.length) {
    // A paragraph can begin in the root and end with display math from a
    // child. Its outer SyncTeX box may name either file. Only a complete
    // expression on the clicked source row and actual glyph can open it.
    const displays = mixed.flatMap(block => (block.editRegions ?? []).filter(region =>
      region.kind === 'math' && region.display && sourceNearLine(region.source, location)));
    const copies = [];
    for (const region of displays) {
      const match = await locateDisplaySourceFormula(pageNumber, presented, region, stillPresented);
      if (!stillPresented()) return null;
      if (match) copies.push({ ...match, region, extent: inkBounds(match.map, pageNumber) });
    }
    const hit = inlineFormulaHit(copies, pageNumber, point);
    if (hit) return { ...hit, caretOffset: window.TdomDirectEditGeometry.hit(hit.map, point) };
    return mathByInk();
  }
  const sourceColumn = sourceColumnForOpaqueClick(location, point);
  const atPoint = { ...location, column: sourceColumn };
  // A paragraph may start in the root and continue in an included file.
  // Each editable region retains its own source in that case.
  const blocks = (domSnapshot.blocks ?? []).filter(block => sourceNearLine(block.source, location) ||
    block.editRegions?.some(item => sourceNearLine(item.source, location)));

  // Prefer the exact forward SyncTeX boxes for math on this source line.
  // This avoids converting proportional TeX glyph advances into a source
  // column by a linear character-count ratio.
  const sourceMath = blocks.flatMap(block => (block.editRegions ?? [])
    .filter(item => item.kind === 'math' && sourceNearLine(item.source, location))
    .map(item => ({ ...item, blockSource: block.source ?? null })));
  // Inline expressions on one source row share a native line box. The row
  // and complete glyph match already identify the expression; spawning a
  // forward SyncTeX query per expression first can hold a click for seconds.
  if (sourceMath.length && sourceMath.every(region => !region.display)) {
    const ink = await mathByInk();
    if (ink || !stillPresented()) return ink;
  }
  const spatialMath = [];
  for (const region of sourceMath) {
    const bounds = await canonicalSourceBounds(region, pageNumber, presented.id, point);
    if (!stillPresented()) return null;
    if (!bounds || point.x < bounds.left - 3 || point.x > bounds.right + 3 ||
        point.y < bounds.top - 3 || point.y > bounds.bottom + 3) continue;
    spatialMath.push({
      region,
      printBounds: bounds,
      caretOffset: caretOffsetForOpaqueRegion(region, location, clickedWord, bounds, point),
    });
  }
  if (spatialMath.length) {
    // Inline expressions on one source line often share a forward SyncTeX
    // rectangle. Its midpoint and a projected column do not identify the
    // printed expression, even in a single-file document.
    if (spatialMath.every(item => !item.region.display)) {
      // Even a unique source range may describe just a numerator or
      // denominator box. Match the full expression before placing its caret.
      if (sourceMath.some(region => region.display)) {
        const ink = await mathByInk();
        if (!stillPresented() || ink) return ink;
      }
      if (spatialMath.length === 1) return resolveRepeatedInk(spatialMath[0]);
      const precise = Number(location.column) > 1
        ? spatialMath.filter(item => sourceContainsPosition(item.region, location)) : [];
      return precise.length === 1 ? resolveRepeatedInk(precise[0]) : null;
    }
    spatialMath.sort((a, b) => {
      const aContains = sourceContainsPosition(a.region, atPoint) ? 0 : 1;
      const bContains = sourceContainsPosition(b.region, atPoint) ? 0 : 1;
      if (aContains !== bContains) return aContains - bContains;
      const acx = (a.printBounds.left + a.printBounds.right) / 2;
      const acy = (a.printBounds.top + a.printBounds.bottom) / 2;
      const bcx = (b.printBounds.left + b.printBounds.right) / 2;
      const bcy = (b.printBounds.top + b.printBounds.bottom) / 2;
      return (acx - point.x) ** 2 + (acy - point.y) ** 2 -
        ((bcx - point.x) ** 2 + (bcy - point.y) ** 2);
    });
    return resolveRepeatedInk(spatialMath[0]);
  }
  // A blank margin, column gutter or line-end has neither a canonical word
  // nor an exact math box. Reverse SyncTeX returns the nearest source line,
  // but proximity is navigation data, not proof that editable ink was hit.
  if (!clickedWord) return null;
  // SyncTeX names a formula's own source line only where the formula's nodes
  // carry it. In some paragraphs (seen where a verbatim macro stands in the
  // same paragraph) a click on an inline formula gives the line that ended
  // the paragraph instead: no block holds that line, no formula was looked
  // at above, and the click opened nothing. There the formula is found by
  // its ink (inlineMathUnderPoint): taken only when exactly one formula of
  // the paragraph that ends at that line is printed under the pointer.
  const inkMath = await mathByInk();
  if (!stillPresented() || inkMath) return inkMath;
  for (const block of blocks) {
    const regions = (block.editRegions ?? [])
      .filter((region) => sameSourceFile(region.source?.file, location.file))
      .map((region) => ({ ...region, blockSource: block.source ?? null }));
    let candidates = regions.filter((region) => sourceContainsPosition(region, atPoint));
    if (clickedWord && candidates.some((region) => region.kind === 'text')) {
      const word = printedKey(clickedWord.text);
      const visible = candidates.filter((region) =>
        region.kind !== 'text' || printedKey(region.value).includes(word)
      );
      // A reference/citation number can reverse-map to the surrounding
      // source line. If the printed word is not part of any editable value,
      // it remains navigation/structure rather than opening nearby prose.
      candidates = visible.some((region) => region.kind === 'text') ||
        candidates.some((region) => region.kind !== 'text') ? visible : [];
    }
    let generatedIndex = null;
    let generatedAnchor = null;
    if (!candidates.length) {
      const generated = regions.filter((region) =>
        Number(region.source?.end?.line) < Number(block.source?.start?.line)
      ).sort((a, b) =>
        Number(a.source.start.line) - Number(b.source.start.line) ||
        Number(a.source.start.column) - Number(b.source.start.column)
      );
      if (generated.length) {
        const printed = await Promise.all(generated.map((region) =>
          canonicalTextBounds(region.value, Number(page.dataset.page), point, presented.id)
        ));
        if (!stillPresented()) return null;
        const printedIndex = printed.findIndex((bounds) => bounds && point &&
          point.x >= bounds.left - 3 && point.x <= bounds.right + 3 &&
          point.y >= bounds.top - 3 && point.y <= bounds.bottom + 3);
        if (printedIndex >= 0) {
          generatedIndex = printedIndex;
          generatedAnchor = { page: Number(page.dataset.page), ...printed[printedIndex], box: printed[printedIndex] };
        }
        const anchors = (location.anchors ?? [])
          .filter((item) => item.page === Number(page.dataset.page))
          .sort((a, b) => a.y - b.y ||
            (b.box.right - b.box.left) - (a.box.right - a.box.left))
          .filter((item, index, all) => index === 0 ||
            Math.abs(item.y - all[index - 1].y) > 1);
        if (generatedIndex == null && anchors.length && point) {
          let anchorIndex = 0;
          let best = Infinity;
          for (let index = 0; index < anchors.length; index++) {
            const center = (anchors[index].box.top + anchors[index].box.bottom) / 2;
            const distance = Math.abs(point.y - center);
            if (distance < best) {
              best = distance;
              anchorIndex = index;
            }
          }
          generatedIndex = anchors.length === 1
            ? 0
            : Math.round((anchorIndex / (anchors.length - 1)) * (generated.length - 1));
          generatedAnchor = anchors[anchorIndex];
        } else if (generatedIndex == null) {
          const anchor = location.anchor?.box;
          const ratio = anchor && point && anchor.bottom > anchor.top
            ? Math.max(0, Math.min(0.999, (point.y - anchor.top) / (anchor.bottom - anchor.top)))
            : 0;
          generatedIndex = Math.min(generated.length - 1, Math.floor(ratio * generated.length));
        }
        candidates = [generated[generatedIndex]];
      }
    }
    if (!candidates.length) continue;
    const region = candidates.sort((a, b) => {
      const ac = (Number(a.source.start.column) + Number(a.source.end.column)) / 2;
      const bc = (Number(b.source.start.column) + Number(b.source.end.column)) / 2;
      return Math.abs(ac - sourceColumn) - Math.abs(bc - sourceColumn);
    })[0];
    const printBounds = await opaquePrintBounds(
      region,
      generatedAnchor ? { ...location, anchor: generatedAnchor } : location,
      point,
      generatedIndex,
      generatedIndex == null ? null : regions.filter((item) =>
        Number(item.source?.end?.line) < Number(block.source?.start?.line)
      ).length,
      presented.id
    );
    if (!stillPresented()) return null;
    if (!printBounds || point.x < printBounds.left - 3 || point.x > printBounds.right + 3 ||
        point.y < printBounds.top - 3 || point.y > printBounds.bottom + 3) return null;
    return resolveRepeatedInk({
      region,
      printBounds,
      caretOffset: caretOffsetForOpaqueRegion(region, location, clickedWord, printBounds, point),
    });
  }
  return null;
}

function chooseRegionByGeometry(candidates, target, event, page, src) {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const sorted = [...candidates].sort(
    (a, b) => a.source.start.line - b.source.start.line || a.source.start.column - b.source.start.column
  );
  const sourceHits = [...page.querySelectorAll('.tdom-source-hit')]
    .filter((node) => node.dataset.src === src && node.getBoundingClientRect().height > 1.5)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  if (target.classList.contains('tdom-source-hit') && sourceHits.length > 1) {
    const targetIndex = sourceHits.indexOf(target);
    const byLine = [];
    for (const region of sorted) {
      const line = region.source.start.line;
      let group = byLine.find((item) => item.line === line);
      if (!group) {
        group = { line, regions: [] };
        byLine.push(group);
      }
      group.regions.push(region);
    }
    if (byLine.length > 1 && targetIndex >= 0) {
      const index = Math.round((targetIndex / Math.max(1, sourceHits.length - 1)) * (byLine.length - 1));
      candidates = byLine[Math.max(0, Math.min(byLine.length - 1, index))].regions;
      if (candidates.length === 1) return candidates[0];
    }
  }

  const rect = target.getBoundingClientRect();
  if (!rect.width) return candidates[0] ?? null;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const start = Math.min(...candidates.map((region) => region.source.start.column));
  const end = Math.max(...candidates.map((region) => region.source.end.column));
  const sourceColumn = start + ratio * Math.max(1, end - start);
  return candidates.find(
    (region) => sourceColumn >= region.source.start.column - 0.35 &&
      sourceColumn <= region.source.end.column + 0.35
  ) ?? null;
}

async function provisionalRegionAtPoint(page, sourceId, candidates, event, rule = null) {
  const point = paperPointForClick(event, page);
  const surfaces = [...pageDivs.values()].filter(surface =>
    surface.querySelector(`.chunkwin[data-src="${CSS.escape(sourceId)}"]`));
  const pages = await Promise.all(surfaces.map(async surface => ({
    surface, epoch: surface.provisionalEpoch, pageNumber: Number(surface.dataset.page),
    glyphs: await chunkGlyphsOnPage(surface, sourceId),
  })));
  const current = () => pages.every(p => p.surface.isConnected && p.surface.provisionalEpoch === p.epoch);
  if (!current()) return null;
  const clickedGlyphs = pages.find(p => p.surface === page)?.glyphs ?? [];
  if (!rule && !clickedGlyphs.some(g => point.x >= g.left - 2 && point.x <= g.right + 2 && point.y >= g.top - 1 && point.y <= g.bottom + 1)) return undefined;
  const geometry = window.TdomDirectEditGeometry;
  const groups = new Map();
  for (const region of candidates) {
    const key = region.kind === 'math'
      ? 'math:' + JSON.stringify(mathSourceTokens(region.value).map(token => token[0]))
      : 'text:' + region.value;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(region);
  }
  const matches = [], textInk = new Map();
  const chunks = page.querySelectorAll(`.chunkwin[data-src="${CSS.escape(sourceId)}"]`);
  const wholeTable = !rule && surfaces.length === 1 && chunks.length === 1 && chunks[0].querySelector('img.chunk') &&
    clickedGlyphs.length <= 4096 &&
    candidates.length && candidates.every(r => r.tableRow != null);
  const runsByRegion = new Map();
  function collect(group, probe) {
    const region = group[0];
    const tableRuns = wholeTable ? geometry.tablePaintRuns(region.value, probe, clickedGlyphs) : null;
    if (tableRuns) {
      const byStart = new Map();
      for (const run of tableRuns) {
        byStart.set(run.start, byStart.has(run.start) ? null : run);
      }
      for (const item of group) runsByRegion.set(item, byStart);
    }
    const occurrences = pages.flatMap(p => {
      if (!p.glyphs.length) return [];
      const maps = tableRuns ?? (region.kind === 'text'
        ? geometry.textMaps(region.value, p.glyphs) : geometry.mathMaps(probe, p.glyphs));
      return maps.map(({ map }) => ({ map, pageNumber: p.pageNumber,
        top: Math.min(...map.map(g => g.top)), left: Math.min(...map.map(g => g.left)) }));
    }).sort((a, b) => a.pageNumber - b.pageNumber || a.top - b.top || a.left - b.left);
    // Count copies across every page of the block. When different source
    // spellings produce the same ink, require the neighboring prose to
    // identify the clicked copy before accepting it.
    const counted = occurrences.length === group.length && (!wholeTable || group.length === 1);
    if (!counted && region.kind !== 'math') return;
    for (let index = 0; index < occurrences.length; index++) {
      const occurrence = occurrences[index];
      if (occurrence.pageNumber !== Number(page.dataset.page)) continue;
      if (region.kind === 'text') {
        const ink = singleLineInk(occurrence.map, occurrence.pageNumber, group.length === 1);
        if (ink) textInk.set(group[index], ink);
      }
      const hit = geometry.nearest(occurrence.map, point);
      const atGlyph = hit && point.x >= hit.left - 2 && point.x <= hit.right + 2 &&
        point.y >= hit.top - 1 && point.y <= hit.bottom + 1;
      if (rule ? !geometry.fractionAtRule(probe, occurrence.map, rule) : !atGlyph) continue;
      const target = counted ? group[index] :
        witnessedInlineFormula(group, occurrence, textInk, candidates, page.provisionalSnapshot, clickedGlyphs);
      if (target) matches.push({ region: target, distance: rule ? 0 : Math.abs((hit.top + hit.bottom) / 2 - point.y) });
    }
  }
  const formulas = [];
  for (const group of groups.values()) {
    if (group[0].kind === 'math') formulas.push(group);
    else collect(group, null);
  }
  // Each field needs a rendered atom layout. Measure independent formulas
  // on the same frame and reuse a bounded set of fields on dense pages.
  const Mathfield = customElements.get('math-field');
  const probes = [];
  const batchSize = 6;
  try {
    for (let first = 0; Mathfield && first < formulas.length; first += batchSize) {
      const batch = formulas.slice(first, first + batchSize);
      for (const [index, group] of batch.entries()) {
        if (!probes[index]) {
          const field = new Mathfield();
          field.mathVirtualKeyboardPolicy = 'manual';
          field.readOnly = true;
          field.inert = true;
          Object.assign(field.style, { position: 'fixed', left: '-10000px', top: '0', opacity: '0', pointerEvents: 'none' });
          probes.push(field);
          document.body.append(field);
        }
        const value = group[0].value;
        probes[index].value = shouldWrapAligned(value) ? wrapAligned(value) : value;
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (!current()) return null;
      for (const [index, group] of batch.entries()) collect(group, probes[index]);
    }
  } finally { for (const probe of probes) probe.remove(); }
  if (!current()) return null;
  if (wholeTable) {
    const ink = geometry.tablePaintHit(candidates, clickedGlyphs, runsByRegion, point);
    if (ink !== undefined) return ink ? { ...ink.region, chunkMap: ink.map } : null;
  }
  matches.sort((a, b) => a.distance - b.distance);
  if (matches.length > 1 && Math.abs(matches[0].distance - matches[1].distance) < 0.01) return null;
  return matches[0]?.region ?? null;
}

async function resolveEditRegion(target, event) {
  const src = srcOf(target);
  let page = target.closest('#pages > .page');
  if (!src || !page) return null;
  const targetSnapshot = {
    pageNumber: Number(page.dataset.page),
    line: target.dataset.line ?? null,
    math: target.dataset.math === '1',
    text: String(target.textContent ?? '').trim(),
    sourceHit: target.classList.contains('tdom-source-hit'),
  };
  const block = await editBlockBySourceId(src, page);
  let candidates = [...(block?.editRegions ?? [])]
    .map((region) => ({ ...region, blockSource: block?.source ?? null }));
  if (!candidates.length) return null;

  // Fetching /dom can overlap a provisional page repaint. The clicked SVG
  // glyph is then detached even though the same printed glyph is already in
  // the replacement SVG. Reacquire it by source identity and click point so
  // rapid edits at a second location do not disappear between those steps.
  if (!target.isConnected) {
    page = pageDivs.get(targetSnapshot.pageNumber) ?? page;
    const nodes = [...page.querySelectorAll(`[data-src="${CSS.escape(src)}"]`)]
      .filter((node) => targetSnapshot.math === (node.dataset.math === '1'));
    const atPoint = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 &&
        event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    const sameText = targetSnapshot.text
      ? nodes.find((node) => String(node.textContent ?? '').trim() === targetSnapshot.text)
      : null;
    const sameLine = targetSnapshot.line == null
      ? null
      : nodes.find((node) => node.dataset.line === targetSnapshot.line);
    const sameHit = targetSnapshot.sourceHit
      ? nodes.find((node) => node.classList.contains('tdom-source-hit'))
      : null;
    target = atPoint ?? sameText ?? sameLine ?? sameHit ?? nodes[0] ?? null;
    if (!target) return null;
  }

  if (target.dataset.part) {
    const rule = target.dataset.part === 'rule' ? target.getBBox() : null;
    return await provisionalRegionAtPoint(page, src, candidates.filter(region => region.kind === 'math'), event, rule) ?? null;
  }
  if (block?.gfx || target.classList.contains('tdom-source-hit')) {
    const matched = await provisionalRegionAtPoint(page, src, candidates, event);
    if (matched !== undefined) return matched;
  }

  if (target.dataset.math === '1') {
    const math = candidates.filter((region) => region.kind === 'math');
    if (math.length) candidates = math;
  } else if (!target.classList.contains('tdom-source-hit')) {
    const printed = String(target.textContent ?? '').replace(/\s+/g, '');
    if (printed) {
      const text = candidates.filter(
        (region) => region.kind === 'text' &&
          String(region.value ?? '').replace(/\s+/g, '').includes(printed)
      );
      if (text.length) candidates = text;
      else return null; // a reference/citation glyph is navigation, not prose
    } else return null; // images/rules are structural, never caption text
  }

  if (target.classList.contains('tdom-source-hit') && target.dataset.line != null) {
    const displayedLine = Number(target.dataset.line);
    const sourceLine = Number(block?.source?.start?.line);
    if (Number.isFinite(displayedLine) && Number.isFinite(sourceLine)) {
      const onDisplayedLine = candidates.filter((region) => {
        const start = Number(region.source?.start?.line) - sourceLine;
        const end = Number(region.source?.end?.line) - sourceLine;
        return Number.isFinite(start) && Number.isFinite(end) &&
          displayedLine >= start && displayedLine <= end;
      });
      if (onDisplayedLine.length) candidates = onDisplayedLine;
    }
  }

  const generatedFromPreamble = candidates.length > 0 && candidates.every((region) =>
    region.source?.file === block.source?.file &&
    Number(region.source?.end?.line) < Number(block.source?.start?.line)
  );
  if (target.classList.contains('tdom-source-hit') || block?.gfx) {
    const location = await syncLocationForClick(event, page);
    if (location) {
      const atPoint = candidates.filter((region) => sourceContainsPosition(region, location));
      if (atPoint.length) candidates = atPoint;
      else {
        // \maketitle pixels reverse-map to the \maketitle invocation, while
        // their editable values live in earlier \title/\author/\date lines.
        // Keep those candidates and let the vertically ordered source-hit
        // geometry below select the matching generated field.
        if (!generatedFromPreamble) return null;
      }
    } else if (
      block?.gfx &&
      !generatedFromPreamble &&
      !(
        candidates.length === 1 && candidates[0].kind === 'math' ||
        target.classList.contains('tdom-source-hit') &&
          target.dataset.ink === '1' &&
          target.dataset.complex !== '1'
      )
    ) {
      // Generated caption prefixes and references can repeat real source
      // words.  A complex graphics block needs current SyncTeX to
      // disambiguate them; during canonical convergence, do not guess. A
      // displayed math line with exactly one math region is already
      // unambiguous and remains immediately editable across consecutive
      // changes while the canonical page catches up.
      return null;
    } else if (
      target.classList.contains('tdom-source-hit') &&
      !generatedFromPreamble &&
      (target.dataset.ink !== '1' || target.dataset.complex === '1') &&
      !candidates.some((region) => Number(String(region.id).split(':').at(-1)) >= 1_000_000)
    ) {
      // An image/graphics box may share a rescued block with an editable
      // caption. Without current SyncTeX or glyph ink, do not guess that an
      // image click meant the caption.
      return null;
    }
  }
  return chooseRegionByGeometry(candidates, target, event, page, src);
}

function editBounds(id, page) {
  const nodes = [...page.querySelectorAll(`[data-edit="${CSS.escape(id)}"]`)]
    .filter((node) => !node.classList.contains('tdom-direct-editor'));
  if (!nodes.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
}

function unionNodeBounds(nodes) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes ?? []) {
    const rect = node?.getBoundingClientRect?.();
    if (!rect || (!rect.width && !rect.height)) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
}

function printedKey(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, '');
}

function textRegionNodes(page, src, value) {
  const wanted = printedKey(value);
  if (!wanted) return [];
  const nodes = [...page.querySelectorAll(`svg text[data-src="${CSS.escape(src)}"]`)]
    .filter((node) => node.dataset.math !== '1' && node.getBoundingClientRect().width > 0);
  const pieces = nodes.map((node) => printedKey(node.textContent));
  for (let start = 0; start < nodes.length; start++) {
    if (!pieces[start] || !wanted.startsWith(pieces[start])) continue;
    let joined = '';
    for (let end = start; end < nodes.length && joined.length <= wanted.length; end++) {
      joined += pieces[end];
      if (joined === wanted) return nodes.slice(start, end + 1);
      if (!wanted.startsWith(joined)) break;
    }
  }
  return [];
}

function mathRegionNodes(page, meta) {
  if (!meta?.src) return [];
  const selector = `[data-src="${CSS.escape(meta.src)}"]`;
  const mathGlyphs = [...page.querySelectorAll(`svg text${selector}[data-math="1"]`)]
    .filter((node) => node.getBoundingClientRect().width > 0);
  const clicked = Number(meta.line);
  const mathLines = [...new Set(mathGlyphs
    .map((node) => Number(node.dataset.line))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  let lineGroup = Number.isFinite(clicked) ? [clicked] : [];
  if (Number.isFinite(clicked) && mathLines.includes(clicked)) {
    const at = mathLines.indexOf(clicked);
    let first = at;
    let last = at;
    while (first > 0 && mathLines[first] - mathLines[first - 1] <= 1) first--;
    while (last + 1 < mathLines.length && mathLines[last + 1] - mathLines[last] <= 1) last++;
    lineGroup = mathLines.slice(first, last + 1);
  }
  const lineSet = new Set(lineGroup.map(String));
  const preciseNodes = [...page.querySelectorAll(`svg ${selector}[data-line]`)].filter((node) => {
    if (!lineSet.has(node.dataset.line)) return false;
    if (node.matches('text[data-math="1"]')) return true;
    // Fraction bars and similar TeX rules belong to the formula. Source-hit
    // rectangles span an entire printed line and must not widen an inline
    // formula editor into a separate line-sized input surface.
    return node.matches('rect:not(.tdom-edit-hit):not(.tdom-source-hit)');
  });
  if (preciseNodes.some((node) => node.matches('text[data-math="1"]'))) return preciseNodes;
  // Exact-render image chunks have no individual SVG glyphs. Their source
  // hit is the only provisional geometry available until inverse SyncTeX
  // boxes are carried into the display list.
  const blockLine = Number(directEditor?.region?.blockSource?.start?.line);
  const regionStart = Number(directEditor?.region?.source?.start?.line);
  const regionEnd = Number(directEditor?.region?.source?.end?.line);
  const exactLineSet = Number.isFinite(blockLine) && Number.isFinite(regionStart) && Number.isFinite(regionEnd)
    ? new Set(Array.from(
      { length: Math.max(1, regionEnd - regionStart + 1) },
      (_, index) => String(regionStart - blockLine + index)
    ))
    : lineSet;
  return [...page.querySelectorAll(`svg rect.tdom-source-hit${selector}[data-line]`)]
    .filter((node) => exactLineSet.has(node.dataset.line));
}

function directEditorAnchor(page) {
  if (!directEditor) return null;
  if (directEditor.anchor?.isConnected) return directEditor.anchor;
  const meta = directEditor.anchorMeta;
  if (!meta?.src) return null;
  const nodes = [...page.querySelectorAll(`[data-src="${CSS.escape(meta.src)}"]`)]
    .filter((node) => !node.classList.contains('tdom-direct-editor'));
  const sameLine = meta.line == null
    ? nodes
    : nodes.filter((node) => node.dataset.line === meta.line);
  const sameKind = meta.math
    ? sameLine.filter((node) => node.dataset.math === '1')
    : sameLine;
  const sameText = meta.text
    ? sameKind.find((node) => String(node.textContent ?? '').trim() === meta.text)
    : null;
  directEditor.anchor = sameText ?? sameKind[0] ?? sameLine[0] ?? nodes[0] ?? null;
  return directEditor.anchor;
}

function directEditorVisualNodes(page) {
  if (!directEditor) return [];
  const meta = directEditor.anchorMeta;
  if (directEditor.kind === 'text') {
    const value = directEditor.readValue?.() ?? directEditor.region.value;
    const matched = textRegionNodes(page, meta?.src, value);
    if (matched.length) return matched;
  } else {
    const matched = mathRegionNodes(page, meta);
    if (matched.length) return matched;
  }
  const anchor = directEditorAnchor(page);
  return anchor ? [anchor] : [];
}

function syncDirectEditorTypography(page, nodes) {
  if (!directEditor) return;
  const textNode = nodes.find((node) => node.tagName?.toLowerCase() === 'text') ??
    (directEditor.anchor?.tagName?.toLowerCase() === 'text' ? directEditor.anchor : null);
  const paper = activePaperGeometry(page);
  const scale = page.getBoundingClientRect().width / Math.max(1, paper.width);
  const svgSize = Number(textNode?.getAttribute?.('font-size'));
  const rect = textNode?.getBoundingClientRect?.();
  const fontSize = Number.isFinite(svgSize) && svgSize > 0
    ? svgSize * scale
    : Math.max(1, rect?.height ?? 10);
  const family = textNode?.getAttribute?.('font-family');
  const color = textNode?.getAttribute?.('fill');
  directEditor.element.style.setProperty('--direct-font-size', `${fontSize}px`);
  if (family) directEditor.element.style.setProperty('--direct-font-family', family);
  if (color) directEditor.element.style.setProperty('--direct-color', color);
  const style = textNode ? getComputedStyle(textNode) : null;
  if (style?.fontStyle) directEditor.element.style.setProperty('--direct-font-style', style.fontStyle);
  if (style?.fontWeight) directEditor.element.style.setProperty('--direct-font-weight', style.fontWeight);
}

function contentEditableCaretRect(control) {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount) return null;
  const selected = selection.getRangeAt(0);
  if (!control?.contains?.(selected.startContainer) || !control.contains(selected.endContainer)) return null;
  const probe = selected.cloneRange();
  probe.collapse(false);
  const rects = [...probe.getClientRects()];
  const rect = rects.at(-1) ?? probe.getBoundingClientRect();
  return rect && [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) &&
    rect.bottom > rect.top ? rect : null;
}

function isDirectTextControl(control) {
  return control?.tagName !== 'MATH-FIELD' && control?.isContentEditable === true;
}

function directSelection(session) {
  if (!isDirectTextControl(session.control)) {
    const range = session.control.selection?.ranges?.[0];
    return Array.isArray(range) ? range : [session.control.position, session.control.position];
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount || !session.control.contains(selection.anchorNode) ||
      !session.control.contains(selection.focusNode)) return null;
  const offset = (node, at) => {
    const range = document.createRange();
    range.selectNodeContents(session.control); range.setEnd(node, at);
    return range.toString().length;
  };
  return [offset(selection.anchorNode, selection.anchorOffset), offset(selection.focusNode, selection.focusOffset)];
}

function setDirectSelection(session, start, end = start) {
  if (!isDirectTextControl(session.control)) {
    session.control.selection = { ranges: [[start, end]], direction: start <= end ? 'forward' : 'backward' };
  } else {
    const locate = (offset) => {
      const walker = document.createTreeWalker(session.control, NodeFilter.SHOW_TEXT);
      let node, last = session.control;
      while ((node = walker.nextNode())) {
        last = node;
        if (offset <= node.length) return [node, Math.max(0, offset)];
        offset -= node.length;
      }
      return [last, last.nodeType === Node.TEXT_NODE ? last.length : 0];
    };
    const a = locate(start), b = locate(end);
    window.getSelection()?.setBaseAndExtent(a[0], a[1], b[0], b[1]);
  }
  paintDirectSelection();
}

function directGeometryHit(session, point) {
  const geometry = window.TdomDirectEditGeometry;
  const ink = pendingFormulas.get(session.formulaSlot?.key);
  if (ink?.map?.length && ink.paintedValue === session.readValue()) return geometry.mathHit(session.control, ink.map, point, ink.slot.rect);
  return session.kind === 'math'
    ? geometry.mathHit(session.control, session.glyphMap ?? [], point, session.printBounds, session.sourceBoxes)
    : geometry.hit(session.glyphMap ?? [], point);
}

// Input, MathLive selection events, and scroll can all fire before one
// frame. Read and paint the final state once; reposition includes the caret.
let directEditorVisualRaf = null;
let directEditorVisualNeedsReposition = false;
function scheduleDirectEditorVisuals(reposition = false) {
  if (!directEditor) return;
  directEditorVisualNeedsReposition ||= reposition;
  if (directEditorVisualRaf != null) return;
  directEditorVisualRaf = requestAnimationFrame(() => {
    const reposition = directEditorVisualNeedsReposition;
    directEditorVisualRaf = null;
    directEditorVisualNeedsReposition = false;
    if (reposition) repositionDirectEditor();
    else paintDirectSelection();
  });
}
function cancelDirectEditorVisuals() {
  if (directEditorVisualRaf != null) cancelAnimationFrame(directEditorVisualRaf);
  directEditorVisualRaf = null;
  directEditorVisualNeedsReposition = false;
}

// A replacement may finish before a new TeX page is available. The active
// input can keep its committed text inside the old selection's printed box
// when every selected glyph belongs to one contiguous line on that page.
function imeReplacementBox(session, start, end, page) {
  if (start === end || session.kind !== 'text' || !page?.classList.contains('is-final') ||
      !session.glyphMap?.length || !page.dataset.canonPresentedSrc || page.querySelector('.tdom-canonical-delta')) return null;
  const glyphs = session.glyphMap.filter(g => g.end > start && g.start < end);
  const first = glyphs[0], last = glyphs.at(-1);
  if (first?.start !== start || last?.end !== end) return null;
  for (let i = 1; i < glyphs.length; i++) {
    const prev = glyphs[i - 1], next = glyphs[i];
    if (prev.end !== next.start || Math.abs(next.top - first.top) > 0.5 ||
        Math.abs(next.bottom - first.bottom) > 0.5 || Math.abs(next.left - prev.right) > 1) return null;
  }
  return { left: first.left, right: last.right, top: first.top, bottom: first.bottom };
}

// Pending edits use the old formula's proven paper position until TeX
// presents its next page. Keep the input field focused in its own session.
const pendingFormulas = new Map();
function forgetPendingFormula(key) {
  const ink = pendingFormulas.get(key);
  if (!ink) return;
  ink.observer.disconnect();
  cancelAnimationFrame(ink.frame);
  ink.node.remove();
  pendingFormulas.delete(key);
}
function retirePendingFormulas(page) {
  if (!page) sourceFormulaEdits.clear();
  for (const [key, ink] of pendingFormulas) if (!page || ink.page === page) forgetPendingFormula(key);
}

function printedMathEm(control, map) {
  const em = parseFloat(getComputedStyle(control).fontSize), sizes = [];
  for (const glyph of map) {
    if ([...glyph.symbol].length !== 1) continue;
    const width = control.getElementInfo(glyph.end)?.glyphBounds?.width;
    if (width > 0 && glyph.right > glyph.left && em > 0) sizes.push((glyph.right - glyph.left) * em / width);
    if (sizes.length === 5) break;
  }
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

async function prepareFormulaSlot(session, page, basis) {
  const { map, src, rev } = basis;
  const image = page.querySelector('img.canon');
  if (!image || image.dataset.src !== src || !map.length) return;
  const geometry = window.TdomDirectEditGeometry;
  const shapes = await geometry.formulaPageShapes(image);
  const retained = directEditRevisits.some(record => record.sessionId === session.sessionId);
  if (!shapes || documentReset.pending || basis.epoch !== documentReset.adoptedEpoch || !page.isConnected ||
      (directEditor !== session && !retained) || session.revisitCancelled || session.formulaBasis !== basis || page.dataset.canonPresentedSrc !== src ||
      page.dataset.canonPresentedRev !== rev || !page.classList.contains('is-final')) return;
  const paper = activePaperGeometry(page), slot = geometry.isolatedFormulaSlot(shapes, map, paper, basis.structures, basis.displayRows, basis.completeMap);
  if (!slot) return;
  session.formulaSlot = { ...slot, color: getComputedStyle(page).backgroundColor, paper, src, rev,
    key: JSON.stringify([documentReset.adoptedEpoch, session.pageNumber, src, directSourceRangeKey(session.region)]) };
  if (directEditor === session) scheduleDirectEditorVisuals();
  else if (session.finishedFormula) paintPendingFormula(session, page);
}

// Source typing has no paper caret. Account for each changed byte using the
// formula ranges of the printed snapshot and the current source snapshot.
function sourceFormulaChangeState(old, region) {
  const auxPattern = /\\(?:label\{[\w.:-]+\}|tag\*?\{[\w .:-]+\}|notag\b|nonumber\b)/g;
  const structures = ['\\frac', '\\tfrac', '\\dfrac', '\\sqrt'];
  const symbols = window.TdomOpaqueEditorCoordinator;
  const syntax = value => {
    if (typeof value !== 'string' || value.length > 512) return null;
    let incomplete = /\\(?:[dt]?frac|sqrt)(?![A-Za-z])\s*(?=}|$)/.test(value);
    const plain = value.replace(auxPattern, '').replace(/\\[A-Za-z]+/g, command => {
      if (structures.includes(command) || symbols.isPrintedSymbolCommand(command)) return 'x';
      if (!structures.some(full => full.startsWith(command)) && !symbols.startsPrintedSymbolCommand(command)) return command;
      incomplete = true;
      return 'x';
    }).replace(/\\(?=}|$)/g, () => {
      incomplete = true;
      return '';
    });
    if (!/^[A-Za-z0-9_^{}\[\]\s+*=().,-]+$/.test(plain)) return null;
    let depth = 0;
    for (const char of plain) {
      if (char === '{') depth++;
      if (char === '}' && --depth < 0) return null;
    }
    return incomplete || depth || /[_^]\s*$/.test(plain) ? 'incomplete' : 'ready';
  };
  if (syntax(old.value) !== 'ready' || typeof region.value !== 'string' ||
      JSON.stringify(old.value.match(auxPattern)) !== JSON.stringify(region.value.match(auxPattern))) return null;
  return syntax(region.value);
}

// The candidate ranges are in source order. Scan to each line once per
// file, even when a multi-cursor edit is near the end of a long chapter.
function orderedSourceOffsets(text) {
  let line = 1, start = 0, newline = text.indexOf('\n');
  return position => {
    if (!Number.isSafeInteger(position?.line) || position.line < line ||
        !Number.isSafeInteger(position.column) || position.column < 1) return -1;
    while (line < position.line) {
      if (newline < 0) return -1;
      start = newline + 1;
      newline = text.indexOf('\n', start);
      line++;
    }
    const offset = start + position.column - 1;
    return offset <= (newline < 0 ? text.length : newline) ? offset : -1;
  };
}

function changedSourceFormulas(before, after, oldBlocks, paperRegions = null) {
  const changes = [], byFile = new Map();
  const wanted = new Map(oldBlocks.map(block => [block.id, block]));
  for (const block of after.blocks) {
    const oldBlock = wanted.get(block.id);
    if (!oldBlock) continue;
    const originals = new Map(oldBlock.editRegions?.map(region => [region.id, region]));
    for (const region of block.editRegions ?? []) {
      if (region.kind !== 'math') continue;
      const old = originals.get(region.id);
      if (old?.kind !== 'math' || (old.value === region.value && !paperRegions?.has(region.id))) continue;
      if (Boolean(old.display) !== Boolean(region.display) || old.source.file !== region.source.file || changes.length >= 32) return null;
      const state = old.value === region.value ? 'ready' : sourceFormulaChangeState(old, region);
      if (!state) return null;
      const change = { old, region, oldBlock, state };
      changes.push(change);
      if (!byFile.has(old.source.file)) byFile.set(old.source.file, []);
      byFile.get(old.source.file).push(change);
    }
  }
  if (!changes.length || before.sources.length !== after.sources.length) return null;
  for (const [i, file] of before.sources.entries()) {
    const next = after.sources[i];
    if (next.file !== file.file) return null;
    const spans = byFile.get(file.file);
    if (!spans) {
      if (file.text !== next.text) return null;
      continue;
    }
    if (typeof file.text !== 'string' || typeof next.text !== 'string') return null;
    const byStart = (a, b) => a.old.source.start.line - b.old.source.start.line ||
      a.old.source.start.column - b.old.source.start.column;
    const oldOffset = orderedSourceOffsets(file.text), newOffset = orderedSourceOffsets(next.text);
    let oldEnd = 0, newEnd = 0;
    for (const { old, region } of spans.sort(byStart)) {
      const start = oldOffset(old.source.start), at = newOffset(region.source.start);
      if (start < oldEnd || at - newEnd !== start - oldEnd ||
          !next.text.startsWith(file.text.slice(oldEnd, start), newEnd)) return null;
      const oldValue = old.sourceValue ?? old.value, newValue = region.sourceValue ?? region.value;
      oldEnd = oldOffset(old.source.end);
      newEnd = newOffset(region.source.end);
      if (oldEnd - start !== oldValue.length || newEnd - at !== newValue.length ||
          !file.text.startsWith(oldValue, start) || !next.text.startsWith(newValue, at)) return null;
    }
    if (file.text.length - oldEnd !== next.text.length - newEnd ||
        !next.text.startsWith(file.text.slice(oldEnd), newEnd)) return null;
    byFile.delete(file.file);
  }
  return byFile.size ? null : changes;
}

// Keep only recent block IDs. A missing ID can never produce an incorrect
// match: changedSourceFormulas also checks the complete source files.
const sourceFormulaEdits = new Map();
const sourceFormulaProofs = new WeakMap();
const sourceFormulaBlockIndexes = new WeakMap();
function sourceFormulaBlocks(snapshot) {
  let blocks = sourceFormulaBlockIndexes.get(snapshot);
  if (!blocks) {
    blocks = new Map(snapshot.blocks.map(block => [block.id, block]));
    sourceFormulaBlockIndexes.set(snapshot, blocks);
  }
  return blocks;
}
function sourceFormulaProof(key, page, presented, block, region) {
  let proofs = sourceFormulaProofs.get(presented.snapshot);
  if (!proofs) sourceFormulaProofs.set(presented.snapshot, proofs = { slots: new Map(), rows: new Map() });
  if (!proofs.slots.has(key)) {
    proofs.slots.set(key, locateSourceFormula(page, presented, block, region, proofs.rows).catch(() => null));
    if (proofs.slots.size > 32) proofs.slots.delete(proofs.slots.keys().next().value);
  }
  return proofs.slots.get(key);
}

function warmSourceFormula(message) {
  // (its drafts are drawn by MathLive, which the switch loads: directEditingOn)
  if (!directEditingOn()) return;
  if (!embeddedHost || directEditor || openingDirectInput || documentReset.pending ||
      message.documentEpoch !== documentReset.adoptedEpoch || !Number.isSafeInteger(message.offset) || message.offset < 0) return;
  const targets = new Map();
  for (const page of pagesEl.querySelectorAll('.page.is-final')) {
    const bounds = page.getBoundingClientRect();
    if (bounds.bottom <= 0 || bounds.top >= innerHeight || page.querySelector('.tdom-canonical-delta')) continue;
    const presented = presentedPageState(page);
    if (presented?.rev !== message.srcRev) continue;
    const snapshot = presented.snapshot, n = Number(page.dataset.page);
    if (!targets.has(snapshot)) {
      const file = snapshot.sources?.find(source => sameSourceFile(source.file, message.file));
      if (!file || message.offset > file.text.length) continue;
      let line = 1, lineStart = 0;
      for (let at = file.text.indexOf('\n'); at >= 0 && at < message.offset; at = file.text.indexOf('\n', lineStart)) {
        line++;
        lineStart = at + 1;
      }
      const column = message.offset - lineStart + 1;
      const found = [];
      for (const block of snapshot.blocks) for (const region of block.editRegions ?? []) {
        if (region.kind !== 'math' || region.source?.file !== file.file) continue;
        const { start, end } = region.source;
        if (line < start.line || line > end.line || line === start.line && column < start.column ||
            line === end.line && column > end.column) continue;
        found.push({ block, region });
      }
      targets.set(snapshot, found);
    }
    const found = targets.get(snapshot);
    if (found.length !== 1) continue;
    const { block, region } = found[0];
    if (block.pages?.length && !block.pages.includes(n)) continue;
    const key = JSON.stringify([message.documentEpoch, n, presented.src, directSourceRangeKey(region)]);
    sourceFormulaProof(key, page, presented, block, region);
  }
}

async function locateDisplaySourceFormula(pageNumber, presented, old, stillCurrent) {
  const [bounds, boxes, glyphs] = await Promise.all([
    canonicalSourceBounds(old, pageNumber, presented.id),
    canonicalSourceEditBoxes(pageNumber, presented.id, old),
    canonicalGlyphs(pageNumber, presented.id),
  ]);
  return matchDisplaySourceFormula(old, bounds, boxes, glyphs, stillCurrent);
}

async function matchDisplaySourceFormula(region, bounds, boxes, glyphs, stillCurrent) {
  const Mathfield = customElements.get('math-field');
  if (!Mathfield || !bounds || !boxes.length || !glyphs.length || !stillCurrent()) return null;
  const rows = boxes.filter(box => !box.empty).map(box => box.box);
  const displayRows = [...(bounds.sourceRows ?? []), ...rows];
  if (!rows.length) return null;
  const scope = { left: Math.min(bounds.left, ...rows.map(b => b.left)), right: Math.max(bounds.right, ...rows.map(b => b.right)),
    top: Math.min(bounds.top, ...rows.map(b => b.top)), bottom: Math.max(bounds.bottom, ...rows.map(b => b.bottom)) };
  const field = new Mathfield(), geometry = window.TdomDirectEditGeometry;
  field.defaultMode = 'math';
  field.readOnly = true;
  field.mathVirtualKeyboardPolicy = 'manual';
  field.inert = true;
  Object.assign(field.style, { position: 'fixed', left: '-10000px', top: '0', opacity: '0', pointerEvents: 'none' });
  try {
    document.body.append(field);
    field.value = region.value;
    hidePaperAuxiliaries(field);
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (!stillCurrent()) return null;
    const matches = geometry.mathMaps(field, glyphs, scope);
    if (matches.length !== 1) return null;
    const { map } = matches[0];
    if (!geometry.completeDisplayMap(field, map)) return null;
    return { map, structures: geometry.printedMathStructures(field, map, glyphs), displayRows,
      completeMap: true, emSize: printedMathEm(field, map) };
  } finally { field.remove(); }
}

async function locateSourceFormula(page, presented, oldBlock, old, rows) {
  const pageNumber = Number(page.dataset.page), base = presented.snapshot, source = old.source;
  if (oldBlock.source?.file !== source.file || oldBlock.sourceRanges?.some(range => range.file !== source.file)) return null;
  const current = () => page.isConnected && page.dataset.canonPresentedSrc === presented.src && !documentReset.pending;
  const copy = old.display ? await locateDisplaySourceFormula(pageNumber, presented, old, current)
    : await locateInlineSourceFormula(pageNumber, presented, oldBlock, old, rows, current);
  if (!copy || !current()) return null;
  const geometry = window.TdomDirectEditGeometry, paper = activePaperGeometry(page);
  const shapes = await geometry.formulaPageShapes(presented.image);
  if (!shapes || !current()) return null;
  const slot = geometry.isolatedFormulaSlot(shapes, copy.map, paper, copy.structures, copy.displayRows, copy.completeMap);
  if (!slot) return null;
  if (!old.display && old.tableRow != null) {
    if (copy.map.some(g => g.left < copy.extent.left || g.right > copy.extent.right)) return null;
    slot.rect.right = Math.min(slot.rect.right, copy.extent.right);
  }
  const rev = String(presented.rev), src = presented.src, epoch = base.documentEpoch;
  return { basis: { map: copy.map, value: old.value, epoch, rev, src, started: true, emSize: copy.emSize },
    slot: { ...slot, rev, src, paper, color: getComputedStyle(page).backgroundColor,
      key: JSON.stringify([epoch, pageNumber, src, directSourceRangeKey(old)]) },
    bounds: inkBounds(copy.map, pageNumber) };
}

async function locateInlineSourceFormula(pageNumber, presented, oldBlock, old, rows, current) {
  const source = old.source;
  if (old.tableRow != null) {
    const sourceRows = tableRowsByFile(oldBlock.editRegions).get(source.file);
    if (!sourceRows) return null;
    const boxes = await canonicalSourceEditBoxes(pageNumber, presented.id, old, true);
    if (!current()) return null;
    const cell = window.TdomDirectEditGeometry.locateTableCell(sourceRows, boxes, { region: old });
    if (!cell) return null;
    const copies = await tableCellInk(cell, pageNumber, presented.id, current, old);
    return copies?.find(copy => copy.region === old) ?? null;
  }
  // The correspondence proof enumerates every printed copy of this value on
  // its paragraph's lines. Multi-cursor edits share that one immutable result.
  const rowKey = JSON.stringify([oldBlock.id, pageNumber, source.file, source.start.line, old.value]);
  if (!rows.has(rowKey)) {
    const lookup = async () => {
      const anchors = await inlineSourceLineBoxes(pageNumber, presented.id, oldBlock, source.start.line);
      if (!anchors.length || !current()) return [];
      return inlineMathCopies(presented.snapshot, { file: source.file, line: source.start.line, anchors },
        pageNumber, presented.id, current, old.value);
    };
    rows.set(rowKey, lookup());
    if (rows.size > 32) rows.delete(rows.keys().next().value);
  }
  const copies = await rows.get(rowKey);
  const occurrences = copies.filter(item => directSourceRangeKey(item.region) === directSourceRangeKey(old));
  if (occurrences.length !== 1 || occurrences[0].region.id !== old.id || !current()) return null;
  return occurrences[0];
}

// A finished paper edit may be ahead of an arriving engine snapshot. Before
// handing its ink back to code editing, ask the host's existing read-only
// source-anchor service whether Monaco still contains this exact snapshot.
// For clicks on retained ink, a range rebased over unrelated edits suffices.
let sourceFormulaRequest = 0;
function confirmSourceFormulaAnchor(snapshot, region, exactFile) {
  const sourceText = sourceTextForRegion(snapshot, region);
  if (typeof sourceText !== 'string') return Promise.resolve(false);
  const requestId = 'source-formula-' + (++sourceFormulaRequest);
  const sessionId = requestId, activationId = embedActivationId;
  const documentEpoch = snapshot.documentEpoch, sourceRev = snapshot.srcRev;
  return new Promise(resolve => {
    const finish = matched => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      resolve(matched);
    };
    const receive = event => {
      const data = event.data;
      if (event.source !== window.parent || data?.source !== 'tdom-host' ||
          data.action !== 'edit-anchor-result' || data.requestId !== requestId || data.sessionId !== sessionId) return;
      finish(data.ok === true && data.activationId === activationId && data.documentEpoch === documentEpoch &&
        data.sourceRev === sourceRev && data.file === region.source.file &&
        data.baseValue === (region.sourceValue ?? region.value) && (!exactFile || data.sourceText === sourceText));
    };
    const timer = setTimeout(() => finish(false), 1500);
    window.addEventListener('message', receive);
    window.parent.postMessage({ source: 'tdom-embed', action: 'edit-anchor', requestId, sessionId,
      activationId, documentEpoch, sourceRev, file: region.source.file, start: region.source.start,
      end: region.source.end, baseValue: region.sourceValue ?? region.value, sourceText }, '*');
  });
}

function pruneSourceFormulas(keep) {
  for (const [key, ink] of pendingFormulas) if (ink.sourceSnapshot && !keep?.has(key)) forgetPendingFormula(key);
}

async function previewSourceFormula(report) {
  // (its drafts are drawn by MathLive, which the switch loads: directEditingOn)
  if (!directEditingOn()) return;
  const rev = report.srcRev, epoch = documentReset.adoptedEpoch;
  if (!embeddedHost || documentReset.pending || rev !== appliedSrcRev) return;
  if (!report.dirtySourceNodes?.length && !report.removedSourceNodes?.length) return;
  for (const node of report.dirtySourceNodes ?? []) {
    const id = String(node).replace(/^src-/, '');
    sourceFormulaEdits.delete(id);
    sourceFormulaEdits.set(id, rev);
  }
  while (sourceFormulaEdits.size > 64) sourceFormulaEdits.delete(sourceFormulaEdits.keys().next().value);
  // A half-written TeX group has no current source map. Preserve the
  // last visible draft until TeX can describe the next edit.
  if (openingDirectInput || report.stats?.closureDeferred) return;
  if (directEditor && ![...pendingFormulas.values()].some(ink => ink.sourceSnapshot)) return;
  if (report.canonicalAnchor?.status === 'pending') { pruneSourceFormulas(); return; }
  const base = canonical && presentedDomSnapshots.get(presentedSnapshotKey(canonical.id, canonical.rev));
  if (!base) { pruneSourceFormulas(); return; }

  // Only load current source when a candidate has math on visible printed
  // paper. Group by the PDF snapshot actually displayed on each such page.
  const groups = new Map();
  const hints = sourceFormulaBlocks(base);
  const demand = new Map();
  let unpaginatedRev = -1;
  for (const [id, lastEdit] of sourceFormulaEdits) {
    const hint = hints.get(id);
    if (!hint?.editRegions?.some(r => r.kind === 'math')) continue;
    if (!hint.pages?.length) unpaginatedRev = Math.max(unpaginatedRev, lastEdit);
    for (const n of hint.pages ?? []) demand.set(n, Math.max(demand.get(n) ?? -1, lastEdit));
  }
  // A native PDF may be ready before the block paginator can place a
  // long paragraph. Only displayed sheets qualify, and source boxes and
  // glyphs still have to prove the complete occurrence on each one.
  if (unpaginatedRev >= 0) for (const page of pagesEl.querySelectorAll('.page.is-final')) {
    const n = Number(page.dataset.page);
    demand.set(n, Math.max(demand.get(n) ?? -1, unpaginatedRev));
  }
  for (const [n, lastEdit] of demand) {
    const page = pageDivs.get(n);
    if (!page?.classList.contains('is-final') || page.querySelector('.tdom-canonical-delta')) continue;
    const viewport = page.getBoundingClientRect();
    if (viewport.bottom <= 0 || viewport.top >= innerHeight) continue;
    const presented = presentedPageState(page);
    if (!presented || presented.rev >= lastEdit) continue;
    if (!groups.has(presented.snapshot)) groups.set(presented.snapshot, new Map());
    groups.get(presented.snapshot).set(n, { page, presented });
  }
  if (!groups.size) { pruneSourceFormulas(); return; }
  const snapshot = await loadProvisionalSnapshot(rev).catch(() => null);
  const current = () => rev === appliedSrcRev && epoch === documentReset.adoptedEpoch &&
    !documentReset.pending && !openingDirectInput;
  if (!current()) return;
  if (!snapshot) return;
  const keep = new Set(), paints = [], confirmations = new Map();
  const paperRegions = new Set([...pendingFormulas.values()].filter(ink => !ink.sourceSnapshot).map(ink => ink.region.id));
  async function releasePaperInk(key, ink, region) {
    const file = region.source.file, owner = ink.sessionId, value = ink.renderValue;
    if (!confirmations.has(file)) confirmations.set(file, confirmSourceFormulaAnchor(snapshot, region, true));
    if (!await confirmations.get(file) || !current() || directEditor?.formulaSlot?.key === key ||
        pendingFormulas.get(key) !== ink || owner !== ink.sessionId || value !== ink.renderValue ||
        !ink.page.classList.contains('is-final') || ink.page.dataset.canonPresentedSrc !== ink.slot.src ||
        ink.page.querySelector('.tdom-canonical-delta')) return false;
    const prior = directEditRevisits.findIndex(record => record.sessionId === owner);
    if (prior >= 0) directEditRevisits.splice(prior, 1);
    return true;
  }
  for (const [printed, pages] of groups) {
    const originals = sourceFormulaBlocks(printed), oldBlocks = [];
    for (const [id, lastEdit] of sourceFormulaEdits) if (lastEdit > printed.srcRev && originals.has(id)) oldBlocks.push(originals.get(id));
    const changes = changedSourceFormulas(printed, snapshot, oldBlocks, paperRegions);
    if (!changes) continue;
    for (const [pageNumber, { page, presented }] of pages) {
      for (const { old, region, oldBlock, state } of changes) {
        if (oldBlock.pages?.length && !oldBlock.pages.includes(pageNumber)) continue;
        const key = JSON.stringify([epoch, pageNumber, presented.src, directSourceRangeKey(old)]);
        keep.add(key);
        // A partly typed control word cannot be typeset yet. Keep its last
        // good ink and revalidate that source range on click. Its peers can update.
        if (state === 'incomplete' || directEditor?.formulaSlot?.key === key) continue;
        // Code can undo a finished paper edit all the way to the printed
        // value. Reveal this one original formula and keep its edited peers.
        if (old.value === region.value) {
          const ink = pendingFormulas.get(key);
          if (ink && !ink.sourceSnapshot) paints.push(releasePaperInk(key, ink, region).then(released => {
            if (released && current() && pendingFormulas.get(key) === ink) forgetPendingFormula(key);
          }));
          continue;
        }
        paints.push(sourceFormulaProof(key, page, presented, oldBlock, old).then(async proof => {
          if (!current() || directEditor?.formulaSlot?.key === key) return;
          if (!proof || page.dataset.canonPresentedSrc !== presented.src || !page.classList.contains('is-final') ||
              page.querySelector('.tdom-canonical-delta')) return;
          const existing = pendingFormulas.get(key);
          if (existing && !existing.sourceSnapshot) {
            if (directEditValuesEqual('math', existing.renderValue, region.value)) return;
            if (!await releasePaperInk(key, existing, region)) return;
          }
          renderPendingFormula(page, proof.slot, proof.basis, region, proof.bounds, region.value, region.value, null, snapshot);
        }));
      }
    }
  }
  pruneSourceFormulas(keep);
  await Promise.all(paints);
}

function paintPendingFormula(session, page, restored = null) {
  if (!session.sentEdit && !restored) {
    const existing = pendingFormulas.get(session.formulaSlot?.key);
    return existing?.paintedValue === session.readValue() ? existing : null;
  }
  const basis = session.formulaBasis;
  if (basis && !basis.started && !directEditValuesEqual('math', session.readValue(), basis.value)) {
    basis.started = true;
    void prepareFormulaSlot(session, page, basis);
  }
  const slot = session.formulaSlot;
  if (!slot || slot.anchorRev && slot.anchorRev !== canonicalAnchorPreview?.srcRev || slot.src !== page.dataset.canonPresentedSrc || slot.rev !== page.dataset.canonPresentedRev) return null;
  const value = restored?.value ?? session.finishedFormula?.value ?? session.readValue();
  if (directEditValuesEqual('math', value, basis.value)) {
    forgetPendingFormula(slot.key);
    return null;
  }
  return renderPendingFormula(page, slot, basis, session.revisitDisplayRegion, session.printBounds, value,
    restored?.fieldValue ?? session.finishedFormula?.latex ?? session.control.value, restored?.sessionId ?? session.sessionId);
}

function hidePaperAuxiliaries(field) {
  const hiddenCommands = ['label', 'tag', 'tagstar', 'notag', 'nonumber']
    .map(name => '.ML__tex64-aux-command--' + name).join(',');
  const auxStyle = document.createElement('style');
  auxStyle.textContent = hiddenCommands + ' {display:none !important}';
  field.shadowRoot?.append(auxStyle);
  return hiddenCommands;
}

function renderPendingFormula(page, slot, basis, region, bounds, value, latex, sessionId, sourceSnapshot = null) {
  let ink = pendingFormulas.get(slot.key);
  if (!ink) {
    const node = document.createElement('div'), field = new (customElements.get('math-field'))();
    node.className = 'tdom-pending-formula';
    node.inert = true;
    node.setAttribute('aria-hidden', 'true');
    field.style.color = slot.foreground;
    field.defaultMode = region.display ? 'math' : 'inline-math';
    field.readOnly = true;
    field.mathVirtualKeyboardPolicy = 'manual';
    field.tabIndex = -1;
    const { rect, paper } = slot;
    Object.assign(node.style, { left: rect.left / paper.width * 100 + '%', top: rect.top / paper.height * 100 + '%',
      width: (rect.right - rect.left) / paper.width * 100 + '%', height: (rect.bottom - rect.top) / paper.height * 100 + '%',
      background: slot.color, visibility: 'hidden' });
    const hiddenCommands = hidePaperAuxiliaries(field);
    node.append(field);
    page.append(node);
    ink = { node, field, page, slot, region, bounds, basis,
      renderValue: null, frame: 0 };
    const fit = () => {
      ink.frame = 0;
      const latex = field.shadowRoot?.querySelector('.ML__latex');
      if (!latex || !node.isConnected) return;
      if (latex.querySelector('.ML__tex64-aux-command:not(:is(' + hiddenCommands + '))')) {
        node.style.visibility = 'hidden';
        ink.map = [];
        ink.paintedValue = null;
        return;
      }
      field.style.transform = 'none';
      const content = latex.getBoundingClientRect(), origin = field.getBoundingClientRect(), area = node.getBoundingClientRect();
      if (!area.width || !area.height || !content.height) return;
      const nativeScale = basis.emSize ? basis.emSize * area.width / (rect.right - rect.left) /
        parseFloat(getComputedStyle(field).fontSize) : Infinity;
      const height = !basis.emSize && slot.baseHeight ? area.height * slot.baseHeight / (rect.bottom - rect.top) : area.height;
      const scale = Math.min(area.width / Math.max(1, content.width), height / content.height, nativeScale);
      // Keep the TeX center unless adjacent paper ink limits that side.
      // Use the free side before shrinking the letters to fit.
      const centerX = slot.centered ? (slot.center - rect.left) * area.width / (rect.right - rect.left) : 0;
      const inset = slot.centered ? Math.max(0, Math.min(area.width - content.width * scale,
        centerX - content.width * scale / 2)) : 0;
      const centerY = slot.centerY == null ? area.height / 2 : (slot.centerY - rect.top) * area.height / (rect.bottom - rect.top);
      const topInset = Math.max(0, Math.min(area.height - content.height * scale, centerY - content.height * scale / 2));
      const x = inset - (content.left - origin.left) * scale, y = topInset - (content.top - origin.top) * scale;
      field.style.transform = 'matrix(' + [scale, 0, 0, scale, x, y].join(',') + ')';
      const toX = x => rect.left + (x - area.left) * (rect.right - rect.left) / area.width;
      const toY = y => rect.top + (y - area.top) * (rect.bottom - rect.top) / area.height;
      ink.map = [];
      const end = field.lastOffset;
      for (let i = 1; i <= end; i++) {
        const info = field.getElementInfo(i), box = info?.glyphBounds ?? info?.bounds;
        if (!box || !info.symbol || !Number.isInteger(info.beforeOffset) || box.width <= 0) continue;
        ink.map.push({ text: info.symbol, symbol: info.symbol, start: info.beforeOffset, end: i,
          left: toX(box.left), right: toX(box.right), top: toY(box.top), bottom: toY(box.bottom) });
      }
      ink.paintedValue = ink.renderValue;
      node.style.visibility = '';
      if (directEditor?.formulaSlot?.key === slot.key) scheduleDirectEditorVisuals();
    };
    ink.schedule = () => { if (!ink.frame) ink.frame = requestAnimationFrame(fit); };
    ink.observer = new ResizeObserver(ink.schedule);
    ink.observer.observe(node);
    ink.observer.observe(field);
    pendingFormulas.set(slot.key, ink);
    while (pendingFormulas.size > 32) forgetPendingFormula(pendingFormulas.keys().next().value);
  }
  if (ink.renderValue !== value) {
    const previous = ink.sourceSnapshot && ink.paintedValue === ink.renderValue ? ink.paintedValue : null;
    ink.renderValue = value;
    ink.field.setValue(latex, { silenceNotifications: true });
    if (sourceSnapshot && latex.includes('\\') && (ink.field.errors?.length ||
        ink.field.getModelMetadata().some(atom => atom.type === 'placeholder' || atom.type === 'error'))) {
      if (previous == null) forgetPendingFormula(slot.key);
      else {
        ink.renderValue = previous;
        ink.field.setValue(previous, { silenceNotifications: true });
        ink.schedule();
      }
      return null;
    }
    ink.schedule();
  }
  ink.sessionId = sessionId;
  ink.region = region;
  ink.sourceSnapshot = sourceSnapshot;
  return ink.paintedValue === value ? ink : null;
}

function pendingFormulaHit(page, point) {
  if (!point) return null;
  for (const ink of pendingFormulas.values()) {
    if (ink.page !== page || ink.slot.src !== page.dataset.canonPresentedSrc ||
        ink.slot.rev !== page.dataset.canonPresentedRev || !ink.map?.length || ink.paintedValue !== ink.renderValue) continue;
    const glyph = window.TdomDirectEditGeometry.nearest(ink.map, point);
    if (glyph && point.x >= glyph.left - 0.3 && point.x <= glyph.right + 0.3 &&
        point.y >= glyph.top - 0.3 && point.y <= glyph.bottom + 0.3) {
      return { ink, sessionId: ink.sessionId, value: ink.renderValue, offset: window.TdomDirectEditGeometry.hit(ink.map, point) };
    }
  }
  return null;
}

function paintDirectSelection() {
  // A synchronous click/geometry commit has already painted this state.
  // Preserve a queued reposition, which may still need updated shell bounds.
  if (!directEditorVisualNeedsReposition) cancelDirectEditorVisuals();
  const session = directEditor;
  if (!session?.inkLayer) return;
  const clear = () => session.inkLayer.replaceChildren();
  const page = pageDivs.get(session.pageNumber);
  if (!page) return clear();
  // Read page geometry before any ink mutation, and reuse it for every
  // selected glyph instead of forcing layout after each inserted marker.
  const pageRect = page.getBoundingClientRect();
  const paper = activePaperGeometry(page);
  const project = bounds => window.TdomOpaqueEditorCoordinator?.clientBounds?.({ bounds, pageRect, paper }) ?? null;
  const pending = session.kind === 'math' && paintPendingFormula(session, page);
  let committed = session.committedIme;
  if (committed) {
    const selection = directSelection(session);
    if (page.dataset.canonPresentedSrc !== committed.surface || !page.classList.contains('is-final') ||
        page.querySelector('.tdom-canonical-delta') || session.readValue() !== committed.value ||
        !selection?.every(offset => offset === committed.offset)) {
      session.committedIme = committed = null;
    }
  }
  const inputInk = session.imeComposing ? session.compositionInk : committed;
  if (inputInk?.text) {
    const { anchor, text } = inputInk;
    const client = project(anchor);
    if (!client) return clear();
    const marker = document.createElement('span');
    marker.className = 'tdom-ink-composition';
    marker.textContent = text;
    Object.assign(marker.style, {
      left: `${client.left - pageRect.left}px`, top: `${client.top - pageRect.top}px`,
      maxWidth: `${Math.max(1, pageRect.right - client.left)}px`,
      fontSize: `${Math.max(1, client.bottom - client.top)}px`,
      fontFamily: getComputedStyle(session.control).fontFamily,
    });
    if (committed) {
      marker.classList.add('is-committed');
      marker.style.width = marker.style.maxWidth = `${client.right - client.left}px`;
      marker.style.height = `${client.bottom - client.top}px`;
    }
    session.inkLayer.replaceChildren(marker);
    const end = document.createRange();
    end.selectNodeContents(marker); end.collapse(false);
    const caret = [...end.getClientRects()].at(-1) ?? marker.getBoundingClientRect();
    if (committed && caret.right > client.right + 1) {
      session.committedIme = null;
      return paintDirectSelection();
    }
    if (committed) {
      const cursor = document.createElement('span');
      cursor.className = 'tdom-ink-caret';
      Object.assign(cursor.style, {
        left: `${caret.right - pageRect.left}px`, top: marker.style.top,
        width: '1.5px', height: marker.style.height,
      });
      session.inkLayer.appendChild(cursor);
    }
    const point = paperPointForClick({ clientX: caret.right, clientY: caret.bottom }, page);
    if (point) {
      session.canonicalAnchorPoint = point;
      if (committed) session.lastPaintedCaret = { ...anchor, x: point.x };
    }
    return;
  }
  const selection = directSelection(session);
  const map = pending?.map ?? session.glyphMap;
  if (!selection || !map?.length) return clear();
  const exact = Boolean(pending) || String(session.readValue()) === session.geometryValue;
  const [start, end] = selection;
  // Until the new PDF geometry is ready, the only valid caret is the
  // previous printed one. Do not traverse the changed model to discard it.
  const box = !exact ? session.lastPaintedCaret : session.kind === 'math'
    ? window.TdomDirectEditGeometry.mathCaret(session.control, map, end, pending?.slot.rect ?? session.printBounds, pending ? [] : session.sourceBoxes)
    : window.TdomDirectEditGeometry.caret(map, end);
  const ink = document.createDocumentFragment();
  const add = (bounds, className) => {
    const client = project(bounds);
    if (!client) return;
    const marker = document.createElement('span');
    marker.className = className;
    Object.assign(marker.style, { left: `${client.left - pageRect.left}px`, top: `${client.top - pageRect.top}px`,
      width: `${Math.max(1.5, client.right - client.left)}px`, height: `${Math.max(2, client.bottom - client.top)}px` });
    ink.appendChild(marker);
  };
  const selectedGlyphs = exact && start !== end ? map.filter(glyph =>
    glyph.end > Math.min(start, end) && glyph.start < Math.max(start, end)) : [];
  if (selectedGlyphs.length) {
    for (const glyph of selectedGlyphs) add(glyph, 'tdom-ink-selection');
  } else {
    const stable = box;
    if (!stable) return clear();
    session.lastPaintedCaret = stable;
    const bounds = { ...stable, left: stable.x, right: stable.x };
    add(bounds, 'tdom-ink-caret');
    session.canonicalAnchorPoint = { x: stable.x, y: stable.bottom };
  }
  session.inkLayer.replaceChildren(ink);
}

function directEditorGeometryRegion(snapshot, session) {
  // A host anchor can already name newer Monaco text while this first click
  // still shows its immutable original PDF. That PDF/source pair remains
  // valid for its initial caret; only staging a new PDF uses the newer basis.
  if (!session.sentEdit && snapshot === session.sourceSnapshot &&
      typeof session.sourceText === 'string' &&
      sourceTextForRegion(snapshot, session.sourceRegion) === session.sourceText &&
      directEditValuesEqual(session.kind, session.sourceRegion.value, String(session.readValue()))) {
    return session.sourceRegion;
  }
  return directEditorRegionInSnapshot(snapshot, session);
}

async function refreshDirectEditGeometry(session = directEditor, clickPoint = null) {
  if (!session) return;
  const page = pageDivs.get(session.pageNumber);
  if (!page) return;
  const value = String(session.readValue());
  const epoch = session.geometryEpoch = (session.geometryEpoch ?? 0) + 1;
  const imageSrc = page.classList.contains('is-final') ? page.querySelector('img.canon')?.dataset.src : null;
  if (session.projectedRev && canonicalAnchorPreview?.srcRev === session.projectedRev && page.querySelector('.tdom-canonical-delta')) return;
  if (session.shipOpeningSrc && imageSrc === session.shipOpeningSrc && !session.sentEdit && session.geometryValue === value) return;
  if (!imageSrc && session.chunkOpeningEpoch != null && session.chunkOpeningEpoch === page.provisionalEpoch &&
      !session.sentEdit && session.geometryValue === value) return;
  const id = canonicalIdFromSrc(imageSrc);
  const canonicalVisible = id != null;
  let printedRegion = null;
  if (canonicalVisible) {
    const printed = directEditorGeometryRegion(presentedPageState(page)?.snapshot, session);
    if (!printed || !directEditValuesEqual(session.kind, printed.value, value)) return;
    printedRegion = printed;
  }
  if (canonicalVisible && (id !== session.presentedId || !session.printBounds)) {
    await refreshDirectEditorExactBounds(session.pageNumber);
    if (clickPoint && directEditor === session && session.geometryValue === value) {
      const offset = directGeometryHit(session, clickPoint);
      if (Number.isInteger(offset)) setDirectSelection(session, offset);
    }
    return;
  }
  const shipped = imageSrc?.startsWith('/ship/');
  const displayedRev = shipped ? Number(new URL(imageSrc, location.href).searchParams.get('r'))
    : Number(page.dataset.provRev);
  if (!canonicalVisible && session.sentEdit && value !== session.geometryValue &&
      displayedRev <= session.sentFromSrcRev) return;
  const surface = imageSrc ?? page.provisionalEpoch;
  const provisional = canonicalVisible || shipped ? null : await directProvisionalGeometry(session, page);
  const [glyphs, sourceBoxes] = await Promise.all([
    canonicalVisible ? canonicalGlyphs(session.pageNumber, id)
      : shipped ? displayedShipGlyphs(session.pageNumber, imageSrc) : provisional.glyphs,
    canonicalVisible && session.kind === 'math' ? canonicalSourceEditBoxes(session.pageNumber, id, printedRegion) : [],
  ]);
  const currentSurface = page.classList.contains('is-final') ? page.querySelector('img.canon')?.dataset.src : page.provisionalEpoch;
  if (directEditor !== session || session.geometryEpoch !== epoch || surface !== currentSurface ||
      value !== String(session.readValue())) return;
  const geometry = window.TdomDirectEditGeometry;
  const mappingBounds = provisional?.bounds ?? session.printBounds ?? {};
  let mappingAnchor = clickPoint ?? session.canonicalAnchorPoint;
  if (session.kind === 'math' && canonicalVisible && session.sentEdit === true && !clickPoint &&
      [mappingBounds.left, mappingBounds.right, mappingBounds.top, mappingBounds.bottom].every(Number.isFinite) &&
      (!mappingAnchor || mappingAnchor.x < mappingBounds.left || mappingAnchor.x > mappingBounds.right ||
        mappingAnchor.y < mappingBounds.top || mappingAnchor.y > mappingBounds.bottom)) {
    // Undo can shrink/move the formula while its last painted caret still
    // belongs to the older PDF. Search the proven current source envelope;
    // mathMap must still find one complete occurrence before any caret moves.
    mappingAnchor = { x: (mappingBounds.left + mappingBounds.right) / 2,
      y: (mappingBounds.top + mappingBounds.bottom) / 2 };
  }
  const map = session.kind === 'text'
    ? (shipped || !provisional?.words?.length && !canonicalVisible ? geometry.textMapFromGlyphs(value, glyphs, provisional?.bounds ?? session.printBounds)
      : geometry.textMap(value, provisional?.words ?? session.printBounds?.words, glyphs))
    : geometry.mathMap(session.control, glyphs, mappingBounds,
      mappingAnchor, { allowUnpaintedAnchor: session.sentEdit === true, sourceBoxes });
  if (!map.length) return;
  if (session.kind === 'math' && canonicalVisible) {
    const structures = /\\(?:[dt]?frac|sqrt)\b/.test(value) ? geometry.printedMathStructures(session.control, map, glyphs) : [];
    // Forward SyncTeX may stop at a radical's inner box. The same PDF's
    // source-box tree also contains the complete expression and column.
    const displayRows = session.region.display ? [
      ...(session.printBounds?.sourceRows ?? []), ...sourceBoxes.filter(b => !b.empty).map(b => b.box),
    ] : null;
    const completeMap = Boolean(displayRows && geometry.completeDisplayMap(session.control, map));
    const emSize = displayRows ? printedMathEm(session.control, map) : null;
    session.formulaBasis = { map, value, structures, displayRows, completeMap, emSize, epoch: documentReset.adoptedEpoch,
      src: page.dataset.canonPresentedSrc, rev: page.dataset.canonPresentedRev };
    session.formulaSlot = null;
  }
  if (session.kind === 'math' && canonicalVisible && session.printBounds) {
    session.printBounds = { ...session.printBounds,
      left: Math.min(session.printBounds.left, ...map.map(g => g.left)),
      right: Math.max(session.printBounds.right, ...map.map(g => g.right)),
      top: Math.min(session.printBounds.top, ...map.map(g => g.top)),
      bottom: Math.max(session.printBounds.bottom, ...map.map(g => g.bottom)),
    };
  }
  if (canonicalVisible && session.kind === 'text') session.printedTextMap = { id, map };
  session.glyphMap = map;
  session.sourceBoxes = sourceBoxes;
  session.geometryValue = value;
  session.resolveOpeningGeometry?.();
  if (clickPoint && map.length) {
    const offset = directGeometryHit(session, clickPoint);
    if (Number.isInteger(offset)) setDirectSelection(session, offset);
  }
  paintDirectSelection();
}

async function displayedShipGlyphs(pageNumber, src) {
  if (!shipGlyphCache.has(src)) {
    const url = new URL(src, location.href);
    shipGlyphCache.set(src, fetch(`/ship-glyphs?page=${pageNumber}&g=${url.searchParams.get('g')}&r=${url.searchParams.get('r')}`)
      .then(r => r.ok ? r.json() : null).then(d => d?.glyphs ?? []).catch(() => []));
    while (shipGlyphCache.size > 16) shipGlyphCache.delete(shipGlyphCache.keys().next().value);
  }
  return shipGlyphCache.get(src);
}

if (directEditingOn()) pagesEl.addEventListener('load', event => {
  if (event.target?.matches?.('img.chunk, img.canon') && directEditor) {
    requestAnimationFrame(() => { void refreshDirectEditGeometry(); });
  }
}, true);

async function directProvisionalGeometry(session, page) {
  const result = directSvgGeometry(page, directEditorVisualNodes(page));
  if (session.kind !== 'math' && result.glyphs.length) return result;
  const paperRect = (rect) => {
    const a = paperPointForClick({ clientX: rect.left, clientY: rect.top }, page);
    const b = paperPointForClick({ clientX: rect.right, clientY: rect.bottom }, page);
    return { left: a.x, top: a.y, right: b.x, bottom: b.y };
  };
  const src = CSS.escape(session.anchorMeta.src);
  const hits = [...page.querySelectorAll(`svg .tdom-source-hit[data-src="${src}"]${session.kind === 'math' ? '[data-math="1"]' : ''}`)];
  // A single expression can span several display rows. The exact symbol
  // multiset narrows this block envelope to the expression being edited.
  const blockBounds = unionNodeBounds(hits);
  const bounds = blockBounds ? paperRect(blockBounds) : session.printBounds;
  const glyphs = await chunkGlyphsOnPage(page, session.anchorMeta.src);
  return { ...result, bounds, glyphs: glyphs.length ? glyphs : result.glyphs };
}

async function loadChunkInputGeometry(img) {
  const imageSrc = img.getAttribute('src');
  const retained = chunkInputGeometry.get(img);
  if (retained?.src === imageSrc) return retained.pending;
  const epoch = documentReset.adoptedEpoch;
  const url = new URL(imageSrc, location.href);
  const key = decodeURIComponent(url.pathname.slice('/chunk/'.length).replace(/\.svg$/, ''));
  const version = url.searchParams.get('v');
  const cacheKey = `${epoch}:${key}:${version}`;
  // most recently used last: a page of code boxes holds more than a few
  const known = chunkGlyphCache.get(cacheKey);
  if (known) {
    chunkGlyphCache.delete(cacheKey);
    chunkGlyphCache.set(cacheKey, known);
  } else {
    const pending = fetch(`/chunk-glyphs?key=${encodeURIComponent(key)}&v=${version}&e=${epoch}`)
      .then(async response => {
        if (!response.ok) throw new Error('Unready chunk mapping');
        const data = await response.json();
        if (!(data.width > 0) || !Array.isArray(data.glyphs) ||
            Number(data.documentEpoch) !== epoch || documentReset.adoptedEpoch !== epoch) {
          throw new Error('Superseded chunk mapping');
        }
        return data;
      });
    chunkGlyphCache.set(cacheKey, pending);
    pending.catch(() => {
      if (chunkGlyphCache.get(cacheKey) === pending) chunkGlyphCache.delete(cacheKey);
    });
    while (chunkGlyphCache.size > 512) chunkGlyphCache.delete(chunkGlyphCache.keys().next().value);
  }
  const pending = chunkGlyphCache.get(cacheKey);
  // The node owns this immutable geometry for as long as its ink is on
  // screen, even after the engine has retired that chunk version.
  chunkInputGeometry.set(img, { src: imageSrc, pending });
  return pending;
}

async function chunkGlyphsOnPage(page, sourceId) {
  const paperRect = rect => {
    const a = paperPointForClick({ clientX: rect.left, clientY: rect.top }, page);
    const b = paperPointForClick({ clientX: rect.right, clientY: rect.bottom }, page);
    return { left: a.x, top: a.y, right: b.x, bottom: b.y };
  };
  const src = CSS.escape(sourceId);
  const glyphs = [];
  for (const part of page.querySelectorAll(`.chunkwin.part[data-src="${src}"]`)) {
    if (part.partGlyphs) glyphs.push(...part.partGlyphs);
  }
  // (a held chunk shows an earlier generation: its glyphs map no current source)
  for (const chunk of page.querySelectorAll(`.chunkwin[data-src="${src}"]:not(.stale):not(.held)`)) {
    const img = chunk.querySelector('img');
    if (!img?.complete || !img.naturalWidth) continue;
    const imageSrc = img.getAttribute('src');
    const data = await loadChunkInputGeometry(img).catch(() => null);
    if (!data?.width || img.getAttribute('src') !== imageSrc || !img.isConnected) continue;
    const imageBounds = paperRect(img.getBoundingClientRect()), clip = paperRect(chunk.getBoundingClientRect());
    const scale = (imageBounds.right - imageBounds.left) / data.width;
    for (const g of data.glyphs) {
      const box = { ...g, left: imageBounds.left + g.left * scale, right: imageBounds.left + g.right * scale,
        top: imageBounds.top + g.top * scale, bottom: imageBounds.top + g.bottom * scale,
        baseline: imageBounds.top + g.baseline * scale };
      const y = (box.top + box.bottom) / 2;
      if (y >= clip.top - 0.1 && y <= clip.bottom + 0.1) glyphs.push(box);
    }
  }
  return glyphs;
}

function directSvgGeometry(page, visualNodes) {
  const nodes = visualNodes.filter(node => node.tagName?.toLowerCase() === 'text');
  const glyphs = [], words = [];
  const paperPoint = (x, y) => paperPointForClick({ clientX: x, clientY: y }, page);
  for (const node of nodes) {
    const matrix = node.getScreenCTM();
    if (!matrix) continue;
    const project = (x, y) => {
      const p = new DOMPoint(x, y).matrixTransform(matrix);
      return paperPoint(p.x, p.y);
    };
    const group = [];
    const text = String(node.textContent ?? '');
    const chars = [...text];
    const count = node.getNumberOfChars();
    const utf16 = count === text.length;
    if (!utf16 && count !== chars.length) continue;
    let index = 0;
    for (const char of chars) {
      let extent = node.getExtentOfChar(index);
      const origin = node.getStartPositionOfChar(index);
      // SVG implementations can address both UTF-16 units of a surrogate
      // pair. Keep one Unicode symbol and unite its actual ink rectangles.
      if (utf16 && char.length > 1) {
        const tail = node.getExtentOfChar(index + 1);
        const x = Math.min(extent.x, tail.x), y = Math.min(extent.y, tail.y);
        extent = { x, y, width: Math.max(extent.x + extent.width, tail.x + tail.width) - x,
          height: Math.max(extent.y + extent.height, tail.y + tail.height) - y };
      }
      index += utf16 ? char.length : 1;
      const a = project(extent.x, extent.y), b = project(extent.x + extent.width, extent.y + extent.height);
      const baseline = project(origin.x, origin.y);
      if (!a || !b || !baseline) continue;
      group.push({ text: char, left: a.x, top: a.y, right: b.x, bottom: b.y, baseline: baseline.y });
    }
    glyphs.push(...group);
    if (group.length) words.push({ text: node.textContent,
      left: Math.min(...group.map(g => g.left)), right: Math.max(...group.map(g => g.right)),
      top: Math.min(...group.map(g => g.top)), bottom: Math.max(...group.map(g => g.bottom)) });
  }
  return { glyphs, words, bounds: glyphs.length ? {
    left: Math.min(...glyphs.map(g => g.left)), right: Math.max(...glyphs.map(g => g.right)),
    top: Math.min(...glyphs.map(g => g.top)), bottom: Math.max(...glyphs.map(g => g.bottom)),
  } : null };
}

if (directEditingOn()) document.addEventListener('selectionchange', () => {
  scheduleDirectEditorVisuals();
  alignOpaqueNativeCaretAnchor();
});

function alignOpaqueNativeCaretAnchor(expectedSessionId = directEditor?.sessionId) {
  const session = directEditor;
  if (!session || session.sessionId !== expectedSessionId) return;
  const control = session.control;
  if (!isDirectTextControl(control)) return;
  // Always measure in untransformed browser layout coordinates. The control
  // is transparent in opaque mode, so translating it cannot alter the
  // canonical page and leaves the shell-owned candidate panel in place.
  // Keep the transform composition-only because it also moves the control's
  // pointer hitbox; ordinary re-clicks must retain the shell's exact bounds.
  control.style.transform = '';
  session.nativeCaretAnchor = null;
  if (!usesDirectEditSurface() || session.imeComposing !== true ||
      !session.canonicalAnchorPoint) return;
  const page = pageDivs.get(session.pageNumber);
  if (!page?.isConnected) return;
  const target = clientBoundsForDisplayedPaperBounds({
    left: session.canonicalAnchorPoint.x,
    top: session.canonicalAnchorPoint.y,
    right: session.canonicalAnchorPoint.x,
    bottom: session.canonicalAnchorPoint.y,
  }, page);
  const caret = contentEditableCaretRect(control) ?? control.getBoundingClientRect?.();
  if (!target || !caret) return;
  const dx = target.left - caret.left;
  const dy = target.top - caret.top;
  const pageRect = page.getBoundingClientRect();
  if (![dx, dy].every(Number.isFinite) ||
      Math.abs(dx) > pageRect.width * 2 || Math.abs(dy) > pageRect.height * 2) return;
  control.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  session.nativeCaretAnchor = {
    target: { x: target.left, y: target.top },
    untransformed: { x: caret.left, y: caret.top },
    delta: { x: dx, y: dy },
  };
}

function positionOpaqueSuggestionPanel(page, pageRect) {
  const session = directEditor;
  if (!session?.element?.isConnected) return;
  const panel = session.element.querySelector('.math-wysiwyg-panel');
  if (!panel) return;
  if (!usesDirectEditSurface() || !session.canonicalAnchorPoint) {
    session.element.style.removeProperty('--tdom-canonical-panel-left');
    session.element.style.removeProperty('--tdom-canonical-panel-top');
    panel.style.left = '';
    panel.style.top = '';
    return;
  }
  const target = clientBoundsForDisplayedPaperBounds({
    left: session.canonicalAnchorPoint.x,
    top: session.canonicalAnchorPoint.y,
    right: session.canonicalAnchorPoint.x,
    bottom: session.canonicalAnchorPoint.y,
  }, page);
  if (!target) return;
  const shellLeft = Number.parseFloat(session.element.style.left) || 0;
  const shellTop = Number.parseFloat(session.element.style.top) || 0;
  const offset = window.TdomOpaqueEditorCoordinator?.overlayOffset?.({
    pageRect,
    shellLeft,
    shellTop,
    anchor: { x: target.left, y: target.top },
    gap: 5,
    panelRect: panel.getBoundingClientRect(),
    viewportRect: pagesEl.getBoundingClientRect(),
  });
  if (!offset) return;
  // MathLive's candidate renderer deliberately repositions its panel after
  // every keyboard navigation render. Keep the canonical anchor on the
  // stable editor shell so CSS can enforce it through those rerenders too.
  session.element.style.setProperty('--tdom-canonical-panel-left', `${offset.left}px`);
  session.element.style.setProperty('--tdom-canonical-panel-top', `${offset.top}px`);
}

function repositionDirectEditor() {
  cancelDirectEditorVisuals();
  if (!directEditor?.element?.isConnected) return;
  if (isDirectTextControl(directEditor.control)) {
    directEditor.control.style.transform = '';
    directEditor.nativeCaretAnchor = null;
  }
  const page = pageDivs.get(directEditor.pageNumber);
  if (!page) return;
  const pageRect = page.getBoundingClientRect();
  let bounds = null;
  const print = directEditor.printBounds;
  if (print) bounds = clientBoundsForDisplayedPaperBounds(print, page);
  if (!bounds) bounds = editBounds(directEditor.id, page);
  if (!bounds) {
    const visualNodes = directEditorVisualNodes(page);
    bounds = unionNodeBounds(visualNodes);
    if (bounds) {
      syncDirectEditorTypography(page, visualNodes);
      directEditor.anchorOffset = {
        left: bounds.left - pageRect.left,
        top: bounds.top - pageRect.top,
        right: bounds.right - pageRect.left,
        bottom: bounds.bottom - pageRect.top,
      };
    } else if (directEditor.anchorOffset) {
      bounds = {
        left: pageRect.left + directEditor.anchorOffset.left,
        top: pageRect.top + directEditor.anchorOffset.top,
        right: pageRect.left + directEditor.anchorOffset.right,
        bottom: pageRect.top + directEditor.anchorOffset.bottom,
      };
    }
  }
  if (!bounds) return;
  directEditor.element.style.left = `${bounds.left - pageRect.left}px`;
  directEditor.element.style.top = `${bounds.top - pageRect.top}px`;
  directEditor.element.style.width = `${Math.max(bounds.right - bounds.left, 1)}px`;
  const height = Math.max(bounds.bottom - bounds.top, 1);
  directEditor.element.style.minHeight = `${height}px`;
  if (directEditor.kind === 'math') directEditor.element.style.height = `${height}px`;
  // Candidate/native IME anchors must use the caret selected in this
  // frame, including a freshly measured composition marker.
  paintDirectSelection();
  positionOpaqueSuggestionPanel(page, pageRect);
  alignOpaqueNativeCaretAnchor();
}

function closeDirectEditor() {
  cancelDirectEditorVisuals();
  if (!directEditor) return;
  rememberDirectEditorRevisit(directEditor);
  if (directEditor.kind === 'math' && directEditor.sentEdit && !directEditor.revisitCancelled) {
    directEditor.finishedFormula = { value: directEditor.readValue(), latex: directEditor.control.value };
    const page = pageDivs.get(directEditor.pageNumber);
    if (page) paintPendingFormula(directEditor, page);
  }
  directEditor.resolveOpeningGeometry?.();
  directEditor.resolvePresentationAnchor?.(null);
  directEditor.wysiwyg?.detach?.();
  directEditor.wysiwyg?.close?.();
  directEditor.element.remove();
  directEditor.inkLayer?.remove();
  directEditor = null;
  for (const batch of opaqueCanonicalBatches.values()) {
    restageOpaqueBatchEditor(batch);
  }
  queueMicrotask(tryCommitProvisionalStages);
}

function sendDirectEdit(region, sessionId, visibleValue, { cancel = false, finish = false } = {}) {
  const sessionState = directEditor?.sessionId === sessionId ? directEditor : null;
  if (sessionState && cancel) {
    sessionState.revisitCancelled = true;
    if (sessionState.formulaSlot) {
      const page = pageDivs.get(sessionState.pageNumber);
      if (page && sessionState.revisit) paintPendingFormula(sessionState, page, sessionState.revisit);
      else if (page && sessionState.openedFromSourceFormula &&
          sessionState.formulaSlot.src === page.dataset.canonPresentedSrc && sessionState.formulaSlot.rev === page.dataset.canonPresentedRev) {
        const original = sessionState.region;
        renderPendingFormula(page, sessionState.formulaSlot, sessionState.formulaBasis, original, sessionState.printBounds,
          original.value, original.value, null, sessionState.sourceSnapshot);
      } else forgetPendingFormula(sessionState.formulaSlot.key);
    }
  }
  // Presentation can advance while a session is open. Its edit anchor stays
  // in the immutable source snapshot from which that session began; the
  // host tracks subsequent changes against this same anchor.
  region = sessionState?.sourceRegion ?? region;
  if ((cancel || finish) && sessionState && !sessionState.sentEdit) return;
  if (!cancel && !finish && sessionState?.lastVisibleValue === visibleValue) return;
  const sourceValue = region.kind === 'math' && !cancel
    ? sessionState?.readSourceValue?.() ?? visibleValue : visibleValue;
  const serialized = region.kind === 'math'
    ? preserveMathAuxCommands(region.sourceValue ?? region.value, sourceValue) : null;
  const raw = sessionState?.formattedSource ?? region.sourceValue ?? region.value;
  const macroSource = region.mathMacros ? window.TdomMathMacros.withoutComments(raw) : raw;
  const projection = region.mathMacros && window.TdomMathMacros.project(macroSource, region.mathMacros);
  const edited = region.kind === 'math' ? preserveMathSourceLayout(projection?.text ?? raw,
    sessionState?.serializedValue ?? region.value, serialized) : latexEscapeText(visibleValue);
  const rewritten = projection ? window.TdomMathMacros.rewrite(macroSource, projection, edited) : edited;
  const replacement = projection && raw !== macroSource ? preserveMathSourceLayout(raw, macroSource, rewritten) : rewritten;
  const payload = {
    source: 'tdom-embed',
    activationId: embedActivationId,
    documentEpoch: documentReset.adoptedEpoch,
    action: 'edit',
    sessionId,
    regionId: region.id,
    kind: region.kind,
    file: region.source.file,
    start: region.source.start,
    end: region.source.end,
    baseValue: region.sourceValue ?? region.value,
    value: sourceValue,
    replacement,
    cancel,
    finish,
    sourceRev: sessionState?.sourceRev ?? appliedSrcRev,
    sourceText: sessionState?.sourceText,
  };
  if (sessionState && !cancel && !finish) {
    updateDirectRevisitOffsets(sessionState);
    sessionState.sentEdit = true;
    if (region.kind === 'math') {
      sessionState.formattedSource = replacement;
      sessionState.serializedValue = serialized;
    }
    sessionState.lastVisibleValue = visibleValue;
    sessionState.sentFromSrcRev = Number(appliedSrcRev);
    for (const batch of opaqueCanonicalBatches.values()) {
      restageOpaqueBatchEditor(batch);
    }
  }
  if (embeddedHost) {
    window.parent.postMessage(payload, '*');
    return;
  }
  // Standalone workbench: apply the same range to its textarea and let the
  // existing 80 ms source-sync path update the engine.
  const start = lineColToOffset(editor.value, region.source.start.line, region.source.start.column);
  const session = directEditor?.standalone;
  const old = session?.lastReplacement ?? region.sourceValue ?? region.value;
  if (editor.value.slice(start, start + old.length) !== old) return;
  const next = cancel ? region.sourceValue ?? region.value : replacement;
  editor.value = editor.value.slice(0, start) + next + editor.value.slice(start + old.length);
  if (directEditor) directEditor.standalone = { lastReplacement: next };
  scheduleHighlight();
  scheduleSync();
}

async function openDirectEditor(
  id,
  target,
  knownRegion = null,
  clickPoint = null,
  printBounds = null,
  caretOffset = null,
  anchorInk = null,
  pendingHit = null
) {
  const inputOpening = openingDirectInput;
  const page = target.closest('#pages > .page');
  const pageNumber = Number(page?.dataset?.page);
  if (!page || !Number.isFinite(pageNumber)) return;
  const presented = usesDirectEditSurface(page) ? presentedPageState(page) : null;
  const nativeShip = anchorInk?.shipSrc && presentedShippingPageState(page)?.src === anchorInk.shipSrc;
  if (usesDirectEditSurface(page) && !presented && !nativeShip) return;
  const sourceFormulaOpening = Boolean(pendingHit?.ink.sourceSnapshot);
  const sourceSnapshot = anchorInk?.snapshot ?? presented?.snapshot ?? page.provisionalSnapshot;
  if (!sourceSnapshot || Number(sourceSnapshot.documentEpoch) !== documentReset.adoptedEpoch) return;
  const presentedRev = Number(presented?.rev ?? sourceSnapshot.srcRev);
  if (!Number.isFinite(presentedRev)) return;
  const canonicalInput = Boolean(presented || nativeShip);
  const region = knownRegion ?? await editRegionById(id, page);
  if (!region) return;
  if (directEditor) {
    sendDirectEdit(
      directEditor.region,
      directEditor.sessionId,
      directEditor.readValue?.() ?? String(directEditor.control.value ?? directEditor.region.value),
      { finish: true }
    );
    closeDirectEditor();
  }
  const displaySourceText = sourceTextForRegion(sourceSnapshot, region);
  const revisit = embeddedHost ? directEditRevisits.findLast(record =>
    directRevisitMatches(record, region, displaySourceText)) : null;

  const shell = document.createElement('div');
  shell.className = `tdom-direct-editor is-${region.kind}`;
  shell.classList.add('is-opaque');
  shell.dataset.edit = id;
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  let control;
  let mathWrapped = false;
  let wysiwyg = null;

  if (region.kind === 'math' && customElements.get('math-field')) {
    const Mathfield = customElements.get('math-field');
    const mf = new Mathfield();
    mf.className = 'tdom-direct-mathfield';
    mf.setAttribute('aria-label', 'Edit formula');
    // The printed TeX pixels remain the visual authority while MathLive is
    // focused above them. MathLive inherits transparent glyph color from the
    // host, but TeX64 auxiliary-command badges have their own background and
    // color inside the shadow root; neutralize those paints as well so a
    // click cannot change even one formula pixel.
    const transparentPaint = document.createElement('style');
    transparentPaint.textContent = `
      .ML__tex64-aux-command,
      .ML__tex64-aux-command * {
        color: transparent !important;
        background: transparent !important;
        border-color: transparent !important;
        box-shadow: none !important;
        -webkit-text-fill-color: transparent !important;
      }
    `;
    mf.shadowRoot?.appendChild(transparentPaint);
    try {
      const ctor = mf.constructor;
      ctor.fontsDirectory = '/host/mathlive/fonts';
      ctor.soundsDirectory = null;
      ctor.locale = 'en';
      mf.setOptions?.({
        smartFence: false,
        smartMode: false,
        inlineShortcuts: {},
        popoverPolicy: 'off',
        mathVirtualKeyboardPolicy: 'manual',
        removeExtraneousParentheses: false,
      });
      mf.mathVirtualKeyboardPolicy = 'manual';
      mathWrapped = shouldWrapAligned(region.value);
      mf.value = mathWrapped ? wrapAligned(region.value) : region.value;
    } catch { mf.textContent = region.value; }
    control = mf;
    control.addEventListener('contextmenu', (event) => event.preventDefault());
    control.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, { capture: true });
    control.addEventListener('focus', event => {
      if (!preserveDirectOpeningFocus(event, sessionId)) return;
      try { window.mathVirtualKeyboard?.hide?.(); } catch { /* no global keyboard */ }
    }, { capture: true });
  } else {
    const input = document.createElement('span');
    input.className = region.kind === 'math' ? 'tdom-direct-math-fallback' : 'tdom-direct-text';
    input.setAttribute('contenteditable', 'plaintext-only');
    input.setAttribute('role', 'textbox');
    input.setAttribute('aria-multiline', 'true');
    // Monaco/texlab owns document spell checking. Native contenteditable
    // squiggles would paint over the canonical TeX pixels even though this
    // direct-input layer is otherwise transparent.
    input.spellcheck = false;
    input.setAttribute('aria-label', region.kind === 'math' ? 'Edit formula source' : 'Edit text');
    input.textContent = region.value;
    control = input;
  }

  const readControlValue = (format = 'latex') => {
    let value;
    if (typeof control.getValue === 'function') {
      try { value = String(control.getValue(format)); } catch { /* fallback below */ }
    }
    if (value == null) value = String(control.value ?? control.textContent ?? '');
    if (region.kind === 'math' && mathWrapped) {
      const result = unwrapAligned(value);
      if (result.unwrapped) return result.value;
      mathWrapped = false;
    }
    return value;
  };
  const readValue = () => readControlValue();
  const writeValue = value => {
    if (typeof control.setValue === 'function') {
      mathWrapped = shouldWrapAligned(value);
      control.setValue(mathWrapped ? wrapAligned(value) : value, { format: 'latex', silenceNotifications: true });
    } else control.textContent = value;
  };
  // Virtual matrix cells remain in MathLive's model/selection coordinates.
  // Only the TeX source serializer removes their non-LaTeX placeholder ink.
  const readSourceValue = () => readControlValue('latex-without-placeholders');
  const resizeText = () => {
    if (!isDirectTextControl(control)) return;
    control.style.minHeight = '0';
    control.style.minHeight = `${Math.max(1, control.scrollHeight)}px`;
  };
  // The transparent input has browser line metrics; scrolling it into view
  // would move the real paper to a different line. Preserve the viewport
  // through native key/selection handling, while ordinary user scrolling
  // remains unrestricted outside those input frames.
  const keepPaperStill = () => {
    const session = directEditor;
    if (session?.sessionId !== sessionId || session.scrollLock) return;
    const lock = { top: pagesEl.scrollTop, left: pagesEl.scrollLeft };
    session.scrollLock = lock;
    const restore = () => {
      if (directEditor !== session || session.scrollLock !== lock) return;
      pagesEl.scrollTop = lock.top;
      pagesEl.scrollLeft = lock.left;
    };
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(() => { restore(); session.scrollLock = null; });
    });
  };
  control.addEventListener('beforeinput', keepPaperStill, { capture: true });
  control.addEventListener('beforeinput', event => {
    const session = directEditor;
    if (session?.sessionId !== sessionId || !isDirectTextControl(control) || session.imeComposing) return;
    session.revisitInputRange = null;
    if (!/^(insert|delete)/.test(event.inputType ?? '')) return;
    const targetRange = event.getTargetRanges?.()[0];
    const textOffset = (node, offset) => {
      const range = document.createRange(); range.selectNodeContents(control); range.setEnd(node, offset);
      return range.toString().length;
    };
    let selection = targetRange && control.contains(targetRange.startContainer) && control.contains(targetRange.endContainer)
      ? [textOffset(targetRange.startContainer, targetRange.startOffset), textOffset(targetRange.endContainer, targetRange.endOffset)]
      : directSelection(session);
    if (!selection) return;
    let start = Math.min(...selection), end = Math.max(...selection);
    if (start === end && event.inputType === 'deleteContentBackward') start -= [...readValue().slice(0, start)].at(-1)?.length ?? 0;
    if (start === end && event.inputType === 'deleteContentForward') end += [...readValue().slice(end)][0]?.length ?? 0;
    session.revisitInputRange = { start, end };
  }, { capture: true });
  control.addEventListener('keydown', keepPaperStill, { capture: true });
  let composing = false;
  const realignOpaqueCaret = () => alignOpaqueNativeCaretAnchor(sessionId);
  control.addEventListener('compositionstart', () => {
    composing = true;
    wysiwyg?.setComposing?.(true);
    if (directEditor?.sessionId === sessionId) {
      const session = directEditor;
      const selection = directSelection(session);
      if (isDirectTextControl(control) && selection) session.revisitInputRange = {
        start: Math.min(...selection), end: Math.max(...selection),
      };
      const offset = selection ? Math.min(...selection) : 0;
      const caret = session.geometryValue === String(session.readValue())
        ? session.kind === 'math'
          ? window.TdomDirectEditGeometry.mathCaret(session.control, session.glyphMap ?? [], offset, session.printBounds, session.sourceBoxes)
          : window.TdomDirectEditGeometry.caret(session.glyphMap ?? [], offset)
        : session.lastPaintedCaret;
      session.committedIme = null;
      session.imeComposing = true;
      session.compositionInk = caret
        ? { text: '', anchor: { ...caret, left: caret.x, right: caret.x } }
        : null;
      if (session.compositionInk && selection && session.geometryValue === readValue()) {
        const end = Math.max(...selection);
        const box = imeReplacementBox(session, offset, end, page);
        if (box) Object.assign(session.compositionInk, {
          box, start: offset, end, original: session.geometryValue, surface: page.dataset.canonPresentedSrc,
        });
      }
    }
    realignOpaqueCaret();
  });
  control.addEventListener('compositionupdate', event => {
    if (directEditor?.sessionId === sessionId && directEditor.compositionInk) {
      directEditor.compositionInk.text = event.data ?? '';
      paintDirectSelection();
    }
    realignOpaqueCaret();
  });
  control.addEventListener('compositionend', event => {
    composing = false;
    wysiwyg?.setComposing?.(false);
    resizeText();
    sendDirectEdit(region, sessionId, readValue());
    if (directEditor?.sessionId === sessionId) {
      const ink = directEditor.compositionInk;
      const text = event.data ?? '';
      const value = readValue();
      if (ink?.box && text && !/[\r\n]/.test(text) && value !== ink.original &&
          value === ink.original.slice(0, ink.start) + text + ink.original.slice(ink.end)) {
        directEditor.committedIme = { anchor: ink.box, text, surface: ink.surface, value, offset: ink.start + text.length };
      }
      directEditor.imeComposing = false;
      directEditor.compositionInk = null;
    }
    for (const batch of opaqueCanonicalBatches.values()) tryCommitOpaqueCanonicalBatch(batch);
    paintDirectSelection();
    realignOpaqueCaret();
  });
  control.addEventListener('input', () => {
    // Connecting MathLive can emit its initial value before this session is
    // installed. That is setup, not user input against a displayed anchor.
    if (directEditor?.sessionId !== sessionId) return;
    resizeText();
    realignOpaqueCaret();
    if (usesDirectEditSurface() && region.kind === 'math') {
      scheduleDirectEditorVisuals(true);
    }
    // Native IME composition can emit several transient input values.
    // Keep those local to the overlay and submit only the committed text.
    if (composing) return;
    sendDirectEdit(region, sessionId, readValue());
    scheduleDirectEditorVisuals();
  });
  // The aligned container belongs to MathLive only. Home, End and arrow
  // navigation must keep the caret inside its first or last cell.
  const keepAlignmentCaret = () => {
    if (!mathWrapped || !control.selectionIsCollapsed || control.lastOffset < 2) return;
    const pos = control.position;
    if (pos !== 0 && pos !== control.lastOffset) return;
    const inside = pos === 0 ? 1 : pos - 1;
    if (control.getEnvironmentContext?.(inside)?.environments.at(-1) === 'aligned') control.position = inside;
  };
  control.addEventListener('selection-change', () => {
    keepAlignmentCaret();
    scheduleDirectEditorVisuals();
  });
  control.addEventListener('keydown', (event) => {
    // Candidate navigation/confirmation/cancellation belongs to the IME.
    // In particular Escape must not cancel previously committed edits.
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (wysiwyg?.handleKeydown?.(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      sendDirectEdit(region, sessionId, region.value, { cancel: true });
      closeDirectEditor();
    } else if (region.kind === 'math' && event.key === 'Enter' && !event.shiftKey) {
      const api = control;
      if ((event.metaKey || event.ctrlKey) && typeof api.executeCommand === 'function') {
        const before = typeof api.getValue === 'function' ? String(api.getValue('latex') ?? '') : '';
        try { api.executeCommand('addColumnAfter'); } catch { /* finish below */ }
        const after = typeof api.getValue === 'function' ? String(api.getValue('latex') ?? '') : before;
        if (after !== before) {
          event.preventDefault();
          control.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      } else if (typeof api.executeCommand === 'function') {
        const before = typeof api.getValue === 'function' ? String(api.getValue('latex') ?? '') : '';
        try { api.executeCommand('addRowAfter'); } catch { /* finish below */ }
        const after = typeof api.getValue === 'function' ? String(api.getValue('latex') ?? '') : before;
        if (after !== before) {
          event.preventDefault();
          control.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
      }
      event.preventDefault();
      control.blur();
    } else if (
      region.kind === 'math' &&
      event.key === '/' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      typeof control.getValue === 'function'
    ) {
      const selection = control.selection;
      const range = Array.isArray(selection?.ranges?.[0])
        ? selection.ranges[0]
        : Array.isArray(selection) && typeof selection[0] === 'number'
          ? selection
          : null;
      if (range && range[0] !== range[1]) {
        const selected = String(control.getValue(range[0], range[1], 'latex') ?? '');
        if (selected) {
          event.preventDefault();
          try {
            control.executeCommand?.('insert', '\\frac{' + selected + '}{\\placeholder{}}', {
              selectionMode: 'placeholder',
              focus: true,
              feedback: false,
              format: 'latex',
            });
            control.dispatchEvent(new Event('input', { bubbles: true }));
          } catch { /* let MathLive keep the selection */ }
        }
      }
    }
  });
  control.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (directEditor?.sessionId === sessionId && !shell.contains(document.activeElement)) {
        // The temporary input sink owns focus while the next paper region
        // resolves. Finish this session only when its successor can open;
        // closing here can release a canonical batch and invalidate that click.
        if (openingDirectInput?.previousSessionId === sessionId) return;
        sendDirectEdit(region, sessionId, readValue(), { finish: true });
        closeDirectEditor();
      }
    }, 0);
  });
  clearPlaceForHost();
  shell.appendChild(control);
  page.appendChild(shell);
  const inkLayer = document.createElement('div');
  inkLayer.className = 'tdom-ink-layer';
  inkLayer.setAttribute('aria-hidden', 'true');
  page.appendChild(inkLayer);
  if (control.tagName === 'MATH-FIELD') {
    try { control.menuItems = []; } catch { /* field remains keyboard-editable */ }
  }
  const Coordinator = window.TdomOpaqueEditorCoordinator;
  const clickOnPaper = clickPoint
    ? paperPointForClick({ clientX: clickPoint.x, clientY: clickPoint.y }, page)
    : null;
  const caretAnchorRatio = Coordinator?.caretAnchorRatio?.(printBounds, clickOnPaper) ?? null;
  const visualHits = [...page.querySelectorAll('svg .tdom-source-hit[data-math="1"]')];
  const visualHit = clickPoint ? visualHits.filter(node => {
    const box = node.getBoundingClientRect();
    return clickPoint.x >= box.left && clickPoint.x <= box.right && clickPoint.y >= box.top && clickPoint.y <= box.bottom;
  }).sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0] : null;
  directEditor = {
    id,
    region,
    sessionId,
    element: shell,
    inkLayer,
    control,
    pageNumber,
    kind: region.kind,
    standalone: null,
    canonicalInput,
    sourceRegion: region,
    sourceSnapshot,
    sourceRev: anchorInk?.snapshot.srcRev ?? presentedRev,
    sourceText: sourceTextForRegion(sourceSnapshot, region),
    revisit,
    revisitDisplayRegion: region,
    revisitDisplaySourceText: displaySourceText,
    visualLine: visualHit?.dataset.line ?? target.dataset.line ?? null,
    wysiwyg: null,
    anchor: target,
    anchorMeta: {
      src: srcOf(target) || String(id).split(':')[0],
      line: target.dataset.line ?? null,
      math: target.dataset.math === '1',
      text: String(target.textContent ?? '').trim(),
    },
    anchorOffset: null,
    printBounds,
    caretOffset,
    caretAnchorRatio,
    // The visible candidate UI and the native IME window share one exact
    // canonical-paper anchor. Zoom/layout changes only project this point to
    // client pixels; a new document generation updates it in the same atomic
    // batch as the page and source mapping.
    canonicalAnchorPoint: clickOnPaper,
    nativeCaretAnchor: null,
    imeComposing: false,
    presentedId: presented?.id ?? null,
    presentedRev,
    readValue,
    writeValue,
    readSourceValue,
    sentEdit: false,
    lastVisibleValue: readValue(),
    serializedValue: region.kind === 'math' ? preserveMathAuxCommands(region.value, readSourceValue()) : null,
    formattedSource: region.sourceValue ?? region.value,
    sentFromSrcRev: anchorInk?.snapshot.srcRev ?? presentedRev,
  };
  if (pendingHit && revisit && pendingHit.sessionId === revisit.sessionId) {
    directEditor.glyphMap = pendingHit.ink.basis.map;
    directEditor.geometryValue = region.value;
  }
  if (sourceFormulaOpening) {
    // Keep the source-backed ink clickable until the session actually
    // changes it. Escape can return to this exact opening snapshot.
    directEditor.openedFromSourceFormula = true;
    directEditor.formulaBasis = pendingHit.ink.basis;
    directEditor.formulaSlot = pendingHit.ink.slot;
  }
  if (anchorInk) {
    directEditor.shipOpeningSrc = anchorInk.shipSrc;
    directEditor.chunkOpeningEpoch = anchorInk.chunkEpoch;
    if (nativeShip && region.kind === 'math') {
      directEditor.sourceBoxes = anchorInk.sourceBoxes ?? [];
      directEditor.formulaBasis = { map: anchorInk.map, value: region.value,
        structures: anchorInk.structures, displayRows: anchorInk.displayRows, completeMap: anchorInk.completeMap,
        emSize: anchorInk.emSize, epoch: sourceSnapshot.documentEpoch,
        src: anchorInk.shipSrc, rev: page.dataset.canonPresentedRev };
      void window.TdomDirectEditGeometry.formulaPageShapes(page.querySelector('img.canon'));
    }
    directEditor.projectedRev = anchorInk.projectedRev;
    if (anchorInk.slot) {
      directEditor.formulaSlot = anchorInk.slot;
      directEditor.formulaBasis = { map: anchorInk.map, value: region.value, started: true,
        epoch: sourceSnapshot.documentEpoch, rev: anchorInk.slot.rev, src: anchorInk.slot.src };
    }
    directEditor.glyphMap = anchorInk.map;
    directEditor.geometryValue = region.value;
  }
  directEditor.revisitModelIds = [];
  directEditor.revisitTokens = directRevisitTokens(directEditor, directEditor.revisitModelIds);
  directEditor.revisitOffsets = Array.from({ length: directEditor.revisitTokens.length + 1 }, (_, index) => index);
  directEditor.revisitBasisIds = [...directEditor.revisitModelIds];
  directEditor.revisitBasisOffsets = [...directEditor.revisitOffsets];
  if (inputOpening) inputOpening.sessionId = sessionId;
  requestDirectEditorPresentationAnchor(directEditor);
  // Position synchronously. Math WYSIWYG is loaded lazily and must not
  // leave a newly opened field flashing at the page origin meanwhile.
  repositionDirectEditor();
  if (region.kind === 'math' && control.tagName === 'MATH-FIELD') {
    try {
      const { initMathWysiwyg } = await loadMathWysiwyg();
      if (directEditor?.sessionId === sessionId) {
        wysiwyg = initMathWysiwyg({
          container: shell,
          autoSuggest: true,
          getMruStorageKey: () => 'tex64.math-wysiwyg.mru',
          insertKey: (key) => {
            const latex = String(key?.latex ?? '').replace(/#\?/g, '\\placeholder{}');
            if (!latex) return;
            try {
              control.executeCommand?.('insert', latex, {
                selectionMode: 'placeholder',
                focus: true,
                feedback: false,
                format: 'latex',
              });
              control.dispatchEvent(new Event('input', { bubbles: true }));
            } catch { /* keep the current formula intact */ }
          },
        });
        wysiwyg.attach(control);
        directEditor.wysiwyg = wysiwyg;
      }
    } catch { /* MathLive itself remains usable without suggestions */ }
  }
  repositionDirectEditor();
  resizeText();
  await new Promise(resolve => requestAnimationFrame(async () => {
    try {
    if (directEditor?.sessionId !== sessionId) return;
    // Leave native input on the opening sink until all awaited work is done.
    // Selecting/focusing the field earlier can consume input at a fallback
    // caret, or terminate an IME composition that began during PDF lookup.
    await refreshDirectEditGeometry(directEditor);
    const sourceCaret = region.kind === 'math' && Number.isInteger(caretOffset) &&
      typeof control.getPromptRange === 'function'
      ? mathModelOffsetFromSource(control, region.value, caretOffset, mathWrapped) : null;
    let openingMathOffset = pendingHit && (sourceFormulaOpening || revisit && pendingHit.sessionId === revisit.sessionId)
      ? pendingHit.offset : await waitForDirectOpeningMathGeometry(
      directEditor, inputOpening, clickOnPaper, sourceCaret
    );
    if (directEditor?.sessionId !== sessionId) return;
    if (revisit) {
      const originalOffset = region.kind === 'math' ? openingMathOffset : caretOffset;
      const restoredOffset = await restoreDirectEditorRevisit(directEditor, inputOpening, originalOffset, pendingHit);
      if (!Number.isInteger(restoredOffset)) {
        // The displayed edit no longer has a corresponding host range.
        // Retire only this field. A later click has its own input and source.
        if (directEditor?.sessionId === sessionId) closeDirectEditor();
        return;
      }
      if (region.kind === 'math') openingMathOffset = restoredOffset;
      else caretOffset = restoredOffset;
    }
    while (openingDirectInput === inputOpening) {
      const pending = [inputOpening, ...queuedDirectOpenings]
        .find(opening => opening?.composing || opening?.nativeInputPending);
      if (!pending) break;
      await (pending.composing ? pending.compositionDone : pending.nativeInputDone);
    }
    if (directEditor?.sessionId !== sessionId ||
        inputOpening && openingDirectInput !== inputOpening) return;
    const scrollTop = pagesEl.scrollTop;
    const scrollLeft = pagesEl.scrollLeft;
    if (inputOpening) inputOpening.focusTransferring = true;
    try { control.focus({ preventScroll: true }); } catch { control.focus(); }
    // MathLive starts its focus state synchronously but defers DOM focus by
    // 60 ms. Hand native input over now, before the opening queue is released;
    // otherwise its active-element guard still sees the temporary textarea.
    control.shadowRoot?.querySelector('.ML__keyboard-sink')?.focus({ preventScroll: true });
    if (isDirectTextControl(control)) {
      const selection = window.getSelection();
      let range = null;
      if (usesDirectEditSurface()) {
        if (Number.isInteger(caretOffset)) {
          const textNode = control.firstChild;
          if (textNode?.nodeType === Node.TEXT_NODE) {
            range = document.createRange();
            range.setStart(textNode, Math.max(0, Math.min(textNode.textContent?.length ?? 0, caretOffset)));
            range.collapse(true);
          }
        }
      } else if (clickPoint) {
        range = document.caretRangeFromPoint?.(clickPoint.x, clickPoint.y) ?? null;
        if (range && !control.contains(range.startContainer)) range = null;
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(control);
        range.collapse(false);
      }
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else if (Number.isInteger(openingMathOffset)) {
      setDirectSelection(directEditor, openingMathOffset);
    } else if (usesDirectEditSurface()) {
      if (Number.isInteger(sourceCaret) && sourceCaret >= 0) control.position = sourceCaret;
    } else if (clickPoint && typeof control.getOffsetFromPoint === 'function') {
      const offset = control.getOffsetFromPoint(clickPoint.x, clickPoint.y);
      if (Number.isFinite(offset) && offset >= 0) control.position = offset;
    } else if (control instanceof HTMLTextAreaElement) {
      control.setSelectionRange(control.value.length, control.value.length);
    }
    if (clickOnPaper && !pendingHit && directEditor.glyphMap?.length) {
      const offset = directGeometryHit(directEditor, clickOnPaper);
      if (Number.isInteger(offset)) setDirectSelection(directEditor, offset);
    }
    keepAlignmentCaret();
    alignOpaqueNativeCaretAnchor(sessionId);
    // Adding a DOM/MathLive selection can scroll after focus even when
    // preventScroll is honored. A preview click must never move the paper.
    pagesEl.scrollTop = scrollTop;
    pagesEl.scrollLeft = scrollLeft;
    requestAnimationFrame(() => {
      if (directEditor?.sessionId === sessionId && directEditor.pageNumber === pageNumber) {
        pagesEl.scrollTop = scrollTop;
        pagesEl.scrollLeft = scrollLeft;
      }
    });
    } finally { resolve(); }
  }));
}

// A first click resolves immutable PDF metadata asynchronously. Retain
// keystrokes arriving in that short interval until its real caret is ready.
let openingDirectInput = null;
const queuedDirectOpenings = [];
const directInputReplayEvents = new WeakSet();

function directOpeningInputTarget() {
  return queuedDirectOpenings.at(-1) ?? openingDirectInput;
}

function isPendingDirectOpening(opening) {
  return openingDirectInput === opening || queuedDirectOpenings.includes(opening);
}

function preserveDirectOpeningFocus(event, sessionId) {
  const capture = directOpeningInputTarget();
  if (!capture?.sink || openingDirectInput?.sessionId === sessionId && openingDirectInput.focusTransferring) return true;
  // A previous MathLive field can still have its 60 ms focus task queued.
  // Stop its native focus handler before it can schedule another transfer.
  event.stopImmediatePropagation();
  try { capture.sink.focus({ preventScroll: true }); } catch { capture.sink.focus(); }
  return false;
}

function disposeDirectOpeningInput(opening) {
  if (!opening) return;
  clearTimeout(opening.compositionTimer);
  opening.resolveComposition?.();
  opening.resolveComposition = null;
  resolveDirectOpeningNativeInput(opening);
  opening.resolveGeometry?.();
  opening.resolveGeometry = null;
  opening.cancelShipMap?.();
  opening.sink?.remove();
  if (openingDirectInput === opening) openingDirectInput = null;
  const queuedIndex = queuedDirectOpenings.indexOf(opening);
  if (queuedIndex >= 0) queuedDirectOpenings.splice(queuedIndex, 1);
  opening.resolveDone?.();
  queueMicrotask(() => {
    if (!openingDirectInput) flushDirectPresentationUpdates();
  });
}

function cancelDirectOpenings() {
  for (const pending of [...queuedDirectOpenings, openingDirectInput]) disposeDirectOpeningInput(pending);
}

function resolveDirectOpeningNativeInput(opening) {
  if (!opening) return;
  opening.nativeInputPending = false;
  opening.resolveNativeInput?.();
  opening.resolveNativeInput = null;
}

function waitForDirectOpeningNativeInput(opening, key) {
  resolveDirectOpeningNativeInput(opening);
  opening.nativeInputPending = true;
  opening.nativeInputKey = key;
  opening.nativeInputDone = new Promise(resolve => { opening.resolveNativeInput = resolve; });
}

async function waitForDirectOpeningMathGeometry(session, opening, point, sourceCaret) {
  if (!opening || !session || session.kind !== 'math' || !point) return null;
  while (openingDirectInput === opening && directEditor === session) {
    if (session.geometryValue === String(session.readValue()) && session.glyphMap?.length) {
      const offset = directGeometryHit(session, point);
      if (Number.isInteger(offset) && offset >= 0) return offset;
    }
    if (Number.isInteger(sourceCaret) && sourceCaret >= 0) return sourceCaret;
    // No proven paper/source caret yet. Keep native input on the temporary
    // sink instead of replaying at MathLive's default end-of-formula offset.
    if (!opening.geometryRetryScheduled) {
      opening.geometryRetryScheduled = true;
      const retry = () => requestAnimationFrame(() => {
        if (openingDirectInput === opening && directEditor === session &&
            (!session.glyphMap?.length || session.geometryValue !== String(session.readValue()))) {
          void refreshDirectEditGeometry(session);
        }
      });
      // MathLive mount schedules its render and fonts independently. Retry
      // at their next stable frame, without polling an unsupported formula.
      retry();
      if (document.fonts?.status === 'loading') document.fonts.ready.then(retry);
    }
    let ready;
    await new Promise(resolve => {
      ready = resolve;
      session.resolveOpeningGeometry = resolve;
      opening.resolveGeometry = resolve;
    });
    if (session.resolveOpeningGeometry === ready) session.resolveOpeningGeometry = null;
    if (opening.resolveGeometry === ready) opening.resolveGeometry = null;
  }
  return null;
}

function focusDirectOpeningInput(opening, event) {
  if (!opening || opening.sink) return;
  const sink = document.createElement('textarea');
  sink.className = 'tdom-direct-opening-input';
  sink.setAttribute('aria-label', 'Edit document');
  sink.tabIndex = -1;
  sink.spellcheck = false;
  sink.rows = sink.cols = 1;
  sink.style.left = event.clientX + 'px';
  sink.style.top = event.clientY + 'px';
  opening.sink = sink;
  sink.addEventListener('beforeinput', input => {
    resolveDirectOpeningNativeInput(opening);
    if (!isPendingDirectOpening(opening) || opening.composing || input.isComposing ||
        input.inputType === 'insertCompositionText' || input.inputType === 'insertFromComposition' || !input.cancelable) return;
    let operation = null;
    if (input.inputType?.startsWith('insert') && typeof input.data === 'string') {
      operation = { type: 'text', text: input.data };
    } else if (['insertLineBreak', 'insertParagraph'].includes(input.inputType)) {
      operation = { type: 'key', key: 'Enter' };
    } else if (['deleteContentBackward', 'deleteContentForward'].includes(input.inputType)) {
      operation = { type: 'key', key: input.inputType === 'deleteContentBackward' ? 'Backspace' : 'Delete' };
    }
    if (!operation) return;
    input.preventDefault();
    input.stopImmediatePropagation();
    opening.operations.push(operation);
  });
  sink.addEventListener('input', input => {
    resolveDirectOpeningNativeInput(opening);
    if (!isPendingDirectOpening(opening) || opening.composing || input.isComposing) return;
    // Native insertion/accessibility can deliver input without a cancelable
    // beforeinput. Read only this temporary sink, never another editor.
    const text = sink.value || input.data || '';
    if (text) opening.operations.push({ type: 'text', text });
    sink.value = '';
    input.stopImmediatePropagation();
  });
  sink.addEventListener('compositionstart', () => {
    if (!isPendingDirectOpening(opening)) return;
    resolveDirectOpeningNativeInput(opening);
    clearTimeout(opening.compositionTimer);
    opening.resolveComposition?.();
    opening.composing = true;
    // Keep the native IME focused while the source lookup runs. Its marked
    // text and candidate window should already be visible at the click.
    const page = pageAtClientPoint(event, event.target);
    const rect = page?.getBoundingClientRect();
    const position = (x, y, height) => {
      sink.style.left = x + 'px';
      sink.style.top = y + 'px';
      sink.style.fontSize = height + 'px';
      sink.style.maxWidth = Math.max(height, Math.min(innerWidth, rect?.right ?? innerWidth) - x) + 'px';
    };
    const scale = rect && rect.width / activePaperGeometry(page).width;
    const height = scale > 0 ? 13 * scale : 16;
    position(event.clientX, event.clientY - height / 2, height);
    sink.classList.add('is-composing');
    const shown = page && presentedPageState(page);
    const point = shown && paperPointForClick(event, page);
    if (point) void canonicalGlyphs(Number(page.dataset.page), shown.id).then(glyphs => {
      if (!opening.composing || !sink.isConnected || presentedPageState(page)?.id !== shown.id) return;
      const glyph = glyphs.find(g => point.x >= g.left && point.x <= g.right && point.y >= g.top && point.y <= g.bottom);
      if (!glyph) return;
      const box = clientBoundsForDisplayedPaperBounds(glyph, page);
      if (box) position(point.x < (glyph.left + glyph.right) / 2 ? box.left : box.right, box.top, box.bottom - box.top);
    });

    opening.compositionDone = new Promise(resolve => { opening.resolveComposition = resolve; });
  });
  sink.addEventListener('compositionend', input => {
    if (!isPendingDirectOpening(opening)) return;
    sink.classList.remove('is-composing');
    if (input.data) opening.operations.push({ type: 'text', text: input.data, composed: true });
    // Keep the sink through the final native input event as well. Switching
    // focus inside compositionend can drop or duplicate the committed text.
    opening.compositionTimer = setTimeout(() => {
      if (!isPendingDirectOpening(opening)) return;
      sink.value = '';
      opening.composing = false;
      opening.resolveComposition?.();
      opening.resolveComposition = null;
    }, 0);
  });
  document.body.appendChild(sink);
  try { sink.focus({ preventScroll: true }); } catch { sink.focus(); }
}

if (directEditingOn()) document.addEventListener('keydown', event => {
  const opening = directOpeningInputTarget();
  if (!opening || opening.composing || directInputReplayEvents.has(event)) return;
  if (event.isComposing || event.keyCode === 229 ||
      event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    // Keep focus through the native result as well: compositionstart can
    // follow this key in a later event while geometry becomes ready.
    waitForDirectOpeningNativeInput(opening, event.key);
    return;
  }
  if (event.key === 'Escape') {
    const activeOpening = openingDirectInput;
    cancelDirectOpenings();
    if (activeOpening?.sessionId && directEditor?.sessionId === activeOpening.sessionId) closeDirectEditor();
    directEditClickEpoch++;
    return;
  }
  const navigation = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Tab'].includes(event.key) &&
    !(event.key === 'Tab' && (event.metaKey || event.ctrlKey || event.altKey));
  // IME can begin after a printable keydown whose isComposing is still
  // false. Let the native sink receive that key and retain only its eventual
  // beforeinput/composition result, rather than preventing composition.
  const deletion = !event.metaKey && !event.ctrlKey && !event.altKey &&
    ['Backspace', 'Delete'].includes(event.key);
  if (!navigation && !deletion) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  opening.operations.push({ type: 'key', key: event.key, code: event.code,
    shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, repeat: event.repeat });
}, { capture: true });

if (directEditingOn()) document.addEventListener('keyup', event => {
  const opening = [openingDirectInput, ...queuedDirectOpenings]
    .find(pending => pending?.sink === event.target) ?? directOpeningInputTarget();
  // A key can produce no input (for example an unavailable dead-key pair).
  // Releasing it ends that native attempt without adding a character.
  if (opening?.nativeInputKey === event.key) resolveDirectOpeningNativeInput(opening);
}, { capture: true });

if (directEditingOn()) document.addEventListener('paste', event => {
  const opening = directOpeningInputTarget();
  if (!opening || directInputReplayEvents.has(event) || !event.clipboardData) return;
  // Retain only the strings delivered by this paste gesture. Replaying must
  // never read a newer system clipboard or request clipboard permission.
  const formats = {};
  for (const type of ['text/plain', 'application/x-latex', 'application/json+mathlive', 'application/json']) {
    if (event.clipboardData.types.includes(type)) formats[type] = event.clipboardData.getData(type);
  }
  if (!Object.keys(formats).length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  opening.operations.push({ type: 'paste', formats });
}, { capture: true });

function replayDirectOpeningOperation(session, operation) {
  const control = session.control;
  // execCommand can emit input without beforeinput. Preserve the actual
  // selected range for repeated letters in buffered native typing as well.
  if (isDirectTextControl(control) && (['text', 'paste'].includes(operation.type) ||
      operation.type === 'key' && (operation.key.length === 1 || ['Enter', 'Backspace', 'Delete'].includes(operation.key)))) {
    const selection = directSelection(session);
    if (selection) {
      let start = Math.min(...selection), end = Math.max(...selection);
      if (start === end && operation.key === 'Backspace') start -= [...session.readValue().slice(0, start)].at(-1)?.length ?? 0;
      if (start === end && operation.key === 'Delete') end += [...session.readValue().slice(end)][0]?.length ?? 0;
      session.revisitInputRange = { start, end };
    }
  }
  if (operation.type === 'text') {
    if (isDirectTextControl(control)) document.execCommand('insertText', false, operation.text);
    else if (!operation.composed && /^[\x20-\x7e]+$/.test(operation.text)) {
      // Committed Latin typing still needs the WYS keydown anchor/mode path.
      // Composition commits are already text; do not reinterpret them as
      // candidate-confirmation or structure-editing keystrokes.
      for (const key of operation.text) {
        if (directEditor !== session) break;
        replayDirectOpeningOperation(session, { type: 'key', key });
      }
    } else control.executeCommand('typedText', operation.text, { focus: true, feedback: false, simulateKeystroke: !operation.composed });
    paintDirectSelection();
    return;
  }
  if (operation.type === 'paste') {
    if (isDirectTextControl(control)) {
      document.execCommand('insertText', false, operation.formats['text/plain'] ?? '');
    } else {
      const sink = control.shadowRoot?.querySelector('.ML__keyboard-sink');
      if (!sink) return;
      const data = new DataTransfer();
      for (const [type, value] of Object.entries(operation.formats)) data.setData(type, value);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true });
      directInputReplayEvents.add(event);
      sink.dispatchEvent(event);
    }
    return;
  }
  const { key, shiftKey, ctrlKey, altKey, metaKey } = operation;
  const event = new KeyboardEvent('keydown', { ...operation, bubbles: true, cancelable: true, composed: true });
  directInputReplayEvents.add(event);
  // The host's capture/bubble handlers establish the WYS trigger anchor,
  // handle candidates, slash selection and matrix Enter before insertion.
  if (!control.dispatchEvent(event) || directEditor !== session) return;
  if (isDirectTextControl(control)) {
    if (key.length === 1 || key === 'Enter') document.execCommand('insertText', false, key === 'Enter' ? '\n' : key);
    else if (key === 'Backspace' || key === 'Delete') document.execCommand(key === 'Backspace' ? 'delete' : 'forwardDelete');
    else if (key === 'Tab') control.blur();
    else {
      const backward = ['ArrowLeft', 'ArrowUp', 'Home'].includes(key);
      const granularity = key === 'Home' || key === 'End' || metaKey && (key === 'ArrowUp' || key === 'ArrowDown') ? 'documentboundary'
        : metaKey ? 'lineboundary' : ctrlKey || altKey ? 'word'
        : key === 'ArrowUp' || key === 'ArrowDown' ? 'line' : 'character';
      window.getSelection()?.modify(shiftKey ? 'extend' : 'move', backward ? 'backward' : 'forward', granularity);
    }
  } else if (key.length === 1) {
    control.executeCommand('typedText', key, { focus: true, feedback: false, simulateKeystroke: true });
  } else {
    let command;
    if (key === 'Backspace' || key === 'Delete') command = key === 'Backspace' && !shiftKey ? 'deleteBackward' : 'deleteForward';
    else if (key === 'Tab') command = shiftKey ? 'moveToPreviousGroup' : 'moveToNextGroup';
    else if (key === 'ArrowUp' || key === 'ArrowDown') command = shiftKey
      ? key === 'ArrowUp' ? 'extendSelectionUpward' : 'extendSelectionDownward'
      : key === 'ArrowUp' ? 'moveUp' : 'moveDown';
    else if (key !== 'Enter') {
      const backward = key === 'ArrowLeft' || key === 'Home';
      if (key === 'Home' || key === 'End' || metaKey) command = shiftKey
        ? backward ? 'extendToMathFieldStart' : 'extendToMathFieldEnd'
        : backward ? 'moveToMathfieldStart' : 'moveToMathfieldEnd';
      else if (ctrlKey) command = shiftKey
        ? backward ? 'extendToGroupStart' : 'extendToGroupEnd'
        : backward ? 'moveToGroupStart' : 'moveToGroupEnd';
      else if (altKey) command = shiftKey
        ? backward ? 'extendToPreviousWord' : 'extendToNextWord'
        : backward ? 'moveToPreviousWord' : 'moveToNextWord';
      else command = shiftKey
        ? backward ? 'extendSelectionBackward' : 'extendSelectionForward'
        : backward ? 'moveToPreviousChar' : 'moveToNextChar';
    }
    if (command) control.executeCommand(command);
  }
  paintDirectSelection();
}

async function activateDirectEditor(event, queuedOpening = null) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.target?.closest?.('.tdom-direct-editor')) return;
  if (!queuedOpening && openingDirectInput &&
      (openingDirectInput.operations.length || openingDirectInput.composing ||
        openingDirectInput.nativeInputPending || queuedDirectOpenings.length)) {
    // Each click retains its own native input. Resolve and send the earlier
    // edit first, while subsequent typing goes to the latest clicked sink.
    const queued = { operations: [], event };
    const done = new Promise(resolve => { queued.resolveDone = resolve; });
    queuedDirectOpenings.push(queued);
    event.preventDefault();
    event.stopPropagation();
    focusDirectOpeningInput(queued, event);
    return done;
  }
  const previous = directEditor;
  if (!queuedOpening) disposeDirectOpeningInput(openingDirectInput);
  const opening = queuedOpening ?? { operations: [] };
  opening.previousSessionId = previous?.sessionId ?? null;
  openingDirectInput = opening;
  try {
    await activateDirectEditorAtPoint(event);
    if (openingDirectInput !== opening) return;
    if (!directEditor || directEditor === previous) {
      // The lookup has finished without an editable target. Its keys belong
      // only to this click; later queued clicks must be allowed to resolve.
      // Keep an in-progress native key/IME on its own sink through commit.
      while (openingDirectInput === opening && (opening.composing || opening.nativeInputPending)) {
        await (opening.composing ? opening.compositionDone : opening.nativeInputDone);
      }
      return;
    }
    const session = directEditor;
    for (const operation of opening.operations) {
      if (directEditor !== session || !session.element.contains(document.activeElement)) break;
      replayDirectOpeningOperation(session, operation);
    }
    if (opening.operations.length && directEditor === session) session.control.dispatchEvent(new Event('input', { bubbles: true }));
    opening.completed = directEditor === session;
  } finally {
    disposeDirectOpeningInput(opening);
    if (!openingDirectInput && queuedDirectOpenings.length) {
      const next = queuedDirectOpenings.shift();
      const capture = queuedDirectOpenings.at(-1) ?? next;
      try { capture.sink?.focus({ preventScroll: true }); } catch { capture.sink?.focus(); }
      void activateDirectEditor(next.event, next);
    }
    if (!openingDirectInput && directEditor === previous &&
        previous && !previous.element.contains(document.activeElement)) {
      sendDirectEdit(previous.region, previous.sessionId, previous.readValue(), { finish: true });
      closeDirectEditor();
    }
  }
}

// Shipping can already have painted the new page while its source-mapped
// PDF is still queued. Keep native input focused during that handoff. Use
// the physical click only when the same revision prints the same ink there.
function clickInkPixels(image, paper, point) {
  if (!image?.naturalWidth || !image.naturalHeight || !(paper.width > 0 && paper.height > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    const sx = image.naturalWidth / paper.width, sy = image.naturalHeight / paper.height;
    ctx.drawImage(image, (point.x - 24) * sx, (point.y - 16) * sy, 48 * sx, 32 * sy, 0, 0, 96, 64);
    return ctx.getImageData(0, 0, 96, 64).data;
  } catch { return null; }
}

// The replay owns a branch-private SyncTeX stream for the exact PDF being
// shown. Require both its native source row and actual painted glyphs.
async function nativeShipHit(page, shipping, point, current) {
  const pageNumber = Number(page.dataset.page), url = new URL(shipping.src, location.href);
  const query = new URLSearchParams(url.searchParams);
  query.set('page', pageNumber);
  const [snapshot, rows, glyphs] = await Promise.all([
    loadProvisionalSnapshot(shipping.rev),
    fetch('/ship-source-rows?' + query).then(r => r.ok ? r.json() : null).then(result => result?.rows),
    displayedShipGlyphs(pageNumber, shipping.src),
  ]);
  if (!current() || !rows?.length || snapshot?.srcRev !== shipping.rev || !glyphs.length) return null;
  const touches = box => point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  const targets = rows.filter(r => !r.empty && touches(r.box));
  const copies = [], textHits = [];
  const geometry = window.TdomDirectEditGeometry;
  const lines = new Map(), checkedDisplays = new Set();
  for (const target of targets) {
    const key = target.file + '\n' + target.line;
    if (!lines.has(key)) lines.set(key, target);
  }
  for (const { file: physicalFile, line } of lines.values()) {
    const sources = snapshot.sources.filter(s => sameSourceFile(s.file, physicalFile));
    if (sources.length !== 1) continue;
    const file = sources[0].file;
    const fileRows = rows.filter(row => row.file === physicalFile);
    const relevant = inlineSourceRows(fileRows, line);
    // TeX tags the outer line with the blank line terminating a paragraph.
    // An inline atom's own box points to the actual source line.
    if (snapshot.blocks?.some(block => block.type === 'paragraph' && block.editRegions?.some(region =>
        region.kind === 'math' && !region.display && sourceNearLine(region.source, { file, line })))) {
      copies.push(...await inlineMathCopies(snapshot, { file, line }, pageNumber, null, current,
        null, relevant, false, true, glyphs));
      if (!current()) return null;
    }
    for (const block of snapshot.blocks) {
      for (const region of block.editRegions ?? []) {
        if (!region.display || region.kind !== 'math' || !sourceNearLine(region.source, { file, line }) ||
            checkedDisplays.has(region.id)) continue;
        checkedDisplays.add(region.id);
        const boxes = fileRows.filter(row => sourceNearLine(region.source, { file, line: row.line }));
        const extent = inkBounds(boxes.filter(row => !row.empty).map(row => row.box), pageNumber);
        const match = await matchDisplaySourceFormula(region, extent, boxes, glyphs, current);
        if (!current()) return null;
        if (match) copies.push({ ...match, region, extent, sourceBoxes: boxes });
      }
    }
    const paragraph = (snapshot.blocks ?? []).filter(b => b.type === 'paragraph' && b.source?.file === file &&
      (b.source.end.line === line || b.source.end.line + 1 === line));
    if (paragraph.length !== 1) continue;
    const block = paragraph[0];
    const sourceLine = block.source.start.line;
    if (line < sourceLine || line > sourceLine + 1 ||
        block.sourceRanges?.some(range => !sameSourceFile(range.file, file)) ||
        block.editRegions?.some(region => region.source?.file !== file ||
          region.source.start.line !== sourceLine || region.source.end.line !== sourceLine)) continue;
    // Multiple boxes can enclose the same glyph. The shaped baseline and
    // the paragraph's reading order must both agree with the text run.
    const baseRows = fileRows.filter(r => r.line === line && !r.empty);
    const rowGlyphs = glyphs.filter(g => baseRows.some(r => Math.abs(r.y - g.baseline) <= 0.25 &&
      (g.left + g.right) / 2 >= r.box.left - 0.25 && (g.left + g.right) / 2 <= r.box.right + 0.25));
    for (const region of block.editRegions ?? []) {
      if (region.kind !== 'text' || region.source?.file !== file || region.source.start.line !== block.source.start.line) continue;
      const hits = geometry.textMaps(region.value, rowGlyphs);
      if (hits.length !== 1 || !hits[0].map.some(touches)) continue;
      const map = hits[0].map;
      textHits.push({ region, map, printBounds: inkBounds(map, pageNumber), caretOffset: geometry.hit(map, point) });
    }
  }
  const mathHit = inlineFormulaHit(copies, pageNumber, point);
  if (mathHit && !textHits.length) return { ...mathHit, snapshot, shipSrc: shipping.src };
  if (textHits.length === 1 && !copies.some(copy => copy.map.some(touches))) {
    return { ...textHits[0], snapshot, shipSrc: shipping.src };
  }
  return null;
}

async function sourceMappedShipClick(page, event, shipping, opening) {
  const point = paperPointForClick(event, page), paper = activePaperGeometry(page);
  if (!point || shipping.rev !== appliedSrcRev) return null;
  event.preventDefault();
  event.stopPropagation();
  focusDirectOpeningInput(opening, event);
  const epoch = documentReset.adoptedEpoch;
  const current = () => openingDirectInput === opening && !documentReset.pending && documentReset.adoptedEpoch === epoch &&
    appliedSrcRev === shipping.rev && page.isConnected && presentedShippingPageState(page)?.src === shipping.src;
  const hit = await nativeShipHit(page, shipping, point, current).catch(() => null);
  if (!current()) return null;
  if (hit) {
    const rect = clientBoundsForDisplayedPaperBounds({ left: point.x, top: point.y, right: point.x, bottom: point.y }, page);
    if (rect) await openDirectEditor(hit.region.id, page, hit.region, { x: rect.left, y: rect.top },
      hit.printBounds, hit.caretOffset, hit);
    return null;
  }
  const original = clickInkPixels(shipping.image, paper, point);
  if (!original) return null;
  opening.waitingForShipMap = shipping.rev;
  const mapped = await new Promise(resolve => {
    const finish = state => {
      observer.disconnect();
      delete opening.checkShipMap;
      delete opening.cancelShipMap;
      resolve(state);
    };
    const check = () => {
      if (openingDirectInput !== opening || documentReset.pending || documentReset.adoptedEpoch !== epoch ||
          appliedSrcRev !== shipping.rev || canonical?.rev > shipping.rev || canonical?.errorRev === shipping.rev || !page.isConnected) return finish(null);
      const state = presentedPageState(page);
      if (state?.rev === shipping.rev) finish(state);
    };
    const observer = new MutationObserver(check);
    observer.observe(pagesEl, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-canon-presented-id', 'data-canon-presented-rev', 'data-canon-presented-src'] });
    opening.checkShipMap = check;
    opening.cancelShipMap = () => finish(null);
    if (canonical?.rev === shipping.rev) updateCanonState(Number(page.dataset.page));
    else requestCanonicalDisplay({ residentImpossible: true });
    check();
  });
  delete opening.waitingForShipMap;
  if (!mapped || openingDirectInput !== opening || appliedSrcRev !== shipping.rev) return null;
  const nextPaper = activePaperGeometry(page);
  // pdfinfo rounds to three decimal places. PDF.js exposes the original
  // page box, so compare in the precision common to both documents.
  if (paper.rotation !== nextPaper.rotation || Math.abs(paper.width - nextPaper.width) > 0.001 ||
      Math.abs(paper.height - nextPaper.height) > 0.001) return null;
  const ink = clickInkPixels(mapped.image, paper, point);
  if (!ink || !original.every((value, index) => value === ink[index])) return null;
  const bounds = clientBoundsForDisplayedPaperBounds({ left: point.x, top: point.y, right: point.x, bottom: point.y }, page);
  return bounds && { target: page, clientX: bounds.left, clientY: bounds.top,
    preventDefault() {}, stopPropagation() {} };
}

// A plain click edits; Cmd/Ctrl+click remains source navigation.  Only the
// printed node under the pointer activates, so scrolling/searching elsewhere
// on the page never creates editor DOM.
async function activateDirectEditorAtPoint(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target?.closest?.('.tdom-direct-editor')) return;
  const clickedPage = pageAtClientPoint(event, event.target);
  const shipping = presentedShippingPageState(clickedPage);
  if (shipping) {
    event = await sourceMappedShipClick(clickedPage, event, shipping, openingDirectInput);
    if (!event) return;
  }
  const clickEpoch = ++directEditClickEpoch;
  const target = usesDirectEditSurface(clickedPage) || event.directRegionId ? clickedPage :
    event.target?.closest?.('[data-edit], .tdom-source-hit, [data-src]');
  if (!target) return;
  const targetPage = pageAtClientPoint(event, target);
  const canonicalClick = usesDirectEditSurface(targetPage);
  const presented = canonicalClick ? presentedPageState(targetPage) : null;
  const provisionalSnapshot = targetPage?.provisionalSnapshot;
  const provisionalEpoch = targetPage?.provisionalEpoch;
  if (canonicalClick && !presented) return;
  const stillCurrent = () => {
    if (clickEpoch !== directEditClickEpoch || !targetPage?.isConnected) return false;
    if (!canonicalClick) return !usesDirectEditSurface(targetPage) &&
      targetPage.provisionalSnapshot === provisionalSnapshot && targetPage.provisionalEpoch === provisionalEpoch;
    const current = presentedPageState(targetPage);
    return current?.id === presented.id && current?.rev === presented.rev && current?.src === presented.src;
  };
  event.preventDefault();
  event.stopPropagation();
  focusDirectOpeningInput(openingDirectInput, event);
  const clickPoint = { x: event.clientX, y: event.clientY };
  const id = event.directRegionId ?? target.dataset.edit;
  if (id) {
    const region = await editRegionById(id, targetPage);
    if (region && stillCurrent()) {
      await openDirectEditor(id, target, region, clickPoint);
    }
    return;
  }
  if (canonicalClick) {
    const page = targetPage;
    const pendingHit = pendingFormulaHit(page, paperPointForClick(event, page));
    const sourceInk = pendingHit?.ink.sourceSnapshot ? pendingHit.ink : null;
    // An unfinished edit elsewhere may leave this formula on an older
    // source revision. Only open it if Monaco can still identify the
    // very same bytes. Never fall through to different ink underneath.
    const clickedSnapshot = sourceInk?.sourceSnapshot;
    const staleSource = clickedSnapshot && clickedSnapshot.srcRev !== appliedSrcRev;
    if (staleSource && (!await confirmSourceFormulaAnchor(clickedSnapshot, sourceInk.region, false) ||
        sourceInk.sourceSnapshot !== clickedSnapshot || pendingFormulas.get(sourceInk.slot.key) !== sourceInk)) return;
    const anchorInk = sourceInk ? { snapshot: clickedSnapshot, map: sourceInk.map } :
      pendingHit ? null : await editAtAnchorInk(page, event);
    const resolved = pendingHit ? { region: pendingHit.ink.region, printBounds: pendingHit.ink.bounds }
      : anchorInk === undefined ? await resolveOpaqueEditRegion(page, event) : anchorInk;
    if (resolved && stillCurrent() && (!anchorInk || staleSource || anchorInk.snapshot.srcRev === appliedSrcRev)) {
      await openDirectEditor(
        resolved.region.id,
        page,
        resolved.region,
        clickPoint,
        resolved.printBounds,
        resolved.caretOffset,
        anchorInk, pendingHit
      );
      // (found by its ink: followed by its ink too when the next canonical pages land)
      if (resolved.byInk && directEditor?.region?.id === resolved.region.id) directEditor.openedByInk = true;
    }
    return;
  }
  const resolved = await resolveEditRegion(target, event);
  if (resolved && stillCurrent()) {
    const { chunkMap, ...region } = resolved;
    // The awaited metadata may have replaced the clicked SVG. The page
    // remains stable and the exact glyph map reacquires this source's ink.
    const ink = chunkMap && { map: chunkMap, snapshot: provisionalSnapshot, chunkEpoch: provisionalEpoch };
    await openDirectEditor(region.id, target.isConnected ? target : targetPage, region, clickPoint,
      ink ? inkBounds(chunkMap, Number(targetPage.dataset.page)) : null, null, ink);
  }
}

let directPointer = null;
let suppressDirectClick = false;
if (directEditingOn()) pagesEl.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey ||
      event.target.closest?.('.math-wysiwyg-panel')) return;
  const page = pageAtClientPoint(event, event.target);
  if (!page) return;
  const point = paperPointForClick(event, page);
  const session = directEditor;
  const pending = pendingFormulaHit(page, point);
  const map = pending && session?.formulaSlot?.key === pending.ink.slot.key && session.readValue() === pending.value ? pending.ink.map :
    session && session.geometryValue === String(session.readValue()) ? session.glyphMap : null;
  const glyph = session?.pageNumber === Number(page.dataset.page) && map
    ? window.TdomDirectEditGeometry.nearest(map, point) : null;
  const inside = glyph && point.x >= glyph.left - 2 && point.x <= glyph.right + 2 &&
    point.y >= glyph.top - 2 && point.y <= glyph.bottom + 2;
  directPointer = { page, event, point, session: inside ? session : null, preservePoint: Boolean(pending || presentedShippingPageState(page)), moved: false };
  if (openingDirectInput && session && (inside || event.target.closest?.('.tdom-direct-editor'))) {
    // Returning to the still-visible old editor is another queued click.
    // Its control will be removed by earlier queued edits, so retain the
    // paper page (and structured region id) rather than that transient DOM.
    const revisit = {
      target: page,
      directRegionId: usesDirectEditSurface(page) ? null : session.id,
      clientX: event.clientX, clientY: event.clientY,
      shiftKey: event.shiftKey,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    };
    directPointer.event = revisit;
    directPointer.session = null;
    event.preventDefault();
    suppressDirectClick = true;
    directPointer.activation = activateDirectEditor(revisit);
    directPointer.opening = directOpeningInputTarget();
    return;
  }
  if (pending && !inside && event.pointerType === 'mouse') {
    // A canonical page can replace these glyphs while the mouse is down.
    // Open against the source and caret the reader actually pressed.
    event.preventDefault();
    suppressDirectClick = true;
    directPointer.start = pending.offset;
    directPointer.activation = activateDirectEditor(event);
    directPointer.opening = directOpeningInputTarget();
    return;
  }
  if (session && !inside && !event.target.closest?.('.tdom-direct-editor')) {
    // Preserve the current input until click installs its synchronous sink.
    // A native pointerdown blur must not close/repaint the page in between.
    event.preventDefault();
  }
  if (inside) {
    event.preventDefault();
    session.control.focus({ preventScroll: true });
    const hit = directGeometryHit(session, point);
    directPointer.start = event.shiftKey ? directSelection(session)?.[0] ?? hit : hit;
    setDirectSelection(session, directPointer.start, hit);
    pagesEl.setPointerCapture(event.pointerId);
    suppressDirectClick = true;
  }
}, { capture: true });
if (directEditingOn()) pagesEl.addEventListener('pointermove', event => {
  const drag = directPointer;
  if (!drag) return;
  const point = paperPointForClick(event, drag.page);
  drag.moved ||= Math.hypot(event.clientX - drag.event.clientX, event.clientY - drag.event.clientY) > 3;
  drag.end = point;
  if (drag.session && directEditor === drag.session && drag.moved) {
    event.preventDefault();
    const offset = directGeometryHit(drag.session, point);
    if (Number.isInteger(offset)) setDirectSelection(drag.session, drag.start, offset);
  }
});
if (directEditingOn()) pagesEl.addEventListener('pointerup', async event => {
  const drag = directPointer;
  directPointer = null;
  if (pagesEl.hasPointerCapture(event.pointerId)) pagesEl.releasePointerCapture(event.pointerId);
  // The synthetic click can round off a subpixel inside a small subscript.
  // Use the original pointer on both live overlays and replayed PDF ink.
  if (drag?.preservePoint && !drag.moved && !drag.session && !drag.activation) {
    suppressDirectClick = true;
    void activateDirectEditor(drag.event);
    return;
  }
  if (!drag?.moved || drag.session) return;
  suppressDirectClick = true;
  const activation = drag.activation ?? activateDirectEditor(drag.event);
  const opening = drag.opening ?? directOpeningInputTarget();
  await activation;
  const session = directEditor;
  if (!opening?.completed || !session || session.sessionId !== opening.sessionId ||
      openingDirectInput && openingDirectInput !== opening ||
      session.pageNumber !== Number(drag.page.dataset.page)) return;
  await new Promise(resolve => requestAnimationFrame(resolve));
  await refreshDirectEditGeometry(session);
  if (directEditor !== session || !session.glyphMap?.length) return;
  setDirectSelection(session, drag.start ?? directGeometryHit(session, drag.point), directGeometryHit(session, drag.end));
});
if (directEditingOn()) pagesEl.addEventListener('pointercancel', () => {
  const opening = directPointer?.opening;
  directPointer = null;
  suppressDirectClick = false;
  if (opening && isPendingDirectOpening(opening) && !opening.operations.length &&
      !opening.composing && !opening.nativeInputPending) {
    const active = openingDirectInput === opening;
    disposeDirectOpeningInput(opening);
    if (directEditor?.sessionId === opening.sessionId) closeDirectEditor();
    if (active) directEditClickEpoch++;
  }
});
if (directEditingOn()) pagesEl.addEventListener('click', event => {
  if (suppressDirectClick) { suppressDirectClick = false; return; }
  void activateDirectEditor(event);
});

let liveSearchRaf = 0;
let liveSearchEpoch = 0;
function scheduleLiveSearchRefresh() {
  if (liveSearchRaf) return;
  liveSearchRaf = requestAnimationFrame(() => {
    liveSearchRaf = 0;
    runLiveSearch(liveSearch.query, false, true);
  });
}

async function runLiveSearch(rawQuery, findPrevious = false, preserveIndex = false) {
  const epoch = ++liveSearchEpoch;
  const query = String(rawQuery ?? '').trim();
  const oldIndex = liveSearch.current;
  for (const marker of pagesEl.querySelectorAll('.tdom-search-marker')) marker.remove();
  if (!query) {
    liveSearch = { query: '', results: [], current: -1 };
    return;
  }
  const foldSearchText = (value) => String(value).toLocaleLowerCase().replace(/\s+/gu, '');
  const needle = foldSearchText(query);
  const results = [];
  for (const [pageNumber, page] of [...pageDivs.entries()].sort((a, b) => a[0] - b[0])) {
    const svg = page.querySelector('svg');
    if (!svg) continue;
    const elements = [...svg.querySelectorAll('text')];
    let haystack = '';
    const spans = [];
    for (const element of elements) {
      const value = foldSearchText(element.textContent ?? '');
      const start = haystack.length;
      haystack += value;
      spans.push({ element, start, end: haystack.length });
    }
    const folded = haystack;
    let from = 0;
    while (from <= folded.length - needle.length) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      const hits = spans.filter((span) => span.end > at && span.start < end).map((span) => span.element);
      if (hits.length) results.push({ pageNumber, page, svg, hits });
      from = at + Math.max(needle.length, 1);
    }
  }
  // Opaque documents intentionally have no provisional SVG/text layer.
  // Search their canonical PDF text on demand; pdftotext is cached by the
  // canonical renderer, so typing remains unaffected and repeat searches
  // do no extra process work.
  if (!results.length && canonical?.id) {
    try {
      const response = await fetch(`/canonical/text?c=${canonical.id}`, { cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json();
        (payload.pages ?? []).forEach((text, index) => {
          const folded = foldSearchText(text);
          let from = 0;
          while (from <= folded.length - needle.length) {
            const at = folded.indexOf(needle, from);
            if (at < 0) break;
            const pageNumber = index + 1;
            const page = pageDivs.get(pageNumber);
            if (page) results.push({ pageNumber, page, svg: null, hits: [] });
            from = at + Math.max(needle.length, 1);
          }
        });
      }
    } catch { /* canonical text search is best-effort */ }
  }
  if (epoch !== liveSearchEpoch) return;
  let current = -1;
  if (results.length) {
    if (preserveIndex) current = Math.min(Math.max(oldIndex, 0), results.length - 1);
    else if (liveSearch.query === query && oldIndex >= 0) {
      current = (oldIndex + (findPrevious ? -1 : 1) + results.length) % results.length;
    } else current = findPrevious ? results.length - 1 : 0;
  }
  liveSearch = { query, results, current };
  results.forEach((result, index) => {
    if (!result.svg || !result.hits.length) return;
    let box = null;
    for (const element of result.hits) {
      try {
        const b = element.getBBox();
        box = box
          ? {
              x: Math.min(box.x, b.x),
              y: Math.min(box.y, b.y),
              right: Math.max(box.right, b.x + b.width),
              bottom: Math.max(box.bottom, b.y + b.height),
            }
          : { x: b.x, y: b.y, right: b.x + b.width, bottom: b.y + b.height };
      } catch { /* SVG not laid out yet */ }
    }
    if (!box) return;
    const vb = result.svg.viewBox?.baseVal;
    const width = vb?.width || geometry.paperwidth;
    const height = vb?.height || geometry.paperheight;
    const marker = document.createElement('span');
    marker.className = `tdom-search-marker${index === current ? ' current' : ''}`;
    marker.style.left = `${(box.x / width) * 100}%`;
    marker.style.top = `${(box.y / height) * 100}%`;
    marker.style.width = `${((box.right - box.x) / width) * 100}%`;
    marker.style.height = `${((box.bottom - box.y) / height) * 100}%`;
    result.page.appendChild(marker);
  });
  results[current]?.page.scrollIntoView({ block: 'center' });
}

function lineColToOffset(text, line, col) {
  let off = 0;
  let l = 1;
  while (l < line) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) break;
    off = nl + 1;
    l++;
  }
  return off + col - 1;
}

// ---------------------------------------------------------------- zoom

let zoom = Number(localStorage.getItem('tdom-zoom')) || 1;

function findZoomAnchorPage(clientX, clientY) {
  const direct = pageAtClientPoint({ clientX, clientY });
  if (direct) return direct;
  const pages = [...pageDivs.values()].filter((page) => {
    const rect = page.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return pages.reduce((best, page) => {
    const rect = page.getBoundingClientRect();
    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const distance = dx * dx + dy * dy;
    return !best || distance < best.distance ? { page, distance } : best;
  }, null)?.page ?? null;
}

// The Jump marker ends with any operation of the reader's own; setZoom is
// shared by the toolbar, pinch and Cmd+wheel.
let dismissSyncMarker = () => {};
// `fitPx`: the paper width at zoom 1 the host's own PDF viewer fits a page to
// (embedded: paper-width). `quiet`: the host keeps the same paper on screen
// across its own swap, no move of the reader's: a Jump or a handoff on its way
// stays, and the zoom is taken as given (not rounded: the width is the point).
function setZoom(z, origin = null, { fitPx = null, quiet = false } = {}) {
  if (!quiet) dismissSyncMarker();
  // Toolbar and host zoom preserve the reading baseline; an explicit
  // pointer origin takes precedence for pinch and Cmd+wheel zoom.
  if (!origin && pagesEl.clientHeight > 0 && typeof pagesEl.getBoundingClientRect === 'function') {
    const view = pagesEl.getBoundingClientRect();
    const reading = captureViewAnchor();
    origin = { x: view.left + pagesEl.clientWidth / 2,
      y: reading?.baseline ?? reading?.y ?? view.top + pagesEl.clientHeight / 2 };
  }
  const anchorPage = origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)
    ? findZoomAnchorPage(origin.x, origin.y)
    : null;
  const anchor = anchorPage && globalThis.TdomViewportMath?.capturePageAnchor({
    clientX: origin.x,
    clientY: origin.y,
    pageRect: anchorPage.getBoundingClientRect(),
  });
  zoom = Math.min(3, Math.max(0.4, quiet ? Number(z) : Math.round(z * 100) / 100));
  if (Number(fitPx) > 0) pagesEl.style.setProperty('--fit-width', `${Number(fitPx)}px`);
  pagesEl.style.setProperty('--zoom', zoom);
  document.getElementById('zoom-level').textContent = Math.round(zoom * 100) + '%';
  localStorage.setItem('tdom-zoom', String(zoom));
  if (anchor && anchorPage?.isConnected) {
    const scroll = globalThis.TdomViewportMath?.calculateAnchoredScroll({
      scrollLeft: pagesEl.scrollLeft,
      scrollTop: pagesEl.scrollTop,
      pageRect: anchorPage.getBoundingClientRect(),
      anchor,
    });
    if (scroll) {
      pagesEl.scrollLeft = scroll.left;
      pagesEl.scrollTop = scroll.top;
    }
  }
  if (directEditor) scheduleDirectEditorVisuals(true);
  noteResizeAnchor();
}

// The paper point at the viewport centre, noted at rest (after a scroll, a
// zoom, a restore), put back at the centre after a resize that draws the
// paper at another width (a narrow pane: the paper is 92% of it). The page
// boxes of the new width are only there once the browser has laid them out:
// the ResizeObserver's turn.
let resizeAnchor = null;
let resizeAnchorFrame = 0;
function noteResizeAnchor() {
  resizeAnchorFrame = 0;
  resizeAnchor = null;
  if (!(pagesEl.clientHeight > 0)) return;
  const view = pagesEl.getBoundingClientRect();
  const x = view.left + pagesEl.clientWidth / 2, y = view.top + pagesEl.clientHeight / 2;
  const page = findZoomAnchorPage(x, y);
  const pageRect = page?.getBoundingClientRect();
  const anchor = pageRect && globalThis.TdomViewportMath?.capturePageAnchor({ clientX: x, clientY: y, pageRect });
  if (anchor) resizeAnchor = { page, anchor, paperWidth: pageRect.width };
}
function scheduleResizeAnchor() {
  if (resizeAnchorFrame || typeof requestAnimationFrame !== 'function') return;
  resizeAnchorFrame = requestAnimationFrame(noteResizeAnchor);
}
function keepResizeAnchor() {
  const held = resizeAnchor;
  if (!held?.page.isConnected || !(pagesEl.clientHeight > 0)) return noteResizeAnchor();
  const pageRect = held.page.getBoundingClientRect();
  // (a resize that leaves the paper's width alone moves nothing)
  if (Math.abs(pageRect.width - held.paperWidth) < 0.5) return;
  const view = pagesEl.getBoundingClientRect();
  const scroll = globalThis.TdomViewportMath?.calculateAnchoredScroll({
    scrollLeft: pagesEl.scrollLeft, scrollTop: pagesEl.scrollTop, pageRect,
    anchor: { ...held.anchor, clientX: view.left + pagesEl.clientWidth / 2, clientY: view.top + pagesEl.clientHeight / 2 },
  });
  if (scroll) {
    pagesEl.scrollLeft = scroll.left;
    pagesEl.scrollTop = scroll.top;
  }
  noteResizeAnchor();
}

document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoom * 1.1));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoom / 1.1));
document.getElementById('zoom-fit').addEventListener('click', () => setZoom(1));

// PDF-viewer convention: Ctrl/Cmd + wheel (and trackpad pinch, which the
// browser reports as a ctrlKey wheel) zooms the document. The factor is
// proportional to the wheel delta: pinch gestures emit many small deltas,
// so a fixed per-event step feels far too aggressive.
pagesEl.addEventListener(
  'wheel',
  (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    let dy = ev.deltaY;
    if (ev.deltaMode === 1) dy *= 16; // line mode -> approx pixels
    const factor = Math.min(1.25, Math.max(1 / 1.25, Math.exp(-dy * 0.0035)));
    setZoom(zoom * factor, { x: ev.clientX, y: ev.clientY });
  },
  { passive: false }
);

setZoom(zoom);

// -------------------------------------------------------- layout controls

layoutViewEl?.addEventListener('change', () => {
  applyLayoutView(layoutViewEl.value);
  applySplitRatio();
});
enhanceTopbarSelect(layoutViewEl);
layoutSplitterEl?.addEventListener('pointerdown', beginLayoutResize);
layoutSplitterEl?.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    nudgeLayoutSplit(-2);
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    nudgeLayoutSplit(2);
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    applySplitRatio(35);
  } else if (ev.key === 'End') {
    ev.preventDefault();
    applySplitRatio(70);
  }
});
window.addEventListener('resize', () => {
  applySplitRatio();
  if (directEditor) scheduleDirectEditorVisuals(true);
});
pagesEl.addEventListener('scroll', () => {
  if (directEditor) scheduleDirectEditorVisuals(true);
  scheduleViewportWarm();
  stageDeferredNearSight();
  scheduleResizeAnchor();
}, { passive: true });
// (a pane that was hidden or resized brings other pages near, and keeps the
// paper point the reader had at its centre: keepResizeAnchor)
if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
  keepResizeAnchor();
  stageDeferredNearSight();
  syncDocResyncVisibility();
}).observe(pagesEl);
document.addEventListener('visibilitychange', syncDocResyncVisibility);
// A same-origin embed can hide its iframe with CSS without resizing it.
// Use the observer to wake recovery; the visibility check ignores covers.
if (window.frameElement && typeof IntersectionObserverEntry === 'function' &&
    'isVisible' in IntersectionObserverEntry.prototype) {
  new IntersectionObserver(syncDocResyncVisibility, { trackVisibility: true, delay: 100 }).observe(pagesEl);
}
// Embed mode (?embed=1): a host app (e.g. TeX64) shows only the pages —
// no topbar, no pane title, no inspector — and owns the editor, pushing
// edits through POST /edit. The host passes its own look so the preview
// reads as part of the host viewer, not as this dev UI:
//   ?bg=%23rrggbb  backdrop behind the pages
//   ?theme=light   light page shadow + light scrollbars
{
  const embedParams = new URLSearchParams(location.search);
  if (embeddedHost) {
    document.body.classList.add('is-embed');
    if (layoutViewEl) layoutViewEl.value = 'preview';
    if (embedParams.get('theme') === 'light') document.body.classList.add('is-embed-light');
    const bg = embedParams.get('bg');
    if (bg && /^#[0-9a-f]{3,8}$/i.test(bg)) {
      document.documentElement.style.setProperty('--embed-bg', bg);
    }

    // The host's viewer toolbar drives this frame over postMessage, so the
    // host keeps its own chrome and this page stays pages-only.
    const sortedPages = () => {
      const all = [...pageDivs.entries()].sort((a, b) => a[0] - b[0]);
      const visible = all.filter(([, div]) => !div.classList.contains('phantom'));
      return visible.length ? visible : all;
    };
    const currentTopPage = () => {
      const top = pagesEl.getBoundingClientRect().top;
      for (const [n, div] of sortedPages()) {
        if (div.getBoundingClientRect().bottom - top > 4) return n;
      }
      return sortedPages()[0]?.[0] ?? 1;
    };
    // With an outer paper the host counts sheets of the whole paper: the
    // sheets before the chapter, the live pages, the sheets after it.
    const firstBelowTop = (run, top) => {
      let lo = 0, hi = run.childElementCount;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (run.children[mid].getBoundingClientRect().bottom - top > 4) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    const paperPageCount = (entries = sortedPages()) => outerBeforeEl.childElementCount + entries.length + outerAfterEl.childElementCount;
    const paperTopPage = () => {
      const top = pagesEl.getBoundingClientRect().top;
      const before = outerBeforeEl.childElementCount;
      const inBefore = firstBelowTop(outerBeforeEl, top);
      if (inBefore < before) return inBefore + 1;
      const entries = sortedPages();
      const live = entries.findIndex(([, div]) => div.getBoundingClientRect().bottom - top > 4);
      if (live >= 0) return before + live + 1;
      const after = outerAfterEl.childElementCount;
      return before + entries.length + Math.max(1, Math.min(after, firstBelowTop(outerAfterEl, top) + 1));
    };
    // The sheet numbering goto-sync uses (scrollToSync): the Build's sheets
    // keep their numbers (1..before, afterFrom..pages) and a live page n is
    // before + n. The toolbar's numbering (paperTopPage, goto-page) counts
    // the sheets as they stand; the two part once the live chapter grows or
    // shrinks. What the frame reports for the host to hand back to it is in
    // the numbering it is handed back in (tex64-internal #121: a reset's
    // reader on the first sheet after a grown chapter came back a sheet on).
    const syncSheetOf = (element) => {
      if (!outerPaper) return { page: Number(element.dataset.page) };
      const before = [...outerBeforeEl.children].indexOf(element);
      if (before >= 0) return { page: before + 1 };
      const after = [...outerAfterEl.children].indexOf(element);
      if (after >= 0) return { page: outerPaper.afterFrom + after };
      const live = Number(element.dataset.page);
      // (a grown chapter's live page can have a trailing sheet's number)
      return { page: outerPaper.before + live, livePage: live };
    };
    const syncTopPage = () => {
      if (!outerPaper) return null;
      const top = pagesEl.getBoundingClientRect().top;
      const sheets = [...outerBeforeEl.children, ...sortedPages().map(([, div]) => div), ...outerAfterEl.children];
      const first = sheets.find((sheet) => sheet.getBoundingClientRect().bottom - top > 4) ?? sheets.at(-1);
      return first ? syncSheetOf(first).page : null;
    };
    const paperPageElement = (n, entries = sortedPages()) => {
      const wanted = Math.max(1, Math.min(paperPageCount(entries), Number.isFinite(n) ? Math.round(n) : 1));
      const before = outerBeforeEl.childElementCount;
      if (wanted <= before) return outerBeforeEl.children[wanted - 1];
      if (wanted <= before + entries.length) return entries[wanted - before - 1][1];
      return outerAfterEl.children[wanted - before - entries.length - 1] ?? null;
    };
    // (an element the viewport shows any of)
    const inViewport = (element, viewport = pagesEl.getBoundingClientRect()) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    };
    // The sheet holds the centre of the viewport: a sliver left in view after
    // a layout shift, the neighbour at the centre, is not the sheet shown. A
    // scroll held at the top or the bottom of the paper cannot centre a point
    // near that edge: there the sheet need only stand on the edge's side of
    // the centre (tex64-internal #121).
    const holdsCentre = (element) => {
      const viewport = pagesEl.getBoundingClientRect();
      if (!inViewport(element, viewport)) return false;
      const rect = element.getBoundingClientRect();
      const centre = viewport.top + pagesEl.clientHeight / 2;
      if (rect.top <= centre && rect.bottom >= centre) return true;
      if (pagesEl.scrollTop <= 1 && rect.top < centre) return true;
      const end = Number(pagesEl.scrollHeight) - pagesEl.clientHeight;
      return Number.isFinite(end) && pagesEl.scrollTop >= end - 1 && rect.bottom > centre;
    };
    // ...and the point on it (paper units from its top) stands at the centre:
    // within an eighth of the viewport, or as near as a scroll held at the top
    // or the bottom of the paper lets it. The sheet alone let a centre that
    // had drifted from y=300 to y=500 on it confirm the host's handoff
    // (audit/scratch boundaries.mjs).
    const holdsPoint = (element, y) => {
      if (!Number.isFinite(y) || !holdsCentre(element)) return false;
      const rect = element.getBoundingClientRect();
      const height = Number(activePaperGeometry(element).height);
      if (!(height > 0) || !(rect.height > 0)) return false;
      const at = rect.top + y / height * rect.height;
      const centre = pagesEl.getBoundingClientRect().top + pagesEl.clientHeight / 2;
      if (Math.abs(at - centre) <= Math.max(16, pagesEl.clientHeight / 8)) return true;
      if (pagesEl.scrollTop <= 1 && at < centre) return true;
      const end = Number(pagesEl.scrollHeight) - pagesEl.clientHeight;
      return Number.isFinite(end) && pagesEl.scrollTop >= end - 1 && at > centre;
    };
    const toolbarPage = (first, entries) => activePaperPage(first,
      outerPaper ? paperPageCount(entries) : entries.at(-1)?.[0] ?? first,
      n => outerPaper ? paperPageElement(n, entries) : pageDivs.get(n),
      pagesEl.getBoundingClientRect(), directEditor);
    // Capture the point at the centre before a document reset clears the
    // page DOM. CSS pixels and fractions also describe the static PDF.
    embeddedViewport = (top = outerPaper ? paperTopPage() : currentTopPage()) => {
      const bounds = pagesEl.getBoundingClientRect();
      const x = bounds.left + pagesEl.clientWidth / 2;
      const y = bounds.top + pagesEl.clientHeight / 2;
      const last = outerPaper ? paperPageCount() : pageDivs.size;
      for (let n = top; n <= last; n++) {
        const sheet = outerPaper ? paperPageElement(n) : pageDivs.get(n);
        if (!sheet) break;
        const rect = sheet.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom < y) continue;
        const paper = activePaperGeometry(sheet);
        return { page: n, width: rect.width, paperHeight: paper.height, x: (x - rect.left) / rect.width,
          y: (y - rect.top) / rect.height, pdfScale: rect.width / paper.width * 72 / 96 };
      }
      return null;
    };
    // The live pages the viewport shows (`required`), and the Build sheets of
    // an outer paper it shows (`outer`). A viewport that shows only Build
    // sheets requires no live page: those sheets are what the reader sees
    // (tex64-internal #121: the first live page stood in for them).
    const visiblePageSnapshot = () => {
      const entries = sortedPages();
      const viewport = pagesEl.getBoundingClientRect();
      const exposed = [];
      let topPage = null;
      for (const entry of entries) {
        const rect = entry[1].getBoundingClientRect();
        if (topPage === null && rect.bottom - viewport.top > 4) topPage = entry[0];
        if (rect.bottom > viewport.top && rect.top < viewport.bottom) exposed.push(entry);
      }
      const outer = outerPaper
        ? [...outerBeforeEl.children, ...outerAfterEl.children].filter((sheet) => inViewport(sheet, viewport)) : [];
      return { entries, required: exposed.length || outer.length ? exposed : entries.slice(0, 1), outer,
        topPage: topPage ?? entries[0]?.[0] ?? 1 };
    };
    // A Build sheet has its picture (a lazy image, decoded once it is near)
    const outerSheetDecoded = (sheet) => {
      const img = sheet.querySelector('img');
      return Boolean(img?.complete && img.naturalWidth > 0);
    };
    const previewReady = (required, outer = []) => {
      if (!bootComplete || !documentReset.acceptsReady(documentReset.adoptedEpoch)) return false;
      if (!required.length && !outer.length) return false;
      if (!outer.every(outerSheetDecoded)) return false;
      if (required.some(([, page]) => page.dataset.canonFallback === '1')) return false;
      if (usesCanonicalSurface()) {
        return required.every(([, page]) => {
          const shipping = presentedShippingPageState(page);
          if (shipping?.rev === Number(appliedSrcRev) &&
              !page.classList.contains('awaiting-canonical')) return true;
          const state = presentedPageState(page);
          return Boolean(
            state && state.id === Number(canonical?.id) && state.rev === Number(appliedSrcRev) &&
            state.image.complete && state.image.naturalWidth > 0 &&
            !page.classList.contains('awaiting-canonical')
          );
        });
      }
      return required.every(([, page]) =>
        Boolean(page.querySelector('svg') ||
          page.classList.contains('is-final') && page.querySelector('img.canon')?.complete)
      );
    };
    const presentationPending = (required, outer = []) => {
      if (documentReset.pending || deferredDirectPresentationEvents.length) return true;
      if (!required.length && !outer.length) return true;
      if (!outer.every(outerSheetDecoded)) return true;
      return required.some(([n, page]) => {
        if (provisionalRemovedPages.has(n)) return true;
        const dirtyRev = pageDirtyRev.get(n) ?? 0;
        if (page.classList.contains('is-final')) {
          const image = page.querySelector('img.canon');
          if (!image?.complete || !image.naturalWidth ||
              image.dataset.src !== page.dataset.canonPresentedSrc) return true;
          const anchor = canonicalAnchorPreview;
          if (!canonicalAnchorPendingPatch &&
              Number(anchor?.srcRev) === appliedSrcRev &&
              Number(anchor?.baseGeneration) === Number(page.dataset.canonPresentedId)) return false;
          // Undo can reuse the PDF already visible on this sheet. Its
          // bytes certify the current paper before the hit map is rebound.
          if (canonical?.rev === appliedSrcRev && n <= canonical.pageCount &&
              image.dataset.src === `/canonical/${n}.svg?c=${canonical.id}`) return false;
          const presentedRev = Number(page.dataset.canonPresentedRev);
          if (presentedRev >= appliedSrcRev) return canonical?.rev >= appliedSrcRev && n > canonical.pageCount;
          return page.dataset.provPending === '1' || !Number.isFinite(presentedRev) ||
            dirtyRev > presentedRev || usesCanonicalSurface() && presentedRev < appliedSrcRev ||
            canonical?.rev >= appliedSrcRev && n > canonical.pageCount;
        }
        if (page.dataset.provPending === '1' || page.classList.contains('awaiting-canonical')) return true;
        // Current complete provisional ink is already on paper. A canonical
        // image decoding behind it is background confirmation, not a hold.
        return page.dataset.prov !== '1' || !page.querySelector(':scope > svg:not(.tdom-canonical-delta)') ||
          Number(page.provisionalSnapshot?.documentEpoch) !== documentReset.adoptedEpoch ||
          dirtyRev > Number(page.dataset.provRev);
      });
    };
    let embedSnapshotRaf = null;
    // The last host goto-sync this frame actually scrolled to. The host keeps
    // its static page up until the frame confirms the handed-off viewport.
    let embedViewportToken = null;
    // ...and the sheet it was acknowledged for: only that sheet in view
    // confirms the handoff (tokenSheetShown), not one with a nearby number
    let embedViewportSheet = null;
    // ...and the point on that sheet (tokenPointShown)
    let embedViewportPointY = null;
    // The paper point at the centre of this viewport, in the goto-sync form
    // (the page in the host's numbering, the sheets of an outer paper
    // included; top-origin y in paper units, the inverse of
    // scrollPageToViewport's centring), and the width the paper is drawn at
    // here. A document reset rebuilds this frame from its first page: the
    // host covers it with its static PDF at this point and this size, and
    // hands it back (tex64-internal #121). A centre between two sheets
    // takes the nearer one.
    const viewportCenter = () => {
      const centerY = pagesEl.getBoundingClientRect().top + pagesEl.clientHeight / 2;
      const sheets = outerPaper
        ? [...outerBeforeEl.children, ...sortedPages().map(([, div]) => div), ...outerAfterEl.children]
        : sortedPages().map(([, div]) => div);
      let best = null;
      for (let k = 0; k < sheets.length; k++) {
        const rect = sheets[k].getBoundingClientRect();
        if (!(rect.height > 0)) continue;
        const gap = centerY < rect.top ? rect.top - centerY : centerY > rect.bottom ? centerY - rect.bottom : 0;
        if (!best || gap < best.gap) best = { k, rect, gap };
        if (!gap) break;
      }
      if (!best) return null;
      const div = sheets[best.k];
      const height = Number(activePaperGeometry(div).height);
      if (!(height > 0)) return null;
      const within = Math.max(0, Math.min(best.rect.height, centerY - best.rect.top));
      const y = Math.round(within / best.rect.height * height * 100) / 100;
      // (a live page's source line at the centre: centreSourceLine)
      const source = pageDivs.get(Number(div.dataset.page)) === div ? centreSourceLine(div, y) : null;
      return {
        ...syncSheetOf(div),
        y,
        paperPx: Math.round(best.rect.width * 100) / 100,
        ...(source ? { source } : {}),
      };
    };
    // Save the ink at the viewport centre and the reader's offset from its
    // baseline. Both survive a reflow of the source into different rows.
    const centreSourceLine = (div, y) => {
      const Anchor = globalThis.TdomViewAnchor;
      const near = Anchor ? viewAnchorPages(0) : null;
      const anchor = near?.pages.length ? Anchor.captureAnchor({ ...near, editSrcs: null }) : null;
      if (anchor && anchor.kind !== 'page' && anchor.page === Number(div.dataset.page)) {
        if (anchor.content && Number.isFinite(anchor.baseline)) {
          const quote = { text: anchor.content.text.slice(0, 160),
            before: anchor.content.before?.slice(0, 160), after: anchor.content.after?.slice(0, 160) };
          return { ...quote, offset: Math.round(((near.viewTop + near.viewBottom) / 2 - anchor.baseline) * 100) / 100 };
        }
        const block = pageDivs.get(anchor.page)?.provisionalSnapshot?.blocks?.find((b) => String(b.id) === String(anchor.src));
        const start = Number(block?.source?.start?.line);
        if (block?.source?.file && Number.isFinite(start)) {
          return { file: block.source.file, line: start + Number(anchor.line), fraction: Math.round(anchor.fraction * 1000) / 1000 };
        }
      }
      return null;
    };
    // Every sheet the viewport shows has paper on it: resident ink, or a
    // decoded canonical, Build or last-good image. An empty shell is a place,
    // not paper: the host keeps its cover over it (tex64-internal #121).
    const previewPainted = (required, outer = []) => (required.length > 0 || outer.length > 0) &&
      outer.every(outerSheetDecoded) && required.every(([, page]) =>
        Boolean(page.querySelector('svg')) ||
        [...page.querySelectorAll('img')].some((img) => img.complete && img.naturalWidth > 0));
    const postEmbedSnapshot = () => {
      try {
        const visible = visiblePageSnapshot();
        const pending = presentationPending(visible.required, visible.outer);
        const ready = previewReady(visible.required, visible.outer);
        const firstPaperPainted = !ready && bootComplete && documentReset.acceptsReady(documentReset.adoptedEpoch) &&
          visible.required.length > 0 && visible.required.every(([, page]) => {
            if (!page.classList.contains('is-final') || page.dataset.canonFallback === '1') return false;
            const state = presentedShippingPageState(page) ?? presentedPageState(page);
            return state && state.image.complete && state.image.naturalWidth > 0;
          });
        const topPage = outerPaper ? paperTopPage() : visible.topPage;
        // Canonical-only policies do not enter the provisional staging path.
        // Demand the old source still on paper, not ordinary image decode.
        if (pending && usesCanonicalSurface() && Number(canonical?.rev ?? 0) < appliedSrcRev) {
          requestCanonicalDisplay({
            residentImpossible: previewPolicy !== 'shipping-exact' || shippingPresentationBlocked(),
          });
        }
        window.parent.postMessage(
          {
            source: 'tdom-embed',
            activationId: embedActivationId,
            documentEpoch: documentReset.adoptedEpoch,
            ready,
            firstPaperPainted,
            presentationPending: pending,
            pageCount: outerPaper ? paperPageCount() : visible.entries.length,
            pageCountAuthoritative: residentPageCountAuthoritative,
            zoom,
            page: topPage,
            activePage: toolbarPage(topPage, visible.entries),
            viewport: embeddedViewport(topPage),
            painted: previewPainted(visible.required, visible.outer),
            // the sheet the last viewport goto-sync was acknowledged for is
            // in view (that sheet itself, not one with a nearby number)
            tokenSheetShown: Boolean(embedViewportSheet?.isConnected && holdsCentre(embedViewportSheet)),
            tokenPointShown: Boolean(embedViewportSheet?.isConnected && holdsPoint(embedViewportSheet, embedViewportPointY)),
            // (the live chapter's own pages: a live page a handoff names that
            // a complete chapter does not have any more is resolved by it)
            livePageCount: sortedPages().length,
            // (the Build's sheets of the live chapter: a place a static Build
            // viewer took names them, the host resolves it against these)
            chapter: outerPaper ? { from: outerPaper.before + 1, to: outerPaper.afterFrom - 1 } : null,
            // (no page owes its layout: the count stands while a failing
            // canonical leaves it without authority)
            pageCountSettled: residentPageCountAuthoritative ||
              (!provisionalPendingLayout.size && canonicalCountStalled(canonical, appliedSrcRev)),
            // (the top sheet and the count in goto-sync's numbering)
            syncPage: outerPaper ? syncTopPage() : visible.topPage,
            syncPageCount: outerPaper
              ? Math.max(outerPaper.pages, outerPaper.before + sortedPages().length) : visible.entries.length,
            srcRev: appliedSrcRev,
            viewportToken: embedViewportToken,
            viewportCenter: viewportCenter(),
            status: lastEngineStatus,
            search: {
              query: liveSearch.query,
              current: liveSearch.current >= 0 ? liveSearch.current + 1 : 0,
              total: liveSearch.results.length,
            },
          },
          '*'
        );
      } catch { /* host gone */ }
    };
    const scheduleEmbedSnapshot = () => {
      if (embedSnapshotRaf !== null) return;
      embedSnapshotRaf = requestAnimationFrame(() => {
        embedSnapshotRaf = null;
        postEmbedSnapshot();
      });
    };
    pagesEl.addEventListener('focusin', scheduleEmbedSnapshot);
    pagesEl.addEventListener('focusout', scheduleEmbedSnapshot);
    const pageEntryFor = (n) => {
      const entries = sortedPages();
      if (!entries.length) return null;
      const wanted = Number.isFinite(n) ? Math.round(n) : entries[0][0];
      return entries.reduce((best, entry) =>
        Math.abs(entry[0] - wanted) < Math.abs(best[0] - wanted) ? entry : best
      );
    };
    // A handoff naming a source line (sourceFile, sourceLine, sourceFraction)
    // is that line on this paper: the block that holds it, a page whose ink
    // shows the block, the line's ink there. Not on resident ink: null (the
    // handoff's page and y, as before).
    const handoffLinePlace = (data) => {
      const Anchor = globalThis.TdomViewAnchor;
      const line = Number(data.sourceLine);
      if (!Anchor || !data.sourceFile || !Number.isInteger(line)) return null;
      const resident = sortedPages().filter(([, div]) => div.dataset.prov === '1' && !div.classList.contains('is-final') && div.provisionalDl);
      const snapshot = resident[0]?.[1].provisionalSnapshot;
      const block = (snapshot?.blocks ?? []).find((b) => sameSourceFile(b.source?.file, data.sourceFile) &&
        line >= Number(b.source?.start?.line) && line <= Number(b.source?.end?.line));
      if (!block) return null;
      const near = Number(data.livePage ?? data.page);
      for (const [n, div] of resident.filter(([n]) => committedPageSrcs.get(n)?.has(String(block.id)))
        .sort((a, b) => Math.abs(a[0] - near) - Math.abs(b[0] - near))) {
        const extent = Anchor.lineExtent(div.provisionalDl, block.id, line - Number(block.source.start.line));
        if (!extent) continue;
        const fraction = Math.max(0, Math.min(1, Number(data.sourceFraction) || 0));
        return { page: div, n, y: extent.top + fraction * (extent.bottom - extent.top) };
      }
      return null;
    };
    let handoffContent = null;
    const HANDOFF_CONTENT_WAIT_MS = 8000;
    const clearHandoffContent = () => {
      if (handoffContent) clearTimeout(handoffContent.timer);
      handoffContent = null;
    };
    const stageHandoffContent = data => {
      const quote = data.sourceAnchor;
      const Anchor = globalThis.TdomViewAnchor;
      if (!Anchor?.contentPlace || typeof quote?.text !== 'string' || quote.text.length < 8 ||
          quote.text.length > 160 || documentReset.pending) return null;
      const token = data.viewportToken;
      const epoch = documentReset.adoptedEpoch;
      const near = Number(data.livePage ?? data.page) || 1;
      if (handoffContent?.token !== token || handoffContent.epoch !== epoch) {
        clearHandoffContent();
        const job = handoffContent = { token, epoch, id: null, result: undefined };
        job.timer = setTimeout(() => {
          if (handoffContent !== job || job.result !== undefined ||
              documentReset.pending || documentReset.adoptedEpoch !== epoch) return;
          job.result = null;
          scrollToSync(data);
        }, HANDOFF_CONTENT_WAIT_MS);
      }
      const job = handoffContent;
      if (job.result !== undefined) {
        if (job.id !== canonical?.id || canonical?.rev !== appliedSrcRev) job.result = null;
        return job;
      }
      if (canonical?.rev !== appliedSrcRev || !canonical?.id || job.id === canonical.id) return job;
      const { id, rev, pageCount } = canonical;
      job.id = id;
      const pages = Array.from({ length: pageCount }, (_, i) => i + 1)
        .sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
      const current = () => handoffContent === job && job.result === undefined && job.id === id && documentReset.adoptedEpoch === epoch &&
        !documentReset.pending && canonical?.id === id && appliedSrcRev === rev;
      const finish = (place) => {
        if (!current()) return;
        clearTimeout(job.timer);
        job.result = place;
        scrollToSync(data);
      };
      void (async () => {
        let best = null;
        for (const n of pages) {
          if (!current()) return;
          const list = Anchor.exactDisplayList('exact:' + n, await canonicalGlyphs(n, id));
          if (!current()) return;
          const row = Anchor.contentPlace(quote, list);
          if (row && (!best || row.score > best.score)) best = { n, y: row.y, score: row.score };
          if (best?.score >= quote.text.length * 2 + 85) break;
        }
        if (!best) return finish(null);
        const div = pageDivs.get(best.n);
        if (!div) return;
        const src = `/canonical/${best.n}.svg?c=${id}`;
        div.dataset.canonStage = src;
        updateCanonState(best.n);
        // A remote exact page can be decoding below the host's cover.
        // Acknowledge only after the pixels used for the lookup are on it.
        const reveal = () => {
          if (!current()) return;
          if (div.dataset.canonPresentedSrc !== src || !div.classList.contains('is-final')) {
            setTimeout(reveal, 50);
            return;
          }
          finish(best);
        };
        reveal();
      })().catch(() => finish(null));
      return job;
    };
    let syncScrollTop = null;
    const scrollPageToViewport = (page, paperY = 0, center = false) => {
      const viewport = pagesEl.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      const paper = activePaperGeometry(page);
      const ratio = Math.max(0, Math.min(1, Number(paperY) / Math.max(1, Number(paper.height))));
      const withinPage = ratio * pageRect.height;
      const target = pagesEl.scrollTop + pageRect.top - viewport.top + withinPage -
        (center ? pagesEl.clientHeight / 2 : 0);
      pagesEl.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
      syncScrollTop = pagesEl.scrollTop;
      scheduleEmbedSnapshot();
    };
    // A first landing already in the middle 70% of the viewport stays put.
    // Refine an estimate by moving only for a material correction.
    const JUMP_TEXT_LINE = 14; // (paper units: a 10–12 pt line)
    const jumpPointInPane = (page, paperY) => {
      const viewport = pagesEl.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      const paper = activePaperGeometry(page);
      const height = Math.max(1, Number(paper.height));
      const scale = pageRect.height / height;
      const y = pageRect.top - viewport.top + Math.max(0, Math.min(height, Number(paperY) || 0)) * scale;
      return { y, scale };
    };
    const jumpScroll = (page, paperY, firstY = null) => {
      const { y, scale } = jumpPointInPane(page, paperY);
      const h = pagesEl.clientHeight;
      const inView = y >= h * 0.15 && y <= h * 0.85;
      if (inView && (firstY === null || Math.abs(y - firstY) <= JUMP_TEXT_LINE * scale)) {
        syncScrollTop = pagesEl.scrollTop;
        scheduleEmbedSnapshot();
        return false;
      }
      scrollPageToViewport(page, paperY, true);
      return true;
    };
    // (a Jump finding its place: the reader's place is not kept meanwhile,
    // viewAnchorHolds; a handoff the host has not revealed yet: neither)
    let jumpRefining = null;
    let handoffHoldUntil = 0;
    viewAnchorHolds.jump = () => jumpRefining !== null;
    viewAnchorHolds.handoff = () => handoffHoldUntil > viewClock();
    viewAnchorHolds.scrolled = () => {
      if (syncScrollTop !== null) syncScrollTop = pagesEl.scrollTop;
    };
    const JUMP_FIRST_MOVE_MS = 1200;
    const JUMP_REFINEMENT_MS = 30000;
    const finishJumpPosition = (job, page, y) => {
      jumpScroll(page, y, job.firstY);
      // Repagination can move the line and preserve this viewport point.
      // The page element used for the estimate can then hold different ink.
      if (job.firstY === null) job.firstY = jumpPointInPane(page, y).y;
      if (jumpRefining === job) jumpRefining = null;
    };
    const jumpFallback = (job) => {
      if (job.firstY !== null || !job.active()) return;
      if (jumpRefining === job) jumpRefining = null;
      const place = job.current() && job.estimate?.page.isConnected ? job.estimate : job.host;
      if (!place?.page?.isConnected) return;
      finishJumpPosition(job, place.page, place.y);
      if (job.wantsMarker) {
        const page = place.page;
        const scale = page.clientHeight / Math.max(1, activePaperGeometry(page).height);
        placeSyncMarker(page, place.box ?? syncBlockBox(page, job.data) ??
          { left: 0, top: place.y * scale, width: page.clientWidth, height: 1 }, false);
      }
    };
    const runJump = async (data, wantsMarker, host, steps) => {
      const generation = syncRefineGeneration, srcRev = appliedSrcRev, epoch = documentReset.adoptedEpoch;
      const deadline = viewClock() + JUMP_REFINEMENT_MS;
      const active = () => generation === syncRefineGeneration && !documentReset.pending &&
        epoch === documentReset.adoptedEpoch;
      const current = () => active() && srcRev === appliedSrcRev && viewClock() < deadline;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const job = { host, data, wantsMarker, active, current, firstY: null, signal: controller?.signal };
      jumpRefining = job;
      const fallback = setTimeout(() => jumpFallback(job), JUMP_FIRST_MOVE_MS);
      let refinementTimer;
      const expired = new Promise(resolve => {
        refinementTimer = setTimeout(() => { controller?.abort(); resolve(false); }, JUMP_REFINEMENT_MS);
      });
      try {
        return await Promise.race([steps(job), expired]);
      } finally {
        clearTimeout(refinementTimer);
        // A superseded source invalidates its exact answer. The still-active
        // Jump keeps its original timer for the host estimate.
        if (job.firstY !== null || !active() || current()) {
          clearTimeout(fallback);
          jumpFallback(job);
          if (jumpRefining === job) jumpRefining = null;
        }
      }
    };
    // A place the engine found for this very revision (goto-sync
    // `liveRevision`): exact for the paper on screen. Its box is drawn once
    // the page shows the generation it was found on.
    // Request those pixels now and use the host position if they take
    // longer than the first-movement deadline.
    const markWhenCurrent = (page, data, canonicalId, y) => runJump(data, true, { page, y }, async job => {
      const srcRev = appliedSrcRev;
      const id = Number(canonicalId);
      let requested = false;
      while (job.current() && page.isConnected) {
        if (canonicalId == null || !Number.isFinite(id) || syncPaperCurrent(page, srcRev, id)) {
          finishJumpPosition(job, page, y);
          placeSyncMarker(page, syncBlockBox(page, data), true);
          return;
        }
        if (!requested) {
          requested = true;
          const n = Number(page.dataset.page);
          page.dataset.canonStage = `/canonical/${n}.svg?c=${id}`;
          updateCanonState(n);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    });
    const scrollToPage = (n) => {
      dismissSyncMarker();
      if (outerPaper) {
        const element = paperPageElement(Number(n));
        if (element) scrollPageToViewport(element);
        return;
      }
      const entry = pageEntryFor(Number(n));
      if (!entry) return;
      scrollPageToViewport(entry[1]);
    };
    // A newer Jump or the reader's own move makes a pending refinement stale:
    // it must neither scroll back nor bring the marker back.
    let syncRefineGeneration = 0;
    const syncPaperCurrent = (page, rev, id) => {
      if (!page?.classList.contains('is-final')) return false;
      return Number(page?.dataset.canonPresentedRev) === rev &&
        canonicalIdFromSrc(page.dataset.canonPresentedSrc) === id;
    };
    const refineSyncToSource = (data, wantsMarker = false, host = null) =>
      runJump(data, wantsMarker, host, job => refineSyncSteps(data, wantsMarker, job, openingPreview));
    const refineSyncSteps = async (data, wantsMarker, job, opening) => {
      const { current } = job;
      const documentEpoch = documentReset.adoptedEpoch;
      const srcRev = appliedSrcRev;
      const file = String(data.sourceFile ?? '');
      const line = Number(data.sourceLine);
      if (!file || !Number.isInteger(line) || line < 1) return false;
      let dom;
      try {
        const response = await fetch('/dom', { cache: 'no-store', signal: job.signal });
        if (response.ok) dom = await response.json();
      } catch { /* the canonical lookup can still succeed */ }
      if (!current()) return false;
      const blocks = (dom?.sourceCurrent !== false && Number(dom?.srcRev) === srcRev &&
        Number(dom?.documentEpoch) === documentEpoch ? dom.blocks ?? [] : []).flatMap(block =>
          (block.sourceRanges ?? [block.source]).filter(source => sameSourceFile(source?.file, file))
            .map(source => ({ ...block, source }))
        ).sort((a, b) => {
          const distance = block => Math.max(Number(block.source.start.line) - line, line - Number(block.source.end.line), 0);
          return distance(a) - distance(b) ||
            (a.source.end.line - a.source.start.line) - (b.source.end.line - b.source.start.line);
        });
      for (const block of blocks.slice(0, 3)) {
        const relativeLine = line - Number(block.source.start.line);
        const candidates = [];
        for (const [, page] of sortedPages()) {
          if (page.classList.contains('is-final')) continue;
          for (const node of page.querySelectorAll(`[data-src="${CSS.escape(String(block.id))}"][data-line]`)) {
            const rect = node.getBoundingClientRect();
            if (!(rect.width > 0 && rect.height > 0)) continue;
            const ink = !node.classList.contains('tdom-source-hit') && !node.classList.contains('tdom-edit-hit') &&
              !node.classList.contains('chunkwin') && ['text', 'tspan', 'use'].includes(node.tagName?.toLowerCase());
            candidates.push({ page, node, ink, distance: Math.abs(Number(node.dataset.line) - relativeLine) });
          }
        }
        candidates.sort((a, b) => a.distance - b.distance || Number(b.ink) - Number(a.ink));
        const first = candidates[0];
        if (!first) continue;
        // A block that begins by clearing the page (\chapter) leaves an
        // inkless trace on the page it closes and its heading on the next.
        // When that next page already shows canonical pixels it is not among
        // the candidates, and the trace alone put the band one page early, at
        // the end of the chapter before (389-page book, measured). The trace
        // of a block that runs over several pages is no position.
        if (!first.ink && (block.pages?.length ?? 0) > 1) continue;
        const nodes = candidates.filter(c => c.page === first.page && c.distance === first.distance && c.ink === first.ink);
        const rects = nodes.map(c => c.node.getBoundingClientRect());
        const top = Math.min(...rects.map(r => r.top)), bottom = Math.max(...rects.map(r => r.bottom));
        const pageRect = first.page.getBoundingClientRect();
        const scale = pageRect.height / activePaperGeometry(first.page).height;
        const currentInk = first.ink && first.distance === 0 && Number(first.page.dataset.provRev) === srcRev;
        const knownInk = currentInk && Number(block.source.start.line) === line && Number(block.source.end.line) === line;
        // Without the line's own ink the block is all there is to go by: the
        // line sits about as far down the block as it does in its source.
        const blockLines = Math.max(1, Number(block.source.end.line) - Number(block.source.start.line));
        const fraction = Math.max(0, Math.min(1, relativeLine / blockLines));
        const estimateTop = currentInk && !opening ? (top + bottom) / 2 : top + (bottom - top) * fraction;
        const estimateBox = { left: 0, top: estimateTop - pageRect.top, width: pageRect.width, height: 1 };
        const inkBox = currentInk ? {
          left: Math.min(...rects.map(r => r.left)) - pageRect.left - 2,
          top: top - pageRect.top - 1,
          width: Math.max(...rects.map(r => r.right)) - Math.min(...rects.map(r => r.left)) + 4,
          height: bottom - top + 2,
        } : estimateBox;
        if (opening) {
          const y = (currentInk ? (top + bottom) / 2 - pageRect.top : estimateBox.top) / scale;
          scrollPageToViewport(first.page, y, true);
          // The resident place, once found, is this Jump's place: neither the
          // pending exact lookup nor the first-move deadline brings back the
          // host's older position (round 20: 75 px off for a second). Only
          // the verified exact answer replaces it.
          job.estimate = { page: first.page, y, box: inkBox, resident: true };
        } else if (job.firstY === null && knownInk && Number(canonical?.rev) !== srcRev &&
            residentPageCountAuthoritative && !provisionalStages.size) {
          finishJumpPosition(job, first.page, ((top + bottom) / 2 - pageRect.top) / scale);
        } else {
          job.estimate = { page: first.page, y: estimateBox.top / scale, box: estimateBox };
        }
        if (wantsMarker && (opening || Number(canonical?.rev) !== srcRev)) placeSyncMarker(first.page, inkBox, false);
        break;
      }
      let hit = null, awaitingPage = null;
      while (current()) {
        if (hit && canonical?.rev === srcRev && canonical.id !== hit.id) hit = null;
        if (!hit) {
          try {
            const response = await fetch('/synctex/jump', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file, line, documentEpoch, srcRev }),
              signal: job.signal,
            });
            if (!response.ok) return false;
            const result = await response.json();
            if (!current()) return false;
            if (result.documentEpoch !== documentEpoch || result.srcRev !== srcRev) return false;
            if (result.boxes?.length) hit = result;
            else if (!result.pending) return false;
            else {
              requestCanonicalDisplay({ residentImpossible: true });
              if (wantsMarker && !job.estimate && job.firstY === null && !job.hasBand && job.host?.page.isConnected) {
                job.hasBand = true;
                placeSyncMarker(job.host.page, syncBlockBox(job.host.page, data), false);
              }
            }
          } catch { return false; }
        }
        if (hit) {
          const page = pageDivs.get(Number(hit.page));
          const boxes = hit.boxes;
          const y = (Math.min(...boxes.map(b => b.top)) + Math.max(...boxes.map(b => b.bottom))) / 2;
          if (page && awaitingPage !== page) {
            awaitingPage = page;
            if (opening) scrollPageToViewport(page, y, true);
            page.dataset.canonStage = `/canonical/${hit.page}.svg?c=${hit.id}`;
            updateCanonState(Number(hit.page));
          }
          // A new mapping must not be painted on old canonical pixels or on
          // a resident pagination that the authority has yet to replace.
          if (syncPaperCurrent(page, srcRev, hit.id)) {
            finishJumpPosition(job, page, y);
            if (wantsMarker) {
              const scale = page.clientWidth / activePaperGeometry(page).width;
              placeSyncMarker(page, boxes.map(b => ({ left: b.left * scale - 2, top: b.top * scale - 1,
                width: (b.right - b.left) * scale + 4, height: (b.bottom - b.top) * scale + 2 })), true);
            }
            return true;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return false;
    };
    // The host's Jump marks where it landed, as the static PDF viewer does:
    // a box over the typeset source line that fades out.
    let syncMarkerTimer = null;
    const clearSyncMarker = () => {
      clearTimeout(syncMarkerTimer);
      syncMarkerTimer = null;
      for (const node of document.querySelectorAll('.tdom-sync-marker')) node.remove();
    };
    const placeSyncMarker = (page, boxOrBoxes, exact = true) => {
      clearSyncMarker();
      const boxes = (Array.isArray(boxOrBoxes) ? boxOrBoxes : [boxOrBoxes])
        .filter((box) => box && box.width > 0 && box.height > 0);
      if (!page?.isConnected || !boxes.length) return;
      if (!exact) {
        // Only roughly known (the last Build's position after edits, or a
        // place inside a block drawn as one picture): say "about here" with a
        // soft band across the page, never with a box around a line that
        // may not be the right one.
        const top = Math.min(...boxes.map(b => b.top)), bottom = Math.max(...boxes.map(b => b.top + b.height));
        const pageHeight = page.clientHeight || 1;
        const height = Math.min(pageHeight, Math.max(bottom - top, pageHeight * 0.045));
        const middle = (top + bottom) / 2;
        boxes.length = 0;
        boxes.push({ left: 0, top: Math.max(0, Math.min(pageHeight - height, middle - height / 2)),
          width: page.clientWidth, height });
      }
      for (const box of boxes) {
        const marker = document.createElement('div');
        marker.className = 'tdom-sync-marker';
        marker.dataset.exact = String(exact);
        marker.style.left = `${box.left}px`;
        marker.style.top = `${box.top}px`;
        marker.style.width = `${box.width}px`;
        marker.style.height = `${box.height}px`;
        page.appendChild(marker);
      }
      syncMarkerTimer = setTimeout(clearSyncMarker, 2600);
    };
    dismissSyncMarker = () => {
      syncRefineGeneration += 1;
      jumpRefining = null;
      syncScrollTop = null;
      // (the reader's own move: the paper is the reader's place again)
      clearHandoffContent();
      handoffHoldUntil = 0;
      if (syncMarkerTimer !== null) clearSyncMarker();
    };
    for (const type of ['wheel', 'pointerdown', 'touchstart']) {
      pagesEl.addEventListener(type, () => dismissSyncMarker(), { passive: true, capture: true });
    }
    document.addEventListener('keydown', () => dismissSyncMarker(), true);
    window.addEventListener('resize', () => dismissSyncMarker());
    // SyncTeX's block (paper points from the top) on this page, in page pixels.
    const syncBlockBox = (page, data) => {
      const paper = activePaperGeometry(page);
      const scale = page.clientWidth / Math.max(1, Number(paper.width));
      // Several rectangles (one per run of typeset lines) when the host sent them.
      const blocks = Array.isArray(data.blocks)
        ? data.blocks.filter((block) => block && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(block[key]))))
        : [];
      if (blocks.length > 1) {
        return blocks.slice(0, 32).map((block) => ({
          left: Number(block.x) * scale - 2, top: Number(block.y) * scale - 1,
          width: Number(block.width) * scale + 4, height: Number(block.height) * scale + 2,
        }));
      }
      const blockX = Number(data.blockX), blockY = Number(data.blockY);
      const blockWidth = Number(data.blockWidth), blockHeight = Number(data.blockHeight);
      if ([blockX, blockY, blockWidth, blockHeight].every(Number.isFinite) && blockWidth > 0 && blockHeight > 0) {
        return { left: blockX * scale - 2, top: blockY * scale - 1, width: blockWidth * scale + 4, height: blockHeight * scale + 2 };
      }
      const x = Number(data.x), y = Number(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { left: x * scale - 10, top: y * scale - 10, width: 20, height: 20 };
    };
    // The point a goto-sync names on `sheet` (paper units from its top),
    // clamped once to the sheet's own paper: the scroll and the point the
    // handoff is acknowledged for are the same one (audit/scratch r7
    // points.mjs: y=770 taken on a Build sheet, scrolled to 500 on a Live
    // sheet 500 high, and acknowledged against 770 for good).
    const syncPointY = (sheet, data) => {
      const blockY = Number(data.blockY);
      const blockHeight = Number(data.blockHeight);
      const y = Number.isFinite(blockY)
        ? blockY + (Number.isFinite(blockHeight) ? blockHeight / 2 : 0)
        : Number(data.y);
      const height = Number(activePaperGeometry(sheet).height);
      const at = Number.isFinite(y) ? Math.max(0, y) : 0;
      return height > 0 ? Math.min(at, height) : at;
    };
    const alignViewport = (sheet, data) => {
      const width = sheet.getBoundingClientRect().width;
      if (data.marker !== false || !(data.viewportWidth > 0) || width <= 0) return;
      if (Math.abs(data.viewportWidth - width) > 1) setZoom(zoom * data.viewportWidth / width);
      if (Number.isFinite(data.viewportX)) {
        const rect = sheet.getBoundingClientRect();
        const bounds = pagesEl.getBoundingClientRect();
        pagesEl.scrollLeft += rect.left + rect.width * data.viewportX - bounds.left - pagesEl.clientWidth / 2;
      }
    };
    const scrollToSync = (data) => {
      // A viewport handoff (it carries a token) is acknowledged only on the
      // very sheet it names: a page a rebuilding paper does not have yet is
      // left for a later snapshot, not answered with the nearest one
      // (tex64-internal #121: live page 3 stood in for live page 4).
      const handoff = typeof data.viewportToken === 'string';
      if (!handoff || handoffContent?.token !== data.viewportToken) clearHandoffContent();
      if (outerPaper) {
        // The host's page is a sheet of the Build paper. Outside the chapter
        // it is the place itself: this frame has no source there to refine it.
        const sheet = Math.round(Number(data.page));
        // (a live page the frame itself reported, syncSheetOf: its pair)
        const live = Number(data.livePage);
        const ownLive = Number.isInteger(live) && live >= 1 && sheet === outerPaper.before + live;
        const buildSheet = !ownLive && (sheet <= outerPaper.before || sheet >= outerPaper.afterFrom);
        const outside = ownLive ? null
          : sheet <= outerPaper.before ? outerBeforeEl.children[sheet - 1]
          : sheet >= outerPaper.afterFrom ? outerAfterEl.children[sheet - outerPaper.afterFrom] : null;
        if (handoff && buildSheet && !outside) return;
        if (outside) {
          const y = syncPointY(outside, data);
          alignViewport(outside, data);
          scrollPageToViewport(outside, y, true);
          embedViewportToken = handoff ? data.viewportToken : null;
          embedViewportSheet = handoff ? outside : null;
          embedViewportPointY = handoff ? y : null;
          clearSyncMarker();
          if (data.marker !== false && typeof data.viewportToken !== 'string') {
            placeSyncMarker(outside, syncBlockBox(outside, data), data.approximate !== true);
          }
          syncRefineGeneration += 1;
          requestAnimationFrame(scheduleEmbedSnapshot);
          return;
        }
        data = { ...data, page: ownLive ? live : sheet - outerPaper.before };
      }
      const entry = pageEntryFor(Number(data.page));
      if (!entry) return;
      // (a handoff naming the reader's source line goes to that line on this
      // paper, wherever a repaginating edit has put it: handoffLinePlace)
      let line = handoff ? handoffLinePlace(data) : null;
      if (handoff && data.sourceAnchor?.text) {
        const job = stageHandoffContent(data);
        if (documentReset.pending || job && job.result === undefined) return;
        if (job?.result) {
          const { n, y: baseline } = job.result;
          const div = pageDivs.get(n);
          if (div?.dataset.canonPresentedSrc !== `/canonical/${n}.svg?c=${job.id}` ||
              !div.classList.contains('is-final')) return;
          const scale = div.getBoundingClientRect().height / activePaperGeometry(div).height;
          line = { page: div, y: baseline + (Number(data.sourceAnchor.offset) || 0) / scale };
        }
      }
      if (handoff && !line && entry[0] !== Math.round(Number(data.page))) return;
      const page = line?.page ?? entry[1];
      const y = line ? line.y : syncPointY(page, data);
      // (a handoff that carries the static viewer's width and horizontal
      // place sets them before the scroll below: alignViewport)
      alignViewport(page, data);
      // A viewport handoff (the host mirroring where the static PDF was
      // scrolled when Live takes over, e.g. at the first keystroke) is not
      // a Jump: it carries a viewportToken and must never draw a marker.
      const wantsMarker = data.marker !== false && typeof data.viewportToken !== 'string';
      // The host's place is exact for this paper when the engine found it for
      // this very revision (`liveRevision`, the host's /synctex/jump): one
      // move, its box once the page shows that generation. Otherwise (the
      // last Build's SyncTeX) it is a first approximation for a source line:
      // the frame gives the exact lookup up to 1.2 s before landing there.
      const live = data.liveRevision;
      const liveExact = !handoff && Boolean(live) && Number(live.documentEpoch) === documentReset.adoptedEpoch &&
        Number(live.srcRev) === Number(appliedSrcRev);
      const refine = !handoff && !liveExact && Boolean(data.sourceFile) &&
        Number.isInteger(Number(data.sourceLine)) && Number(data.sourceLine) >= 1;
      if (openingPreview && refine) scrollPageToViewport(page, y, true);
      else if (refine || liveExact && wantsMarker) syncScrollTop = pagesEl.scrollTop;
      else if (wantsMarker) jumpScroll(page, y);
      else scrollPageToViewport(page, y, true);
      if (!handoff) handoffHoldUntil = 0;
      else if (embedViewportToken !== data.viewportToken) handoffHoldUntil = viewClock() + 10_000;
      embedViewportToken = handoff ? data.viewportToken : null;
      embedViewportSheet = handoff ? page : null;
      embedViewportPointY = handoff ? y : null;
      clearSyncMarker();
      syncRefineGeneration += 1;
      if (wantsMarker && liveExact) void markWhenCurrent(page, data, live.canonicalId, y);
      // The host's position comes from the last Build. It is exact only for
      // a line this frame cannot look up at all.
      else if (wantsMarker && (!refine || openingPreview)) {
        placeSyncMarker(page, syncBlockBox(page, data), !data.sourceFile && data.approximate !== true);
      }
      if (refine) void refineSyncToSource(data, wantsMarker, { page, y });
      requestAnimationFrame(scheduleEmbedSnapshot);
    };
    pagesEl.addEventListener('scroll', () => {
      if (syncScrollTop !== null && Math.abs(pagesEl.scrollTop - syncScrollTop) > 1) dismissSyncMarker();
      // (no reverse SyncTeX per scroll: it answered 404 where the centre has no
      // ink or no canonical exists yet, an error in the console each time; the
      // centre's row comes from the list on screen, viewAnchorList)
      scheduleEmbedSnapshot();
    }, { passive: true });
    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || d.source !== 'tdom-host') return;
      if (d.action === 'edit-anchor-result') {
        if (ev.source === window.parent) receiveDirectEditorPresentationAnchor(d);
        return;
      }
      if (d.activationId && d.activationId !== embedActivationId) return;
      if (d.action === 'reset-ack') {
        if (documentReset.acknowledge(d.documentEpoch)) {
          maybeAdoptCompletedReset(Number(d.documentEpoch));
        }
      } else if (d.action === 'zoom-in') setZoom(zoom * 1.1);
      else if (d.action === 'zoom-out') setZoom(zoom / 1.1);
      else if (d.action === 'zoom-fit') setZoom(1);
      // The host's static PDF and this paper show one paper at one width: its
      // fit width is this paper's zoom 1, and its paper width now (a zoom the
      // reader chose there) this paper's width. A swap of the two surfaces
      // then changes no width the reader did not.
      else if (d.action === 'paper-width' && Number(d.fitPx) > 0) {
        const paperPx = Number(d.paperPx) > 0 ? Number(d.paperPx) : Number(d.fitPx) * zoom;
        // (the same widths again, as a held frame is told on each of its moves: nothing to do)
        const same = pagesEl.style.getPropertyValue('--fit-width') === `${Number(d.fitPx)}px` &&
          Math.abs(paperPx / Number(d.fitPx) - zoom) < 1e-6;
        if (!same) setZoom(paperPx / Number(d.fitPx), null, { fitPx: Number(d.fitPx), quiet: true });
      }
      else if (d.action === 'goto-page') scrollToPage(Number(d.page));
      else if (d.action === 'goto-sync') scrollToSync(d);
      // (the host revealed the paper its handoff placed: the reader's place is kept again)
      else if (d.action === 'handoff-done') handoffHoldUntil = 0;
      else if (d.action === 'page-prev' || d.action === 'page-next') {
        const page = toolbarPage(outerPaper ? paperTopPage() : currentTopPage(), sortedPages());
        scrollToPage(page + (d.action === 'page-prev' ? -1 : 1));
      }
      else if (d.action === 'search') runLiveSearch(d.query, d.findPrevious === true);
    });
    setInterval(postEmbedSnapshot, 400);
  }
}
applyLayoutView();
applySplitRatio();

// ------------------------------------------------------------------ buttons

document.getElementById('btn-compare')?.addEventListener('click', () => {
  window.open('/compare', '_blank');
});

// ---------------------------------------------------------------- inspector

function fmtUs(us) {
  return us < 1000 ? `${us} µs` : `${(us / 1000).toFixed(2)} ms`;
}

function chips(list, cls = '') {
  if (!list || list.length === 0) return `<span class="chip none">—</span>`;
  const MAX = 14;
  const shown = list.slice(0, MAX).map((x) => `<span class="chip ${cls}">${escapeHtml(String(x))}</span>`);
  if (list.length > MAX) shown.push(`<span class="chip none">+${list.length - MAX}</span>`);
  return shown.join('');
}

function renderInspector(report, rtt) {
  // the inspector pane is not shown inside a host
  if (embeddedHost) return;
  const s = report.stats;
  const deps = report.dirtyDependencies.map((d) => `${d.kind}:${d.key} → ${d.affected.join(', ')}`);
  const phases = Object.entries(s)
    .filter(([k, v]) => k.endsWith('Us') && k !== 'totalUs' && typeof v === 'number')
    .map(([k, v]) => [k.slice(0, -2), v]);
  const maxUs = Math.max(...phases.map((p) => p[1]), 1);

  if (report.edit !== 'open') {
    history.unshift({ rev: report.rev, edit: report.edit, pages: report.dirtyPages, us: s.totalUs });
    if (history.length > 8) history.pop();
  }

  const isOpaque = (report.mode ?? mode) === 'opaque';
  const cacheRows = `
        <span class="k">ブロック総数</span><span class="v">${s.blocksTotal}</span>
        <span class="k">fork再開組版</span><span class="v">${s.blocksTypeset}</span>
        <span class="k">ブロック再利用</span><span class="v good">${s.blocksTotal - s.blocksTypeset}</span>
        <span class="k">組版時間 (実TeX)</span><span class="v good">${s.typesetMs} ms</span>
        <span class="k">常駐チェックポイント</span><span class="v">${s.checkpoints}</span>
        <span class="k">フル再構築</span><span class="v">${s.rebooted ? 'あり（プリアンブル変更）' : 'なし'}</span>
        <span class="k">ページ再利用</span><span class="v good">${s.pagesReused} / ${s.pageCount}</span>
        <span class="k">ページ再構築</span><span class="v">${s.pagesRebuilt}</span>`;

  const c = report.canonical ?? canonical ?? {};
  const verify = s.verify;
  const canonState = c.error
    ? `<span class="v" style="color:var(--err)">TeXエラー</span>`
    : c.inFlight
      ? `<span class="v" style="color:var(--warn)">コンパイル中</span>`
      : c.rev >= (report.srcRev ?? 0)
        ? `<span class="v good">現行ソースと一致</span>`
        : `<span class="v">srcRev ${c.rev} 待ち</span>`;
  const canonicalCard = `
    <div class="card">
      <h3>Canonical（LuaLaTeX 実出力・最終表示の権威）</h3>
      <div class="kv">
        <span class="k">状態</span>${canonState}
        <span class="k">コンパイル済み / 現在</span><span class="v">srcRev ${c.rev ?? 0} / ${report.srcRev ?? 0}</span>
        <span class="k">実ページ数</span><span class="v">${c.pageCount ?? 0}</span>
        <span class="k">パス数 / 時間</span><span class="v">${c.passes ?? 0} / ${c.ms ?? 0} ms</span>
        ${
          verify
            ? `<span class="k">一致検証</span><span class="v ${verify.mismatches?.length ? '' : 'good'}">${
                verify.mismatches?.length
                  ? escapeHtml(verify.mismatches[0])
                  : `${verify.pagesChecked} ページ一致`
              }</span>`
            : ''
        }
        ${
          s.fidelity
            ? `<span class="k">Fidelity gate</span><span class="v">safe ${s.fidelity.safeBlocks} / exact ${s.fidelity.exactBlocks}${
                s.fidelity.canonicalOnlyBlocks ? ` / canon-only ${s.fidelity.canonicalOnlyBlocks}` : ''
              }${s.fidelity.demoted ? `（降格 ${s.fidelity.demoted}）` : ''}${
                s.fidelity.pendingRenders ? ` / chunk待ち ${s.fidelity.pendingRenders}` : ''
              }</span>`
            : ''
        }
      </div>
      ${c.error ? `<div class="diag">${escapeHtml(c.error)}</div>` : ''}
      ${(s.fidelity?.demotedFonts ?? []).map((f) => `<div class="diag">font demoted: ${escapeHtml(f)}</div>`).join('')}
    </div>`;

  const opaqueCard = isOpaque
    ? `<div class="card">
        <h3>Opaque モード</h3>
        <div class="diag">structured 層は停止中。表示は LuaLaTeX 実出力のみ。編集は続けられる。</div>
        ${(report.modeReasons ?? modeReasons ?? []).map((r) => `<div class="diag">${escapeHtml(r)}</div>`).join('')}
      </div>`
    : '';

  inspectorEl.innerHTML = `
    <div class="card">
      <div class="bigtime">${fmtUs(s.totalUs)} <span class="unit">${isOpaque ? 'opaque (canonicalのみ)' : 'checkpoint engine (常駐TeX)'}${rtt != null ? ` / 往復 ${rtt.toFixed(0)} ms` : ''}</span></div>
      <div class="editlabel">edit: ${escapeHtml(report.edit)} (rev ${report.rev} / src ${report.srcRev ?? '-'})</div>
    </div>

    ${opaqueCard}
    ${canonicalCard}

    <div class="card">
      <h3>Dirty 伝播チェーン</h3>
      <div class="chainrow"><span class="lbl">Source</span><span class="chips">${chips(report.dirtySourceNodes)}</span></div>
      <div class="chainrow"><span class="lbl">Blocks</span><span class="chips">${chips(report.dirtySemanticNodes)}</span></div>
      <div class="chainrow"><span class="lbl">Deps</span><span class="chips">${chips(deps, 'dep')}</span></div>
      <div class="chainrow"><span class="lbl">Pages</span><span class="chips">${chips(report.dirtyPages.map((p) => 'page ' + p), 'page')}</span></div>
      <div class="chainrow"><span class="lbl">Patches</span><span class="chips">${chips(report.patches.map((p) => (p.type === 'replace-page' ? `replace p${p.page}` : `${p.type} ${p.from ?? ''}`)), 'page')}</span></div>
    </div>

    <div class="card">
      <h3>キャッシュと再利用</h3>
      <div class="kv">${cacheRows}</div>
    </div>

    <div class="card">
      <h3>フェーズ別時間</h3>
      <div class="bars">
        ${phases
          .map(
            ([n, us]) => `
          <div class="bar">
            <span class="n">${n}</span>
            <span class="track"><span class="fill" style="width:${Math.max(2, (us / maxUs) * 100)}%"></span></span>
            <span class="t">${fmtUs(us)}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>

    ${
      (s.macrosChanged?.length || s.labelsChanged?.length)
        ? `<div class="card"><h3>依存グラフ差分</h3>
           <div class="chainrow"><span class="lbl">macros</span><span class="chips">${chips((s.macrosChanged ?? []).map((m) => '\\' + m), 'dep')}</span></div>
           <div class="chainrow"><span class="lbl">labels</span><span class="chips">${chips(s.labelsChanged ?? [], 'dep')}</span></div></div>`
        : ''
    }

    ${
      s.diagnostics?.length
        ? `<div class="card"><h3>診断</h3>${s.diagnostics
            .slice(0, 6)
            .map((d) => `<div class="diag">${escapeHtml(d)}</div>`)
            .join('')}</div>`
        : ''
    }

    ${
      history.length
        ? `<div class="card"><h3>履歴</h3><div class="hist">${history
            .map(
              (h) =>
                `<div><b>#${h.rev}</b><span>${escapeHtml(shortEdit(h.edit))}</span><span>p[${h.pages.join(',')}]</span><span class="t">${fmtUs(h.us)}</span></div>`
            )
            .join('')}</div></div>`
        : ''
    }
  `;
}

function shortEdit(edit) {
  return edit.replace('main.tex:', '');
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}
function escapeHtml(s) {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
}

// ---------------------------------------------------------------- SSE

// A page's display list comes whole the first time this stream carries it
// and after that as its change from the one before: the commands between
// those that are the same at the start and at the end (server.js
// broadcastAtLists). The lists are kept here as they arrive, whatever the
// viewer then does with the event, so the next change always has its base.
// The commands of the shared start and end are the objects held: nothing
// here ever changes a command it was sent.
const streamLists = new Map(); // page -> { n, commands }: the list this stream last carried for the page
/** Puts every display list of an event in place; false when one cannot be made from what is held. */
function resolveStreamLists(msg) {
  const patches = Array.isArray(msg?.patches) ? msg.patches : Array.isArray(msg?.report?.patches) ? msg.report.patches : null;
  if (!patches) return true;
  for (const patch of patches) {
    const dl = patch?.type === 'replace-page' ? patch.displayList : null;
    if (!dl) continue;
    const sent = dl.commands;
    // (a plain list: the server keeps no base for this page either)
    if (Array.isArray(sent)) { streamLists.delete(dl.page); continue; }
    if (!sent || typeof sent !== 'object' || !Number.isSafeInteger(sent.n)) return false;
    let commands = sent.all;
    if (!Array.isArray(commands)) {
      const held = streamLists.get(dl.page);
      const { head, tail, mid } = sent;
      if (!held || held.n !== sent.base || held.commands.length !== sent.of || !Array.isArray(mid) ||
          !Number.isSafeInteger(head) || !Number.isSafeInteger(tail) || head < 0 || tail < 0 || head + tail > held.commands.length) return false;
      commands = head === held.commands.length && !mid.length
        ? held.commands
        : [...held.commands.slice(0, head), ...mid, ...held.commands.slice(held.commands.length - tail)];
    }
    dl.commands = commands;
    streamLists.set(dl.page, { n: sent.n, commands });
  }
  return true;
}
let sse = null;
function openEventStream() {
  const stream = new EventSource('/events?lists=cut');
  sse = stream;
  // (a stream that connects again is another stream to the server: it starts
  // from whole lists, and what it sent meanwhile is lost: streamReconnected)
  let opened = false;
  stream.onopen = () => {
    if (sse !== stream) return;
    streamLists.clear();
    if (opened) streamReconnected();
    opened = true;
  };
  stream.onmessage = (ev) => {
    if (sse !== stream) return;
    try {
      stateEventEpoch++;
      const tracing = Array.isArray(globalThis.__tdomStageTrace);
      if (tracing) traceStage('event', null, { bytes: ev.data.length });
      const msg = JSON.parse(ev.data);
      if (!resolveStreamLists(msg)) {
        // Not reachable while both ends keep to the stream's order. If it
        // ever is, nothing built on this event can be trusted: take a new
        // stream and the document as the server has it.
        console.warn('[tdom] a display list could not be made from the one held; reloading the document');
        stream.close();
        streamLists.clear();
        openEventStream();
        void boot();
        return;
      }
      if (tracing) traceStage('parsed', null, { kind: msg.kind });
      receivePreviewEvent(msg);
    } catch { /* ignore malformed events */ }
  };
}
openEventStream();
window.tdomTeardown = () => {
  teardownDocRecovery();
  const stream = sse;
  sse = null;
  stream?.close();
};
function receivePreviewEvent(msg) {
  try {
    if (msg.kind === 'reset-pending') {
      beginClientDocumentReset(msg.documentEpoch);
      return;
    }
    if (msg.kind === 'reset') {
      // A reconnect can miss reset-pending. Starting the same gate here is
      // still safe: the new DOM waits for the host's static-view ack.
      if (!documentReset.pending) beginClientDocumentReset(msg.documentEpoch);
      completeClientDocumentReset(msg.documentEpoch);
      return;
    }
    if (documentReset.pending) {
      // New-engine canonical/update events may arrive before reset completes.
      // /doc is the single atomic snapshot adopted after both sides agree.
      return;
    }
    if (msg.kind === 'warm' && msg.warm && !['scheduled', 'running', 'superseded', 'rejected', 'error'].includes(msg.warm.status) &&
        Number(msg.warm.sourceRev) === Number(appliedSrcRev)) {
      // The caret has settled on a block: fetch the source mapping now. The
      // first keystroke there otherwise fetches the whole document's mapping
      // (10 MB for a book, 170 ms) before its page may be shown; with this
      // one in hand it asks only for what the keystroke changed.
      void loadProvisionalSnapshot(appliedSrcRev).catch(() => {});
    }
    if (Number.isInteger(Number(msg.documentEpoch)) &&
        Number(msg.documentEpoch) !== documentReset.adoptedEpoch) {
      return;
    }
    if (msg.kind === 'opening-settled') {
      openingPreview = false;
      return;
    }
    if (msg.kind === 'ship-repaginated') {
      if (msg.srcRev === appliedSrcRev && usesCanonicalSurface() && !document.hidden) {
        requestCanonicalDisplay({ residentImpossible: true });
      }
      return;
    }
    if (holdingDirectOpeningPaper()) {
      deferredDirectPresentationEvents.push(() => receivePreviewEvent(msg));
      return;
    }
    if (msg.kind === 'canonical') {
      // a real-lualatex compile landed: converge every covered page to it
      const activeAnchor = canonicalAnchorPendingPatch ?? canonicalAnchorPreview;
      if (activeAnchor && (
        msg.canonical?.rev >= Number(activeAnchor.targetSrcRev ?? activeAnchor.srcRev)
      )) {
        // Retire the overlay when a covering page replaces its base image,
        // not now: until that image decodes and commits, removing the delta
        // would show the older base page underneath.
        canonicalAnchorPendingPatch = null;
        if (canonicalAnchorPreview) canonicalAnchorPreview.retiring = true;
      }
      canonical = msg.canonical;
      openingDirectInput?.checkShipMap?.();
      if (msg.mode) setMode(msg.mode, msg.canonical?.modeReasons ?? modeReasons);
      syncCanonical();
      retryCommitAfterCanonicalStall();
      return;
    }
    if (msg.kind === 'canonical-anchor') {
      applyCanonicalAnchorPatch(msg.patch);
      return;
    }
    if (msg.kind === 'canonical-visual-cut') {
      if (msg.patch?.visualCut === true && globalThis.TdomCanonicalAnchorRaster) {
        applyCanonicalAnchorPatch(msg.patch, { allowVisualCut: true });
      }
      return;
    }
    if (msg.kind === 'ship-wave') {
      // The authority is one complete replay PDF after document end, not a
      // bag of tail-page pager artifacts. Atomically decode every page that
      // is visible now; offscreen pages only adopt this same immutable PDF
      // generation when they later enter the viewport.
      if (Date.now() >= Number(msg.deadlineAt) || Number(msg.srcRev) !== Number(appliedSrcRev)) return;
      if (embeddedHost && shippingPresentationBlocked()) {
        // Shipping pages are read-only exact pixels. They may replace a
        // code-edit preview, but never an opening/active PDF editor surface.
        // The same lease is checked again after asynchronous image decode.
        if (usesCanonicalSurface()) requestCanonicalDisplay({ residentImpossible: true });
        return;
      }
      if (shipWaveBatch) cancelShipWaveBatch(shipWaveBatch);
      const allPages = new Set((msg.pages ?? []).map(Number).filter(Number.isInteger));
      if (!allPages.size) return;
      const viewport = pagesEl.getBoundingClientRect();
      const pages = new Set([...allPages].filter((page) => {
        const div = pageDivs.get(page);
        if (!div?.isConnected) return false;
        const rect = div.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      }));
      const key = `${msg.gen}:${msg.srcRev}:${msg.deadlineAt}`;
      const batch = {
        key,
        documentEpoch: Number(msg.documentEpoch),
        gen: Number(msg.gen),
        srcRev: Number(msg.srcRev),
        acceptedAt: Number(msg.acceptedAt),
        receivedAt: Date.now(),
        engineElapsedMs: Number(msg.elapsedMs),
        deadlineAt: Number(msg.deadlineAt),
        allPages,
        pages,
        expected: new Map(),
        cutoffTimer: null,
      };
      for (const page of allPages) {
        shipPages.set(page, {
          gen: batch.gen,
          srcRev: batch.srcRev,
          batchKey: key,
          deadlineAt: batch.deadlineAt,
          // Rotated/resized pages carry their own displayed box (#64).
          paper: msg.papers?.[page - 1] ?? null,
        });
      }
      // There may be no visible page during a reset/resize. The backing
      // generation is already committed; its first future page is rendered
      // lazily from the complete PDF rather than a stale pager fragment.
      if (!pages.size) return;
      shipWaveBatch = batch;
      stageShipViewAnchor(batch);
      batch.cutoffTimer = window.setTimeout(
        () => cancelShipWaveBatch(batch),
        Math.max(0, batch.deadlineAt - Date.now())
      );
      for (const page of pages) {
        if (pageDivs.has(page)) updateCanonState(page);
      }
      return;
    }
    if (msg.kind === 'patches') {
      // async arrivals (TikZ exact renders, background chain discoveries):
      // the SOURCE is unchanged, so canonical stays authoritative — no
      // dirty marks, but re-evaluate each repainted page's overlay state
      if (msg.rev > appliedRev) {
        if (Number.isInteger(msg.srcRev) && msg.srcRev < appliedSrcRev) return;
        injectFonts(msg.fonts);
        appliedRev = msg.rev;
        if (mode === 'opaque' || previewPolicy !== 'structured') return;
        // (a patch of a source revision this viewer has not applied: held
        // until that revision's report, holdPatchEvent)
        if (Number.isInteger(msg.srcRev) && msg.srcRev > appliedSrcRev) holdPatchEvent(msg);
        else applyPatchEvent(msg);
      }
      return;
    }
    if (msg.kind === 'source-edit-location') {
      warmSourceFormula(msg);
      return;
    }
    if (msg.kind === 'update' && msg.report.rev > appliedReportRev) {
      if (msg.dom) adoptPushedSnapshot(msg.dom, msg.documentEpoch);
      applyReport(msg.report);
      renderInspector(msg.report, null);
      // Editor-source sync exists for OTHER clients' edits (a second tab
      // must see the new text). The old unconditional fetch also fired on
      // our OWN edit's echo — re-serializing the entire document (source +
      // every page's display list) once per keystroke. While we are the
      // editing client (focused editor or an in-flight POST of ours), the
      // patches in this report are all we need.
      // Embedded in a host there is no editor of this page to keep in step:
      // the host owns the source. There this fetch ran on every keystroke
      // (the whole document, every page's display list: 11 MB for a
      // 389-page book), holding the server's one thread while the pictures
      // of the page just edited waited behind it.
      if (!embeddedHost && document.activeElement !== editor && !inFlight) {
        fetch('/doc')
          .then((r) => r.json())
          .then((doc) => {
            if (doc.report.rev === appliedReportRev && editor.value !== doc.source && document.activeElement !== editor) {
              serverText = doc.source;
              editor.value = doc.source;
              syncEditorHighlight();
            }
          });
      }
    }
  } catch {
    /* ignore malformed events */
  }
}

// collapsible inspector (preference persists)
function setInspector(hidden) {
  document.body.classList.toggle('no-inspector', hidden);
  localStorage.setItem('tdom-inspector', hidden ? 'hidden' : 'shown');
}
document.getElementById('insp-toggle').addEventListener('click', () => setInspector(true));
document.getElementById('insp-reopen').addEventListener('click', () => setInspector(false));
setInspector(localStorage.getItem('tdom-inspector') === 'hidden');

boot();

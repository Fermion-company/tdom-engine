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
const statusEl = document.getElementById('status');
const inspectorEl = document.getElementById('inspector');
const layoutViewEl = document.getElementById('layout-view');
const layoutSplitterEl = document.getElementById('workspace-preview-splitter');
const layoutEl = document.getElementById('layout');
const workspacePaneEl = document.getElementById('workspace-pane');
const previewPaneEl = document.getElementById('preview-pane');
const initialParams = new URLSearchParams(location.search);
const embeddedHost = initialParams.get('embed') === '1';
const embedActivationId = initialParams.get('activationId') ?? '';

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
let composing = false;
let sending = Promise.resolve();
let debounceTimer = null;
let pendingEditorInputAtEpochMs = null;
let inFlight = false;
const history = [];
const pageDivs = new Map();
const provisionalStages = new Map(); // latest unpublished display list per page
const provisionalRemovedPages = new Set();
const provisionalDisplayLists = new Map(); // complete resident page layout, including unchanged pages
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
async function canonicalSourceEditBoxes(pageNumber, id, region) {
  const source = region?.source;
  if (!source?.file || !Number.isInteger(source.start?.line) || !Number.isInteger(source.end?.line)) return [];
  const epoch = documentReset.adoptedEpoch;
  if (documentReset.pending) return [];
  const key = `${epoch}:${id}:${pageNumber}:${source.file}:${source.start.line}:${source.end.line}`;
  if (!canonicalSourceBoxCache.has(key)) {
    const pending = fetch('/canonical/source-boxes', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, page: pageNumber, documentEpoch: epoch, file: source.file,
        startLine: source.start.line, endLine: source.end.line }),
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
  const pending = fetch('/dom', { cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null)
    .then((snapshot) => {
      // /dom always describes the current editor source. It is a valid hit
      // map for a canonical generation only while both source revisions are
      // identical. Keeping this immutable snapshot lets an already printed
      // page resolve a second location while the next compile is pending.
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
  provisionalStages.clear();
  provisionalRemovedPages.clear();
  provisionalDisplayLists.clear();
  bootComplete = false;
  directEditClickEpoch++;
  cancelDirectOpenings();
  closeDirectEditor();
  directEditRevisits.length = 0;
  if (embeddedHost) {
    window.parent.postMessage({
      source: 'tdom-embed',
      activationId: embedActivationId,
      action: 'reset-pending',
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
  cancelObsoleteOpaqueBatches();
  geometry = doc.geometry;
  backend = doc.backend ?? 'checkpoint';
  injectFonts(doc.fonts);
  serverText = doc.source;
  editor.value = doc.source;
  syncEditorHighlight();
  pagesEl.textContent = '';
  pageDivs.clear();
  provisionalStages.clear();
  provisionalRemovedPages.clear();
  provisionalDisplayLists.clear();
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
  if (shipWaveBatch) cancelShipWaveBatch(shipWaveBatch);
  shipPages.clear();
  appliedRev = doc.report.rev;
  appliedSrcRev = doc.report.srcRev ?? doc.report.rev;
  if (previewPolicy === 'structured') {
    stageProvisionalPatches(doc.pages.map(displayList => ({ type: 'replace-page', displayList })), false, doc.pages.length);
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

function srcOf(target) {
  const src = target?.dataset?.src ?? target?.closest?.('[data-src]')?.dataset?.src;
  if (!src || src.startsWith('_')) return null;
  return src;
}

function stageProvisionalPatches(patches, flash, pageCount = null) {
  for (const patch of patches) {
    if (patch.type === 'replace-page') provisionalDisplayLists.set(patch.displayList.page, patch.displayList);
    else if (patch.type === 'remove-pages') {
      for (const n of provisionalDisplayLists.keys()) if (n >= patch.from) provisionalDisplayLists.delete(n);
    }
  }
  if (Number.isInteger(pageCount) && pageCount >= 0) {
    for (const n of provisionalDisplayLists.keys()) if (n > pageCount) provisionalDisplayLists.delete(n);
    if ([...pageDivs.keys(), ...provisionalStages.keys()].some(n => n > pageCount)) removePagesFrom(pageCount + 1);
  }
  if (usesCanonicalSurface()) {
    provisionalStages.clear();
    provisionalRemovedPages.clear();
    return;
  }
  if (committedCanonicalGeneration?.rev === appliedSrcRev &&
      committedCanonicalGeneration.epoch === documentReset.adoptedEpoch) return;
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
  for (const [n, dl] of displayLists) {
    const previous = provisionalStages.get(n);
    if (replaced.has(n) || !previous || previous.sourceRev !== appliedSrcRev ||
        previous.documentEpoch !== documentReset.adoptedEpoch) renderPage(dl, flash);
  }
  queueMicrotask(tryCommitProvisionalStages);
}

function directPresentationBlocked() {
  return Boolean(openingDirectInput?.sink) || flushingDirectPresentation;
}

function shippingPresentationBlocked() {
  return documentReset.pending || Boolean(directEditor) || Boolean(openingDirectInput) ||
    queuedDirectOpenings.length > 0 || flushingDirectPresentation || opaqueBatchCommitDepth > 0;
}

function scheduleViewportWarm() {
  window.clearTimeout(viewportWarmTimer);
  viewportWarmTimer = window.setTimeout(() => {
    if (documentReset.pending || usesCanonicalSurface() || directEditor || inFlight || composing) return;
    const viewport = pagesEl.getBoundingClientRect();
    const center = (viewport.top + viewport.bottom) / 2;
    let nearest = null;
    let distance = Infinity;
    for (const [page, div] of pageDivs) {
      const bounds = div.getBoundingClientRect();
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
      const gap = Math.abs((bounds.top + bounds.bottom) / 2 - center);
      if (gap < distance) { nearest = page; distance = gap; }
    }
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
  if (openingDirectInput?.sink || flushingDirectPresentation || documentReset.pending) return;
  // Replay source events in order, while keeping their intermediate surfaces
  // offscreen. Delta patches cannot be replaced by only the last event.
  flushingDirectPresentation = true;
  try {
    while (deferredDirectPresentationEvents.length && !openingDirectInput?.sink) {
      deferredDirectPresentationEvents.shift()();
    }
  } finally {
    flushingDirectPresentation = false;
  }
  if (openingDirectInput?.sink || documentReset.pending) return;
  for (const pageNumber of pageDivs.keys()) updateCanonState(pageNumber);
  for (const batch of opaqueCanonicalBatches.values()) tryCommitOpaqueCanonicalBatch(batch);
  tryCommitProvisionalStages();
  if (shipWaveBatch) tryCommitShipWaveBatch(shipWaveBatch);
  tryApplyPendingCanonicalAnchor();
  const commits = [...deferredDirectPresentationCommits.values()];
  deferredDirectPresentationCommits.clear();
  for (const commit of commits) commit();
}

function tryCommitProvisionalStages() {
  if (directPresentationBlocked()) return;
  // A provisional shrink cannot decide which printed page disappears. Hold
  // its replacements too, so moved ink does not appear on both old and new
  // pages while the definitive PDF establishes the page count.
  if (usesCanonicalSurface() || documentReset.pending) return;
  if (provisionalRemovedPages.size) {
    requestCanonicalDisplay({ residentImpossible: true });
    return;
  }
  if (!provisionalStages.size) return;
  // Canonical can create pages the resident layout never had (for example
  // an unbreakable display after a large fixed gap). Its old extra page has
  // no resident remove-pages event. Never mix those two page address spaces.
  if (committedCanonicalGeneration?.epoch === documentReset.adoptedEpoch &&
      committedCanonicalGeneration.pageCount !== provisionalDisplayLists.size) {
    requestCanonicalDisplay({ residentImpossible: true });
    return;
  }
  const stages = [...provisionalStages.values()].sort((a, b) => a.dl.page - b.dl.page);
  if (stages.some(stage => !stage.ready || stage.sourceRev !== appliedSrcRev ||
      stage.documentEpoch !== documentReset.adoptedEpoch ||
      Number(stage.snapshot?.srcRev) !== appliedSrcRev ||
      Number(stage.snapshot?.documentEpoch) !== stage.documentEpoch)) return;
  const editorStage = stages.find(stage => stage.dl.page === directEditor?.pageNumber);
  const editorRegion = editorStage ? directEditorRegionInSnapshot(editorStage.snapshot, directEditor) : null;
  if (editorStage && !provisionalStageKeepsEditor(editorStage, editorRegion)) {
    const pending = directEditorSnapshotPending(editorStage.snapshot, directEditor, editorStage.sourceRev, editorRegion);
    requestCanonicalDisplay({ residentImpossible: !pending });
    return;
  }
  // All affected pages change within this synchronous transaction. A new
  // provisional page is also kept detached until its complete ink is ready.
  provisionalStages.clear();
  for (const stage of stages) {
    const { dl, staging, sourceRev, snapshot } = stage;
    let div = pageDivs.get(dl.page);
    if (!div) div = ensureShell(dl.page);
    div.querySelector(':scope > svg:not(.tdom-canonical-delta)')?.remove();
    div.querySelectorAll('.chunkwin').forEach(e => e.remove());
    div.append(...staging.childNodes);
    div.provisionalEpoch = (div.provisionalEpoch ?? 0) + 1;
    div.provisionalSnapshot = snapshot;
    div.dataset.prov = '1';
    div.dataset.provRev = String(sourceRev);
    delete div.dataset.provPending;
    div.classList.remove('awaiting-canonical');
  }
  for (const stage of stages) updateCanonState(stage.dl.page);
  if (stages.every(stage => {
    const page = pageDivs.get(stage.dl.page);
    return !page.classList.contains('is-final') || Number(page.dataset.canonPresentedRev) >= stage.sourceRev;
  })) fulfillCanonicalDisplay();
  if (liveSearch.query) scheduleLiveSearchRefresh();
  if (stages.some(stage => stage.dl.page === directEditor?.pageNumber)) {
    repositionDirectEditor();
    void refreshDirectEditGeometry();
  }
  updateBadge();
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
    if (!(data?.width > 0)) continue;
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

function renderPage(dl, flash) {
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
  if (dl.commands.some(cmd => cmd.op === 'canon' || cmd.op === 'pending-exact' ||
      cmd.op === 'glyphs' && cmd.math || cmd.op === 'chunk' && cmd.st)) {
    requestCanonicalDisplay({ residentImpossible: dl.commands.some(cmd => cmd.op === 'canon') });
    return;
  }
  const families = [...new Set(dl.commands.filter(cmd => cmd.op === 'glyphs' && cmd.fam).map(cmd => cmd.fam))];
  injectFonts(families);
  const staging = document.createElement('div');
  staging.innerHTML = svgFor(dl);
  for (const cmd of dl.commands) {
    if (cmd.op !== 'chunk') continue;
    const W = geometry.paperwidth;
    const H = geometry.paperheight;
    const shiftPct = (cmd.sy / cmd.w) * 100;
    staging.insertAdjacentHTML(
      'beforeend',
      `<div class="chunkwin${cmd.st ? ' stale' : ''}" data-src="${cmd.src}"${cmd.line == null ? '' : ` data-line="${escapeXml(String(cmd.line))}"`} style="left:${(cmd.x / W) * 100}%;top:${(cmd.y / H) * 100}%;width:${(cmd.w / W) * 100}%;height:${(cmd.h / H) * 100}%">` +
        `<img class="chunk" src="/chunk/${encodeURIComponent(cmd.chunk)}.svg?v=${cmd.cv ?? 0}" style="margin-top:-${shiftPct}%" draggable="false"></div>`
    );
  }
  const ready = () => {
    if (provisionalStages.get(dl.page) !== stage || usesCanonicalSurface() ||
        sourceRev !== appliedSrcRev || stage.documentEpoch !== documentReset.adoptedEpoch) return;
    if (families.some(family => !readyFonts.has(family))) return;
    // Font promises can resolve while the SVG is still detached. Its
    // pending markers must be cleared here as well as in injectFonts().
    staging.querySelectorAll('text[data-font-pending]').forEach(node => node.removeAttribute('data-font-pending'));
    stage.staging = staging;
    stage.ready = true;
    tryCommitProvisionalStages();
  };
  const images = [...staging.querySelectorAll('img')];
  const pending = [
    loadProvisionalSnapshot(sourceRev).then(snapshot => { stage.snapshot = snapshot; }),
    ...images.map(img => img.decode()),
    Promise.all(images.map(loadChunkInputGeometry)).then(chunks => {
      stage.glyphs = provisionalChunkGlyphs(dl.commands, chunks);
    }),
    ...families.map(family => fontLoads.get(family)),
  ];
  void Promise.all(pending).then(ready).catch(() => {
    // A failed load can be a superseded source/chunk response. It cannot
    // prove resident impossibility; the bounded canonical grace still ends
    // if a persistent failure prevents the next page from committing.
    if (provisionalStages.get(dl.page) === stage && sourceRev === appliedSrcRev &&
        stage.documentEpoch === documentReset.adoptedEpoch) requestCanonicalDisplay();
  });
}

/** Unified SVG page: TeX-positioned glyph runs, rules, chunk images, folio. */
function svgFor(dl, className = '') {
  const parts = [
    `<svg${className ? ` class="${escapeXml(className)}"` : ''} viewBox="0 0 ${geometry.paperwidth} ${geometry.paperheight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
  ];
  for (const cmd of dl.commands) {
    const lineAttr = cmd.line == null ? '' : ` data-line="${escapeXml(String(cmd.line))}"`;
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
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="${cmd.size}"${fontAttrs} fill="${cmd.color || '#1a1a1a'}" data-width="${cmd.w ?? 0}" data-gh="${cmd.gh ?? 0}" data-gd="${cmd.gd ?? 0}" data-src="${cmd.src}"${lineAttr}${cmd.math ? ' data-math="1"' : ''}${cmd.edit ? ` data-edit="${escapeXml(cmd.edit)}"` : ''} xml:space="preserve">${escapeXml(cmd.text)}</text>`
      );
    } else if (cmd.op === 'rule' && cmd.w > 0 && cmd.h > 0) {
      parts.push(
        `<rect x="${cmd.x}" y="${cmd.y}" width="${cmd.w}" height="${cmd.h}" fill="${cmd.color || '#1a1a1a'}" data-src="${cmd.src}"${lineAttr}${cmd.edit ? ` data-edit="${escapeXml(cmd.edit)}"` : ''}/>`
      );
    } else if (cmd.op === 'editbox') {
      parts.push(
        `<rect class="tdom-edit-hit" x="${cmd.x}" y="${cmd.y}" width="${Math.max(cmd.w, 0.5)}" height="${Math.max(cmd.h, 0.5)}" fill="transparent" data-src="${cmd.src}" data-edit="${escapeXml(cmd.edit)}"/>`
      );
    } else if (cmd.op === 'sourcebox') {
      parts.push(
        `<rect class="tdom-source-hit" x="${cmd.x}" y="${cmd.y}" width="${Math.max(cmd.w, 0.5)}" height="${Math.max(cmd.h, 0.5)}" fill="transparent" data-src="${cmd.src}"${lineAttr}${cmd.ink ? ' data-ink="1"' : ''}${cmd.math ? ' data-math="1"' : ''}${cmd.stale ? ' data-stale="1"' : ''}${cmd.complex ? ' data-complex="1"' : ''}/>`
      );
    } else if (cmd.op === 'chunk') {
      // exact-render chunks are drawn as HTML <img> overlays (see renderPage)
    } else if (cmd.op === 'folio') {
      parts.push(
        `<text x="${cmd.x}" y="${cmd.y}" font-size="10" font-family="${FONT_FAMILY.regular}" fill="#1a1a1a" text-anchor="middle">${escapeXml(cmd.text)}</text>`
      );
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function removePagesFrom(from) {
  // Resident pagination is provisional. A shrink must not erase the last
  // printed page before the definitive PDF (including any moved ink) lands.
  lastRemoveRev = appliedSrcRev;
  for (const n of provisionalStages.keys()) if (n >= from) provisionalStages.delete(n);
  for (const [n, div] of pageDivs) if (n >= from) {
    provisionalRemovedPages.add(n);
    div.dataset.provPending = '1';
  }
}

function applyReport(report) {
  if (openingDirectInput?.sink) {
    deferredDirectPresentationEvents.push(() => applyReport(report));
    return;
  }
  if (report.rev <= appliedRev) return;
  // Font registration and the page patch are one visual transaction. The
  // SVG may be inserted before the local face finishes decoding, but its
  // affected runs remain hidden until injectFonts marks that face ready.
  injectFonts(report.fonts);
  appliedRev = report.rev;
  appliedSrcRev = report.srcRev ?? appliedSrcRev;
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
  if (closureDeferred && canonicalAnchorPreview) {
    // The source revision advances while an unfinished TeX construct holds
    // the last successful pixels. Keep that exact previous overlay eligible
    // for the new revision; it will be replaced when native closure succeeds.
    canonicalAnchorPreview.targetSrcRev = appliedSrcRev;
  } else if (!anchorIntent || canonicalAnchorPreview && (
    canonicalAnchorPreview.blockId !== anchorIntent.blockId ||
    canonicalAnchorPreview.baseGeneration !== anchorIntent.baseGeneration
  )) {
    clearCanonicalAnchorPreview();
  } else if (anchorIntent && canonicalAnchorPreview) {
    // Keep the previous keystroke visible while the next cumulative patch is
    // resolving, but make its convergence target the newest source revision.
    canonicalAnchorPreview.targetSrcRev = anchorIntent.srcRev;
  }
  const provisionalPatches = [];
  for (const patch of report.patches) {
    if (previewPolicy !== 'structured') continue;
    if (patch.type === 'replace-page') {
      const dl = patch.displayList;
      if (anchorIntent && (anchorIntent.provisionalPages ?? [anchorIntent.provisionalPage]).includes(dl.page) &&
          dl.commands?.some((command) => command.src === anchorIntent.blockId)) {
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
      provisionalPatches.push(patch);
    }
  }
  stageProvisionalPatches(provisionalPatches, true, report.stats?.pageCount);
  for (const patch of provisionalPatches) {
    if (patch.type === 'replace-page') updateCanonState(patch.displayList.page);
  }
  updateBadge();
}

function clearCanonicalAnchorPreview() {
  pagesEl.querySelectorAll('svg.tdom-canonical-delta').forEach((node) => node.remove());
  canonicalAnchorPreview = null;
  canonicalAnchorPendingPatch = null;
}

function canonicalAnchorForPage(pageNumber) {
  const candidate = canonicalAnchorPendingPatch ?? canonicalAnchorPreview;
  const pagePatch = canonicalAnchorPages(candidate).find((page) => Number(page.page) === Number(pageNumber));
  if (!candidate || !pagePatch) return null;
  if (Number(candidate.targetSrcRev ?? candidate.srcRev) !== Number(appliedSrcRev)) return null;
  return { ...candidate, ...pagePatch };
}

function tryApplyPendingCanonicalAnchor() {
  if (directPresentationBlocked()) return false;
  const patch = canonicalAnchorPendingPatch;
  if (!patch || patch.srcRev !== appliedSrcRev || !canonicalAnchorWithinDeadline(patch)) return false;
  const pagePatches = canonicalAnchorPages(patch);
  const transactions = [];
  for (const pagePatch of pagePatches) {
    const pageNumber = Number(pagePatch.page);
    const page = pageDivs.get(pageNumber);
    const presented = page?.isConnected ? presentedPageState(page) : null;
    if (!page?.classList.contains('is-final') ||
        presented?.id !== Number(patch.baseGeneration) ||
        presented?.rev !== Number(patch.baseRev)) return false;
    const rules = [];
    for (const mask of pagePatch.masks ?? []) {
      if (!mask || ![mask.left, mask.top, mask.right, mask.bottom].every(Number.isFinite)) return false;
      const background = canonicalAnchorBackground(page, mask);
      if (!background) {
        // A solid mask is exact only when the canonical ink sits on a locally
        // uniform background. Gradients, artwork, and frames fail closed.
        clearCanonicalAnchorPreview();
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
    transactions.push({ pageNumber, page, commands: [...rules, ...(pagePatch.commands ?? [])] });
  }
  // The deadline is checked again immediately before the atomic DOM commit;
  // image decode or background probing is not allowed to publish a stale win.
  if (!canonicalAnchorWithinDeadline(patch)) {
    clearCanonicalAnchorPreview();
    return false;
  }
  pagesEl.querySelectorAll('svg.tdom-canonical-delta').forEach((node) => node.remove());
  for (const transaction of transactions) {
    transaction.page.insertAdjacentHTML(
      'beforeend',
      svgFor({ page: transaction.pageNumber, commands: transaction.commands }, 'tdom-canonical-delta')
    );
  }
  const committedAt = performance.now();
  canonicalAnchorPreview = {
    blockId: patch.blockId,
    srcRev: patch.srcRev,
    targetSrcRev: patch.srcRev,
    baseGeneration: patch.baseGeneration,
    baseRev: patch.baseRev,
    pages: pagePatches.map((page) => ({ page: page.page })),
  };
  canonicalAnchorPendingPatch = null;
  for (const { page } of transactions) {
    page.classList.remove('fading');
    page.classList.add('patched');
    requestAnimationFrame(() => page.classList.add('fading'));
    setTimeout(() => page.classList.remove('patched', 'fading'), 1200);
  }
  updateBadge();
  reportCanonicalAnchorPresented(patch, pagePatches, committedAt);
  fulfillCanonicalDisplay();
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
    ? [{ page: Number(patch.page), masks: patch.mask ? [patch.mask] : [], commands: patch.commands ?? [] }]
    : [];
}

function canonicalAnchorWithinDeadline(patch) {
  const startedAt = canonicalAnchorEditStartedAt.get(Number(patch?.srcRev));
  const limit = Number(patch?.publishWithinMs ?? 850);
  return Number.isFinite(startedAt) && Number.isFinite(limit) &&
    performance.now() - startedAt < limit;
}

function canonicalAnchorBackground(page, mask) {
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
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function cssColor(value) {
  const match = String(value ?? '').match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  return match ? match.slice(1, 4).map(Number) : null;
}

function applyCanonicalAnchorPatch(patch) {
  if (!patch || patch.srcRev !== appliedSrcRev) return;
  if (patch.baseGeneration !== canonical?.id || patch.baseRev !== canonical?.rev) return;
  if (patch.status !== 'ready') {
    clearCanonicalAnchorPreview();
    return;
  }
  if (!canonicalAnchorWithinDeadline(patch)) return;
  const pagePatches = canonicalAnchorPages(patch);
  if (!pagePatches.length || pagePatches.some((page) =>
    !Number.isInteger(Number(page.page)) || Number(page.page) < 1 ||
    !Array.isArray(page.masks) || !page.masks.length ||
    page.masks.some((mask) => !mask || ![mask.left, mask.top, mask.right, mask.bottom].every(Number.isFinite))
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
  div.querySelector(':scope > svg')?.remove();
  div.querySelectorAll('.chunkwin').forEach((element) => element.remove());
  div.classList.remove('patched', 'fading');
  delete div.dataset.prov;
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

function presentedPageState(page) {
  const image = page?.querySelector?.('img.canon');
  const id = Number(page?.dataset?.canonPresentedId);
  const rev = Number(page?.dataset?.canonPresentedRev);
  if (!image || image.dataset.src !== page?.dataset?.canonPresentedSrc ||
      !Number.isFinite(id) || !Number.isFinite(rev)) return null;
  const snapshot = presentedDomSnapshots.get(presentedSnapshotKey(id, rev));
  return snapshot ? { image, id, rev, snapshot, src: image.dataset.src } : null;
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
    value: String(session.readValue()), replacement: session.kind === 'math'
      ? session.formattedSource : latexEscapeText(session.readValue()),
    tokens: session.revisitTokens, offsets: session.revisitOffsets });
  let cost = directEditRevisits.reduce((sum, item) => sum + item.sourceText.length + item.displaySourceText.length, 0);
  while (directEditRevisits.length > 32 || cost > 8 * 1024 * 1024) {
    const removed = directEditRevisits.shift();
    cost -= removed.sourceText.length + removed.displaySourceText.length;
  }
}

async function restoreDirectEditorRevisit(session, opening, offset) {
  const record = session.revisit;
  if (!record) return offset;
  const reply = await session.presentationAnchorDone;
  if (directEditor !== session || opening && openingDirectInput !== opening) return null;
  if (!reply || reply.baseValue !== record.replacement || !Number.isInteger(record.offsets[offset])) return null;
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
  return record.offsets[offset];
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
  const bounds = session.kind === 'text'
    ? await canonicalTextRegionBounds(region, snapshot, batch.id)
    : await canonicalSourceBounds(region, null, batch.id, near);
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
  cancelObsoleteOpaqueBatches(key);
  let batch = opaqueCanonicalBatches.get(key);
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
    };
    opaqueCanonicalBatches.set(key, batch);
    batch.snapshotReady = ensurePresentedDomSnapshot(id, rev).then((snapshot) => {
      if (opaqueCanonicalBatches.get(key) !== batch) return null;
      batch.snapshot = snapshot;
      tryCommitOpaqueCanonicalBatch(batch);
      return snapshot;
    });
    restageOpaqueBatchEditor(batch);
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

function reconcileOpaquePageCount(pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 0) return;
  for (const [pageNumber, page] of [...pageDivs]) {
    if (pageNumber <= pageCount) continue;
    canonicalStageObserver?.unobserve(page);
    page.remove();
    pageDivs.delete(pageNumber);
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
      batch.editorStage === undefined) return;
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
  batch.committing = true;
  opaqueCanonicalBatches.delete(batch.key);
  // All mutations below are synchronous. The browser cannot paint a frame
  // with page 1 from generation N+1 and page 2 from N, nor with an editor
  // candidate panel still anchored to the old generation.
  for (const [, entry] of [...batch.expected].sort((a, b) => a[0] - b[0])) {
    entry.apply();
  }
  committedCanonicalGeneration = { id: batch.id, rev: batch.rev, epoch: batch.documentEpoch, pageCount: batch.pageCount };
  provisionalStages.clear();
  provisionalRemovedPages.clear();
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
  reconcileOpaquePageCount(batch.pageCount);
  scheduleViewportWarm();
  updateBadge();
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
  for (const [, entry] of [...batch.expected].sort((a, b) => a[0] - b[0])) entry.apply();
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
        readyOpaqueCanonicalBatchPage(batchRegistration, () => {
          div.dataset.canonPresentedSrc = src;
          div.dataset.canonPresentedId = String(currentId);
          div.dataset.canonPresentedRev = String(currentRev);
          current.dataset.canonId = String(currentId);
          current.dataset.canonRev = String(currentRev);
          div.classList.remove('awaiting-canonical');
        });
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
  if (div.dataset.canonPending === src) return current;
  div.dataset.canonPending = src;

  const candidate = createCanonicalImage(src);
  const rawPresentationId = generation?.id ?? canonicalIdFromSrc(src);
  const rawPresentationRev = generation?.rev;
  const presentationId = rawPresentationId == null ? NaN : Number(rawPresentationId);
  const presentationRev = rawPresentationRev == null ? NaN : Number(rawPresentationRev);
  const requiresSnapshot =
    Number.isFinite(presentationId) && Number.isFinite(presentationRev);
  const snapshotReady = requiresSnapshot
    ? ensurePresentedDomSnapshot(presentationId, presentationRev)
    : Promise.resolve(true);
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
      window.setTimeout(() => {
        if (div.dataset.canonWanted === src && !div.dataset.canonPending) {
          updateCanonState(Number(div.dataset.page));
        }
      }, Math.min(3000, 150 * 2 ** Math.min(attempts - 1, 5)));
    }
  };
  const commit = async () => {
    if (settled) return;
    const snapshot = await snapshotReady;
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
        applyCandidate();
        directEditClickEpoch++;
        updateCanonState(Number(div.dataset.page));
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
  pagesEl.insertBefore(div, after ? after[1] : null);
  pageDivs.set(n, div);
  return div;
}

/** Reconcile shells + per-page overlays after a canonical compile lands. */
function syncCanonical() {
  let opaqueBatch = null;
  if (canonical && canonical.id) {
    // Dirty marks are retired with the actual generation commit. Metadata
    // can precede image decode and a newer edit by several event turns.
    // Canonical-only pages (beyond the provisional count) get shells only
    // when this compile covers the CURRENT source.  After /open, the cold
    // renderer can still describe the previous document for the idle
    // debounce window; letting that stale pageCount create shells briefly
    // resurrected old pages (for example a 1-page document showed /2).
    if (canonical.rev >= appliedSrcRev && canonical.rev >= lastRemoveRev) {
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
  const anchorCanonical = canonicalAnchorForPage(n);
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
  const canonAvail = canonical && canonical.id && n <= canonical.pageCount;
  const coldFresh = canonAvail && (pageDirtyRev.get(n) ?? 0) <= canonical.rev;
  const ship = shipPages.get(n);
  const shipOk = !!ship && (pageDirtyRev.get(n) ?? 0) <= ship.srcRev;
  // prefer the freshest real-pixels source for THIS page
  const useShip = mode !== 'opaque' && shipOk && (!embeddedHost || !shippingPresentationBlocked()) &&
    (!coldFresh || ship.srcRev > Number(canonical?.rev ?? -1));
  const fresh = coldFresh || useShip;
  let img = div.querySelector('img.canon');
  const stageCanonical = canonAvail && (
    usesCanonicalSurface() || coldFresh || !img
  );
  let targetSrc = null;
  if (stageCanonical || useShip) {
    const src = useShip
      ? `/ship/${n}.svg?g=${ship.gen}&r=${ship.srcRev}`
      : `/canonical/${n}.svg?c=${canonical.id}`;
    targetSrc = src;
    img = queueCanonicalImageSwap(
      div,
      src,
      useShip
        ? { w: geometry.paperwidth, h: geometry.paperheight }
        : canonical.papers?.[n - 1] ?? canonical.paper,
      useShip
        ? {
            id: null,
            rev: ship.srcRev,
            pageCount: canonical?.pageCount,
            shipWaveKey: ship.batchKey,
          }
        : { id: canonical.id, rev: canonical.rev, pageCount: canonical.pageCount }
    );
  } else {
    div.dataset.canonWanted = '';
    delete div.dataset.canonPending;
  }

  // Binary per page: canonical pixels only when a compile of the CURRENT
  // source covers this page; otherwise the provisional layer owns the whole
  // page. No band splice — mixing the two layouts on one page showed stale
  // and edited lines together whenever they drifted.
  const targetPresented = Boolean(
    targetSrc && img?.dataset.src === targetSrc && div.dataset.canonPresentedSrc === targetSrc
  );
  const retainingCanonical = img && div.classList.contains('is-final') && (
    div.dataset.provPending === '1' || targetSrc || canonical?.id && n > canonical.pageCount
  );
  const state = usesCanonicalSurface()
    ? (img ? 'final' : 'provisional')
    : ((fresh && targetPresented || retainingCanonical) ? 'final' : 'provisional');
  if (img) img.style.clipPath = '';
  const previousFinal = div.classList.contains('is-final');
  div.classList.toggle('is-final', state === 'final');
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
    const statusDocumentEpoch = Number(s.documentEpoch);
    if (documentReset.adoptedEpoch > 0 &&
        Number.isInteger(statusDocumentEpoch) && statusDocumentEpoch > documentReset.adoptedEpoch) {
      beginClientDocumentReset(statusDocumentEpoch);
      if (!s.busy) completeClientDocumentReset(statusDocumentEpoch);
    } else if (documentReset.pending?.epoch === statusDocumentEpoch && !s.busy) {
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

// Preview interaction: Cmd/Ctrl+click mirrors the static PDF viewer's
// SyncTeX gesture.  In embedded mode the real editor owns navigation; the
// standalone TDOM workbench keeps Alt+click for its internal textarea.
pagesEl.addEventListener('click', async (ev) => {
  if (embeddedHost ? !(ev.metaKey || ev.ctrlKey) : !ev.altKey) return;
  if (ev.target?.closest?.('.tdom-direct-editor')) return;
  const clickEpoch = ++directEditClickEpoch;
  const clickedPage = pageAtClientPoint(ev, ev.target);
  const presented = usesCanonicalSurface() ? presentedPageState(clickedPage) : null;
  if (usesCanonicalSurface() && !presented) return;
  const stillCurrent = () => {
    if (clickEpoch !== directEditClickEpoch || !clickedPage?.isConnected) return false;
    if (!usesCanonicalSurface()) return true;
    const current = presentedPageState(clickedPage);
    return current?.id === presented.id && current?.rev === presented.rev && current?.src === presented.src;
  };
  const src = srcOf(ev.target);
  ev.preventDefault();
  ev.stopPropagation();
  let location = null;
  let block = null;
  if (src) {
    const dom = await fetch('/dom').then((r) => r.json());
    block = dom.blocks.find((b) => b.id === src);
    if (block) location = block.source;
  }
  if (!location && embeddedHost) location = await syncLocationForClick(ev, clickedPage);
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
  if (!block) return;
  const offset = lineColToOffset(editor.value, block.source.start.line, block.source.start.column);
  editor.focus();
  editor.setSelectionRange(offset, offset);
  const lineTop = editor.value.slice(0, offset).split('\n').length - 1;
  editor.scrollTop = Math.max(0, lineTop * 19 - editor.clientHeight / 2);
  statusEl.textContent = `ソース対応 ${src} → main.tex:${block.source.start.line} (${block.type})`;
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
  const base = String(baseValue ?? '');
  let next = String(nextValue ?? '');
  const auxiliaries = [];
  const pattern = /\\(?:label\{(?:[^{}]|\\.)*\}|(?:notag|nonumber)\b)/g;
  let match;
  while ((match = pattern.exec(base))) {
    if (!next.includes(match[0])) {
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

function mathSourceTokens(value) {
  const text = String(value ?? ''), tokens = [], textModes = [false];
  for (const match of text.matchAll(/\\(?:[A-Za-z@]+|[\s\S])|[\s\S]/gu)) {
    const token = match[0], at = match.index;
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

// Keep source line breaks/spacing when MathLive only changes a local span.
// Its initial serialization often removes all display-environment newlines;
// sending that normalization as an edit invalidates unrelated source lines.
function preserveMathSourceLayout(raw, previous, next) {
  raw = String(raw ?? ''); previous = String(previous ?? ''); next = String(next ?? '');
  const before = mathSourceTokens(previous), after = mathSourceTokens(next), original = mathSourceTokens(raw);
  // This splice needs identical source tokens, including virtual markers.
  // Printed-value equality intentionally ignores empty MathLive placeholders.
  if (JSON.stringify(before.map(token => token[0])) !== JSON.stringify(original.map(token => token[0]))) return next;
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
  const candidate = prefix + inserted + suffix;
  // A structural edit can pair unrelated braces as a common suffix, moving
  // harmless outer whitespace into an environment name or text argument.
  // Preserve formatting only when the resulting source still tokenizes as
  // the requested value; otherwise use the unchanged MathLive serialization.
  return JSON.stringify(mathSourceTokens(candidate).map(token => token[0])) ===
    JSON.stringify(after.map(token => token[0])) ? candidate : next;
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

async function loadProvisionalSnapshot(sourceRev) {
  const epoch = documentReset.adoptedEpoch;
  const key = `${epoch}:${sourceRev}`;
  if (!provisionalSnapshotCache.has(key)) {
    const pending = fetch('/dom', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('Unready source mapping');
      const snapshot = await response.json();
      if (snapshot.sourceCurrent === false || Number(snapshot.srcRev) !== Number(sourceRev) ||
          Number(snapshot.documentEpoch) !== epoch || documentReset.adoptedEpoch !== epoch) {
        throw new Error('Superseded source mapping');
      }
      return snapshot;
    });
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
    if (region) return { ...region, blockSource: block.source ?? null };
  }
  return null;
}

async function editBlockBySourceId(id, page = null) {
  const snapshot = await editSnapshotForPage(page);
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

async function canonicalTextBoxes(requestedId = canonical?.id) {
  const id = Number(requestedId);
  if (!Number.isFinite(id)) return [];
  if (canonicalTextBoxesCache.has(id)) return canonicalTextBoxesCache.get(id);
  try {
    const response = await fetch(`/canonical/boxes?c=${id}`, { cache: 'no-store' });
    if (!response.ok) return [];
    // Poppler already returns word rectangles after page `/Rotate`; do not
    // rotate them again. Their space is the canonical SVG viewport.
    const pages = (await response.json()).pages ?? [];
    // Cache under the ID that was actually requested, never whichever
    // canonical happened to become global while the request was awaiting.
    canonicalTextBoxesCache.set(id, pages);
    while (canonicalTextBoxesCache.size > 4) {
      canonicalTextBoxesCache.delete(canonicalTextBoxesCache.keys().next().value);
    }
    return pages;
  } catch {
    return [];
  }
}

async function canonicalTextMatches(value, pageNumber = null, requestedId = canonical?.id) {
  const wanted = printedKey(value);
  if (!wanted) return [];
  const pages = await canonicalTextBoxes(requestedId);
  const matches = [];
  const pageIndexes = Number.isInteger(pageNumber)
    ? [pageNumber - 1]
    : pages.map((_, index) => index);
  for (const pageIndex of pageIndexes) {
    const words = pages[pageIndex] ?? [];
    for (let start = 0; start < words.length; start++) {
      let joined = '';
      for (let end = start; end < words.length && joined.length <= wanted.length; end++) {
        joined += printedKey(words[end].text);
        if (joined === wanted) {
          const group = words.slice(start, end + 1);
          matches.push({
            page: pageIndex + 1,
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
  }
  return matches;
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
  const identical = new Map();
  for (const block of snapshot.blocks ?? []) {
    for (const region of block.editRegions ?? []) {
      if (region.kind === 'text' && printedKey(region.value) === printedKey(selected.value) &&
          sameSourceFile(region.source?.file, selected.source.file)) {
        identical.set(directSourceRangeKey(region), { ...region, blockSource: block.source ?? null });
      }
    }
  }
  // Escaped text may be represented by a proven combined source span.
  if (!identical.has(directSourceRangeKey(selected))) identical.set(directSourceRangeKey(selected), selected);
  const regions = [...identical.values()].sort((a, b) =>
    a.source.start.line - b.source.start.line || a.source.start.column - b.source.start.column);
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
  const occurrences = [];
  for (const printBounds of matches) {
    const word = printBounds.words[0];
    const x = (word.left + word.right) / 2;
    let choices = regions.flatMap((region, index) => forward.results.some(result =>
      probeOwners[result?.locationIndex] === index && Number(result.page) === printBounds.page &&
      x >= result.box?.left - 2 && x <= result.box?.right + 2 &&
      word.bottom >= result.box?.top - 2 && word.top <= result.box?.bottom + 2) ? [index] : []);
    if (!choices.length) continue;
    const location = await fetch('/synctex', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: requestedId, page: printBounds.page,
        x, y: (word.top + word.bottom) / 2 }),
    }).then(response => response.ok ? response.json() : null).catch(() => null);
    if (documentReset.pending || documentReset.adoptedEpoch !== epoch) return [];
    // Paragraph-end SyncTeX nodes often report the following blank line.
    // Forward boxes prove the source span; a compatible inverse location
    // can narrow it, but a line-only mismatch must not discard that proof.
    if (sameSourceFile(location?.file, selected.source.file) &&
        Number.isInteger(Number(location.line)) && Number(location.line) > 0) {
      const precise = choices.filter(index => sourceContainsPosition(regions[index], location));
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
    const line = regions[choices[0]].source.start.line;
    // A line-only inverse mapping can cover several identical fragments.
    // Only a complete, nonoverlapping same-line group has a source/PDF order.
    if (group.length !== choices.length ||
        choices.some((index, at) => regions[index].source.start.line !== line || regions[index].source.end.line !== line ||
          at > 0 && regions[choices[at - 1]].source.end.column > regions[index].source.start.column)) return [];
    group.forEach((item, at) => assigned.set(item, choices[at]));
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

async function canonicalTextRegionBounds(region, snapshot, requestedId) {
  const mappings = await canonicalTextRegionMappings(region, snapshot, requestedId);
  return mappings.find(item => directSourceRangeKey(item.region) === directSourceRangeKey(region))?.printBounds ?? null;
}

async function canonicalWordAtPoint(pageNumber, point, requestedId = canonical?.id) {
  if (!Number.isInteger(pageNumber) || !point) return null;
  const words = (await canonicalTextBoxes(requestedId))[pageNumber - 1] ?? [];
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
    bounds = await canonicalTextRegionBounds(currentRegion, presented.snapshot, presented.id);
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

async function syncLocationForClick(event, page) {
  const presented = usesDirectEditSurface(page) ? presentedPageState(page) : null;
  const mappingId = presented?.id ?? canonical?.id;
  if (!mappingId || (!usesDirectEditSurface() && canonical.rev !== appliedSrcRev)) return null;
  const pageNumber = Number(page?.dataset?.page);
  const point = paperPointForClick(event, page);
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
      }),
    });
    if (!response.ok) return null;
    const result = await response.json();
    return { ...result, canonicalId: mappingId, canonicalRev: presented?.rev ?? canonical?.rev };
  } catch {
    return null;
  }
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
  const location = await syncLocationForClick(event, page);
  if (!stillPresented()) return null;
  const domSnapshot = presented.snapshot;
  const clickedWord = await canonicalWordAtPoint(pageNumber, point, presented.id);
  if (!stillPresented()) return null;
  const word = printedKey(clickedWord?.text);
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
  const printedCandidates = [];
  for (const block of domSnapshot.blocks ?? []) {
    for (const item of block.editRegions ?? []) {
      if (item.kind !== 'text' ||
          location?.file && !sameSourceFile(item.source?.file, location.file) ||
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
  const sourceColumn = sourceColumnForOpaqueClick(location, point);
  const atPoint = { ...location, column: sourceColumn };
  const blocks = (domSnapshot.blocks ?? []).filter((block) =>
    sameSourceFile(block.source?.file, location.file) &&
    Number(location.line) >= Number(block.source?.start?.line) &&
    Number(location.line) <= Number(block.source?.end?.line)
  );

  // Prefer the exact forward SyncTeX boxes for math on this source line.
  // This avoids converting proportional TeX glyph advances into a source
  // column by a linear character-count ratio.
  const spatialMath = [];
  for (const block of blocks) {
    for (const item of block.editRegions ?? []) {
      if (item.kind !== 'math' || !sameSourceFile(item.source?.file, location.file) ||
          Number(location.line) < Number(item.source?.start?.line) ||
          Number(location.line) > Number(item.source?.end?.line)) continue;
      const region = { ...item, blockSource: block.source ?? null };
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
  }
  if (spatialMath.length) {
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

async function provisionalRegionAtPoint(page, sourceId, candidates, event) {
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
  if (!clickedGlyphs.some(g => point.x >= g.left - 2 && point.x <= g.right + 2 && point.y >= g.top - 1 && point.y <= g.bottom + 1)) return undefined;
  const geometry = window.TdomDirectEditGeometry;
  const groups = new Map();
  for (const region of candidates) {
    const key = region.kind === 'math'
      ? 'math:' + JSON.stringify(mathSourceTokens(region.value).map(token => token[0]))
      : 'text:' + region.value;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(region);
  }
  let probe = null;
  const matches = [];
  try {
    for (const group of groups.values()) {
      const region = group[0];
      if (region.kind === 'math') {
        const Mathfield = customElements.get('math-field');
        if (!Mathfield) continue;
        if (!probe) {
          probe = new Mathfield();
          probe.mathVirtualKeyboardPolicy = 'manual';
          probe.setAttribute('aria-hidden', 'true');
          Object.assign(probe.style, { position: 'fixed', left: '-10000px', top: '0', opacity: '0', pointerEvents: 'none' });
          document.body.appendChild(probe);
        }
        probe.value = shouldWrapAligned(region.value) ? wrapAligned(region.value) : region.value;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const occurrences = pages.flatMap(p => {
        if (!p.glyphs.length) return [];
        const bounds = { left: Math.min(...p.glyphs.map(g => g.left)), right: Math.max(...p.glyphs.map(g => g.right)),
          top: Math.min(...p.glyphs.map(g => g.top)), bottom: Math.max(...p.glyphs.map(g => g.bottom)) };
        const maps = region.kind === 'text'
          ? geometry.textMaps(region.value, p.glyphs) : geometry.mathMaps(probe, p.glyphs, bounds);
        return maps.map(({ map }) => ({ map, pageNumber: p.pageNumber,
          top: Math.min(...map.map(g => g.top)), left: Math.min(...map.map(g => g.left)) }));
      }).sort((a, b) => a.pageNumber - b.pageNumber || a.top - b.top || a.left - b.left);
      // Identical source formulas must form a complete source-to-ink
      // bijection, including copies on other pages of this same block.
      // Choosing each candidate's nearest ink would edit the first source
      // occurrence even when the second printed copy was clicked.
      if (occurrences.length !== group.length) continue;
      const ordered = [...group].sort((a, b) => a.source.start.line - b.source.start.line || a.source.start.column - b.source.start.column);
      for (let index = 0; index < occurrences.length; index++) {
        const occurrence = occurrences[index];
        if (occurrence.pageNumber !== Number(page.dataset.page)) continue;
        const hit = geometry.nearest(occurrence.map, point);
        if (hit && point.x >= hit.left - 2 && point.x <= hit.right + 2 &&
            point.y >= hit.top - 1 && point.y <= hit.bottom + 1) {
          matches.push({ region: ordered[index], distance: Math.abs((hit.top + hit.bottom) / 2 - point.y) });
        }
      }
    }
  } finally { probe?.remove(); }
  if (!current()) return null;
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
  if (session.imeComposing && session.compositionInk?.text) {
    const { anchor, text } = session.compositionInk;
    const client = project(anchor);
    if (!client) return clear();
    // Only uncommitted IME text uses browser paint. Its immutable paper
    // anchor is the selected PDF glyph boundary; the surrounding PDF and
    // every other formula remain mounted through candidate conversion.
    const marker = document.createElement('span');
    marker.className = 'tdom-ink-composition';
    marker.textContent = text;
    Object.assign(marker.style, {
      left: `${client.left - pageRect.left}px`, top: `${client.top - pageRect.top}px`,
      maxWidth: `${Math.max(1, pageRect.right - client.left)}px`,
      fontSize: `${Math.max(1, client.bottom - client.top)}px`,
      fontFamily: getComputedStyle(session.control).fontFamily,
    });
    session.inkLayer.replaceChildren(marker);
    const end = document.createRange();
    end.selectNodeContents(marker); end.collapse(false);
    const caret = [...end.getClientRects()].at(-1) ?? marker.getBoundingClientRect();
    const point = paperPointForClick({ clientX: caret.right, clientY: caret.bottom }, page);
    if (point) session.canonicalAnchorPoint = point;
    return;
  }
  const selection = directSelection(session);
  if (!selection || !session.glyphMap?.length) return clear();
  const exact = String(session.readValue()) === session.geometryValue;
  const [start, end] = selection;
  // Until the new PDF geometry is ready, the only valid caret is the
  // previous printed one. Do not traverse the changed model to discard it.
  const box = !exact ? session.lastPaintedCaret : session.kind === 'math'
    ? window.TdomDirectEditGeometry.mathCaret(session.control, session.glyphMap, end, session.printBounds, session.sourceBoxes)
    : window.TdomDirectEditGeometry.caret(session.glyphMap, end);
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
  const selectedGlyphs = exact && start !== end ? session.glyphMap.filter(glyph =>
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
  if (session.kind === 'math' && canonicalVisible && session.printBounds) {
    session.printBounds = { ...session.printBounds,
      left: Math.min(session.printBounds.left, ...map.map(g => g.left)),
      right: Math.max(session.printBounds.right, ...map.map(g => g.right)),
      top: Math.min(session.printBounds.top, ...map.map(g => g.top)),
      bottom: Math.max(session.printBounds.bottom, ...map.map(g => g.bottom)),
    };
  }
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

pagesEl.addEventListener('load', event => {
  if (event.target?.matches?.('img.chunk, img.canon') && directEditor) {
    requestAnimationFrame(() => { void refreshDirectEditGeometry(); });
  }
}, true);

async function directProvisionalGeometry(session, page) {
  const result = directSvgGeometry(session, page);
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
  if (!chunkGlyphCache.has(cacheKey)) {
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
    while (chunkGlyphCache.size > 24) chunkGlyphCache.delete(chunkGlyphCache.keys().next().value);
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
  for (const chunk of page.querySelectorAll(`.chunkwin[data-src="${src}"]:not(.stale)`)) {
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

function directSvgGeometry(session, page) {
  const nodes = directEditorVisualNodes(page).filter(node => node.tagName?.toLowerCase() === 'text');
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

document.addEventListener('selectionchange', () => {
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
  if (sessionState && cancel) sessionState.revisitCancelled = true;
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
  const replacement = region.kind === 'math'
    ? preserveMathSourceLayout(sessionState?.formattedSource ?? region.sourceValue ?? region.value,
      sessionState?.serializedValue ?? region.value, serialized)
    : latexEscapeText(visibleValue);
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
  const old = session?.lastReplacement ?? region.value;
  if (editor.value.slice(start, start + old.length) !== old) return;
  editor.value = editor.value.slice(0, start) + replacement + editor.value.slice(start + old.length);
  if (directEditor) directEditor.standalone = { lastReplacement: replacement };
  scheduleHighlight();
  scheduleSync();
}

async function openDirectEditor(
  id,
  target,
  knownRegion = null,
  clickPoint = null,
  printBounds = null,
  caretOffset = null
) {
  const inputOpening = openingDirectInput;
  const page = target.closest('#pages > .page');
  const pageNumber = Number(page?.dataset?.page);
  if (!page || !Number.isFinite(pageNumber)) return;
  const presented = usesDirectEditSurface(page) ? presentedPageState(page) : null;
  if (usesDirectEditSurface(page) && !presented) return;
  const sourceSnapshot = presented?.snapshot ?? page.provisionalSnapshot;
  if (!sourceSnapshot || Number(sourceSnapshot.documentEpoch) !== documentReset.adoptedEpoch) return;
  const presentedRev = Number(presented?.rev ?? sourceSnapshot.srcRev);
  if (!Number.isFinite(presentedRev)) return;
  const canonicalInput = Boolean(presented);
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
      session.imeComposing = true;
      session.compositionInk = caret
        ? { text: '', anchor: { ...caret, left: caret.x, right: caret.x } }
        : null;
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
  control.addEventListener('compositionend', () => {
    composing = false;
    wysiwyg?.setComposing?.(false);
    resizeText();
    sendDirectEdit(region, sessionId, readValue());
    if (directEditor?.sessionId === sessionId) {
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
  control.addEventListener('selection-change', () => {
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
    sourceRev: presentedRev,
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
    sentFromSrcRev: presentedRev,
  };
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
    let openingMathOffset = await waitForDirectOpeningMathGeometry(
      directEditor, inputOpening, clickOnPaper, sourceCaret
    );
    if (directEditor?.sessionId !== sessionId) return;
    if (revisit) {
      const originalOffset = region.kind === 'math' ? openingMathOffset : caretOffset;
      const restoredOffset = await restoreDirectEditorRevisit(directEditor, inputOpening, originalOffset);
      if (!Number.isInteger(restoredOffset)) {
        // No accepted host lineage means the queued edit cannot target this
        // old ink safely. Keep its native input until the opening is cancelled.
        if (inputOpening) await new Promise(resolve => { inputOpening.resolveCancelled = resolve; });
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
    if (clickOnPaper && directEditor.glyphMap?.length) {
      const offset = directGeometryHit(directEditor, clickOnPaper);
      if (Number.isInteger(offset)) setDirectSelection(directEditor, offset);
    }
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
  opening.resolveCancelled?.();
  opening.resolveCancelled = null;
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
  Object.assign(sink.style, {
    position: 'fixed', left: `${event.clientX}px`, top: `${event.clientY}px`,
    width: '1px', height: '1px', minHeight: '0', margin: '0', padding: '0',
    border: '0', outline: 'none', boxShadow: 'none', resize: 'none',
    opacity: '0', pointerEvents: 'none', overflow: 'hidden', fontSize: '16px',
  });
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
    opening.compositionDone = new Promise(resolve => { opening.resolveComposition = resolve; });
  });
  sink.addEventListener('compositionend', input => {
    if (!isPendingDirectOpening(opening)) return;
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

document.addEventListener('keydown', event => {
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

document.addEventListener('keyup', event => {
  const opening = [openingDirectInput, ...queuedDirectOpenings]
    .find(pending => pending?.sink === event.target) ?? directOpeningInputTarget();
  // A key can produce no input (for example an unavailable dead-key pair).
  // Releasing it ends that native attempt without adding a character.
  if (opening?.nativeInputKey === event.key) resolveDirectOpeningNativeInput(opening);
}, { capture: true });

document.addEventListener('paste', event => {
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
      if (opening.operations.length || opening.composing || opening.nativeInputPending) {
        // An unproven target must not consume typed text, including text in
        // later queued clicks. Keep it until the user explicitly cancels.
        await new Promise(resolve => { opening.resolveCancelled = resolve; });
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

// A plain click edits; Cmd/Ctrl+click remains source navigation.  Only the
// printed node under the pointer activates, so scrolling/searching elsewhere
// on the page never creates editor DOM.
async function activateDirectEditorAtPoint(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target?.closest?.('.tdom-direct-editor')) return;
  const clickEpoch = ++directEditClickEpoch;
  const clickedPage = pageAtClientPoint(event, event.target);
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
    const resolved = await resolveOpaqueEditRegion(page, event);
    if (resolved && stillCurrent()) {
      await openDirectEditor(
        resolved.region.id,
        page,
        resolved.region,
        clickPoint,
        resolved.printBounds,
        resolved.caretOffset
      );
    }
    return;
  }
  const region = await resolveEditRegion(target, event);
  if (region && stillCurrent()) {
    // The awaited metadata may have replaced the clicked SVG. The page
    // remains stable and the exact glyph map reacquires this source's ink.
    await openDirectEditor(region.id, target.isConnected ? target : targetPage, region, clickPoint);
  }
}

let directPointer = null;
let suppressDirectClick = false;
pagesEl.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey ||
      event.target.closest?.('.math-wysiwyg-panel')) return;
  const page = pageAtClientPoint(event, event.target);
  if (!page) return;
  const point = paperPointForClick(event, page);
  const session = directEditor;
  const glyph = session?.pageNumber === Number(page.dataset.page) &&
    session.geometryValue === String(session.readValue())
    ? window.TdomDirectEditGeometry.nearest(session.glyphMap ?? [], point) : null;
  const inside = glyph && point.x >= glyph.left - 2 && point.x <= glyph.right + 2 &&
    point.y >= glyph.top - 2 && point.y <= glyph.bottom + 2;
  directPointer = { page, event, point, session: inside ? session : null, moved: false };
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
pagesEl.addEventListener('pointermove', event => {
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
pagesEl.addEventListener('pointerup', async event => {
  const drag = directPointer;
  directPointer = null;
  if (pagesEl.hasPointerCapture(event.pointerId)) pagesEl.releasePointerCapture(event.pointerId);
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
  const geometry = window.TdomDirectEditGeometry;
  setDirectSelection(session, directGeometryHit(session, drag.point), directGeometryHit(session, drag.end));
});
pagesEl.addEventListener('pointercancel', () => {
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
pagesEl.addEventListener('click', event => {
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

function setZoom(z, origin = null) {
  const anchorPage = origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)
    ? findZoomAnchorPage(origin.x, origin.y)
    : null;
  const anchor = anchorPage && globalThis.TdomViewportMath?.capturePageAnchor({
    clientX: origin.x,
    clientY: origin.y,
    pageRect: anchorPage.getBoundingClientRect(),
  });
  zoom = Math.min(3, Math.max(0.4, Math.round(z * 100) / 100));
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
}, { passive: true });
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
      return { entries, required: exposed.length ? exposed : entries.slice(0, 1),
        topPage: topPage ?? entries[0]?.[0] ?? 1 };
    };
    const previewReady = (required) => {
      if (!bootComplete || !documentReset.acceptsReady(documentReset.adoptedEpoch) || !required.length) return false;
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
    const presentationPending = (required) => {
      if (documentReset.pending || !required.length || deferredDirectPresentationEvents.length) return true;
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
    const postEmbedSnapshot = () => {
      try {
        const visible = visiblePageSnapshot();
        const pending = presentationPending(visible.required);
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
            ready: previewReady(visible.required),
            presentationPending: pending,
            pageCount: visible.entries.length,
            zoom,
            page: visible.topPage,
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
    const pageEntryFor = (n) => {
      const entries = sortedPages();
      if (!entries.length) return null;
      const wanted = Number.isFinite(n) ? Math.round(n) : entries[0][0];
      return entries.reduce((best, entry) =>
        Math.abs(entry[0] - wanted) < Math.abs(best[0] - wanted) ? entry : best
      );
    };
    const scrollPageToViewport = (page, paperY = 0, center = false) => {
      const viewport = pagesEl.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      const paper = activePaperGeometry(page);
      const ratio = Math.max(0, Math.min(1, Number(paperY) / Math.max(1, Number(paper.height))));
      const withinPage = ratio * pageRect.height;
      const target = pagesEl.scrollTop + pageRect.top - viewport.top + withinPage -
        (center ? pagesEl.clientHeight / 2 : 0);
      pagesEl.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
      scheduleEmbedSnapshot();
    };
    const scrollToPage = (n) => {
      const entry = pageEntryFor(Number(n));
      if (!entry) return;
      scrollPageToViewport(entry[1]);
    };
    const refineSyncToSource = async (data) => {
      const file = String(data.sourceFile ?? '');
      const line = Number(data.sourceLine);
      if (!file || !Number.isFinite(line)) return false;
      let dom;
      try {
        const response = await fetch('/dom', { cache: 'no-store' });
        if (!response.ok) return false;
        dom = await response.json();
      } catch {
        return false;
      }
      const blocks = (dom?.blocks ?? []).filter((block) =>
        block?.id && sameSourceFile(block.source?.file, file) &&
        Number(block.source?.start?.line) <= line && Number(block.source?.end?.line) >= line
      ).sort((a, b) =>
        (Number(a.source.end.line) - Number(a.source.start.line)) -
        (Number(b.source.end.line) - Number(b.source.start.line))
      );
      for (const block of blocks) {
        const relativeLine = line - Number(block.source.start.line);
        for (const [, page] of sortedPages()) {
          const nodes = [...page.querySelectorAll(`[data-src="${CSS.escape(String(block.id))}"][data-line]`)]
            .filter((node) => {
              const rect = node.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
          if (!nodes.length) continue;
          const values = [...new Set(nodes.map((node) => Number(node.dataset.line)).filter(Number.isFinite))];
          if (!values.length) continue;
          const targetLine = values.includes(relativeLine)
            ? relativeLine
            : values.reduce((best, value) =>
              Math.abs(value - relativeLine) < Math.abs(best - relativeLine) ? value : best
            );
          const exact = nodes.filter((node) => Number(node.dataset.line) === targetLine);
          const ink = exact.filter((node) =>
            !node.classList.contains('tdom-source-hit') &&
            !node.classList.contains('tdom-edit-hit')
          );
          // Rescue/source-hit rectangles can cover a whole tcolorbox. They
          // are useful for click mapping but too broad for a precise jump.
          if (!ink.length) continue;
          const rects = ink.map((node) => node.getBoundingClientRect());
          const top = Math.min(...rects.map((rect) => rect.top));
          const bottom = Math.max(...rects.map((rect) => rect.bottom));
          const viewport = pagesEl.getBoundingClientRect();
          pagesEl.scrollTo({
            top: Math.max(0, pagesEl.scrollTop + (top + bottom) / 2 - viewport.top - pagesEl.clientHeight / 2),
            behavior: 'auto',
          });
          scheduleEmbedSnapshot();
          return true;
        }
      }
      return false;
    };
    const scrollToSync = (data) => {
      const entry = pageEntryFor(Number(data.page));
      if (!entry) return;
      const [, page] = entry;
      const blockY = Number(data.blockY);
      const blockHeight = Number(data.blockHeight);
      const y = Number.isFinite(blockY)
        ? blockY + (Number.isFinite(blockHeight) ? blockHeight / 2 : 0)
        : Number(data.y);
      scrollPageToViewport(page, Number.isFinite(y) ? y : 0, true);
      void refineSyncToSource(data);
      requestAnimationFrame(scheduleEmbedSnapshot);
    };
    pagesEl.addEventListener('scroll', scheduleEmbedSnapshot, { passive: true });
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
      else if (d.action === 'goto-page') scrollToPage(Number(d.page));
      else if (d.action === 'goto-sync') scrollToSync(d);
      else if (d.action === 'page-prev') scrollToPage(currentTopPage() - 1);
      else if (d.action === 'page-next') scrollToPage(currentTopPage() + 1);
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

const sse = new EventSource('/events');
sse.onmessage = (ev) => {
  try {
    stateEventEpoch++;
    receivePreviewEvent(JSON.parse(ev.data));
  } catch { /* ignore malformed events */ }
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
    if (Number.isInteger(Number(msg.documentEpoch)) &&
        Number(msg.documentEpoch) !== documentReset.adoptedEpoch) {
      return;
    }
    if (openingDirectInput?.sink) {
      deferredDirectPresentationEvents.push(() => receivePreviewEvent(msg));
      return;
    }
    if (msg.kind === 'canonical') {
      // a real-lualatex compile landed: converge every covered page to it
      const activeAnchor = canonicalAnchorPendingPatch ?? canonicalAnchorPreview;
      if (activeAnchor && (
        msg.canonical?.rev >= Number(activeAnchor.targetSrcRev ?? activeAnchor.srcRev)
      )) clearCanonicalAnchorPreview();
      canonical = msg.canonical;
      if (msg.mode) setMode(msg.mode, msg.canonical?.modeReasons ?? modeReasons);
      syncCanonical();
      return;
    }
    if (msg.kind === 'canonical-anchor') {
      applyCanonicalAnchorPatch(msg.patch);
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
        });
      }
      // There may be no visible page during a reset/resize. The backing
      // generation is already committed; its first future page is rendered
      // lazily from the complete PDF rather than a stale pager fragment.
      if (!pages.size) return;
      shipWaveBatch = batch;
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
        injectFonts(msg.fonts);
        appliedRev = msg.rev;
        if (mode === 'opaque' || previewPolicy !== 'structured') return;
        stageProvisionalPatches(msg.patches, true);
        for (const patch of msg.patches) {
          if (patch.type === 'replace-page') updateCanonState(patch.displayList.page);
        }
      }
      return;
    }
    if (msg.kind === 'update' && msg.report.rev > appliedRev) {
      applyReport(msg.report);
      renderInspector(msg.report, null);
      // Editor-source sync exists for OTHER clients' edits (a second tab
      // must see the new text). The old unconditional fetch also fired on
      // our OWN edit's echo — re-serializing the entire document (source +
      // every page's display list) once per keystroke. While we are the
      // editing client (focused editor or an in-flight POST of ours), the
      // patches in this report are all we need.
      if (document.activeElement !== editor && !inFlight) {
        fetch('/doc')
          .then((r) => r.json())
          .then((doc) => {
            if (doc.report.rev === appliedRev && editor.value !== doc.source && document.activeElement !== editor) {
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

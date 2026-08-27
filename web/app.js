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
const failedFonts = new Set(); // families reported to /font-fail (once each)

let serverText = '';
let appliedRev = 0;
let composing = false;
let sending = Promise.resolve();
let debounceTimer = null;
let inFlight = false;
const history = [];
const pageDivs = new Map();
let lastEngineStatus = null;
let liveSearch = { query: '', results: [], current: -1 };
let editDomCache = null;
let editDomFetch = null;
let directEditor = null;
let mathWysiwygModulePromise = null;
let mathCaretProbe = null;
let mathCaretProbeSeq = 0;
const mathCaretOffsetCache = new Map();
const canonicalTextBoxesCache = new Map();
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
let canonical = null; // {id, rev(srcRev), pageCount, paper, inFlight, error}
// incremental authority (shipping chain): page -> {gen, srcRev}. A shipped
// page is the SAME fidelity class as a canonical page (a real LuaLaTeX
// page), it just arrives ~ms after the edit instead of after a full compile.
const shipPages = new Map();
let appliedSrcRev = 0;
const pageDirtyRev = new Map(); // page -> srcRev of the last provisional patch
let lastRemoveRev = 0; // srcRev of the last provisional remove-pages patch
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
    document.fonts.load(`12px "${k}"`).then(
      (faces) => {
        if (!faces || faces.length === 0) reportFontFailure(k);
      },
      () => reportFontFailure(k)
    );
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

function presentedSnapshotKey(id, rev) {
  return `${Number(id)}:${Number(rev)}`;
}

async function ensurePresentedDomSnapshot(id, rev) {
  const numericId = Number(id);
  const numericRev = Number(rev);
  if (!Number.isFinite(numericId) || !Number.isFinite(numericRev)) return null;
  const key = presentedSnapshotKey(numericId, numericRev);
  if (presentedDomSnapshots.has(key)) return presentedDomSnapshots.get(key);
  if (presentedDomFetches.has(key)) return presentedDomFetches.get(key);
  const pending = fetch('/dom', { cache: 'no-store' })
    .then((response) => response.ok ? response.json() : null)
    .then((snapshot) => {
      // /dom always describes the current editor source. It is a valid hit
      // map for a canonical generation only while both source revisions are
      // identical. Keeping this immutable snapshot lets an already printed
      // page resolve a second location while the next compile is pending.
      if (!snapshot || Number(snapshot.srcRev) !== numericRev) return null;
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
  adoptDoc(doc);
  if (mode === 'opaque' && canonical?.id && canonical.rev === appliedSrcRev) {
    await ensurePresentedDomSnapshot(canonical.id, canonical.rev);
  }
  if (requestEpoch !== bootRequestEpoch || eventEpoch !== stateEventEpoch) {
    queueMicrotask(() => boot(expectedDocumentEpoch));
    return;
  }
  if (!documentReset.adopt(doc.documentEpoch)) {
    if (expectedDocumentEpoch !== null) queueMicrotask(() => boot(expectedDocumentEpoch));
    return;
  }
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
  bootComplete = false;
  directEditClickEpoch++;
  closeDirectEditor();
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
  closeDirectEditor();
  cancelObsoleteOpaqueBatches();
  geometry = doc.geometry;
  backend = doc.backend ?? 'checkpoint';
  injectFonts(doc.fonts);
  serverText = doc.source;
  editor.value = doc.source;
  syncEditorHighlight();
  pagesEl.textContent = '';
  pageDivs.clear();
  pageDirtyRev.clear();
  lastRemoveRev = 0;
  mode = doc.mode ?? 'structured';
  modeReasons = doc.modeReasons ?? [];
  document.body.classList.toggle('is-opaque-document', mode === 'opaque');
  canonical = doc.canonical ?? null;
  shipPages.clear();
  for (const dl of doc.pages) {
    renderPage(dl, false);
  }
  appliedRev = doc.report.rev;
  appliedSrcRev = doc.report.srcRev ?? doc.report.rev;
  // a canonical compile older than the document state cannot vouch for any
  // page — show provisional until the fresh one lands (reload after
  // convergence has canonical.rev === srcRev: exact from frame one)
  if (mode === 'structured' && canonical && canonical.rev < appliedSrcRev) {
    for (const n of pageDivs.keys()) pageDirtyRev.set(n, appliedSrcRev);
  }
  syncCanonical();
}

// ---------------------------------------------------------------- pages

function srcOf(target) {
  const src = target?.dataset?.src ?? target?.closest?.('[data-src]')?.dataset?.src;
  if (!src || src.startsWith('_')) return null;
  return src;
}

async function currentEditDomSnapshot(expectedRev) {
  if (editDomCache?.rev === expectedRev) return editDomCache;
  if (editDomFetch?.rev !== expectedRev) {
    const promise = fetch('/dom', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .catch(() => null);
    editDomFetch = { rev: expectedRev, promise };
  }
  const pending = editDomFetch;
  const snapshot = await pending.promise;
  if (editDomFetch === pending) editDomFetch = null;
  if (snapshot?.rev !== expectedRev || appliedRev !== expectedRev) return null;
  editDomCache = snapshot;
  return snapshot;
}

function finishMathGroup(groups, active) {
  if (active?.nodes.some((node) => node.matches('[data-math="1"]'))) groups.push(active);
  return null;
}

function provisionalMathGroups(svg, src) {
  const groups = [];
  let active = null;
  for (const node of svg.children) {
    const sameSource = node.dataset.src === src;
    const line = node.dataset.line ?? '';
    const mathGlyph = sameSource && (
      node.matches('text[data-math="1"]') ||
      node.matches('rect.tdom-source-hit[data-math="1"][data-stale="1"]')
    );
    const mathRule = sameSource && active && line === active.line &&
      node.matches('rect:not(.tdom-edit-hit):not(.tdom-source-hit)');
    if (mathGlyph) {
      if (active && line !== active.line) active = finishMathGroup(groups, active);
      if (!active) active = { line, nodes: [] };
      active.nodes.push(node);
    } else if (mathRule) {
      active.nodes.push(node);
    } else if (active) {
      active = finishMathGroup(groups, active);
    }
  }
  finishMathGroup(groups, active);
  return groups;
}

function provisionalNodeBounds(node) {
  if (node.matches('text')) {
    const x = Number(node.getAttribute('x'));
    const y = Number(node.getAttribute('y'));
    const width = Number(node.dataset.width);
    const gh = Number(node.dataset.gh);
    const gd = Number(node.dataset.gd);
    if ([x, y, width, gh, gd].every(Number.isFinite) && width > 0 && gh + gd > 0) {
      return { left: x, top: y - gh, right: x + width, bottom: y + gd };
    }
  } else if (node.matches('rect')) {
    const x = Number(node.getAttribute('x'));
    const y = Number(node.getAttribute('y'));
    const width = Number(node.getAttribute('width'));
    const height = Number(node.getAttribute('height'));
    if ([x, y, width, height].every(Number.isFinite)) {
      return { left: x, top: y, right: x + width, bottom: y + height };
    }
  }
  try {
    const box = node.getBBox();
    return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
  } catch {
    return null;
  }
}

function provisionalGroupBounds(group) {
  let bounds = null;
  for (const node of group.nodes) {
    const box = provisionalNodeBounds(node);
    if (!box) continue;
    bounds = bounds
      ? {
          left: Math.min(bounds.left, box.left),
          top: Math.min(bounds.top, box.top),
          right: Math.max(bounds.right, box.right),
          bottom: Math.max(bounds.bottom, box.bottom),
        }
      : box;
  }
  return bounds;
}

function sourceOrder(a, b) {
  return Number(a.source?.start?.line) - Number(b.source?.start?.line) ||
    Number(a.source?.start?.column) - Number(b.source?.start?.column);
}

async function scheduleProvisionalMath(page) {
  const svg = page.querySelector('svg');
  if (!svg || !window.customElements?.get('math-span')) return;
  const sources = [...new Set([...svg.querySelectorAll(
    'text[data-math="1"][data-src], rect.tdom-source-hit[data-math="1"][data-stale="1"][data-src]'
  )]
    .map((node) => node.dataset.src)
    .filter(Boolean))];
  if (!sources.length) return;

  const expectedRev = appliedRev;
  const sequence = String((Number(page.dataset.provisionalMathSeq) || 0) + 1);
  page.dataset.provisionalMathSeq = sequence;
  const snapshot = await currentEditDomSnapshot(expectedRev);
  if (!snapshot || page.dataset.provisionalMathSeq !== sequence || !svg.isConnected) return;
  const blocks = new Map((snapshot.blocks ?? []).map((block) => [block.id, block]));

  for (const src of sources) {
    const block = blocks.get(src);
    const regions = (block?.editRegions ?? [])
      .filter((region) => region.kind === 'math')
      .sort(sourceOrder);
    const groups = provisionalMathGroups(svg, src);
    // The source regions are the authority. If a formula cannot be paired
    // one-to-one with TeX's run groups, leave the exact chunk path alone
    // instead of guessing and painting the wrong expression.
    if (!regions.length || groups.length !== regions.length) continue;

    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      const bounds = provisionalGroupBounds(group);
      if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) continue;
      if (page.dataset.provisionalMathSeq !== sequence) continue;
      const shell = document.createElement('span');
      shell.className = 'tdom-provisional-math';
      shell.setAttribute('aria-hidden', 'true');
      shell.style.left = `${(bounds.left / geometry.paperwidth) * 100}%`;
      shell.style.top = `${(((bounds.top + bounds.bottom) / 2) / geometry.paperheight) * 100}%`;
      const fontSize = Math.max(...group.nodes
        .filter((node) => node.matches('text'))
        .map((node) => Number(node.getAttribute('font-size')) || 0),
        Math.min(14, Math.max(1, (bounds.bottom - bounds.top) * 0.85)));
      shell.style.fontSize = `${(fontSize / geometry.paperwidth) * 100}cqw`;
      shell.style.color = group.nodes.find((node) => node.matches('text'))?.getAttribute('fill') || '#1a1a1a';
      const mathSpan = document.createElement('math-span');
      mathSpan.setAttribute('mode', regions[index].display ? 'displaystyle' : 'textstyle');
      mathSpan.textContent = String(regions[index].value ?? '');
      shell.appendChild(mathSpan);
      page.appendChild(shell);
      mathSpan.render?.();
      if (!shell.isConnected || page.dataset.provisionalMathSeq !== sequence) continue;
      const naturalWidth = shell.getBoundingClientRect().width;
      const pageWidth = page.getBoundingClientRect().width;
      const targetWidth = ((bounds.right - bounds.left) / geometry.paperwidth) * pageWidth;
      if (!(naturalWidth > 0) || !(targetWidth > 0)) {
        shell.remove();
        continue;
      }
      const scale = Math.min(2.5, Math.max(0.4, targetWidth / naturalWidth));
      shell.style.setProperty('--tdom-math-scale', String(scale));
      shell.classList.add('ready');
      for (const node of group.nodes) node.style.opacity = '0';
      // Display math still has the previous exact SVG underneath this
      // provisional layer. Hide only the stale chunk window for the matched
      // TeX line, atomically after MathLive is ready, so old/new formulas do
      // not appear doubled. Multi-line chunks deliberately have no line id
      // and therefore retain the fail-closed exact display.
      for (const chunk of page.querySelectorAll('.chunkwin.stale')) {
        if (chunk.dataset.src === src && chunk.dataset.line === group.line) {
          chunk.style.opacity = '0';
        }
      }
    }
  }
}

function renderPage(dl, flash) {
  let div = pageDivs.get(dl.page);
  if (mode === 'opaque') {
    // Opaque pages are created exclusively from canonical metadata. A late
    // resident patch must not create an empty phantom shell or stale hit map.
    if (div) prepareOpaqueShell(div);
    return;
  }
  if (!div) {
    div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = dl.page;
    const no = document.createElement('span');
    no.className = 'pageno';
    no.textContent = `page ${dl.page}`;
    div.appendChild(no);
    const after = [...pageDivs.entries()].filter(([n]) => n > dl.page).sort((a, b) => a[0] - b[0])[0];
    pagesEl.insertBefore(div, after ? after[1] : null);
    pageDivs.set(dl.page, div);
  }
  // rebuild only the PROVISIONAL layers; the canonical overlay (img.canon)
  // survives provisional repaints untouched
  div.querySelector('svg')?.remove();
  div.querySelectorAll('.chunkwin').forEach((e) => e.remove());
  div.querySelectorAll('.tdom-provisional-math').forEach((e) => e.remove());
  div.dataset.prov = '1';

  // display lists carry glyph runs -> unified SVG plus absolutely-
  // positioned <img> overlays for exact-render block chunks
  div.insertAdjacentHTML('beforeend', svgFor(dl));
  for (const cmd of dl.commands) {
    if (cmd.op !== 'chunk') continue;
    const W = geometry.paperwidth;
    const H = geometry.paperheight;
    const shiftPct = (cmd.sy / cmd.w) * 100; // margin-top % is width-relative
    // st=1: a stale-exact chunk — the previous edit's TeX pixels, held
    // until the fresh render lands (~100–200ms). Old but clean beats fast
    // but wrong; the class is a hook for the inspector, not a visual.
    div.insertAdjacentHTML(
      'beforeend',
      `<div class="chunkwin${cmd.st ? ' stale' : ''}" data-src="${cmd.src}"${cmd.line == null ? '' : ` data-line="${escapeXml(String(cmd.line))}"`} style="left:${(cmd.x / W) * 100}%;top:${(cmd.y / H) * 100}%;width:${(cmd.w / W) * 100}%;height:${(cmd.h / H) * 100}%">` +
        `<img class="chunk" src="/chunk/${encodeURIComponent(cmd.chunk)}.svg?v=${cmd.cv ?? 0}" style="margin-top:-${shiftPct}%" draggable="false"></div>`
    );
  }
  scheduleProvisionalMath(div);

  if (flash) {
    div.classList.remove('fading');
    div.classList.add('patched');
    requestAnimationFrame(() => div.classList.add('fading'));
    setTimeout(() => div.classList.remove('patched', 'fading'), 1200);
  }
  if (liveSearch.query) scheduleLiveSearchRefresh();
  if (directEditor?.pageNumber === dl.page) requestAnimationFrame(repositionDirectEditor);
}

/** Unified SVG page: TeX-positioned glyph runs, rules, chunk images, folio. */
function svgFor(dl) {
  const parts = [
    `<svg viewBox="0 0 ${geometry.paperwidth} ${geometry.paperheight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
  ];
  for (const cmd of dl.commands) {
    const lineAttr = cmd.line == null ? '' : ` data-line="${escapeXml(String(cmd.line))}"`;
    if (cmd.op === 'glyphs') {
      let fontAttrs;
      if (cmd.fam) {
        // checkpoint backend: real TeX font, TeX positions; disable browser
        // shaping so run-start x + font advances reproduce TeX exactly
        fontAttrs = ` font-family="${escapeXml(cmd.fam)}" style="font-kerning:none;font-variant-ligatures:none;letter-spacing:0"`;
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
  for (const [n, div] of [...pageDivs.entries()]) {
    if (n >= from) {
      div.remove();
      pageDivs.delete(n);
    }
  }
}

function applyReport(report) {
  if (report.rev <= appliedRev) return;
  appliedRev = report.rev;
  appliedSrcRev = report.srcRev ?? appliedSrcRev;
  setMode(report.mode ?? 'structured', report.modeReasons ?? []);
  if (report.canonical) canonical = report.canonical;
  for (const patch of report.patches) {
    if (patch.type === 'replace-page') {
      const dl = patch.displayList;
      renderPage(dl, true);
      // this page now differs from the last canonical compile — provisional
      // owns it until a compile of srcRev >= this lands
      pageDirtyRev.set(dl.page, appliedSrcRev);
      updateCanonState(dl.page);
    } else if (patch.type === 'remove-pages') {
      lastRemoveRev = appliedSrcRev;
      if (mode !== 'opaque') removePagesFrom(patch.from);
    }
  }
  updateBadge();
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
  if (mode === 'opaque' && exactWidth > 0 && exactHeight > 0) {
    return { width: exactWidth, height: exactHeight, rotation: Number(exactPaper?.rotation) || 0 };
  }
  return {
    width: Number(geometry?.paperwidth) || exactWidth || 612,
    height: Number(geometry?.paperheight) || exactHeight || 792,
    rotation: Number(exactPaper?.rotation) || 0,
  };
}

function prepareOpaqueShell(div) {
  if (!div || mode !== 'opaque') return;
  div.querySelector('svg')?.remove();
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
  document.body.classList.toggle('is-opaque-document', mode === 'opaque');
  directEditClickEpoch++;
  directEditor?.element?.classList.toggle('is-opaque', mode === 'opaque');
  if (mode !== 'opaque' && directEditor?.control) directEditor.control.style.transform = '';
  if (mode === 'opaque') {
    // A structured editor is anchored to provisional SVG geometry. Once the
    // document demotes, that coordinate system no longer exists; retaining
    // its WYSIWYG/IME surface above an old canonical page would be a visible
    // mixed-generation UI. Input events are sent eagerly, so only the
    // transient surface is closed here.
    closeDirectEditor();
    // the provisional layers are dead weight now — every page is canonical
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

function directEditorRegionInSnapshot(snapshot, session) {
  if (!snapshot || !session) return null;
  const regions = (snapshot.blocks ?? []).flatMap((block) =>
    (block.editRegions ?? []).map((region) => ({ ...region, blockSource: block.source ?? null }))
  );
  const visible = String(session.readValue?.() ?? session.region?.value ?? '');
  const exact = regions.find((region) =>
    region.id === session.region?.id && String(region.value ?? '') === visible
  );
  if (exact) return exact;
  const sameKindAndFile = regions.filter((region) =>
    region.kind === session.kind && sameSourceFile(region.source?.file, session.region?.source?.file)
  );
  const sameValue = sameKindAndFile.filter((region) => String(region.value ?? '') === visible);
  const candidates = sameValue.length ? sameValue : sameKindAndFile.filter((region) =>
    String(region.value ?? '') === String(session.region?.value ?? '')
  );
  const oldLine = Number(session.region?.source?.start?.line);
  return candidates.sort((a, b) =>
    Math.abs(Number(a.source?.start?.line) - oldLine) -
    Math.abs(Number(b.source?.start?.line) - oldLine)
  )[0] ?? null;
}

async function stageDirectEditorForOpaqueBatch(batch) {
  const session = directEditor;
  if (!session || mode !== 'opaque') return { sessionId: null };
  const snapshot = await batch.snapshotReady;
  if (!snapshot || directEditor?.sessionId !== session.sessionId) return { sessionId: session.sessionId, mapping: null };
  const visible = String(session.readValue?.() ?? session.region?.value ?? '');
  let region = directEditorRegionInSnapshot(snapshot, session);
  const sentFromSrcRev = Number(session.sentFromSrcRev ?? session.presentedRev);
  if (!region && batch.rev <= sentFromSrcRev) {
    // The transparent control is ahead of the engine/host debounce. This
    // generation is already obsolete from the typist's point of view; keep
    // the old exact page and focused control until the matching source rev
    // produces its own canonical generation.
    return { sessionId: session.sessionId, localAhead: true, mapping: null };
  }
  if (!region) {
    // LaTeX escaping can split one visible text region into several source
    // regions (for example `a$b` -> `a`, `\$`, `b`). Once the canonical
    // revision is newer than the revision from which the edit was sent, the
    // visible value is authoritative for PDF geometry even if no single new
    // DOM region retains the old id.
    region = { ...session.region, value: visible };
  }
  const near = session.printBounds
    ? {
        page: session.pageNumber,
        x: (session.printBounds.left + session.printBounds.right) / 2,
        y: (session.printBounds.top + session.printBounds.bottom) / 2,
      }
    : { page: session.pageNumber };
  const value = visible;
  const bounds = session.kind === 'text'
    ? await canonicalTextBounds(value, null, near, batch.id)
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
  if (!key || mode !== 'opaque') return null;
  cancelObsoleteOpaqueBatches(key);
  let batch = opaqueCanonicalBatches.get(key);
  if (!batch) {
    const id = Number(generation.id);
    const rev = Number(generation.rev);
    batch = {
      key,
      id,
      rev,
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
    page.remove();
    pageDivs.delete(pageNumber);
  }
}

function applyStagedDirectEditor(stage, batch) {
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
  targetPage.appendChild(session.element);
  session.pageNumber = mapping.pageNumber;
  session.region = mapping.region;
  session.printBounds = mapping.bounds;
  session.presentedId = batch.id;
  session.presentedRev = batch.rev;
  session.canonicalAnchorPoint = mapping.canonicalAnchorPoint;
  session.anchor = null;
  session.anchorOffset = null;
  repositionDirectEditor();
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
  if (!batch || batch.committing || !batch.sealed || batch.snapshot === undefined ||
      batch.editorStage === undefined) return;
  if (opaqueCanonicalBatches.get(batch.key) !== batch || mode !== 'opaque' ||
      Number(canonical?.id) !== batch.id || Number(canonical?.rev) !== batch.rev ||
      batch.rev !== Number(appliedSrcRev) || !batch.snapshot) {
    return;
  }
  const currentEditorSessionId = directEditor?.sessionId ?? null;
  if ((batch.editorStage?.sessionId ?? null) !== currentEditorSessionId) {
    restageOpaqueBatchEditor(batch);
    return;
  }
  if (batch.editorStage?.localAhead &&
      directEditor?.sessionId === batch.editorStage.sessionId) return;
  if (batch.editorStage?.mapping &&
      directEditor?.sessionId === batch.editorStage.sessionId &&
      String(directEditor.readValue?.() ?? '') !== String(batch.editorStage.mapping.region?.value ?? '')) return;
  if (!ensureOpaqueBatchEditorTargetPage(batch)) return;
  for (const [pageNumber, entry] of [...batch.expected]) {
    if (!entry.page?.isConnected || entry.page.dataset.canonWanted !== entry.src) {
      batch.expected.delete(pageNumber);
      continue;
    }
    if (typeof entry.apply !== 'function') return;
  }
  batch.committing = true;
  opaqueCanonicalBatches.delete(batch.key);
  // All mutations below are synchronous. The browser cannot paint a frame
  // with page 1 from generation N+1 and page 2 from N, nor with an editor
  // candidate panel still anchored to the old generation.
  for (const [, entry] of [...batch.expected].sort((a, b) => a[0] - b[0])) {
    entry.apply();
  }
  applyStagedDirectEditor(batch.editorStage, batch);
  reconcileOpaquePageCount(batch.pageCount);
  directEditClickEpoch++;
  opaqueBatchCommitDepth++;
  try {
    for (const pageNumber of pageDivs.keys()) updateCanonState(pageNumber);
  } finally {
    opaqueBatchCommitDepth--;
  }
  updateBadge();
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
  const batch = mode === 'opaque' && opaqueBatchCommitDepth === 0
    ? getOpaqueCanonicalBatch(generation)
    : null;
  const batchRegistration = batch ? registerOpaqueCanonicalBatchPage(batch, div, src) : null;
  if (current?.dataset.src === src) {
    div.dataset.canonWanted = src;
    delete div.dataset.canonPending;
    delete div.dataset.canonRetries;
    const currentId = generation?.id ?? canonicalIdFromSrc(src);
    const currentRev = generation?.rev;
    if (mode === 'opaque' && currentId != null && currentRev != null) {
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
  if (!nearViewport && !observerReleased && canonicalStageObserver) {
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
  const requiresSnapshot = mode === 'opaque' &&
    Number.isFinite(presentationId) && Number.isFinite(presentationRev);
  const snapshotReady = requiresSnapshot
    ? ensurePresentedDomSnapshot(presentationId, presentationRev)
    : Promise.resolve(true);
  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    if (div.dataset.canonPending === src) delete div.dataset.canonPending;
    // Opaque mode deliberately retains the previous known-good exact page.
    // Structured mode can safely reveal its coherent provisional page.
    if (div.dataset.canonWanted === src && mode !== 'opaque') {
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
    if (batchRegistration) {
      readyOpaqueCanonicalBatchPage(batchRegistration, applyCandidate);
    } else {
      applyCandidate();
      directEditClickEpoch++;
      updateCanonState(Number(div.dataset.page));
      if (directEditor?.pageNumber === Number(div.dataset.page)) {
        void refreshDirectEditorExactBounds(Number(div.dataset.page));
      }
      updateBadge();
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
  if (mode === 'opaque') div.classList.add('awaiting-canonical');
  div.dataset.page = n;
  const exactPaper = canonical?.papers?.[n - 1] ?? canonical?.paper;
  const paper = mode === 'opaque' && exactPaper
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
    // dirty marks covered by this compile are settled: those pages are
    // exactly what LuaLaTeX printed for the current source
    for (const [n, rev] of [...pageDirtyRev]) {
      if (rev <= canonical.rev) pageDirtyRev.delete(n);
    }
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
    // canonical-only shells beyond the new page count disappear
    for (const [n, div] of [...pageDivs]) {
      if (mode !== 'opaque' && n > canonical.pageCount && div.dataset.prov !== '1') {
        div.remove();
        pageDivs.delete(n);
      }
    }
    if (mode === 'opaque') {
      if (canonical.rev >= appliedSrcRev) {
        opaqueBatch = getOpaqueCanonicalBatch({
          id: canonical.id,
          rev: canonical.rev,
          pageCount: canonical.pageCount,
        });
      }
      for (const div of pageDivs.values()) prepareOpaqueShell(div);
    }
  }
  for (const n of pageDivs.keys()) updateCanonState(n);
  if (opaqueBatch && opaqueBatch.expected.size === 0 && canonical.pageCount > 0) {
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
  const div = pageDivs.get(n);
  if (!div) return;
  const canonAvail = canonical && canonical.id && n <= canonical.pageCount;
  const coldFresh = canonAvail && (pageDirtyRev.get(n) ?? 0) <= canonical.rev;
  const ship = shipPages.get(n);
  const shipOk = !!ship && (pageDirtyRev.get(n) ?? 0) <= ship.srcRev;
  // prefer the freshest real-pixels source for THIS page
  const useShip = mode !== 'opaque' && shipOk && (!coldFresh || ship.srcRev > canonical.rev);
  const fresh = coldFresh || useShip;
  let img = div.querySelector('img.canon');
  const stageCanonical = canonAvail && (mode !== 'opaque' || canonical.rev >= appliedSrcRev);
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
        ? { id: null, rev: ship.srcRev, pageCount: canonical?.pageCount }
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
  const state = mode === 'opaque'
    ? (img ? 'final' : 'provisional')
    : (fresh && targetPresented ? 'final' : 'provisional');
  if (img) img.style.clipPath = '';
  div.classList.toggle('is-final', state === 'final');
  div.classList.remove('is-partial');
  // a fully-fresh canonical is the page-count authority: provisional-only
  // pages beyond it are phantoms of the JS pagination and are hidden
  const phantom = mode !== 'opaque' &&
    canonical &&
    canonical.id &&
    canonical.rev >= appliedSrcRev &&
    pageDirtyRev.size === 0 &&
    n > canonical.pageCount;
  div.classList.toggle('phantom', !!phantom);
}

function updateBadge() {
  if (!docStateEl) return;
  const err = canonical?.error;
  const parts = [];
  let cls = 'state-preview';
  let text;
  if (mode === 'opaque') {
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
    const t0 = performance.now();
    inFlight = true;
    noteEditStart(); // status pill: computing, instantly
    try {
      const res = await fetch('/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // rev: optimistic-concurrency token — the server 409s instead of
        // silently applying our offsets to a source that moved under us
        body: JSON.stringify({ ...d, rev: appliedSrcRev }),
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
      const rtt = performance.now() - t0;
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

// Preview interaction: Cmd/Ctrl+click mirrors the static PDF viewer's
// SyncTeX gesture.  In embedded mode the real editor owns navigation; the
// standalone TDOM workbench keeps Alt+click for its internal textarea.
pagesEl.addEventListener('click', async (ev) => {
  if (embeddedHost ? !(ev.metaKey || ev.ctrlKey) : !ev.altKey) return;
  if (ev.target?.closest?.('.tdom-direct-editor')) return;
  const clickEpoch = ++directEditClickEpoch;
  const clickedPage = pageAtClientPoint(ev, ev.target);
  const presented = mode === 'opaque' ? presentedPageState(clickedPage) : null;
  if (mode === 'opaque' && !presented) return;
  const stillCurrent = () => {
    if (clickEpoch !== directEditClickEpoch || !clickedPage?.isConnected) return false;
    if (mode !== 'opaque') return true;
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
  return Number(control.lastOffset) || 0;
}

function loadMathWysiwyg() {
  if (!mathWysiwygModulePromise) {
    mathWysiwygModulePromise = import('/host/web/math/wysiwyg/math-wysiwyg.js');
  }
  return mathWysiwygModulePromise;
}

async function editRegionById(id) {
  if (!editDomCache || editDomCache.rev !== appliedRev) {
    editDomCache = await fetch('/dom', { cache: 'no-store' }).then((r) => r.json());
  }
  for (const block of editDomCache.blocks ?? []) {
    const region = (block.editRegions ?? []).find((item) => item.id === id);
    if (region) return { ...region, blockSource: block.source ?? null };
  }
  return null;
}

async function editBlockBySourceId(id) {
  if (!editDomCache || editDomCache.rev !== appliedRev) {
    editDomCache = await fetch('/dom', { cache: 'no-store' }).then((r) => r.json());
  }
  return (editDomCache.blocks ?? []).find((block) => block.id === id) ?? null;
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
    candidates = all;
    if (!candidates.length) return null;
    canonicalRegionBoundsCache.set(key, candidates);
    while (canonicalRegionBoundsCache.size > 512) {
      canonicalRegionBoundsCache.delete(canonicalRegionBoundsCache.keys().next().value);
    }
  } catch {
    return null;
  }
  return window.TdomOpaqueEditorCoordinator?.selectSourceBounds?.({
    results: candidates,
    pageNumber,
    near,
  }) ?? null;
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

async function canonicalTextBounds(value, pageNumber = null, near = null, requestedId = canonical?.id) {
  const wanted = printedKey(value);
  if (!wanted) return null;
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
  if (!session || mode !== 'opaque' || session.pageNumber !== pageNumber) return;
  const page = pageDivs.get(pageNumber);
  const presented = presentedPageState(page);
  if (!presented) return;
  let bounds = null;
  if (session.kind === 'text') {
    const value = session.readValue?.() ?? session.region.value;
    const near = session.printBounds
      ? {
          x: (session.printBounds.left + session.printBounds.right) / 2,
          y: (session.printBounds.top + session.printBounds.bottom) / 2,
        }
      : null;
    bounds = await canonicalTextBounds(value, pageNumber, near, presented.id);
  } else {
    bounds = await canonicalSourceBounds(session.region, pageNumber, presented.id, session.printBounds ? {
      page: pageNumber,
      x: (session.printBounds.left + session.printBounds.right) / 2,
      y: (session.printBounds.top + session.printBounds.bottom) / 2,
    } : null);
  }
  if (directEditor?.sessionId !== session.sessionId) return;
  if (bounds) {
    session.printBounds = bounds;
    session.presentedId = presented.id;
    session.presentedRev = presented.rev;
  }
  requestAnimationFrame(repositionDirectEditor);
}

async function syncLocationForClick(event, page) {
  const presented = mode === 'opaque' ? presentedPageState(page) : null;
  const mappingId = presented?.id ?? canonical?.id;
  if (!mappingId || (mode !== 'opaque' && canonical.rev !== appliedSrcRev)) return null;
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

async function resolveOpaqueEditRegion(page, event) {
  if (mode !== 'opaque') return null;
  if (!page) page = pageAtClientPoint(event);
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
    return printedCandidates.sort((a, b) =>
      (a.printBounds.right - a.printBounds.left) * (a.printBounds.bottom - a.printBounds.top) -
      (b.printBounds.right - b.printBounds.left) * (b.printBounds.bottom - b.printBounds.top)
    )[0];
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
    return spatialMath[0];
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
    return {
      region,
      printBounds,
      caretOffset: caretOffsetForOpaqueRegion(region, location, clickedWord, printBounds, point),
    };
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
  const block = await editBlockBySourceId(src);
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

function alignOpaqueNativeCaretAnchor(expectedSessionId = directEditor?.sessionId) {
  const session = directEditor;
  if (!session || session.sessionId !== expectedSessionId) return;
  const control = session.control;
  if (!control?.isContentEditable) return;
  // Always measure in untransformed browser layout coordinates. The control
  // is transparent in opaque mode, so translating it cannot alter the
  // canonical page and leaves the shell-owned candidate panel in place.
  // Keep the transform composition-only because it also moves the control's
  // pointer hitbox; ordinary re-clicks must retain the shell's exact bounds.
  control.style.transform = '';
  session.nativeCaretAnchor = null;
  if (mode !== 'opaque' || session.imeComposing !== true ||
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
  if (mode !== 'opaque' || !session.canonicalAnchorPoint) {
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
  if (!directEditor?.element?.isConnected) return;
  if (directEditor.control?.isContentEditable) {
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
  positionOpaqueSuggestionPanel(page, pageRect);
  alignOpaqueNativeCaretAnchor();
}

function closeDirectEditor() {
  if (!directEditor) return;
  directEditor.wysiwyg?.detach?.();
  directEditor.wysiwyg?.close?.();
  directEditor.element.remove();
  directEditor = null;
  for (const batch of opaqueCanonicalBatches.values()) {
    restageOpaqueBatchEditor(batch);
  }
}

function sendDirectEdit(region, sessionId, visibleValue, { cancel = false, finish = false } = {}) {
  const sessionState = directEditor?.sessionId === sessionId ? directEditor : null;
  if ((cancel || finish) && sessionState && !sessionState.sentEdit) return;
  if (!cancel && !finish && sessionState?.lastVisibleValue === visibleValue) return;
  const replacement = region.kind === 'math'
    ? preserveMathAuxCommands(region.value, visibleValue)
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
    value: visibleValue,
    replacement,
    cancel,
    finish,
    sourceRev: sessionState?.presentedRev ?? appliedSrcRev,
  };
  if (sessionState && !cancel && !finish) {
    sessionState.sentEdit = true;
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
  const page = target.closest('#pages > .page');
  const pageNumber = Number(page?.dataset?.page);
  if (!page || !Number.isFinite(pageNumber)) return;
  const presented = mode === 'opaque' ? presentedPageState(page) : null;
  if (mode === 'opaque' && !presented) return;
  const region = knownRegion ?? await editRegionById(id);
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

  const shell = document.createElement('div');
  shell.className = `tdom-direct-editor is-${region.kind}`;
  shell.classList.toggle('is-opaque', mode === 'opaque');
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
    control.addEventListener('focus', () => {
      try { window.mathVirtualKeyboard?.hide?.(); } catch { /* no global keyboard */ }
    });
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

  const readValue = () => {
    let value;
    if (typeof control.getValue === 'function') {
      try { value = String(control.getValue('latex')); } catch { /* fallback below */ }
    }
    if (value == null) value = String(control.value ?? control.textContent ?? '');
    if (region.kind === 'math' && mathWrapped) {
      const result = unwrapAligned(value);
      if (result.unwrapped) return result.value;
      mathWrapped = false;
    }
    return value;
  };
  const resizeText = () => {
    if (!control.isContentEditable) return;
    control.style.minHeight = `${Math.max(1, control.scrollHeight)}px`;
  };
  let composing = false;
  const realignOpaqueCaret = () => alignOpaqueNativeCaretAnchor(sessionId);
  control.addEventListener('compositionstart', () => {
    composing = true;
    if (directEditor?.sessionId === sessionId) directEditor.imeComposing = true;
    realignOpaqueCaret();
  });
  control.addEventListener('compositionupdate', realignOpaqueCaret);
  control.addEventListener('compositionend', () => {
    composing = false;
    resizeText();
    sendDirectEdit(region, sessionId, readValue());
    if (directEditor?.sessionId === sessionId) directEditor.imeComposing = false;
    realignOpaqueCaret();
  });
  control.addEventListener('input', () => {
    resizeText();
    realignOpaqueCaret();
    if (mode === 'opaque' && region.kind === 'math') {
      requestAnimationFrame(repositionDirectEditor);
    }
    // Native IME composition can emit several transient input values.
    // Keep those local to the overlay and submit only the committed text.
    if (composing) return;
    sendDirectEdit(region, sessionId, readValue());
  });
  control.addEventListener('keydown', (event) => {
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
        sendDirectEdit(region, sessionId, readValue(), { finish: true });
        closeDirectEditor();
      }
    }, 0);
  });
  shell.appendChild(control);
  page.appendChild(shell);
  if (control.tagName === 'MATH-FIELD') {
    try { control.menuItems = []; } catch { /* field remains keyboard-editable */ }
  }
  const Coordinator = window.TdomOpaqueEditorCoordinator;
  const clickOnPaper = mode === 'opaque' && clickPoint
    ? paperPointForClick({ clientX: clickPoint.x, clientY: clickPoint.y }, page)
    : null;
  const caretAnchorRatio = Coordinator?.caretAnchorRatio?.(printBounds, clickOnPaper) ?? null;
  directEditor = {
    id,
    region,
    sessionId,
    element: shell,
    control,
    pageNumber,
    kind: region.kind,
    standalone: null,
    wysiwyg: null,
    anchor: target,
    anchorMeta: {
      src: srcOf(target),
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
    presentedRev: presented?.rev ?? appliedSrcRev,
    readValue,
    sentEdit: false,
    lastVisibleValue: region.value,
    sentFromSrcRev: Number(presented?.rev ?? appliedSrcRev),
  };
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
  requestAnimationFrame(() => {
    const scrollTop = pagesEl.scrollTop;
    const scrollLeft = pagesEl.scrollLeft;
    try { control.focus({ preventScroll: true }); } catch { control.focus(); }
    if (control.isContentEditable) {
      const selection = window.getSelection();
      let range = null;
      if (mode === 'opaque') {
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
    } else if (mode === 'opaque') {
      if (Number.isInteger(caretOffset) && typeof control.getPromptRange === 'function') {
        const offset = mathModelOffsetFromSource(control, region.value, caretOffset, mathWrapped);
        if (Number.isFinite(offset) && offset >= 0) control.position = offset;
      } else if (Number.isFinite(Number(control.lastOffset))) {
        // No PDF/source mapping is safer than asking MathLive to interpret a
        // browser-space point over a LuaLaTeX page. Keep a valid, predictable
        // model boundary until an exact mapping is available.
        control.position = Number(control.lastOffset);
      }
    } else if (clickPoint && typeof control.getOffsetFromPoint === 'function') {
      const offset = control.getOffsetFromPoint(clickPoint.x, clickPoint.y);
      if (Number.isFinite(offset) && offset >= 0) control.position = offset;
    } else if (control instanceof HTMLTextAreaElement) {
      control.setSelectionRange(control.value.length, control.value.length);
    }
    alignOpaqueNativeCaretAnchor(sessionId);
    // Adding a DOM/MathLive selection can scroll after focus even when
    // preventScroll is honored. A preview click must never move the paper.
    pagesEl.scrollTop = scrollTop;
    pagesEl.scrollLeft = scrollLeft;
    requestAnimationFrame(() => {
      if (directEditor?.sessionId === sessionId) {
        pagesEl.scrollTop = scrollTop;
        pagesEl.scrollLeft = scrollLeft;
      }
    });
  });
}

// A plain click edits; Cmd/Ctrl+click remains source navigation.  Only the
// printed node under the pointer activates, so scrolling/searching elsewhere
// on the page never creates editor DOM.
pagesEl.addEventListener('click', async (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target?.closest?.('.tdom-direct-editor')) return;
  const clickEpoch = ++directEditClickEpoch;
  const target = event.target?.closest?.('[data-edit], .tdom-source-hit, [data-src]') ??
    (mode === 'opaque' ? pageAtClientPoint(event, event.target) : null);
  if (!target) return;
  const targetPage = pageAtClientPoint(event, target);
  const presented = mode === 'opaque' ? presentedPageState(targetPage) : null;
  if (mode === 'opaque' && !presented) return;
  const stillCurrent = () => {
    if (clickEpoch !== directEditClickEpoch || !targetPage?.isConnected) return false;
    if (mode !== 'opaque') return true;
    const current = presentedPageState(targetPage);
    return current?.id === presented.id && current?.rev === presented.rev && current?.src === presented.src;
  };
  event.preventDefault();
  event.stopPropagation();
  const clickPoint = { x: event.clientX, y: event.clientY };
  const id = target.dataset.edit;
  if (id) {
    const region = await editRegionById(id);
    if (region && stillCurrent()) {
      await openDirectEditor(id, target, region, clickPoint);
    }
    return;
  }
  if (mode === 'opaque') {
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
    await openDirectEditor(region.id, target, region, clickPoint);
  }
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

function setZoom(z) {
  zoom = Math.min(3, Math.max(0.4, Math.round(z * 100) / 100));
  pagesEl.style.setProperty('--zoom', zoom);
  document.getElementById('zoom-level').textContent = Math.round(zoom * 100) + '%';
  localStorage.setItem('tdom-zoom', String(zoom));
  if (directEditor) requestAnimationFrame(repositionDirectEditor);
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
    setZoom(zoom * factor);
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
  if (directEditor) requestAnimationFrame(repositionDirectEditor);
});
pagesEl.addEventListener('scroll', () => {
  if (directEditor) requestAnimationFrame(repositionDirectEditor);
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
    const previewReady = () => {
      if (!bootComplete || !documentReset.acceptsReady(documentReset.adoptedEpoch)) return false;
      const entries = sortedPages();
      if (!entries.length) return false;
      const viewport = pagesEl.getBoundingClientRect();
      const exposed = entries.filter(([, page]) => {
        const rect = page.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      const required = exposed.length ? exposed : [entries[0]];
      if (mode === 'opaque') {
        if (!canonical?.id || canonical.inFlight || canonical.error || canonical.rev < appliedSrcRev) {
          return false;
        }
        return required.every(([, page]) => {
          const state = presentedPageState(page);
          return Boolean(
            state && state.id === Number(canonical.id) && state.rev === Number(appliedSrcRev) &&
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
    let embedSnapshotRaf = null;
    const postEmbedSnapshot = () => {
      try {
        window.parent.postMessage(
          {
            source: 'tdom-embed',
            activationId: embedActivationId,
            documentEpoch: documentReset.adoptedEpoch,
            ready: previewReady(),
            pageCount: sortedPages().length,
            zoom,
            page: currentTopPage(),
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
    const msg = JSON.parse(ev.data);
    stateEventEpoch++;
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
    if (msg.kind === 'canonical') {
      // a real-lualatex compile landed: converge every covered page to it
      canonical = msg.canonical;
      if (msg.mode) setMode(msg.mode, msg.canonical?.modeReasons ?? modeReasons);
      syncCanonical();
      return;
    }
    if (msg.kind === 'ship') {
      // one page's real pixels landed from the incremental authority
      shipPages.set(msg.page, { gen: msg.gen, srcRev: msg.srcRev });
      if (pageDivs.has(msg.page)) updateCanonState(msg.page);
      return;
    }
    if (msg.kind === 'patches') {
      // async arrivals (TikZ exact renders, background chain discoveries):
      // the SOURCE is unchanged, so canonical stays authoritative — no
      // dirty marks, but re-evaluate each repainted page's overlay state
      if (msg.rev > appliedRev) {
        appliedRev = msg.rev;
        if (mode === 'opaque') return;
        for (const patch of msg.patches) {
          if (patch.type === 'replace-page') {
            const dl = patch.displayList;
            renderPage(dl, true);
            updateCanonState(dl.page);
          } else if (patch.type === 'remove-pages') {
            removePagesFrom(patch.from);
          }
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
};

// collapsible inspector (preference persists)
function setInspector(hidden) {
  document.body.classList.toggle('no-inspector', hidden);
  localStorage.setItem('tdom-inspector', hidden ? 'hidden' : 'shown');
}
document.getElementById('insp-toggle').addEventListener('click', () => setInspector(true));
document.getElementById('insp-reopen').addEventListener('click', () => setInspector(false));
setInspector(localStorage.getItem('tdom-inspector') === 'hidden');

boot();

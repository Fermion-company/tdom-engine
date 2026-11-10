import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
const span = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start) + start.length));
const transactions = [
  span('function currentCanonicalPageCount', 'function srcOf'),
  span('function stageProvisionalPatches', 'function directPresentationBlocked'),
  span('function tryCommitProvisionalStages', 'let lastCanonicalDisplayDemand'),
  span('function removePagesFrom', 'function applyReport'),
  span('function reconcilePageCount', 'function moveDirectEditorToPage'),
  span('function tryCommitOpaqueCanonicalBatch', 'function cancelShipWaveBatch'),
  span('function usesCanonicalSurface', 'function createCanonicalImage'),
  span('const presentationPending = (required)', 'let embedSnapshotRaf'),
  'this.presentationPending = presentationPending;',
].join('\n');

export const pageList = (page, commands = [{ op: 'glyphs', src: `b${page}`, text: `page ${page}` }]) => ({ page, commands });

// Run the actual viewer transactions; only DOM shells and image/font decoding
// are faked. In particular canonical clears stages just as the app does.
export function provisionalViewer(pages, canonicalCount = pages.length) {
  const state = {
    mode: 'structured', previewPolicy: 'structured', appliedSrcRev: 1,
    provisionalStages: new Map(), provisionalRemovedPages: new Set(),
    provisionalDisplayLists: new Map(pages.map(dl => [dl.page, dl])),
    provisionalPendingLayout: new Set(pages.filter(dl => dl.commands.some(c => c.op === 'pending-exact' && c.wholePage)).map(dl => dl.page)),
    committedPageSrcs: new Map(), pageDivs: new Map(), pageDirtyRev: new Map(), pageEditGroup: new Map(),
    editGroupSeq: 0, lastRemoveRev: 0, directEditClickEpoch: 0, opaqueBatchCommitDepth: 0,
    opaqueCanonicalBatches: new Map(), shipPages: new Map(), canonicalStageObserver: null,
    documentReset: { pending: false, adoptedEpoch: 1 }, committedCanonicalGeneration: null,
    directEditor: null, residentPageCountAuthoritative: false, liveSearch: { query: '' },
    deferredDirectPresentationEvents: [], canonicalAnchorPreview: null, canonicalAnchorPendingPatch: null,
    directPresentationBlocked: () => false, ensureOpaqueBatchEditorTargetPage: () => true,
    captureDirectEditorPageScroll() {}, applyStagedDirectEditor() {}, scheduleViewportWarm() {},
    updateCanonState() {}, fulfillCanonicalDisplay() {}, updateBadge() {}, traceStage() {},
    demands: [], requestCanonicalDisplay(options) { state.demands.push(options); },
    queueMicrotask: fn => fn(),
    ensureShell(n) {
      if (!state.pageDivs.has(n)) state.pageDivs.set(n, {
        dataset: { page: String(n) }, isConnected: true, paper: null,
        classList: { contains: name => name === 'is-final' && state.pageDivs.get(n).dataset.prov !== '1', remove() {} },
        querySelector(selector) {
          if (selector === 'img.canon') return { complete: true, naturalWidth: 600,
            dataset: { src: this.dataset.canonPresentedSrc } };
          return null;
        },
        querySelectorAll: () => [],
        append(...nodes) { this.paper = nodes; }, remove() { this.isConnected = false; },
      });
      return state.pageDivs.get(n);
    },
    renderPage(dl) {
      const ready = !dl.commands.some(c => c.op === 'pending-exact' || c.op === 'canon' ||
        c.op === 'chunk' && c.st || c.op === 'glyphs' && c.math);
      state.provisionalStages.set(dl.page, {
        dl, ready, sourceRev: state.appliedSrcRev, documentEpoch: 1,
        snapshot: { srcRev: state.appliedSrcRev, documentEpoch: 1 }, staging: { childNodes: [dl] },
      });
    },
  };
  vm.createContext(state);
  vm.runInContext(transactions, state);
  state.commitCanonical = (pageCount, rev = state.appliedSrcRev) => {
    state.canonical = { id: rev, rev, pageCount };
    const batch = { key: String(rev), id: rev, rev, documentEpoch: 1, pageCount,
      sealed: true, snapshot: {}, editorStage: {}, expected: new Map() };
    for (let n = 1; n <= pageCount; n++) {
      const page = state.ensureShell(n);
      const src = `/canonical/${n}.svg?c=${rev}`;
      page.dataset.canonWanted = src;
      batch.expected.set(n, { page, src, apply() {
        page.paper = `canonical:${rev}:${n}`;
        page.dataset.canonPresentedRev = String(rev);
        page.dataset.canonPresentedSrc = src;
      } });
    }
    state.opaqueCanonicalBatches.set(batch.key, batch);
    state.tryCommitOpaqueCanonicalBatch(batch);
  };
  state.commitCanonical(canonicalCount);
  state.appliedSrcRev++;
  return state;
}

// The embed Jump code runs against the same presentation shells as the
// transaction harness. Only browser layout, network and time are supplied.
export function jumpViewer({ fetch, pages = 2 } = {}) {
  const state = provisionalViewer(Array.from({ length: pages }, (_, n) => pageList(n + 1)));
  const listeners = new Map(), timers = new Map();
  let timerId = 0;
  Object.assign(state, {
    fetch, CSS: { escape: String }, embedViewportToken: null, dismissSyncMarker() {},
    sameSourceFile: (a, b) => a === b, scheduleEmbedSnapshot() {},
    requestAnimationFrame(fn) { fn(); },
    canonicalIdFromSrc: src => Number(/\?c=(\d+)/.exec(src)?.[1]),
    presentedShippingPageState: page => page?.dataset.canonPresentedSrc?.startsWith('/ship/'),
    activePaperGeometry: () => ({ width: 600, height: 800 }),
    sortedPages: () => [...state.pageDivs].sort((a, b) => a[0] - b[0]),
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: {
      addEventListener() {},
      querySelectorAll: () => [...state.pageDivs.values()].flatMap(page => page.markers),
      createElement: () => ({ dataset: {}, style: {}, remove() { this.parent.markers = this.parent.markers.filter(m => m !== this); } }),
    },
    window: { addEventListener() {} },
    pagesEl: {
      scrollTop: 0, clientHeight: 500,
      getBoundingClientRect: () => ({ top: 0, width: 600, height: 500 }),
      scrollTo({ top }) { this.scrollTop = top; },
      addEventListener(type, fn) { listeners.set(type, fn); },
    },
  });
  for (const [number, page] of state.pageDivs) {
    page.markers = []; page.clientWidth = 600;
    page.getBoundingClientRect = () => ({ top: (number - 1) * 820 - state.pagesEl.scrollTop, left: 0, width: 600, height: 800 });
    page.appendChild = marker => { marker.parent = page; page.markers.push(marker); };
  }
  vm.runInContext(span('    const pageEntryFor =', "    window.addEventListener('message',") +
    '\nthis.jump = scrollToSync; this.refine = refineSyncToSource;', state);
  state.flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
  state.tick = async () => {
    for (const [id, timer] of [...timers]) if (timer.ms === 250) { timers.delete(id); timer.fn(); }
    await state.flush();
  };
  state.dispatch = type => listeners.get(type)?.();
  state.markers = () => [...state.pageDivs.values()].flatMap(page => page.markers);
  return state;
}

// Swapping a host viewer's page area for the live engine, without ever
// showing the user a blank or a stale frame.
//
// The host keeps its own chrome (toolbar, sidebar, status) and its own
// already-rendered static PDF. Only the page area is covered by the engine's
// `?embed=1` iframe. The hard part is the moment of the swap: an iframe that
// has just been navigated, or has just discarded its document for a reset,
// has nothing to show, and revealing it one frame too early is a visible
// flash of blank or of the previous document.
//
// The discipline that avoids it:
//
//   1. The iframe paints CONTINUOUSLY, below an opaque static cover. It is
//      never `visibility: hidden` — Chromium may skip rasterizing a hidden
//      cross-origin iframe and then expose its blank backing store for one
//      frame when it becomes visible. Activation changes stacking order only.
//   2. The child declares `ready: true` for a specific `documentEpoch`. That
//      is a claim about its own paint, not about the compositor.
//   3. The host then waits two animation frames. The first lets the ready
//      child paint while still covered; the second contains nothing but the
//      stacking-order change, so no commit can ever hold the iframe's old or
//      blank backing store.
//   4. A document reset runs the same barrier in reverse: the host puts the
//      static cover back, forces the new stacking order to resolve, and only
//      then acknowledges the reset so the child may discard its old DOM.
//
// Everything else here exists to make sure those steps apply to the right
// document: activations, epochs and reveal tokens are all versioned, and a
// message that fails any check is dropped rather than acted on.

import { createEmbedClient, embedUrl } from './embed-client.js';
import { resolveLiveStatus } from './live-status.js';
import { normalizeLiveToolbarSnapshot, stepLiveToolbarPage } from './live-toolbar-state.js';

const noop = () => {};

export const LIVE_PHASES = ['off', 'activation-pending', 'reset-pending', 'staging', 'active'];

export function createLiveSurface({
  frame,
  hostWindow = globalThis,
  raf,
  now = Date.now,
  getTheme = () => 'dark',
  getBackground = () => null,
  // Forcing style resolution before acknowledging a reset guarantees the new
  // stacking order exists before the child is allowed to throw its document
  // away. Reading a computed value is the portable way to do it.
  forceStyleFlush,
  onPhase = noop,
  onToolbar = noop,
  onStatus = noop,
  onSurfaceReady = noop,
  onErrorSurfaceReady = noop,
  onSource = noop,
  onEdit = noop,
  onStaticRestore = noop,
} = {}) {
  const requestFrame =
    raf ||
    (typeof hostWindow.requestAnimationFrame === 'function'
      ? hostWindow.requestAnimationFrame.bind(hostWindow)
      : (callback) => setTimeout(() => callback(0), 0));
  const flushStyle =
    forceStyleFlush ||
    (() => {
      try {
        hostWindow.getComputedStyle?.(frame)?.zIndex;
      } catch {
        /* no layout engine (tests, headless hosts) */
      }
    });

  let phase = 'off';
  let activation = null;
  let client = null;
  let toolbar = normalizeLiveToolbarSnapshot();
  let activationSequence = 0;
  let revealSequence = 0;
  let errorSurfaceSequence = 0;
  let pendingErrorSurface = null;
  let pendingSync = null;
  let surfaceOwned = false;
  let deferredStatic = null;
  let deferredStaticFlushToken = 0;

  const isLive = () => phase === 'active';
  const isPending = () =>
    phase === 'activation-pending' || phase === 'reset-pending' || phase === 'staging';
  const hasSession = () => isLive() || isPending();

  const setPhase = (next, info) => {
    phase = next;
    if (frame) {
      if (next === 'off') delete frame.dataset?.livePhase;
      else if (frame.dataset) frame.dataset.livePhase = next;
      frame.setAttribute?.('aria-hidden', next === 'active' ? 'false' : 'true');
    }
    onPhase(next, info);
  };

  const emitToolbar = () => onToolbar({ ...toolbar });
  const emitStatus = (data) => {
    const search = data?.search;
    if (search?.query) {
      onStatus({
        key: 'liveSearch',
        tone: 'idle',
        detail: search.query,
        search: { query: search.query, current: Number(search.current) || 0, total: Number(search.total) || 0 },
      });
      return;
    }
    const view = resolveLiveStatus(data?.status);
    if (view) onStatus(view);
  };

  const cancelReveal = () => {
    revealSequence += 1;
    if (activation) activation.reveal = null;
  };
  const cancelErrorSurface = () => {
    errorSurfaceSequence += 1;
    pendingErrorSurface = null;
  };

  const post = (action, extra) => {
    if (!client) return false;
    return client.post(action, extra);
  };

  const applySync = (payload) => {
    if (!payload || !hasSession()) return false;
    toolbar = normalizeLiveToolbarSnapshot(toolbar, { page: Number(payload.page) });
    // The sync arrived while the next document is still staging. Replaying it
    // after the reveal is correct; sending it now would scroll a frame the
    // user cannot see.
    if (!isLive()) {
      pendingSync = payload;
      return true;
    }
    pendingSync = null;
    emitToolbar();
    post('goto-sync', payload);
    return true;
  };

  const deactivate = () => {
    // Advancing the sequence also invalidates a delayed ready message from a
    // frame that is about to be navigated to about:blank.
    activationSequence += 1;
    cancelReveal();
    activation = null;
    surfaceOwned = false;
    client?.dispose();
    client = null;
    if (frame) frame.src = 'about:blank';
    toolbar = normalizeLiveToolbarSnapshot();
    const deferredSync = pendingSync;
    pendingSync = null;
    setPhase('off', { deferredSync });
    emitToolbar();
    onStatus({ key: 'ready', tone: 'idle', detail: '' });

    if (deferredStatic) scheduleStaticRestore();
  };

  // Give the retained static document one committed frame after the live
  // cover is removed, so the host never repaints the page area in the same
  // frame that the iframe leaves it. The request stays in `deferredStatic`
  // until it is actually handed over: a live activation that lands inside
  // that frame must keep it deferred, not drop it.
  const scheduleStaticRestore = () => {
    const flushToken = ++deferredStaticFlushToken;
    requestFrame(() => {
      if (flushToken !== deferredStaticFlushToken) return;
      if (surfaceOwned) return;
      const pending = deferredStatic;
      if (!pending) return;
      deferredStatic = null;
      onStaticRestore(pending);
    });
  };

  const activate = (data) => {
    if (!frame || !activation || !isPending()) return false;
    if (data?.ready !== true || data.activationId !== activation.id) {
      if (activation.reveal) cancelReveal();
      return false;
    }
    const documentEpoch = Number(data.documentEpoch);
    if (!Number.isInteger(documentEpoch)) return false;
    // A reset is waiting for one specific epoch; anything else is the old
    // document still talking.
    if (
      Number.isInteger(activation.pendingDocumentEpoch) &&
      documentEpoch !== activation.pendingDocumentEpoch
    ) {
      return false;
    }
    if (Number.isInteger(activation.documentEpoch) && documentEpoch < activation.documentEpoch) {
      return false;
    }
    if (activation.reveal?.documentEpoch === documentEpoch) {
      // The child sends periodic snapshots. Keep the newest toolbar/status
      // payload without postponing an already scheduled paint barrier.
      activation.reveal.data = data;
      return true;
    }

    const current = activation;
    const revealToken = ++revealSequence;
    current.reveal = { token: revealToken, documentEpoch, data };
    setPhase('staging');
    requestFrame(() => {
      requestFrame(() => {
        const reveal = current.reveal;
        if (!reveal || reveal.token !== revealToken || revealSequence !== revealToken) return;
        if (activation !== current || !isPending()) return;
        if (current.id !== data.activationId || reveal.documentEpoch !== documentEpoch) return;
        if (
          Number.isInteger(current.pendingDocumentEpoch) &&
          documentEpoch !== current.pendingDocumentEpoch
        ) {
          return;
        }
        const latestData = reveal.data;
        if (latestData?.ready !== true || Number(latestData.documentEpoch) !== documentEpoch) return;

        current.reveal = null;
        current.documentEpoch = documentEpoch;
        current.pendingDocumentEpoch = null;
        // One task, one commit: the already-painted iframe replaces the
        // opaque static cover on this compositor frame.
        setPhase('active');
        emitToolbar();
        onStatus({ key: 'live', tone: 'idle', detail: '' });
        emitStatus(latestData);
        if (pendingSync) applySync(pendingSync);
        onSurfaceReady({
          activationId: current.id,
          url: current.url,
          generation: current.generation,
          documentEpoch,
        });
      });
    });
    return true;
  };

  const holdStaticForDocumentReset = (data) => {
    if (!frame || !activation) return false;
    const documentEpoch = Number(data?.documentEpoch);
    if (!Number.isInteger(documentEpoch)) return false;
    const adoptedEpoch = Number(activation.documentEpoch);
    const pendingEpoch = Number(activation.pendingDocumentEpoch);
    if (Number.isInteger(adoptedEpoch) && documentEpoch <= adoptedEpoch) return false;
    if (Number.isInteger(pendingEpoch) && documentEpoch < pendingEpoch) return false;

    cancelReveal();
    activation.pendingDocumentEpoch = documentEpoch;
    toolbar = normalizeLiveToolbarSnapshot();
    setPhase('reset-pending');
    emitToolbar();
    onStatus({ key: 'liveUpdating', tone: 'busy', detail: '' });
    // Resolve the new stacking order before allowing the child to discard its
    // old document DOM. The iframe stays paintable below the static cover.
    flushStyle();
    post('reset-ack', { documentEpoch });
    return true;
  };

  const handleFrameMessage = (data) => {
    if (!hasSession() || !activation) return;
    if (data.activationId !== activation.id) return;
    if (data.action === 'reset-pending') {
      holdStaticForDocumentReset(data);
      return;
    }
    // Snapshots may arrive while the frame is still preloading. Keep them
    // offscreen until this same activation declares its first paint ready.
    toolbar = normalizeLiveToolbarSnapshot(toolbar, data);
    if (isPending()) {
      activate(data);
      return;
    }
    if (
      Number.isInteger(activation.documentEpoch) &&
      Number(data.documentEpoch) !== activation.documentEpoch
    ) {
      return;
    }
    if (data.action === 'source') {
      onSource({ file: data.file, line: data.line, column: data.column });
      return;
    }
    if (data.action === 'edit') {
      onEdit(data);
      return;
    }
    emitToolbar();
    emitStatus(data);
  };

  const setLive = (payload) => {
    // Any live-state message supersedes an error acknowledgement that has not
    // crossed its paint barrier yet.
    cancelErrorSurface();
    const rawUrl = payload && typeof payload.url === 'string' ? payload.url.trim() : '';
    if (!rawUrl) {
      deactivate();
      return;
    }
    if (!frame) return;

    const url = rawUrl.replace(/\/+$/, '');
    const generation = Number(payload?.generation) || 0;
    // The same engine at the same generation is the same surface; re-running
    // activation would navigate the frame and flash for nothing.
    if (activation?.url === url && activation?.generation === generation && hasSession()) return;

    surfaceOwned = true;
    // Invalidates a restore scheduled by a deactivation in this same frame;
    // the request itself is kept for the next time live goes off.
    deferredStaticFlushToken += 1;
    const id = `${now().toString(36)}-${(++activationSequence).toString(36)}`;
    cancelReveal();
    activation = {
      id,
      url,
      generation,
      documentEpoch: null,
      pendingDocumentEpoch: null,
      reveal: null,
    };
    toolbar = normalizeLiveToolbarSnapshot();
    setPhase('activation-pending');
    emitToolbar();
    onStatus({ key: 'liveUpdating', tone: 'busy', detail: '' });

    client?.dispose();
    client = createEmbedClient({
      frame,
      activationId: id,
      hostWindow,
      onMessage: handleFrameMessage,
    });
    frame.src = embedUrl(url, { activationId: id, theme: getTheme(), bg: getBackground() });
  };

  const setError = (payload) => {
    cancelErrorSurface();
    const error = typeof payload?.error === 'string' ? payload.error : '';
    if (!error) {
      if (isLive()) onStatus({ key: 'live', tone: 'idle', detail: '' });
      else if (isPending()) onStatus({ key: 'liveUpdating', tone: 'busy', detail: '' });
      else onStatus({ key: 'ready', tone: 'idle', detail: '' });
      return;
    }
    onStatus({ key: 'liveError', tone: 'error', detail: error, message: error });
    const pending = {
      token: errorSurfaceSequence,
      error,
      url: typeof payload?.url === 'string' ? payload.url : null,
      generation: Number(payload?.generation) || 0,
    };
    pendingErrorSurface = pending;
    // A terminal error is a surface too. A host window that becomes visible
    // as soon as its renderer says "ready" would show one frame of nothing
    // before the error text paints, so use the same two-paint barrier.
    requestFrame(() => {
      requestFrame(() => {
        if (pendingErrorSurface !== pending || pending.token !== errorSurfaceSequence) return;
        pendingErrorSurface = null;
        onErrorSurfaceReady({
          error: pending.error,
          url: pending.url,
          generation: pending.generation,
        });
      });
    });
  };

  const gotoPage = (page) => {
    if (!isLive()) return false;
    toolbar = normalizeLiveToolbarSnapshot(toolbar, { page: Number(page) });
    emitToolbar();
    return post('goto-page', { page: toolbar.page });
  };

  return {
    setLive,
    setError,
    sync: applySync,
    // The visible number moves on the click, not on the frame's next 400ms
    // snapshot.
    stepPage: (delta) => {
      if (!isLive()) return false;
      toolbar = stepLiveToolbarPage(toolbar, delta);
      emitToolbar();
      return post('goto-page', { page: toolbar.page });
    },
    gotoPage,
    zoomIn: () => isLive() && post('zoom-in'),
    zoomOut: () => isLive() && post('zoom-out'),
    zoomFit: () => isLive() && post('zoom-fit'),
    search: (query, findPrevious = false) => isLive() && post('search', { query, findPrevious }),
    // A host must not load a static document while live owns the surface:
    // tearing the cover out from under the frame is the flash this whole
    // module exists to prevent. Hand it here instead; the newest one is
    // replayed through onStaticRestore once live is off.
    deferStatic: (request) => {
      if (!surfaceOwned) return false;
      deferredStatic = request;
      return true;
    },
    isLive,
    isPending,
    hasSession,
    isSurfaceOwned: () => surfaceOwned,
    getPhase: () => phase,
    getToolbar: () => ({ ...toolbar }),
    getActivation: () => (activation ? { ...activation } : null),
    dispose: () => {
      cancelReveal();
      cancelErrorSurface();
      client?.dispose();
      client = null;
    },
  };
}

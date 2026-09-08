// Browser side: driving the engine's embedded preview (`/?embed=1`).
//
// In embed mode the engine's own client renders pages only — no topbar, no
// editor, no inspector — so a host viewer keeps its own chrome and swaps just
// its page area for this iframe. The two halves talk over postMessage:
//
//   host  -> frame  { source: 'tdom-host',  activationId, action, ... }
//   frame -> host   { source: 'tdom-embed', activationId, ... }
//
// Every frame message carries the activation id the host passed in the URL.
// A stale iframe from a previous activation therefore cannot drive a viewer
// that has already moved on to a new document or a new engine process.

export const HOST_MESSAGE_SOURCE = 'tdom-host';
export const FRAME_MESSAGE_SOURCE = 'tdom-embed';

// `bg` and `theme` exist so the preview reads as part of the host viewer
// rather than as the engine's dev UI.
export function embedUrl(base, { activationId = '', theme, bg } = {}) {
  const url = new URL('/', base);
  url.searchParams.set('embed', '1');
  if (activationId) url.searchParams.set('activationId', String(activationId));
  if (theme === 'light' || theme === 'dark') url.searchParams.set('theme', theme);
  if (typeof bg === 'string' && /^#[0-9a-f]{3,8}$/i.test(bg)) url.searchParams.set('bg', bg);
  return url.toString();
}

export function createEmbedClient({
  frame,
  activationId = '',
  hostWindow = globalThis,
  onSnapshot,
  onResetPending,
  onSource,
  onEdit,
  onMessage,
}) {
  const post = (action, payload = {}) => {
    const target = frame?.contentWindow;
    if (!target) return false;
    try {
      target.postMessage({ source: HOST_MESSAGE_SOURCE, activationId, action, ...payload }, '*');
      return true;
    } catch {
      // The frame can be torn down between a toolbar click and this call.
      return false;
    }
  };

  const listener = (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== FRAME_MESSAGE_SOURCE) return;
    if (activationId && data.activationId && data.activationId !== activationId) return;
    onMessage?.(data);
    // `reset-pending` asks the host to hold its static surface while the
    // client discards its old document DOM; the host answers with reset-ack
    // once the new stacking order is committed, never before.
    if (data.action === 'reset-pending') onResetPending?.(data);
    else if (data.action === 'source') onSource?.(data);
    else if (data.action === 'edit') onEdit?.(data);
    else if (!data.action) onSnapshot?.(data);
  };
  hostWindow.addEventListener('message', listener);

  return {
    post,
    dispose: () => hostWindow.removeEventListener('message', listener),
    zoomIn: () => post('zoom-in'),
    zoomOut: () => post('zoom-out'),
    zoomFit: () => post('zoom-fit'),
    gotoPage: (page) => post('goto-page', { page: Number(page) }),
    pagePrev: () => post('page-prev'),
    pageNext: () => post('page-next'),
    gotoSync: (location) => post('goto-sync', location),
    search: (query, findPrevious = false) => post('search', { query, findPrevious }),
    resetAck: (documentEpoch) => post('reset-ack', { documentEpoch: Number(documentEpoch) }),
  };
}

// One unambiguous viewer state out of the engine's status snapshot.
//
// The engine reports several overlapping facts at once (a foreground busy
// flag, a canonical compile in flight, a canonical error from an older
// revision, opaque mode). A viewer has one status line, so the order below is
// the meaning, not a formatting detail.
//
// `key` is a message id the host maps to its own wording; `message`, when
// present, is literal text from the engine and is shown as-is.

export const LIVE_STATUS_KEYS = [
  'live',
  'liveUpdating',
  'liveExactRendering',
  'liveFullCompile',
  'liveError',
  'liveUnavailable',
  'ready',
];

export const resolveLiveStatus = (status) => {
  if (!status) return null;
  if (status.up === false) {
    return { key: 'liveUnavailable', tone: 'error', detail: '' };
  }
  // canonical.inFlight is the exact LuaLaTeX path. It may overlap with the
  // foreground engine's generic busy flag, so it must take precedence.
  if (status.canonical?.inFlight) {
    return { key: 'liveExactRendering', tone: 'busy', detail: '' };
  }
  if (status.busy) {
    return { key: 'liveUpdating', tone: 'busy', detail: '' };
  }
  // An error from a revision older than the current source has already been
  // superseded by the edit the user just made.
  if (status.canonical?.error && Number(status.canonical.errorRev) >= Number(status.srcRev)) {
    return { key: 'liveError', tone: 'error', detail: status.canonical.error };
  }
  if (status.mode === 'opaque') {
    return { key: 'liveFullCompile', tone: 'idle', detail: '' };
  }
  return { key: 'live', tone: 'idle', detail: '' };
};

// The toolbar numbers a host viewer shows while live.
//
// The embedded client sends partial snapshots (some carry only zoom, some
// only a page), and a page step must move the visible number immediately
// rather than waiting for the frame's next 400ms snapshot. Both facts make
// this a small state machine rather than a straight assignment.

const finiteNumber = (value, fallback) => (Number.isFinite(value) ? Number(value) : fallback);

export const normalizeLiveToolbarSnapshot = (current = {}, update = {}) => {
  const pageCount = Math.max(
    0,
    Math.floor(finiteNumber(update.pageCount, finiteNumber(current.pageCount, 0)))
  );
  const requestedPage = Math.max(
    1,
    Math.floor(finiteNumber(update.page, finiteNumber(current.page, 1)))
  );
  const zoom = Math.max(0.01, finiteNumber(update.zoom, finiteNumber(current.zoom, 1)));
  return {
    pageCount,
    // A page beyond the document is never shown, but page count 0 (nothing
    // reported yet) must not clamp the number to zero.
    page: Math.min(requestedPage, pageCount || 1),
    zoom,
  };
};

export const stepLiveToolbarPage = (current = {}, delta = 0) =>
  normalizeLiveToolbarSnapshot(current, {
    page: finiteNumber(current.page, 1) + finiteNumber(delta, 0),
  });

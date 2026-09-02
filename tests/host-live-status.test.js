import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_STATUS_KEYS, resolveLiveStatus } from '../host/live-status.js';

test('the exact canonical path has a distinct visible status', () => {
  // busy, opaque and canonical.inFlight are all true at once here; the exact
  // LuaLaTeX path is the one the user is actually waiting for.
  assert.deepEqual(
    resolveLiveStatus({ up: true, busy: true, mode: 'opaque', srcRev: 4, canonical: { inFlight: true } }),
    { key: 'liveExactRendering', tone: 'busy', detail: '' }
  );
  assert.deepEqual(resolveLiveStatus({ up: true, busy: true }), {
    key: 'liveUpdating',
    tone: 'busy',
    detail: '',
  });
});

test('live errors and settled exact pages retain their meanings', () => {
  assert.deepEqual(
    resolveLiveStatus({
      up: true,
      mode: 'structured',
      srcRev: 8,
      canonical: { error: 'Undefined control sequence', errorRev: 8 },
    }),
    { key: 'liveError', tone: 'error', detail: 'Undefined control sequence' }
  );
  // An error from an older revision has already been superseded.
  assert.equal(
    resolveLiveStatus({
      up: true,
      mode: 'structured',
      srcRev: 9,
      canonical: { error: 'Undefined control sequence', errorRev: 8 },
    })?.key,
    'live'
  );
  assert.equal(resolveLiveStatus({ up: true, mode: 'opaque' })?.key, 'liveFullCompile');
  assert.equal(resolveLiveStatus({ up: false })?.key, 'liveUnavailable');
  assert.equal(resolveLiveStatus(null), null);
});

test('every resolved key is one a host can translate', () => {
  const keys = [
    resolveLiveStatus({ up: false }),
    resolveLiveStatus({ up: true, canonical: { inFlight: true } }),
    resolveLiveStatus({ up: true, busy: true }),
    resolveLiveStatus({ up: true, srcRev: 1, canonical: { error: 'x', errorRev: 1 } }),
    resolveLiveStatus({ up: true, mode: 'opaque' }),
    resolveLiveStatus({ up: true }),
  ].map((view) => view.key);
  for (const key of keys) assert.ok(LIVE_STATUS_KEYS.includes(key), `${key} is not declared`);
});

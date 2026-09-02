// Where a host app finds an engine checkout.
//
// A host ships against a moving engine: developers edit a checkout, released
// builds carry a vendored copy. Resolution therefore prefers a real checkout
// (so editing it is picked up on the next preview start) and falls back to
// the vendored copy only when no checkout exists.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server.js is the engine's entry point; a directory without it is not an
// engine checkout no matter what it is called.
export const ENGINE_MARKER = 'server.js';
export const ENGINE_NAME = 'tdom-engine';

// A sandboxed host (macOS app under App Sandbox / TCC) cannot stat arbitrary
// directories without a user grant. It replaces this gate with its own, where
// probeIfAllowed returns null for "not allowed to look yet" — distinct from
// false, which means the host looked and found nothing.
export const NO_FILE_ACCESS = {
  classify: () => null,
  getState: () => 'granted',
  probeIfAllowed: (_candidate, probe) => probe(),
  ensureAccess: async () => true,
};

// This package's own root, so a host embedded in the repo (tests, tools, the
// Electron example) needs no configuration at all.
export function packageEngineDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultCheckoutCandidates(homeDir = os.homedir(), name = ENGINE_NAME) {
  return [
    path.join(homeDir, 'Developer', name),
    path.join(homeDir, name),
    path.join(homeDir, 'Desktop', name),
  ];
}

// Returns { dir, needsAccess }. `needsAccess` is the file-access key of the
// first candidate the host was not allowed to probe, so the caller can ask
// for that grant instead of reporting a bogus "engine not found".
export function resolveEngineDir({
  envDir,
  explicitDir,
  candidates,
  vendoredDir = null,
  homeDir = os.homedir(),
  name = ENGINE_NAME,
  marker = ENGINE_MARKER,
  existsSync = fs.existsSync,
  fileAccess = NO_FILE_ACCESS,
} = {}) {
  const selected = typeof envDir === 'string' && envDir.trim() ? envDir.trim() : explicitDir;
  if (selected) return { dir: selected, needsAccess: null };

  const searched = candidates ?? defaultCheckoutCandidates(homeDir, name);
  let needsAccess = null;
  for (const candidate of searched) {
    const found = fileAccess.probeIfAllowed(candidate, () =>
      existsSync(path.join(candidate, marker))
    );
    if (found === true) return { dir: candidate, needsAccess: null };
    if (found === null) needsAccess ||= fileAccess.classify(candidate)?.key || null;
  }

  if (vendoredDir && existsSync(path.join(vendoredDir, marker))) {
    return { dir: vendoredDir, needsAccess: null };
  }

  const own = packageEngineDir();
  if (existsSync(path.join(own, marker))) return { dir: own, needsAccess: null };

  // Nothing resolved: report the last checkout candidate so the error names a
  // path the user can actually create.
  return { dir: searched.at(-1) ?? own, needsAccess };
}

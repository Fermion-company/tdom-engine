import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { documentBounds } from '../segmenter.js';
import { isPathInside } from '../project-inputs.js';
import { watchInclude } from './include-expander.js';
import { visitProjectPackages } from './rescue-classifier.js';

export const styleInput = file => /\.(?:sty|cls|clo|cfg|def|fd|ldf|lbx|bbx|cbx)$/i.test(file);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function diskDigest(file) {
  try { return digest(readFileSync(file)); } catch { return null; }
}

export class PreambleInputs {
  constructor(context, onChange) {
    this.context = context;
    this.onChange = onChange;
    this.watchers = new Map();
    this.inputs = new Map();
  }

  scan(source, force = false) {
    const bounds = documentBounds(source);
    this.bodyStart = bounds.hasBegin ? bounds.body.start : Infinity;
    const preamble = source.slice(bounds.preamble.start, bounds.preamble.end);
    if (!force && this.preamble === preamble) return;
    this.preamble = preamble;
    const inputs = new Map();
    visitProjectPackages(preamble, this.context,
      (file, _body, bytes) => inputs.set(file, digest(bytes)),
      file => { if (!inputs.has(file)) inputs.set(file, null); });
    this.declared = inputs;
    this.manifestId = null;
    // Keep the previous recorder's names until another successful compile
    // can replace them. A deleted macro-loaded package has no new manifest.
    this.recorded ??= new Map();
    for (const file of this.recorded.keys()) {
      const overlay = this.context.overlays.get(file) ?? this.context.savedOverlays?.get(file);
      if (inputs.has(file)) this.recorded.delete(file);
      else this.recorded.set(file, overlay === undefined ? diskDigest(file) : digest(overlay));
    }
    this.updateWatches();
  }

  // TeX expands macros and conditionals before loading a package. The
  // canonical recorder also covers local styles that a literal scan missed.
  acceptManifest(manifest, startedAt, id) {
    if (!manifest || !this.declared || this.manifestId === id) return;
    this.manifestId = id;
    const recorded = new Map();
    for (const [file, hash] of manifest) {
      if (styleInput(file) && !this.declared.has(file) && isPathInside(this.context.docDir, file)) {
        recorded.set(file, this.recorded.has(file) ? this.recorded.get(file) : hash);
      }
    }
    const added = [...recorded.keys()].filter(file => !this.inputs.has(file));
    this.recorded = recorded;
    this.updateWatches();
    this.recheckNew(added, startedAt);
  }

  acceptFailedInputs(pairs, startedAt) {
    if (!this.declared) return;
    const added = [];
    for (const [file, physical] of pairs) {
      if (!styleInput(file) || this.inputs.has(file) || !isPathInside(this.context.docDir, file)) continue;
      this.recorded.set(file, diskDigest(physical));
      added.push(file);
    }
    if (added.length) {
      this.updateWatches();
      this.recheckNew(added, startedAt);
    }
  }

  recheckNew(files, startedAt) {
    if (!Number.isFinite(startedAt)) return;
    for (const file of files) {
      // It could have been replaced between TeX opening it and the first
      // watch. Retry that generation once, even if the later hash matches.
      let stat;
      try { stat = statSync(file, { throwIfNoEntry: false }); } catch { continue; }
      if (!stat || stat.ctimeMs >= startedAt) {
        this.onChange(file, true);
        return;
      }
    }
  }

  noteMissing(error) {
    const name = /File [`'"]([^`'"\r\n]+)['"] not found/i.exec(error)?.[1];
    if (!name || !styleInput(name) || !this.declared) return;
    const { docDir, sourceDir = docDir } = this.context;
    const candidates = new Set([sourceDir, docDir].map(dir => path.resolve(dir, name)));
    const added = [];
    for (const file of candidates) {
      if (!isPathInside(docDir, file) || this.inputs.has(file)) continue;
      this.recorded.set(file, null);
      added.push(file);
    }
    if (!added.length) return;
    this.updateWatches();
    // The file may have arrived while TeX reported the failure.
    const arrived = added.find(file => this.diskChanged(file));
    if (arrived) this.onChange(arrived);
  }

  updateWatches() {
    const inputs = new Map([...this.declared, ...this.recorded]);
    this.inputs = inputs;
    for (const [file, handle] of this.watchers) {
      if (!inputs.has(file)) { handle.close(); this.watchers.delete(file); }
    }
    for (const file of inputs.keys()) {
      if (this.watchers.has(file)) continue;
      try { watchInclude(file, this.watchers, this.onChange); } catch { /* a watch cannot block typesetting */ }
    }
  }

  holdsOverlay(file, text) {
    return typeof text === 'string' && this.inputs.has(file) && this.inputs.get(file) === digest(text);
  }

  diskChanged(file) {
    if (!this.inputs.has(file)) return false;
    return this.inputs.get(file) !== diskDigest(file);
  }

  close() {
    for (const handle of this.watchers.values()) handle.close();
    this.watchers.clear();
    this.inputs.clear();
  }
}

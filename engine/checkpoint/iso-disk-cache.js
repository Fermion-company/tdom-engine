import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fnv1a } from '../hash.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Isolated compile results outlive the process. A rescue key already names
 * every input the compile depends on (block text, entry state, preamble,
 * referenced labels, page offset), so a result can be reused by a later
 * engine for the same inputs: reopening a long document adopts its
 * splitting blocks (multicols, breakable boxes) inline during the boot walk
 * instead of paying a cold lualatex per block after it. The namespace also
 * carries what the key does not see: the engine's Lua daemons, its version
 * and the TeX binary, so an update never serves a result compiled by an
 * older toolchain.
 */
export function isoCacheEpoch() {
  const parts = [];
  for (const name of ['daemon.lua', 'shipd.lua']) {
    try { parts.push(fnv1a(readFileSync(path.join(DIR, name), 'utf8'))); } catch { parts.push('-'); }
  }
  try { parts.push(JSON.parse(readFileSync(path.join(DIR, '..', '..', 'package.json'), 'utf8')).version ?? '0'); } catch { parts.push('0'); }
  try { parts.push(fnv1a(execFileSync('lualatex', ['--version'], { encoding: 'utf8', timeout: 15_000 }).split('\n')[0] ?? '')); } catch { parts.push('notex'); }
  return parts.join('-');
}

export class IsoDiskCache {
  constructor(root, { epoch = isoCacheEpoch(), maxEntries = Number(process.env.TDOM_ISO_DISK_CACHE || 512) } = {}) {
    this.dir = path.join(root, 'iso-cache', epoch);
    this.maxEntries = Math.max(16, maxEntries);
    this.disabled = process.env.TDOM_ISO_DISK_CACHE === '0';
    this.stats = { hits: 0, misses: 0, writes: 0 };
  }

  #paths(key) {
    return { json: path.join(this.dir, `${key}.json`), pdf: path.join(this.dir, `${key}.pdf`) };
  }

  #attachPdf(iso, pdf) {
    if (!iso?.chunks?.length) return iso;
    const editPdf = existsSync(pdf) ? readFileSync(pdf) : null;
    if (!editPdf) throw new Error('cached iso without its pdf');
    for (const chunk of iso.chunks) chunk.editPdf = editPdf;
    return iso;
  }

  /**
   * The latest result stored for an offset-free base key. Its compiledOff
   * says which page offset it was compiled at; the caller adopts it and lets
   * the moved-offset pass decide whether that offset still holds.
   */
  getBase(baseKey) {
    if (this.disabled) return undefined;
    const link = path.join(this.dir, `base-${baseKey}.json`);
    if (!existsSync(link)) { this.stats.misses++; return undefined; }
    try {
      const { key } = JSON.parse(readFileSync(link, 'utf8'));
      const { json, pdf } = this.#paths(key);
      const iso = this.#attachPdf(JSON.parse(readFileSync(json, 'utf8')), pdf);
      this.stats.hits++;
      return { key, iso };
    } catch {
      rmSync(link, { force: true });
      this.stats.misses++;
      return undefined;
    }
  }

  /** Synchronous: the boot walk asks for a rescue result inline. */
  get(key) {
    if (this.disabled) return undefined;
    const { json, pdf } = this.#paths(key);
    if (!existsSync(json)) { this.stats.misses++; return undefined; }
    try {
      const iso = this.#attachPdf(JSON.parse(readFileSync(json, 'utf8')), pdf);
      this.stats.hits++;
      return iso;
    } catch {
      rmSync(json, { force: true });
      rmSync(pdf, { force: true });
      this.stats.misses++;
      return undefined;
    }
  }

  set(key, iso, baseKey = null) {
    if (this.disabled || !iso || typeof iso !== 'object') return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const { json, pdf } = this.#paths(key);
      const editPdf = iso.chunks?.find((chunk) => chunk.editPdf)?.editPdf ?? null;
      const chunks = (iso.chunks ?? []).map(({ editPdf: _pdf, ...rest }) => rest);
      const tmp = `${json}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...iso, chunks }));
      if (editPdf) writeFileSync(pdf, editPdf);
      renameSync(tmp, json);
      if (baseKey) writeFileSync(path.join(this.dir, `base-${baseKey}.json`), JSON.stringify({ key }));
      this.stats.writes++;
      this.#trim();
    } catch { /* a cache miss next time is the only consequence */ }
  }

  #trim() {
    let entries;
    try { entries = readdirSync(this.dir).filter((name) => name.endsWith('.json') && !name.startsWith('base-')); } catch { return; }
    if (entries.length <= this.maxEntries) return;
    const dated = entries.map((name) => {
      try { return { name, mtime: statSync(path.join(this.dir, name)).mtimeMs }; } catch { return { name, mtime: 0 }; }
    }).sort((a, b) => a.mtime - b.mtime);
    for (const { name } of dated.slice(0, entries.length - this.maxEntries)) {
      rmSync(path.join(this.dir, name), { force: true });
      rmSync(path.join(this.dir, name.replace(/\.json$/, '.pdf')), { force: true });
    }
  }
}

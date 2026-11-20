import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reference = /^\d+ \d+ R$/;

// Hash the complete PDF paint inputs, not just /Contents: an unchanged
// stream can select a different font, image, form or inherited page width.
// Unknown document-level rendering features and cyclic graphs fail closed.
export function isoPageKeys(json, count) {
  try {
    if (json.pages?.length !== count || json.qpdf?.[0]?.jsonversion !== 2) return null;
    const objects = json.qpdf[1], memo = new Map(), active = new Set();
    const valueOf = ref => objects['obj:' + ref]?.value;
    const catalog = valueOf(objects.trailer?.value?.['/Root']);
    if (!catalog || Object.keys(catalog).some(k => !['/Type', '/Pages', '/Version'].includes(k))) return null;
    let visits = 0;
    function hash(value, depth = 0) {
      if (++visits > 200000 || depth > 64) throw new Error('PDF graph budget');
      if (typeof value === 'string' && reference.test(value)) {
        if (memo.has(value)) return memo.get(value);
        if (active.has(value) || !objects['obj:' + value]) throw new Error('PDF graph reference');
        active.add(value);
        const result = digest([value, hash(objects['obj:' + value], depth + 1)]);
        active.delete(value);
        memo.set(value, result);
        return result;
      }
      if (Array.isArray(value)) return digest(value.map(v => hash(v, depth + 1)));
      if (value && typeof value === 'object') {
        return digest(Object.keys(value).sort().map(k => [k, hash(value[k], depth + 1)]));
      }
      return digest(value);
    }
    return json.pages.map((page, index) => {
      const dict = valueOf(page.object);
      if (!dict || dict['/Type'] !== '/Page') throw new Error('PDF page');
      const inherited = {}, seen = new Set();
      let parent = dict;
      while (parent) {
        for (const k of ['/Resources', '/MediaBox', '/CropBox', '/Rotate']) {
          if (!(k in inherited) && k in parent) inherited[k] = parent[k];
        }
        const ref = parent['/Parent'];
        if (!ref) break;
        if (seen.has(ref) || !valueOf(ref)) throw new Error('PDF page tree');
        seen.add(ref);
        parent = valueOf(ref);
      }
      if (!inherited['/MediaBox'] || !inherited['/Resources']) throw new Error('PDF page inheritance');
      const { '/Parent': _parent, ...own } = dict;
      return digest([index, catalog['/Version'], hash({ ...inherited, ...own })]);
    });
  } catch { return null; }
}

export async function readIsoPageKeys(pdf, count, run = execFileP) {
  try {
    const { stdout } = await run('qpdf', ['--json', '--json-key=pages', '--json-key=qpdf',
      '--json-stream-data=inline', pdf], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    return isoPageKeys(JSON.parse(stdout), count);
  } catch { return null; }
}

export class IsoPageCache {
  constructor(maxBytes = 8 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map();
    this.stats = { hits: 0, misses: 0 };
  }

  get(key) {
    const svg = key && this.entries.get(key);
    if (svg === undefined || !key) { this.stats.misses++; return undefined; }
    this.entries.delete(key);
    this.entries.set(key, svg);
    this.stats.hits++;
    return svg;
  }

  set(key, svg) {
    if (!key || svg.length > this.maxBytes) return;
    if (this.entries.has(key)) this.bytes -= this.entries.get(key).length;
    this.entries.delete(key);
    this.entries.set(key, svg);
    this.bytes += svg.length;
    while (this.bytes > this.maxBytes || this.entries.size > 64) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).length;
      this.entries.delete(oldest);
    }
  }
}

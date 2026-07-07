import { parsePlacement } from './pagebuilder.js';

/**
 * galley items -> the page builder's input stream. The items ARE the real
 * main vertical list (boxes, glue with full specs, penalties, inserts,
 * float anchors, eject markers) — this function only reshapes them into
 * stream entries and attaches drawing/chunk metadata. Entry objects are
 * cached per block (unitsSig), so page identity survives unrelated edits.
 */
export function buildStream(block, chunks) {
  const galley = block.galley;
  const items = galley?.items ?? [];
  const floats = galley?.floats ?? [];
  const fid = block.fidelity;
  // Fidelity display policy (best available first):
  //   fresh chunk > STALE chunk (the previous edit's TeX pixels — old but
  //   clean) > glyph bridge (only where every glyph is at least mappable)
  //   > blank (no-bridge lines, canonical-only blocks).
  // A fast-but-wrong display is never an option; a ~100ms-old exact one is.
  const bc = chunks.get(block.id);
  const bcFresh = !!bc && bc.forGalley === block.galleyHash;
  const blockExact = !!(block.gfx || fid?.blockExact);
  const canonicalOnly = !!fid?.canonicalOnly;

  const stream = [];
  let li = 0;
  let yOff = 0;
  let insOrdinal = 0;

  const makeFloat = (n) => {
    const f = floats.find((x) => x.n === n);
    if (!f) return null;
    const chunkKey = block.id + '#' + f.n;
    const fc = chunks.get(chunkKey);
    const ffid = fid?.floats?.get(f.n);
    const wantExact = !canonicalOnly && !!(f.gfx || ffid?.exact);
    const chunkRef =
      wantExact && fc
        ? { key: chunkKey, w: f.w, stale: fc.forGalley === block.galleyHash ? undefined : 1 }
        : null;
    const suppress = canonicalOnly || (wantExact && !fc && !!ffid?.noBridge);
    return {
      id: chunkKey,
      n: f.n,
      place: parsePlacement(f.placement),
      type: f.type,
      w: f.w,
      h: f.h ?? 0,
      d: f.d ?? 0,
      gfx: f.gfx,
      blockId: block.id,
      units: miniUnits(f.items, block.id, chunkRef, suppress),
    };
  };

  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    if (it.k === 'glue') {
      stream.push({ t: 'glue', a: it.a ?? 0, st: it.st ?? 0, sto: it.sto ?? 0, sh: it.sh ?? 0, sho: it.sho ?? 0, sub: it.sub ?? 0 });
      yOff += it.a ?? 0;
    } else if (it.k === 'kern') {
      stream.push({ t: 'kern', a: it.a ?? 0 });
      yOff += it.a ?? 0;
    } else if (it.k === 'pen') {
      stream.push({ t: 'pen', v: it.v ?? 0 });
    } else if (it.k === 'ins') {
      // footnote bodies get their own chunk pages (RENDER pages after the
      // floats) when the fidelity gate flags them
      const k = insOrdinal++;
      const ifid = fid?.ins?.get(k);
      const chunkKey = `${block.id}@fn${k}`;
      const ic = chunks.get(chunkKey);
      const wantExact = !canonicalOnly && !!ifid?.exact;
      const chunkRef =
        wantExact && ic
          ? { key: chunkKey, w: ic.wBp, stale: ic.forGalley === block.galleyHash ? undefined : 1 }
          : null;
      const suppress = canonicalOnly || (wantExact && !ic && !!ifid?.noBridge);
      stream.push({
        t: 'ins',
        h: it.h ?? it.hc ?? 0,
        d: it.d ?? 0,
        hc: it.hc ?? it.h ?? 0,
        units: miniUnits(it.items, block.id, chunkRef, suppress),
      });
    } else if (it.k === 'fm') {
      const f = makeFloat(it.n);
      if (f) stream.push({ t: 'fm', f, vmode: true });
    } else if (it.k === 'eject') {
      stream.push({ t: 'eject', v: it.v ?? -10000 });
    } else if (it.k === 'enlarge') {
      // \enlargethispage marker: grows the CURRENT page's goal in the page
      // builder at exactly this stream position
      stream.push({ t: 'enlarge', a: it.a ?? 0, star: it.star ?? 0 });
    } else if (it.k === 'ev') {
      // page-style event marker: invisible, but its page decides when the
      // event (pagenumbering/style/marks) takes effect. The payload kind
      // rides along so the page builder can act on folio-coupled events
      // (\pagenumbering resets, \cleardoublepage blank pages).
      const ev = block.galley?.events?.[it.n ?? 0];
      stream.push({ t: 'ev', bid: block.id, i: it.n ?? 0, k: ev?.k, a: ev?.a });
    } else if (it.k === 'tl') {
      // tocline marker: page-anchors the contents entry it points at
      stream.push({ t: 'tl', bid: block.id, i: it.n ?? 0 });
    } else if (it.k === 'box') {
      // fidelity verdict for THIS line: exact-required lines map into the
      // block chunk (fresh, or stale until the new one lands ~100ms later);
      // safe lines stay pure glyphs. Rescued blocks carry per-item chunk
      // refs (multi-page isolated renders) which take precedence.
      const flags = fid?.itemFlags?.[ii] ?? 0;
      const wantExact = !canonicalOnly && (blockExact || (flags & 1) !== 0);
      let gfxChunk = null;
      if (it.chunk) {
        gfxChunk = { blockId: it.chunk, yOff: it.coff ?? 0, w: chunks.get(it.chunk)?.wBp ?? galley.w };
        if (it.full) gfxChunk.full = 1; // real shipped page: owns folio/hf
      } else if (wantExact && bc) {
        gfxChunk = { blockId: block.id, yOff, w: galley.w, stale: bcFresh ? undefined : 1 };
      }
      // no exact pixels yet: mappable glyphs may bridge the render latency;
      // unmappable ones (and verification-demoted blocks) show nothing
      // rather than something wrong
      const lineNoBridge =
        canonicalOnly || (flags & 2) !== 0 || (blockExact && !!fid?.noBridge);
      const suppress = !gfxChunk && (canonicalOnly || (wantExact && lineNoBridge));
      const unit = {
        blockId: block.id,
        li: li++,
        h: it.h ?? 0,
        d: it.d ?? 0,
        // canonical-only band: the blank keeps the layout, the canonical
        // page shows through — the display list advertises the band (op
        // 'canon') so referees count real-PDF lines there as covered
        cn: !gfxChunk && canonicalOnly ? 1 : undefined,
        ln: {
          descent: it.d ?? 0,
          boxH: it.h ?? 0,
          runs: suppress ? [] : (it.runs ?? []),
          gfxChunk,
        },
      };
      stream.push({ t: 'box', u: unit });
      yOff += (it.h ?? 0) + (it.d ?? 0);
      if (it.fm) {
        for (const n of it.fm) {
          const f = makeFloat(n);
          if (f) stream.push({ t: 'fm', f, vmode: false });
        }
      }
    }
  }
  // tag the block's first stream node: the page builder records \pagetotal
  // at block entry there (page-context-sensitive rescues need it)
  if (stream[0]) {
    stream[0].first = true;
    stream[0].bid = block.id;
  }
  return stream;
}

/** Convert a captured mini-galley (float body, footnote text) to draw
 * units. `suppress` blanks the glyph runs when the fidelity gate forbids a
 * glyph bridge and no exact chunk has landed yet. */
export function miniUnits(items, blockId, chunkRef, suppress = false) {
  const units = [];
  let y = 0;
  for (const it of items ?? []) {
    if (it.k === 'glue' || it.k === 'kern') {
      y += it.a ?? 0;
      continue;
    }
    if (it.k !== 'box') continue;
    units.push({
      blockId,
      h: it.h ?? 0,
      d: it.d ?? 0,
      yRel: y + (it.h ?? 0), // baseline relative to the mini-galley top
      ln: {
        descent: it.d ?? 0,
        boxH: it.h ?? 0,
        runs: suppress && !chunkRef ? [] : (it.runs ?? []),
        gfxChunk: chunkRef
          ? { blockId: chunkRef.key, yOff: y, w: chunkRef.w, stale: chunkRef.stale }
          : null,
      },
    });
    y += (it.h ?? 0) + (it.d ?? 0);
  }
  return units;
}

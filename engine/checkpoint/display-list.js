import { fnv1a } from '../hash.js';
import { remapText } from './mathmap.js';
import { r2 } from './util/svg.js';

export function buildDisplayList(page, { geometry, chunks, hf, hfSig, fonts, twinMetrics }) {
  const geo = geometry;
  const L = 72 + (geo.oddsidemargin ?? 0);
  const T = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
  const commands = [];
  let gfxOpen = null;
  const flushGfx = () => {
    if (!gfxOpen) return;
    const meta = chunks.get(gfxOpen.blockId);
    const visibleHeight = gfxOpen.clip1 - gfxOpen.clip0;
    if (gfxOpen.units === 1 && visibleHeight > Math.max(12, gfxOpen.covered * 2)) {
      commands.push({
        op: 'sourcebox',
        x: r2(L),
        y: r2(gfxOpen.top + gfxOpen.clip0),
        w: r2(gfxOpen.w),
        h: r2(visibleHeight),
        ink: gfxOpen.ink ? 1 : undefined,
        chunk: 1,
        complex: 1,
        src: gfxOpen.blockId,
      });
    }
    commands.push({
      op: 'chunk',
      chunk: gfxOpen.blockId,
      x: r2(L),
      y: r2(gfxOpen.top + gfxOpen.clip0),
      w: r2(gfxOpen.w),
      h: r2(gfxOpen.clip1 - gfxOpen.clip0),
      sy: r2(gfxOpen.clip0),
      ch: r2(meta?.hBp ?? gfxOpen.clip1),
      cv: meta?.v ?? 0,
      st: gfxOpen.stale ? 1 : undefined, // stale-exact: previous pixels held
      src: gfxOpen.blockId,
    });
    gfxOpen = null;
  };

  let ownsPage = false; // a real shipped page (iso `full` chunk) carries
  // its own page style — no provisional folio/header on top of it
  for (const entry of page.draw ?? []) {
    const u = entry.u;
    const baseline = T + entry.y;
    if (u.ln.gfxChunk) {
      const c = u.ln.gfxChunk;
      if (c.full) ownsPage = true;
      const unitTop = baseline - u.ln.boxH;
      const chunkTop = unitTop - c.yOff;
      const clip0 = c.yOff;
      const clip1 = c.yOff + u.h + (u.d ?? 0);
      const unitRuns = u.ln.editRuns ?? u.ln.runs ?? [];
      const unitInk = unitRuns.some((run) => !run.rule && !!run.t);
      const unitExtent = Math.max(0, (u.h ?? 0) + (u.d ?? 0));
      if (gfxOpen && gfxOpen.blockId === c.blockId && Math.abs(gfxOpen.top - chunkTop) < 0.05) {
        gfxOpen.clip1 = Math.max(gfxOpen.clip1, clip1);
        gfxOpen.stale ||= !!c.stale;
        gfxOpen.units++;
        gfxOpen.covered += unitExtent;
        gfxOpen.ink ||= unitInk;
      } else {
        flushGfx();
        gfxOpen = {
          blockId: c.blockId,
          top: chunkTop,
          clip0,
          clip1,
          w: c.w,
          stale: !!c.stale,
          units: 1,
          covered: unitExtent,
          ink: unitInk,
        };
      }
      // Exact pixels cover this line; the unchanged TeX run extents provide
      // one transparent source-line hit surface underneath the chunk.
      sourceHitCommand(commands, L, baseline, u, u.blockId);
      continue;
    }
    flushGfx();
    if (u.cn) {
      // canonical-only band (margin-bearing blocks): blank in the
      // provisional layer, the canonical page supplies the pixels —
      // advertised so the referee counts real lines here as covered
      commands.push({
        op: 'canon',
        x: r2(L),
        y: r2(baseline - u.ln.boxH),
        w: r2(geo.textwidth),
        h: r2(u.ln.boxH + (u.d ?? 0)),
        src: u.blockId,
      });
      sourceHitCommand(commands, L, baseline, u, u.blockId, geo.textwidth);
      continue;
    }
    runCommands(commands, u.ln.runs, L, baseline, u.blockId, { fonts, twinMetrics, line: u.li });
  }
  flushGfx();
  // Header / footer: TeX-typeset boxes from the page-style job (the exact
  // \@oddhead/\@oddfoot with the page's real folio format, style and
  // marks). \@outputpage geometry: head box bottom at topmargin+headheight,
  // foot baseline \footskip below the text area.
  const hfEntry = ownsPage ? null : hf?.get(page.number);
  if (hfEntry) {
    paintHfItems(commands, hfEntry.h, L, 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0), {
      fonts,
      twinMetrics,
    });
    paintHfItems(commands, hfEntry.f, L, T + geo.textheight + (geo.footskip ?? 30), {
      fonts,
      twinMetrics,
    });
  } else if (!ownsPage) {
    // header job hasn't landed yet: provisional plain folio (replaced by
    // the TeX-typeset footer as soon as the async job reports)
    commands.push({
      op: 'folio',
      x: r2(L + geo.textwidth / 2),
      y: r2(T + geo.textheight + (geo.footskip ?? 30)),
      text: String(page.number),
    });
  }
  const dl = { page: page.number, commands };
  dl.hash = fnv1a(JSON.stringify(commands));
  dl.hfSig = hfSig; // display lists built pre-header-job get rebuilt
  return dl;
}

/** Paint one run list (glyphs + rules) at a baseline — shared by body
 * units and the TeX-typeset header/footer boxes. */
function runCommands(commands, runs, X, baseline, src, { fonts, twinMetrics, line }) {
  for (const r of runs ?? []) {
    if (r.rule) {
      // TeX uses zero-width/zero-height rules as invisible struts and
      // anchors (luatexja emits many of them around CJK glyphs). They
      // affect box metrics but paint no ink. Sending them to SVG made the
      // browser's minimum rect width turn them into stray vertical hairs.
      if (!(r.w > 0) || !(r.h > 0)) continue;
      commands.push({
        op: 'rule',
        x: r2(X + r.x),
        y: r2(baseline + r.dy),
        w: r2(r.w),
        h: r2(r.h),
        color: r.c && r.c !== '#000000' ? r.c : undefined,
        src,
        line,
      });
    } else if (r.t) {
      const fmeta = fonts.get(r.f);
      const text = fmeta?.remap ? remapText(r.t, fmeta.remap) : r.t;
      // cmex (OMX) glyphs hang below their reference point in TeX's
      // metrics; the unicode twins sit on a normal baseline. Align the
      // ink tops exactly: TeX extents travel with the run, twin extents
      // were measured by the daemon from the actual twin font.
      let dy = r.dy;
      if (fmeta?.omx) {
        const gh = r.gh ?? 0;
        const gd = r.gd ?? 0;
        const cp = text.codePointAt(0);
        const tm = twinMetrics?.[cp];
        if (tm) {
          dy = r.dy - gh + tm[0] * (r.s / 10);
        } else {
          dy = r.dy - gh + 0.78 * (gh + gd);
        }
      }
      commands.push({
        op: 'glyphs',
        fam: fmeta?.family ?? 'f-unknown',
        size: r.s,
        x: r2(X + r.x),
        y: r2(baseline + dy),
        text,
        w: r2(r.w ?? Math.max(1, text.length * r.s * 0.5)),
        gh: r2(r.gh ?? r.s * 0.8),
        gd: r2(r.gd ?? r.s * 0.2),
        color: r.c && r.c !== '#000000' ? r.c : undefined,
        src,
        line,
        math: fmeta?.mth ? 1 : undefined,
      });
    }
  }
}

function sourceHitCommand(commands, X, baseline, unit, src, fallbackWidth = 1) {
  const runs = unit.ln.editRuns ?? unit.ln.runs ?? [];
  let left = Infinity;
  let right = -Infinity;
  for (const run of runs) {
    if (!run.rule && !run.t) continue;
    left = Math.min(left, run.x ?? 0);
    right = Math.max(right, (run.x ?? 0) + Math.max(run.w ?? 0, 0.5));
  }
  const hasRunBounds = Number.isFinite(left) && Number.isFinite(right) && right > left;
  const hasTextInk = runs.some((run) => !run.rule && !!run.t);
  commands.push({
    op: 'sourcebox',
    x: r2(X + (hasRunBounds ? left : 0)),
    y: r2(baseline - (unit.ln.boxH ?? unit.h ?? 0)),
    w: r2(Math.max(hasRunBounds ? right - left : (unit.ln.gfxChunk?.w ?? fallbackWidth), 1)),
    h: r2(Math.max((unit.ln.boxH ?? unit.h ?? 0) + (unit.d ?? 0), 1)),
    line: unit.li,
    ink: hasTextInk ? 1 : undefined,
    src,
  });
}

/** Paint a harvested header/footer box (vbox-wrapped hbox items) with its
 * first line's baseline at anchorY. */
function paintHfItems(commands, items, X, anchorY, context) {
  let y = anchorY;
  let first = true;
  for (const it of items ?? []) {
    if (it.k === 'glue' || it.k === 'kern') {
      y += it.a ?? 0;
    } else if (it.k === 'box') {
      if (!first) y += it.h ?? 0;
      runCommands(commands, it.runs, X, y, '_hf', context);
      y += it.d ?? 0;
      first = false;
    }
  }
}

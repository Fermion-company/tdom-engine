import { fnv1a } from '../hash.js';
import { remapText } from './mathmap.js';
import { classifyResidentRun } from './run-semantics.js';
import { r2 } from './util/svg.js';

// Half a bp is smaller than one device pixel at common preview zoom levels,
// so fractional CSS clipping could still shave antialiased math ink. Two bp
// remains well inside ordinary TeX line spacing while surviving that rounding.
const EXACT_CHUNK_BLEED_BP = 2;
// A run cut out of an earlier picture (exact-parts.js) takes less to its
// sides than above and below: what stands beside it in that picture is
// other ink of that line, which may not be beside it any more.
const EXACT_PART_SIDE_BLEED_BP = 0.75;

// A page is built again with every keystroke on it, and all but a line or
// two of it is what it was: the lines of the blocks that did not change, at
// the places they had. On a dense page of Japanese text (a run a character,
// 1,500 commands, 195 KB) making those commands again and hashing the whole
// page's JSON was a quarter of the engine's time for the keystroke.
//  - LINE_COMMANDS: the commands of a line that is glyphs and rules only,
//    kept with the line (stream.js keeps a block's lines while its galley
//    and pictures stay) and used again while it stands at the same place.
//    Fonts never change under a line: a demoted family rebuilds every
//    block's lines (fidelity-gate.js).
//  - COMMAND_HASH: the page's hash is made of one hash per command, kept
//    with the command, so only new commands are serialised for it. It is
//    still a function of the commands' content alone.
// TDOM_NO_LINE_REUSE=1: build every line and hash the page's JSON, as before.
const NO_LINE_REUSE = !!process.env.TDOM_NO_LINE_REUSE;
const LINE_COMMANDS = new WeakMap();
const COMMAND_HASH = new WeakMap();
function hashCommands(commands) {
  if (NO_LINE_REUSE) return fnv1a(JSON.stringify(commands));
  let joined = '';
  for (const command of commands) {
    let hash = COMMAND_HASH.get(command);
    if (hash === undefined) COMMAND_HASH.set(command, hash = fnv1a(JSON.stringify(command)));
    joined += hash + ',';
  }
  return fnv1a(joined);
}

/** The chunk holding page `page`'s head (`h`) or foot (`f`) band cut from a
 * canonical page: used when that band is drawn with graphics. */
export function hfBandChunkKey(page, which) {
  return `__hf-${page}-${which}`;
}

export function buildDisplayList(page, { geometry, chunks, hf, hfSig, fonts, twinMetrics }) {
  const geo = geometry;
  const L = 72 + (geo.oddsidemargin ?? 0);
  const T = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
  const commands = [];
  for (const src of page.pendingExact ?? []) {
    // The absent block has no geometry yet; the signal is deliberately
    // page-wide and contributes no fabricated coordinates or dimensions.
    commands.push({ op: 'pending-exact', src, wholePage: 1 });
  }
  let gfxOpen = null;
  const flushGfx = () => {
    if (!gfxOpen) return;
    const meta = chunks.get(gfxOpen.blockId);
    // PDF/SVG ink may overhang TeX's logical box (notably subscripts,
    // superscripts and large operators). Keep the chunk clipped, but give its
    // outer band a bounded bleed that also survives browser pixel rounding.
    const chunkHeight = Math.max(0, meta?.hBp ?? gfxOpen.clip1);
    const clip0 = Math.min(chunkHeight, Math.max(0, gfxOpen.clip0 - EXACT_CHUNK_BLEED_BP));
    const clip1 = Math.min(chunkHeight, gfxOpen.clip1 + EXACT_CHUNK_BLEED_BP);
    const visibleHeight = Math.max(0, clip1 - clip0);
    const logicalHeight = gfxOpen.clip1 - gfxOpen.clip0;
    if (gfxOpen.units === 1 && logicalHeight > Math.max(12, gfxOpen.covered * 2)) {
      commands.push({
        op: 'sourcebox',
        x: r2(L),
        y: r2(gfxOpen.top + gfxOpen.clip0),
        w: r2(gfxOpen.w),
        h: r2(logicalHeight),
        ink: gfxOpen.ink ? 1 : undefined,
        chunk: 1,
        complex: 1,
        src: gfxOpen.blockId,
      });
    }
    commands.push({
      op: 'chunk',
      chunk: gfxOpen.blockId,
      // The SVG already contains paragraph indentation. Anchor it at the
      // text block origin; adding run.x here would indent exact lines twice.
      x: r2(L + (meta?.xBp ?? 0)),
      y: r2(gfxOpen.top + clip0),
      w: r2(meta?.wBp ?? gfxOpen.w),
      h: r2(visibleHeight),
      sy: r2(clip0),
      ch: r2(chunkHeight),
      cv: meta?.v ?? 0,
      st: gfxOpen.stale ? 1 : undefined, // stale-exact: previous pixels held
      held: gfxOpen.held ? 1 : undefined, // an earlier galley's own pixels: display only (#103)
      // The picture is shown only through these openings, [x, y, w, h] on
      // the page: the runs that need exact pixels. The rest of each line is
      // drawn by the glyph layer (`ov` commands), under the picture's window.
      show: gfxOpen.show && !gfxOpen.whole ? gfxOpen.show : undefined,
      line: gfxOpen.units === 1 ? gfxOpen.line : undefined,
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
      const unitInk = unitRuns.some((run) => runPaintsInk(run, u.ln.backend));
      const unitExtent = Math.max(0, (u.h ?? 0) + (u.d ?? 0));
      const reveal = u.ln.reveal ?? null;
      if (gfxOpen && gfxOpen.blockId === c.blockId && Math.abs(gfxOpen.top - chunkTop) < 0.05) {
        gfxOpen.clip1 = Math.max(gfxOpen.clip1, clip1);
        gfxOpen.stale ||= !!c.stale;
        gfxOpen.held ||= !!c.held;
        gfxOpen.units++;
        if (gfxOpen.line !== u.li) gfxOpen.line = null;
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
          held: !!c.held,
          line: u.li,
          units: 1,
          covered: unitExtent,
          ink: unitInk,
        };
      }
      if (reveal) {
        // the same boxes a cut-out of this run would have (partCommands)
        gfxOpen.show ??= [];
        for (const part of reveal.parts) {
          gfxOpen.show.push([
            r2(L + part.x - EXACT_PART_SIDE_BLEED_BP), r2(baseline + part.top - EXACT_CHUNK_BLEED_BP),
            r2(part.w + 2 * EXACT_PART_SIDE_BLEED_BP), r2(part.h + 2 * EXACT_CHUNK_BLEED_BP),
          ]);
        }
      } else gfxOpen.whole = true; // a line of this window that is shown whole
      // Exact pixels cover this line; the unchanged TeX run extents provide
      // one transparent source-line hit surface underneath the chunk.
      sourceHitCommand(commands, L, baseline, u, u.blockId, 1, fonts);
      if (reveal) {
        // (drawn over the hit surface and marked `ov`: the viewer shows them
        // and gives them no part in editing, which goes by the picture)
        runCommands(commands, reveal.runs, L, baseline, u.blockId, {
          fonts, twinMetrics, line: u.li, backend: u.ln.backend, over: true,
        });
      }
      continue;
    }
    flushGfx();
    if (u.cn || u.ln.pendingExact) {
      // canonical-only band (margin-bearing blocks): blank in the
      // provisional layer, the canonical page supplies the pixels —
      // advertised so the referee counts real lines here as covered
      commands.push({
        // Suppressed glyphs must retain a paint requirement. Without this
        // marker an atomic viewer could publish the otherwise complete page
        // while a formula, graphic, float or footnote was entirely absent.
        op: u.cn ? 'canon' : 'pending-exact',
        x: r2(L),
        y: r2(baseline - u.ln.boxH),
        w: r2(geo.textwidth),
        h: r2(u.ln.boxH + (u.d ?? 0)),
        src: u.blockId,
      });
      sourceHitCommand(commands, L, baseline, u, u.blockId, geo.textwidth, fonts);
      continue;
    }
    const kept = !NO_LINE_REUSE && !u.ln.parts ? LINE_COMMANDS.get(u) : null;
    if (kept && kept.L === L && kept.baseline === baseline && kept.fonts === fonts && kept.twinMetrics === twinMetrics &&
        kept.runs === u.ln.runs && kept.src === u.blockId && kept.line === u.li && kept.backend === u.ln.backend) {
      for (const command of kept.commands) commands.push(command);
      continue;
    }
    const first = commands.length;
    runCommands(commands, u.ln.runs, L, baseline, u.blockId, {
      fonts,
      twinMetrics,
      line: u.li,
      backend: u.ln.backend,
    });
    if (u.ln.parts) partCommands(commands, u, L, baseline, chunks.get(u.ln.partsChunk ?? u.blockId), fonts);
    else if (!NO_LINE_REUSE) {
      LINE_COMMANDS.set(u, {
        L, baseline, fonts, twinMetrics, runs: u.ln.runs, src: u.blockId, line: u.li, backend: u.ln.backend,
        commands: commands.slice(first),
      });
    }
  }
  flushGfx();
  // Header / footer: TeX-typeset boxes from the page-style job (the exact
  // \@oddhead/\@oddfoot with the page's real folio format, style and
  // marks). \@outputpage geometry: head box bottom at topmargin+headheight,
  // foot baseline \footskip below the text area.
  // A page shipped whole (iso `full` chunk) is cropped to the text area, so
  // its own head and foot are not in the picture. The header job reads the
  // page's style events (a \thispagestyle{empty} in it included), so its
  // entry is still the page's furniture; only the provisional folio, which
  // knows no style, is withheld (tdom-engine #17: running heads and folios
  // vanished from every page a two-column block filled).
  const hfEntry = hf?.get(page.number);
  if (hfEntry) {
    const headBand = { top: 0, bottom: T };
    const footBand = { top: T + geo.textheight, bottom: geo.paperheight };
    for (const [which, anchorY, band] of [
      ['h', 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0), headBand],
      ['f', T + geo.textheight + (geo.footskip ?? 30), footBand],
    ]) {
      // (one overlay picture in the head may paint the foot too: either
      // band with graphics takes both from the canonical page)
      if (!hfEntry.hg && !hfEntry.fg) {
        paintHfItems(commands, hfEntry[which], L, anchorY, { fonts, twinMetrics });
        continue;
      }
      // Graphics in the head or foot (TikZ against `current page`): the
      // canonical page's own band, when one has been cut for this page
      // (canonical-arrival.js cropCanonicalHeaderBands).
      const key = hfBandChunkKey(page.number, which);
      const meta = chunks.get(key);
      if (!meta || !(band.bottom > band.top)) continue;
      commands.push({
        op: 'chunk',
        chunk: key,
        x: 0,
        y: r2(band.top),
        w: r2(meta.wBp),
        h: r2(meta.hBp),
        sy: 0,
        ch: r2(meta.hBp),
        cv: meta.v ?? 0,
        src: '_hf',
      });
    }
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
  dl.hash = hashCommands(commands);
  dl.hfSig = hfSig; // this page's own head and foot: rebuilt when they change (header-footer.js pageHfSig)
  return dl;
}

/** The exact runs of a composed line (stream.js `parts`): each a window on
 * the block's picture in hand, which was made for an earlier galley. `sx`
 * and `sy` say where in that picture the window looks, `cw` how wide the
 * whole picture is; `held` keeps every reader of exact pixels (editing
 * geometry, the publication referee) from taking them for the current
 * source's. Text between the windows is ordinary glyph commands. */
function partCommands(commands, unit, X, baseline, meta, fonts) {
  if (!meta) return;
  const pad = -(meta.xBp ?? 0);
  const width = meta.wBp ?? 0;
  const height = meta.hBp ?? 0;
  for (const part of unit.ln.parts) {
    let sx = part.sx + pad - EXACT_PART_SIDE_BLEED_BP;
    let x = X + part.x - EXACT_PART_SIDE_BLEED_BP;
    let w = part.w + 2 * EXACT_PART_SIDE_BLEED_BP;
    if (sx < 0) { x -= sx; w += sx; sx = 0; }
    w = Math.min(w, width - sx);
    let sy = part.sy - EXACT_CHUNK_BLEED_BP;
    let y = baseline + part.top - EXACT_CHUNK_BLEED_BP;
    let h = part.h + 2 * EXACT_CHUNK_BLEED_BP;
    if (sy < 0) { y -= sy; h += sy; sy = 0; }
    h = Math.min(h, height - sy);
    if (!(w > 0) || !(h > 0)) continue;
    const run = unit.ln.editRuns?.[part.runIndex];
    commands.push({
      op: 'chunk',
      chunk: unit.ln.partsChunk ?? unit.blockId,
      x: r2(x),
      y: r2(y),
      w: r2(w),
      h: r2(h),
      sx: r2(sx),
      sy: r2(sy),
      cw: r2(width),
      ch: r2(height),
      cv: meta.v ?? 0,
      held: 1,
      part: 1,
      partGlyphs: partMathGlyphs(run, X, baseline, fonts),
      partRule: run?.rule && run.w > 0 && run.h > 0
        ? [r2(X + run.x), r2(baseline + run.dy), r2(run.w), r2(run.h)] : undefined,
      line: unit.li,
      src: unit.blockId,
    });
  }
}

// The picture can come from an earlier render, but these positions belong
// to the current TeX run. They're also the hit geometry for its MathLive input.
function partMathGlyphs(run, origin, lineBaseline, fonts) {
  if (!run?.m || !run.t) return undefined;
  const font = fonts.get(run.f);
  if (!font) return undefined;
  const chars = [...(font.remap ? remapText(run.t, font.remap) : run.t)];
  const offsets = chars.length === 1 ? [0] : run.gp;
  if (!offsets || offsets.length !== chars.length) return undefined;
  const baseline = r2(lineBaseline + (run.dy ?? 0));
  const top = r2(baseline - run.gh), bottom = r2(baseline + run.gd);
  if (!(bottom > top)) return undefined;
  const glyphs = [];
  for (let index = 0; index < chars.length; index++) {
    const left = r2(origin + run.x + offsets[index]);
    const right = r2(origin + run.x + (offsets[index + 1] ?? run.w));
    if (!(right > left)) return undefined;
    glyphs.push({ text: chars[index], left, right, top, bottom, baseline });
  }
  return glyphs;
}

/** Paint one run list (glyphs + rules) at a baseline — shared by body
 * units and the TeX-typeset header/footer boxes. */
function runCommands(commands, runs, X, baseline, src, { fonts, twinMetrics, line, backend = null, over = false }) {
  for (const r of runs ?? []) {
    if (r.rule) {
      // Geometry is not a paint oracle: a normal zero-area PDF rule may be a
      // visible device hairline. Only a backend-certified empty_rule is
      // omitted. Fidelity has already routed unknown or zero-area normal
      // rules to an exact TeX chunk, so this renderer remains fail-closed.
      if (classifyResidentRun(r, backend).tag === 'LayoutOnly') continue;
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
        ov: over ? 1 : undefined,
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
      const command = {
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
        math: r.m || fmeta?.mth ? 1 : undefined,
        ov: over ? 1 : undefined,
      };
      if (over) {
        // Ink only (the viewer gives it no part in editing): the runs of a
        // line that share font, size, baseline and colour go as one command,
        // each run's place and text in `runs`. A Japanese line is a run a
        // character; one command a run made the page's patch half as large
        // again, and the viewer build a node for every character of every
        // such line on the page with every keystroke.
        const last = commands[commands.length - 1];
        if (last && last.ov && last.op === 'glyphs' && last.runs && last.fam === command.fam && last.size === command.size &&
            last.y === command.y && last.color === command.color && last.math === command.math && last.src === src && last.line === line) {
          last.runs.push([command.x, text]);
          last.text += text;
          last.w = r2(command.x + command.w - last.x);
          last.gh = Math.max(last.gh, command.gh);
          last.gd = Math.max(last.gd, command.gd);
          continue;
        }
        command.runs = [[command.x, text]];
      }
      commands.push(command);
    }
  }
}

/** The commands a harvested line would paint at the position its source hit
 * box records (sourceHitCommand: x = origin + first ink run, y = baseline -
 * box height). A block whose exact chunk owns its pixels never emits them,
 * yet canonical-anchor may repaint one plain line of such a block over the
 * canonical page. Null when the line has no ink run to pin its origin. */
export function sourceBoxLineCommands(sourcebox, item, { src, line, fonts, twinMetrics, backend = null }) {
  const runs = item?.runs ?? [];
  let left = Infinity;
  for (const run of runs) {
    if (!run.rule && !run.t) continue;
    left = Math.min(left, run.x ?? 0);
  }
  const x = Number(sourcebox?.x);
  const y = Number(sourcebox?.y);
  const boxH = Number(item?.h ?? 0);
  if (!Number.isFinite(left) || ![x, y, boxH].every(Number.isFinite)) return null;
  const commands = [];
  runCommands(commands, runs, x - left, y + boxH, src, { fonts, twinMetrics, line, backend });
  return commands;
}

function runPaintsInk(run, backend) {
  if (!run?.rule) return !!run?.t;
  const semantics = classifyResidentRun(run, backend);
  return semantics.tag !== 'LayoutOnly' && Number(run.w) > 0 && Number(run.h) > 0;
}

function sourceHitCommand(commands, X, baseline, unit, src, fallbackWidth = 1, fonts = new Map()) {
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
    math: runs.some((run) =>
      !run.rule && !!run.t && (!!run.m || !!fonts.get(run.f)?.mth)
    ) ? 1 : undefined,
    stale: unit.ln.gfxChunk?.stale ? 1 : undefined,
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

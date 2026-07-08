import path from 'node:path';
import { fnv1a } from '../hash.js';
import { documentBounds } from '../segmenter.js';
import { buildIsoCompileSource } from './tex-templates.js';

export function prepareIsoCompileJob({
  block,
  idx,
  forceCold,
  checkpoints,
  isoForkBroken,
  blocks,
  counters,
  text,
  workDir,
  labelTable,
  geometry,
  needsRescue,
  breakableRe,
}) {
  // Fork mode: rescue in a child forked from the pristine post-preamble
  // checkpoint (ckpt:0) — the preamble (the 10-15s / 300-500MB part of a
  // cold iso on package-heavy documents) is already loaded and COW-shared.
  // Cold mode remains the fallback when no resident root exists (opaque
  // mode, boot failure) or infra fails before the fork happens.
  // \includepdf keeps the REAL output routine (page-emitting) — that
  // cannot run in a fork child yet (inherited dormant page state breaks
  // it under luatexja), so it always compiles cold. Everything else
  // forks with the iso absorb; a fork run that DISCARDS (a split was
  // actually needed at this offset) retries cold with the real routine.
  const includesPdf = /\\includepdf\b/.test(block.text);
  const ck0 =
    !forceCold &&
    !process.env.TDOM_ISO_COLD &&
    !isoForkBroken.has(block.id) &&
    !includesPdf
      ? checkpoints.get(0)
      : null;
  // label values as injected into THIS run — recorded on the result so
  // resolvedInGalley can compare exactly (see #jobBlock's refSnapshot)
  const labelSnap = new Map(labelTable);
  const entry = {};
  const prevVec = idx > 0 ? JSON.parse(blocks[idx - 1].stateVec ?? '[]') : [];
  counters.forEach((c, i) => {
    entry[c] = prevVec[i] ?? 0;
  });
  // tail layout: [...counters, tdom@pd, tdom@nobreak, tdom@ls]
  const prevPd = idx > 0 && prevVec.length >= 3 ? prevVec[prevVec.length - 3] : -65536000;
  const prevNobreak = idx > 0 && prevVec.length >= 2 ? prevVec[prevVec.length - 2] === 1 : false;
  const bounds = documentBounds(text);
  const jobdir = path.join(workDir, `rescue-${block.id}-${fnv1a(block.text)}`);
  // absolute path injected into inline Lua (fork mode): single-quoted, so
  // escape the characters that would break the literal
  const jobdirForBody = jobdir.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  needsRescue(block.text); // populate _breakableRe for this preamble
  const splitMode =
    !includesPdf &&
    (/\\begin\{(mdframed|framed|shaded|longtable|multicols\*?)\}|\\begin\{tcolorbox\}\[[^\]]*breakable/.test(
      block.text
    ) ||
      (breakableRe()?.test(block.text) ?? false));
  // Page-EMITTING blocks (\includepdf: whole foreign pages) keep the REAL
  // output routine so every page ships and becomes a per-page chunk. The
  // dormant absorb would hand their zero-dimension page paintings back to
  // the galley as invisible material (pdfpages draws via a 0pt picture
  // box). Galley-material blocks keep the absorb as before.
  //
  // SPLITTING environments (mdframed / framed / breakable tcolorbox) also
  // keep the real routine: their page-splitting machinery only runs
  // inside \output, so under the dormant absorb a box that must break
  // simply never makes progress (runaway → discard → failed compile).
  // With the real routine the box splits exactly as in print: full pages
  // ship as per-page chunks (page 1 cropped below the entry strut), and
  // the final partial page stays on the galley for the normal remainder
  // harvest. A box that FITS never fires the routine, so its galley is
  // byte-identical to the absorb path.
  // fork children always run the iso absorb: the real routine cannot run
  // against the inherited dormant page state yet (box255/unbox cascades
  // under luatexja). A fork run whose absorb DISCARDS (the env truly had
  // to split at this offset) is retried cold below, where the real
  // routine splits exactly as in print.
  const realOutput = !ck0 && (includesPdf || splitMode);
  // page-context strut: reproduce the block's true on-page start position
  // so splitting environments (mdframed & co.) measure the same
  // \pagegoal-\pagetotal as in print. The iso page's own \topskip already
  // contributed, so the strut is the entry \pagetotal minus that.
  // 0.25bp quantum (≈0.09mm — invisible): keys, struts and the
  // moved-offset comparison all use the same grid, so float-noise drifts
  // can never force a recompile, and both engines compile identical
  // galleys for offsets inside one quantum (condition D stays exact)
  const entryOff = Math.round((block.pageOffset ?? 0) * 4) / 4;
  const topskipW =
    typeof geometry?.topskip === 'object'
      ? geometry.topskip.w ?? 0
      : geometry?.topskip ?? 0;
  // clamp inside the page: an offset captured mid-breakage can exceed
  // \textheight, which would start the box below the page and spin the
  // dormant absorb (runaway → discard → failed compile)
  const maxStrut = Math.max(0, (geometry?.textheight ?? Infinity) - 1);
  const strut = Math.min(Math.max(0, entryOff - topskipW), maxStrut);
  const prevLsSp = idx > 0 ? prevVec[prevVec.length - 1] ?? 0 : 0;
  const isoTex = buildIsoCompileSource({
    ck0,
    preamble: text.slice(bounds.preamble.start, bounds.preamble.end),
    jobdirForBody,
    labelTable,
    entry,
    counters,
    geometry,
    blockText: block.text,
    prevPd,
    prevNobreak,
    prevLsSp,
    realOutput,
    strut,
  });
  return {
    ck0,
    labelSnap,
    jobdir,
    pdf: path.join(jobdir, ck0 ? 'driver.pdf' : 'iso.pdf'),
    statePath: path.join(jobdir, 'state.json'),
    splitMode,
    strut,
    entryOff,
    isoTex,
  };
}

// Pages the viewer asked to have warmed whose warm another warm overtook
// (docs/10 §10.4r).
//
// A long document's boot renders no block's exact picture (background-
// scheduler.js: canonical paints the pages). A page of such pictures the
// viewer has to show provisionally (after an edit, or a page staged at the
// boot) owes their ink until its blocks are rendered, and only a warm of the
// page renders them: the viewer sends POST /warm {page} for the page it
// shows that owes ink (web/app.js scheduleViewportWarm). Each warm overtakes
// the one before it (engine-v3.js warmEditOffset, `warmSeq`), so a reader
// who scrolls on within a second or two leaves the page behind unwarmed,
// and the viewer asks for it again only when it is scrolled to again. On the
// 30-page booklet the app's probe looked at pages 29-31 and 25-28 half a
// second each, 8 s and 45 s after typing a lesson: page 26's Data box was
// never rendered, and the page kept an older paper both times (tex64-internal
// #121, round 10).
//
// Such a page is kept here (the newest few) and warmed again once nothing
// else runs: no update, no walk, no edit or warm for QUIET_MS. A page that
// no longer owes ink is dropped; each page is tried a few times per source
// revision. Every turn waits on a timer.
const MAX_PAGES = 8;
const QUIET_MS = 600;
const MAX_TRIES = 3;

/** Whether page `number` still has a block whose exact picture is missing or stale. */
export function pageOwesExact(engine, number) {
  const page = engine.pages?.find((p) => p.number === number);
  if (!page) return false;
  const ids = new Set((page.draw ?? []).map((d) => d.u?.blockId));
  return engine.blocks.some((block) => ids.has(block.id) && block.needsRender &&
    engine.chunkTargetsOf(block).some((t) => engine.chunks.get(t.key)?.forGalley !== block.galleyHash));
}

/** A warm of page `number` was overtaken: warm it again later (`warm(number)`). */
export function noteOvertakenPage(engine, number, warm) {
  if (engine.closed || !Number.isSafeInteger(number)) return;
  const queue = (engine.overtakenPages ??= new Map());
  // (the chunk map is the document's: a page of the document before an open is not warmed)
  const entry = queue.get(number)?.chunks === engine.chunks ? queue.get(number) : { tries: 0, srcRev: engine.srcRev, chunks: engine.chunks };
  if (entry.srcRev !== engine.srcRev) {
    entry.tries = 0;
    entry.srcRev = engine.srcRev;
  }
  queue.delete(number);
  queue.set(number, entry); // the newest last
  while (queue.size > MAX_PAGES) queue.delete(queue.keys().next().value);
  arm(engine, warm, QUIET_MS);
}

function arm(engine, warm, ms) {
  if (engine.overtakenTimer || engine.closed) return;
  engine.overtakenTimer = setTimeout(() => {
    engine.overtakenTimer = null;
    drain(engine, warm).catch((err) => engine.diagnostics?.push(`page warm: ${err?.message ?? err}`));
  }, ms);
  engine.overtakenTimer.unref?.();
}

async function drain(engine, warm) {
  const queue = engine.overtakenPages;
  if (!queue?.size || engine.closed || engine.mode !== 'structured') return;
  // quiet: measured from the last edit and from the last warm anyone started
  const seen = (engine.overtakenSeen ??= { seq: engine.warmSeq, at: Date.now() });
  if (seen.seq !== engine.warmSeq) {
    seen.seq = engine.warmSeq;
    seen.at = Date.now();
  }
  const since = Date.now() - Math.max(engine.lastEditAt ?? 0, seen.at);
  if (engine.updating || engine.warming || engine.editPending > 0 || since < QUIET_MS) {
    arm(engine, warm, Math.max(50, QUIET_MS - since));
    return;
  }
  const [number, entry] = [...queue].at(-1);
  queue.delete(number);
  if (entry.srcRev !== engine.srcRev) {
    // (an edit since: the page is the new source's, tried afresh)
    entry.tries = 0;
    entry.srcRev = engine.srcRev;
  }
  if (entry.chunks === engine.chunks && entry.tries < MAX_TRIES && pageOwesExact(engine, number)) {
    entry.tries++;
    engine.overtakenStats ??= { warms: 0 };
    engine.overtakenStats.warms++;
    const result = await warm(number).catch(() => null);
    seen.seq = engine.warmSeq;
    seen.at = Date.now();
    // (overtaken again: warmPage noted it again, with its tries)
    if (result?.status === 'superseded' && queue.has(number)) queue.get(number).tries = Math.max(queue.get(number).tries, entry.tries);
  }
  if (queue.size) arm(engine, warm, QUIET_MS);
}

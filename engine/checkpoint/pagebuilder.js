// pagebuilder.js — TeX's page builder + LaTeX's output routine, transcribed.
//
// The input stream is the document's REAL main vertical list (harvested
// node-by-node from the resident lualatex, see daemon.lua): boxes, glue with
// full stretch/shrink specs, penalties (club/widow/section — TeX's own
// values), footnote inserts at their true stream positions, float anchors
// and eject markers. This module re-runs, in JavaScript, exactly the
// algorithms that consume that list in a vanilla run:
//
//   - the page builder's break-cost machinery (tex.web §1005–1008):
//     legal breakpoints, badness, insert accounting against \pagegoal,
//     best-break selection, \topskip, \maxdepth;
//   - LaTeX's float placement (ltoutput: \@addtocurcol, \@addtotoporbot,
//     \@addtobot, \@startcolumn, \@tryfcolumn) with the class's real
//     \topfraction/\bottomfraction/\textfraction/\floatpagefraction,
//     topnumber/bottomnumber/totalnumber and separation glues;
//   - \@makecol page assembly: \skip\footins + the class's measured
//     \footnoterule recipe + stacked inserts, \@combinefloats, and the
//     final vbox-to-\@colht glue setting (which is what makes
//     \raggedbottom/\flushbottom come out right: the .0001fil absorbs
//     the slack exactly like TeX's glue setting does).
//
// No dimension in this file is invented; everything comes from the stream
// or from parameters measured in the live TeX run.

const AWFUL = 0x3fffffff; // tex.web awful_bad
const INF_BAD = 10000;
const DEPLORABLE = 100000;
const EJECT = -10000;
const FIL = 65536 / 65781.76; // 1fil in bp units (the stream's bp scale)
const ORDERS = 5; // LuaTeX glue orders: normal, fi, fil, fill, filll

// TeX's badness function (tex.web §108), computed in scaled points.
function badness(tBp, sBp) {
  const t = Math.round(tBp * 65781.76);
  const s = Math.round(sBp * 65781.76);
  if (t === 0) return 0;
  if (s <= 0) return INF_BAD;
  let r;
  if (t <= 7230584) r = Math.floor((t * 297) / s);
  else if (s >= 1663497) r = Math.floor(t / Math.floor(s / 297));
  else r = t;
  if (r > 1290) return INF_BAD;
  return Math.floor((r * r * r + 0x20000) / 0x40000);
}

const G0 = { w: 0, st: 0, sh: 0, sto: 0, sho: 0 };
function glueOf(g, fallbackW = 0) {
  if (g == null) return { ...G0, w: fallbackW };
  if (typeof g === 'number') return { ...G0, w: g };
  return { w: g.w ?? 0, st: g.st ?? 0, sh: g.sh ?? 0, sto: g.sto ?? 0, sho: g.sho ?? 0 };
}
function negGlue(g) {
  return { w: -g.w, st: -g.st, sh: -g.sh, sto: g.sto, sho: g.sho };
}

/** Parse a float placement spec exactly like \@xfloat parses #2. */
export function parsePlacement(spec) {
  let bits = 0;
  let bang = false;
  for (const ch of String(spec || '').toLowerCase()) {
    if (ch === 'h') bits |= 1;
    else if (ch === 't') bits |= 2;
    else if (ch === 'b') bits |= 4;
    else if (ch === 'p') bits |= 8;
    else if (ch === '!') bang = true;
  }
  if (bits === 0) bits = 2 | 4 | 8; // \@fpsadddefault (tbp)
  if (bits === 1) bits = 1 | 2; // \@resethfps: `h' alone becomes `ht'
  return { bits, bang };
}

/**
 * Build pages from the stream. `incr` (optional) enables incremental
 * repagination: `{ prevRun, dirtyFromSi, suffixStartNew, suffixShift }`
 * — resume from the last page boundary before the first divergent stream
 * index, and once a boundary in the clean suffix matches the previous
 * run's state, splice the remaining old pages instead of re-breaking
 * them. Editing cost becomes O(pages around the edit), not O(document).
 */
export function buildPages(stream, geo, incr = null) {
  const builder = new PageBuilder(stream, geo);
  const prevRun = incr && incr.prevRun && incr.prevRun.geo === geo ? incr.prevRun : null;
  const pages = builder.run(prevRun, incr ?? {});
  // \pagetotal at each block's entry — page-context-sensitive rescues
  // (mdframed & co.) need their true on-page start position. Blocks the
  // incremental run never re-processed keep their previous entry offsets.
  if (prevRun) {
    for (const [k, v] of prevRun.blockEntry) {
      if (!builder.blockEntry.has(k)) builder.blockEntry.set(k, v);
    }
  }
  pages.blockEntry = builder.blockEntry;
  pages.__run = {
    geo,
    pages,
    blockEntry: builder.blockEntry,
    snapshots: builder.snapshots,
    sawParityEvent: builder.sawParityEvent,
  };
  return pages;
}

class PageBuilder {
  constructor(stream, geo) {
    this.geo = geo;
    // Two-source consumption: `si` walks the pristine stream, `pending`
    // holds injected material (float bodies, penalties) and the leftovers
    // a fired page re-queues. Keeping the pristine stream untouched makes
    // a page-boundary snapshot O(carried items) instead of O(document).
    this.stream = stream;
    this.si = 0;
    this.pending = [];
    this.pages = [];
    this.deferlist = [];
    this.snapshots = []; // page-boundary resume points
    this.sawParityEvent = false; // \cleardoublepage / \pagenumbering seen

    this.textheight = geo.textheight;
    this.maxdepth = geo.atmaxdepth ?? geo.maxdepth ?? 4;
    this.topskip = glueOf(geo.topskip, 10);
    this.footskip = glueOf(geo.footinsskip, 9);
    this.footFactor = (geo.footinsfactor ?? 1000) / 1000;
    this.floatsep = glueOf(geo.floatsep, 12);
    this.textfloatsep = glueOf(geo.textfloatsep, 20);
    this.intextsep = glueOf(geo.intextsep, 12);
    this.fptop = glueOf(geo.fptop, 0);
    this.fpsep = glueOf(geo.fpsep, 8);
    this.fpbot = glueOf(geo.fpbot, 0);
    this.parskip = glueOf({ w: geo.parskip ?? 0, st: 1, sto: 0 }); // stream carries real parskip; only used for \vskip-\parskip after vmode h-floats
    this.interlinepenalty = geo.interlinepenalty ?? 0;
    this.raggedbottom = (geo.raggedbottom ?? 1) === 1;
    this.twoside = (geo.twoside ?? 0) === 1;
    this.folio = 1; // TeX's \c@page: assigned per emitted page, reset by \pagenumbering
    this.pendingFolio = null;
    this.footruleUnit = footruleUnitFor(geo);
    this.blockEntry = new Map(); // blockId -> \pagetotal at its first node
    // break-decision dump for offline referees (tools/compare-breaks.mjs):
    // when the host installs __TDOM_PAGE_DUMP__, every fired page's contents
    // (the pre-output body stream, natural glue values) is recorded
    this.dumpRec = typeof globalThis.__TDOM_PAGE_DUMP__ === 'function' ? [] : null;

    this.#startColumnState();
    this.#resetPage();
  }

  // ---- LaTeX column state (\@floatplacement / \@startcolumn) -------------

  #startColumnState() {
    const g = this.geo;
    this.colht = this.textheight; // \@colht
    this.colroom = this.colht; // \@colroom
    this.topnum = g.topnumber ?? 2;
    this.botnum = g.bottomnumber ?? 1;
    this.colnum = g.totalnumber ?? 3;
    this.toproom = (g.topfraction ?? 0.7) * this.colht;
    this.botroom = (g.bottomfraction ?? 0.3) * this.colht;
    this.fpmin = (g.floatpagefraction ?? 0.5) * this.colht;
    this.textfloatsheight = 0; // \@textfloatsheight
    this.toplist = [];
    this.botlist = [];
    this.midlist = [];
  }

  // ---- TeX page-builder state --------------------------------------------

  /** \cleardoublepage's blank verso: an empty page with \thispagestyle{empty},
   * emitted when the next folio would be even (twoside). */
  #emitBlankPage() {
    if (this.dumpRec) this.dumpRec.push({ blank: true });
    const folio = this.pendingFolio ?? this.folio;
    this.pendingFolio = null;
    this.folio = folio + 1;
    this.pages.push({
      number: this.pages.length + 1,
      folio,
      draw: [],
      identity: ['__blank' + (this.pages.length + 1)],
      startUnit: null,
      feet: [],
      topFloats: [],
      botFloats: [],
      evs: [{ k: 'thisstyle', a: 'empty' }],
    });
  }

  #resetPage() {
    this.contents = []; // placed entries: {e (stream entry), …}
    this.total = 0; // \pagetotal
    this.depth = 0; // \pagedepth
    this.prevdepth = null; // real \prevdepth (uncapped) for interline synthesis
    this.stretch = new Array(ORDERS).fill(0); // by LuaTeX order (fi..filll)
    this.shrink = 0;
    this.shrinkInf = false;
    this.hasBox = false; // topskip not yet inserted
    this.feet = []; // ins entries accepted on this page (in order)
    this.footSeen = false;
    this.best = null; // {index into contents, cost}
    this.lastPen = 0; // most recent penalty passed (for @nobreak emulation)
  }

  get goal() {
    // \pagegoal = \vsize (= \@colroom after float commits), reduced by
    // insert accounting (first footins: -\skip\footins; each: -height*f)
    let g = this.colroom;
    if (this.footSeen) {
      g -= this.footskip.w;
      for (const f of this.feet) g -= f.e.h * this.footFactor;
    }
    return g;
  }

  // pageht as \@specialoutput measures it before \@addtocurcol
  get pageht() {
    let h = this.total + this.depth;
    if (this.footSeen) {
      h += this.footskip.w;
      for (const f of this.feet) h += f.e.h * this.footFactor;
    }
    return h;
  }

  // ------------------------------------------------------------------ run

  #nextItem() {
    if (this.pending.length) return this.pending.shift();
    if (this.si < this.stream.length) return this.stream[this.si++];
    return null;
  }

  /** Peek the k-th upcoming item without consuming (pending first). */
  #peekItem(k) {
    if (k < this.pending.length) return this.pending[k];
    return this.stream[this.si + (k - this.pending.length)];
  }

  /** Boundary resume point — everything the builder carries across a page. */
  #snapshot() {
    return {
      si: this.si,
      pending: this.pending.slice(),
      deferlist: this.deferlist.slice(),
      folio: this.folio,
      pendingFolio: this.pendingFolio,
      sawParityEvent: this.sawParityEvent,
      pageCount: this.pages.length,
      col: {
        colroom: this.colroom,
        topnum: this.topnum,
        botnum: this.botnum,
        colnum: this.colnum,
        toproom: this.toproom,
        botroom: this.botroom,
        textfloatsheight: this.textfloatsheight,
        toplist: this.toplist.slice(),
        botlist: this.botlist.slice(),
        midlist: this.midlist.slice(),
      },
    };
  }

  #restore(s, pages) {
    this.si = s.si;
    this.pending = s.pending.slice();
    this.deferlist = s.deferlist.slice();
    this.folio = s.folio;
    this.pendingFolio = s.pendingFolio;
    this.sawParityEvent = s.sawParityEvent;
    this.pages = pages.slice(0, s.pageCount);
    this.colht = this.textheight;
    this.colroom = s.col.colroom;
    this.topnum = s.col.topnum;
    this.botnum = s.col.botnum;
    this.colnum = s.col.colnum;
    this.toproom = s.col.toproom;
    this.botroom = s.col.botroom;
    this.textfloatsheight = s.col.textfloatsheight;
    this.toplist = s.col.toplist.slice();
    this.botlist = s.col.botlist.slice();
    this.midlist = s.col.midlist.slice();
    this.#resetPage();
  }

  /**
   * Do two boundary states describe the same continuation? Stream items
   * compare by identity (clean blocks keep their unit objects across runs);
   * synthetic items (float glue/penalties) compare structurally; float and
   * unit references compare by identity.
   */
  #sameBoundary(a, b) {
    if (a.pending.length !== b.pending.length) return false;
    for (let i = 0; i < a.pending.length; i++) {
      if (!sameCarryItem(a.pending[i], b.pending[i])) return false;
    }
    if (a.deferlist.length !== b.deferlist.length) return false;
    for (let i = 0; i < a.deferlist.length; i++) {
      if (a.deferlist[i] !== b.deferlist[i]) return false;
    }
    const ca = a.col;
    const cb = b.col;
    if (
      ca.colroom !== cb.colroom || ca.topnum !== cb.topnum || ca.botnum !== cb.botnum ||
      ca.colnum !== cb.colnum || ca.toproom !== cb.toproom || ca.botroom !== cb.botroom ||
      ca.textfloatsheight !== cb.textfloatsheight ||
      ca.toplist.length !== cb.toplist.length || ca.botlist.length !== cb.botlist.length ||
      ca.midlist.length !== cb.midlist.length
    ) {
      return false;
    }
    for (let i = 0; i < ca.toplist.length; i++) if (ca.toplist[i] !== cb.toplist[i]) return false;
    for (let i = 0; i < ca.botlist.length; i++) if (ca.botlist[i] !== cb.botlist[i]) return false;
    for (let i = 0; i < ca.midlist.length; i++) if (ca.midlist[i] !== cb.midlist[i]) return false;
    if (a.pendingFolio !== b.pendingFolio) return false;
    return true;
  }

  run(prevRun = null, incr = {}) {
    // record the pristine start as a resume point (snapshot 0)
    this.snapshots.push(this.#snapshot());

    // ---- incremental resume: skip the clean prefix -----------------------
    let resyncFrom = null; // old-si -> old snapshot index list, armed below
    if (prevRun && Number.isFinite(incr.dirtyFromSi)) {
      let best = null;
      for (const s of prevRun.snapshots) {
        // everything a boundary carries was consumed from indices < si, so
        // any boundary at si <= first divergence is valid verbatim
        if (s.si <= incr.dirtyFromSi && (!best || s.si > best.si)) best = s;
      }
      if (best && best.pageCount <= prevRun.pages.length) {
        this.#restore(best, prevRun.pages);
        // resume points up to here stay valid for FUTURE edits too
        this.snapshots = prevRun.snapshots.slice(0, prevRun.snapshots.indexOf(best) + 1);
        resyncFrom = new Map();
        for (let i = 0; i < prevRun.snapshots.length; i++) {
          const s = prevRun.snapshots[i];
          if (!resyncFrom.has(s.si)) resyncFrom.set(s.si, []);
          resyncFrom.get(s.si).push(s);
        }
      }
    }
    const suffixStartNew = incr.suffixStartNew ?? Infinity;
    const suffixShift = incr.suffixShift ?? 0;

    for (;;) {
      // ---- resync: a boundary in the clean suffix that matches the old
      // run replays identically — splice the remaining old pages
      if (resyncFrom && this.justFired && this.pages.length && this.si >= suffixStartNew) {
        const candidates = resyncFrom.get(this.si - suffixShift) ?? [];
        const here = this.#snapshot();
        for (const old of candidates) {
          if (!this.#sameBoundary(here, { ...old, si: old.si + suffixShift })) continue;
          const folioDelta = here.folio - old.folio;
          if (folioDelta !== 0 && (this.sawParityEvent || old.sawParityEvent)) break;
          if (this.#spliceOldPages(prevRun, old, folioDelta, suffixShift)) {
            if (this.dumpRec) globalThis.__TDOM_PAGE_DUMP__(this.dumpRec);
            return this.pages;
          }
        }
      }
      this.justFired = false;

      const e = this.#nextItem();
      if (!e) break;
      // a block's first stream node: record its effective entry offset
      // (space already unavailable on this page: \pagetotal plus whatever
      // inserts/floats took off \pagegoal). FIRST-seen wins: this is the
      // position the block was GIVEN — where the real run's output routine
      // decides whether/where to break. Recording the post-requeue landing
      // instead creates a SECOND stable fixpoint for splitting rescues
      // ("plain galley re-broken by the builder at the next page top" vs
      // "eject-carrying galley compiled at the given offset"), and which one
      // an engine settles on depends on edit history (stress seed-21). With
      // the given position, the isolated real-routine compile is the single
      // authority for the break and the fixpoint is unique.
      if (e.first && e.bid && !this.blockEntry.has(e.bid)) {
        this.blockEntry.set(e.bid, this.textheight - this.goal + this.total);
      }
      switch (e.t) {
        case 'box':
          this.#contributeBox(e);
          break;
        case 'glue':
          this.#contributeGlue(e);
          break;
        case 'kern':
          this.#contributeKern(e);
          break;
        case 'pen':
          this.#contributePen(e);
          break;
        case 'ins':
          this.#contributeIns(e);
          break;
        case 'fm':
          this.#handleFloat(e);
          break;
        case 'eject':
          this.#handleEject(e);
          break;
        case 'enlarge':
          // \enlargethispage at this stream position: the CURRENT page's
          // goal grows; #startColumnState resets it for the next page
          this.colroom += e.a;
          break;
        case 'ev':
          // page-style event marker: rides the stream so its PAGE is exact,
          // but is transparent to spacing and break legality (the marker
          // whatsit exists only in the engine's stream, not in a vanilla
          // run — it must not change any break decision)
          if (e.k === 'pagenum' || e.k === 'cleardouble') this.sawParityEvent = true;
          if (e.k === 'pagenum') this.pendingFolio = 1;
          if (e.k === 'cleardouble') {
            // transcription of the classes' clear-to-parity tail: when the
            // NEXT page's folio parity is wrong, ship a blank page with
            // \thispagestyle{empty} — the page builder owns folios, so the
            // \ifodd\c@page the class would have evaluated is decided here
            const nextFolio = this.pendingFolio ?? this.folio ?? 1;
            const wantOdd = (e.a || 'odd') !== 'even';
            if (this.twoside && (nextFolio % 2 === 1) !== wantOdd) this.#emitBlankPage();
            break; // the marker itself never lands on a page
          }
          this.contents.push({ e });
          break;
        case 'tl':
          // tocline marker: transparent, page-anchors a contents entry
          this.contents.push({ e });
          break;
        default:
          break;
      }
    }
    // end of document: \enddocument runs \clearpage, whose \newpage puts
    //   \ifdim\prevdepth>\z@ \vskip-min(\prevdepth,\maxdepth) \fi \vfil
    // before the eject. NB LuaTeX glue orders run fi=1,fil=2,fill=3,filll=4
    // (the stream uses that encoding), so \vfil is order TWO here.
    this.finishing = true;
    if (this.contents.some((c) => c.e.t === 'box' || c.e.t === 'ins') ||
        this.toplist.length || this.botlist.length) {
      if (this.hasBox) {
        const pd = this.prevdepth ?? 0;
        if (pd > 0) {
          this.#contributeGlue({ t: 'glue', a: -Math.min(pd, this.maxdepth), st: 0, sto: 0, sh: 0, sho: 0 });
        }
        this.#contributeGlue({ t: 'glue', a: 0, st: FIL, sto: 2, sh: 0, sho: 0 });
      }
      this.#firePage(this.contents.length, null);
    }
    while (this.deferlist.length) {
      const made = this.#tryFloatColumn(true);
      if (!made) break;
    }
    if (!this.pages.length) this.#emitEmptyPage();
    if (this.dumpRec) globalThis.__TDOM_PAGE_DUMP__(this.dumpRec);
    return this.pages;
  }

  // ------------------------------------------------- contributions (§997+)

  #pageEmpty() {
    return !this.hasBox && this.feet.length === 0;
  }

  #contributeBox(e) {
    if (!this.hasBox) {
      // \topskip: glue above the first box, natural = max(topskip - h, 0)
      const eff = Math.max(this.topskip.w - e.u.h, 0);
      this.contents.push({
        e: { t: 'glue', a: eff, st: this.topskip.st, sto: this.topskip.sto, sh: this.topskip.sh, sho: this.topskip.sho, sub: 10 },
        topskip: true,
      });
      this.total += eff;
      this.stretch[this.topskip.sto] += this.topskip.st;
      if (this.topskip.sho === 0) this.shrink += this.topskip.sh;
      else if (this.topskip.sh) this.shrinkInf = true;
      this.hasBox = true;
    }
    this.total += this.depth + e.u.h;
    this.depth = e.u.d;
    this.prevdepth = e.u.d; // uncapped, unlike \pagedepth
    if (this.depth > this.maxdepth) {
      this.total += this.depth - this.maxdepth;
      this.depth = this.maxdepth;
    }
    this.contents.push({ e });
    this.#checkOverfull();
  }

  #contributeGlue(e) {
    if (!this.hasBox) return; // discardables above the first box are dropped
    // ev/tl markers are transparent: look through them for the legality check
    let pi = this.contents.length - 1;
    while (pi >= 0 && (this.contents[pi].e.t === 'ev' || this.contents[pi].e.t === 'tl')) pi--;
    const prev = this.contents[pi];
    const prevNondiscardable =
      prev && (prev.e.t === 'box' || prev.e.t === 'ins' || prev.e.t === 'rule');
    if (prevNondiscardable && this.#evalBreak(this.contents.length, 0, e)) {
      // the page fired; the glue re-enters via the queue in document order
      return;
    }
    this.contents.push({ e });
    this.total += e.a ?? 0;
    this.stretch[e.sto ?? 0] += e.st ?? 0;
    if ((e.sho ?? 0) === 0) this.shrink += e.sh ?? 0;
    else if (e.sh) this.shrinkInf = true;
  }

  #contributeKern(e) {
    if (!this.hasBox) return;
    // a kern is a breakpoint when immediately followed by glue (ev/tl
    // markers are transparent — peek through them)
    let k = 0;
    let next = this.#peekItem(k);
    while (next && (next.t === 'ev' || next.t === 'tl')) next = this.#peekItem(++k);
    if (next && next.t === 'glue' && this.#evalBreak(this.contents.length, 0, e)) {
      return;
    }
    this.contents.push({ e });
    this.total += e.a ?? 0;
  }

  #contributePen(e) {
    this.lastPen = e.v;
    if (!this.hasBox) return;
    if (e.v < INF_BAD) this.#evalBreak(this.contents.length, e.v, null);
    // Penalties occupy no space but MUST be stored: a glue whose previous
    // node is a (discardable) penalty is NOT a legal breakpoint — \nobreak
    // after headings relies on exactly this. Dropping the node here made
    // the following glue look box-preceded and legal, so pages broke right
    // after headings and every subsequent page under-filled.
    this.contents.push({ e });
  }

  #contributeIns(e) {
    // inserts are non-discardable; accepted even before the first box
    if (!this.footSeen) this.footSeen = true;
    const entry = { e };
    this.feet.push(entry);
    this.contents.push(entry);
    this.#checkOverfull();
  }

  #handleEject(e) {
    if (e.v <= -10001) {
      // \clearpage's second eject (\vbox{}\penalty-\@Mi): \@doclearpage
      // DISCARDS the ejected material (it is only the empty marker vbox)
      // when \footins is void, then flushes deferred floats as float pages.
      if (this.feet.length) {
        this.#firePage(this.contents.length, null);
      } else {
        // page-style event / tocline markers must survive the discard: they
        // belong to whatever page comes next (the discarded material is
        // invisible)
        const evs = this.contents.filter((c) => c.e.t === 'ev' || c.e.t === 'tl');
        this.contents = [];
        this.#resetPage();
        this.contents.push(...evs);
      }
      while (this.deferlist.length) {
        if (!this.#tryFloatColumn(true)) break;
      }
      return;
    }
    // \newpage (-10000): forced break at this point. A boxless page is
    // suppressed, but its event markers carry over to the next real page.
    if (this.hasBox || this.feet.length || this.toplist.length || this.botlist.length) {
      const fired = this.#evalBreak(this.contents.length, EJECT, null);
      if (!fired) this.#firePage(this.contents.length, null);
    }
  }

  // --------------------------------------------- break costs (tex.web §1005)

  /** @returns true when the page fired (pending item re-enters via queue). */
  #evalBreak(index, pi, pending) {
    if (pi >= INF_BAD) return false;
    let b;
    if (this.total < this.goal) {
      b = this.stretch[1] || this.stretch[2] || this.stretch[3] || this.stretch[4]
        ? 0
        : badness(this.goal - this.total, this.stretch[0]);
    } else if (this.total - this.goal > this.shrink && !this.shrinkInf) {
      b = AWFUL;
    } else {
      b = badness(this.total - this.goal, this.shrinkInf ? 1e9 : this.shrink);
    }
    let c;
    if (b < AWFUL) {
      if (pi <= EJECT) c = pi;
      else if (b < INF_BAD) c = b + pi;
      else c = DEPLORABLE;
    } else c = b;
    if (this.best === null || c <= this.best.cost) {
      this.best = { index, cost: c, pen: pi };
    }
    if (process.env.TDOM_DEBUG_BREAK) {
      console.error(
        `evalBreak idx=${index} pi=${pi} total=${this.total.toFixed(1)} goal=${this.goal.toFixed(1)} b=${b} c=${c} best=${this.best.index}/${this.best.cost}`
      );
    }
    if (c === AWFUL || pi <= EJECT) {
      if (process.env.TDOM_DEBUG_BREAK) {
        const around = this.contents
          .slice(Math.max(0, this.best.index - 3), this.best.index + 2)
          .map((x) => x.e.t + (x.e.t === 'pen' ? `(${x.e.v})` : x.e.t === 'box' ? `(h${(x.e.u?.h ?? 0).toFixed(0)})` : ''));
        console.error(`FIRE at ${this.best.index} pen=${this.best.pen} around=[${around.join(' ')}]`);
      }
      this.#firePage(this.best.index, this.best.pen, pending);
      return true;
    }
    return false;
  }

  #checkOverfull() {
    // a box/ins landing may push the page beyond goal+shrink with the next
    // breakpoint far away; TeX fires at the next legal breakpoint, which
    // #evalBreak handles — nothing to do eagerly.
  }

  /**
   * append_to_vlist's interline glue (tex.web §679) for a box the page
   * builder itself commits (inline float): baselineskip minus prevdepth
   * minus the box height, or lineskip when that falls under lineskiplimit.
   * Returns null when \prevdepth is in ignore state (fresh page).
   */
  #interlineGlue(boxHeight) {
    const pd = this.prevdepth;
    if (pd === null || pd <= -996) return null; // \ignoredepth (-1000pt)
    const g = this.geo;
    const b = (g.baselineskip ?? 0) - pd - boxHeight;
    if (b < (g.lineskiplimit ?? 0)) {
      return {
        t: 'glue', a: g.lineskip ?? 0, st: g.lineskipst ?? 0, sto: g.lineskipsto ?? 0,
        sh: g.lineskipsh ?? 0, sho: g.lineskipsho ?? 0, sub: 1,
      };
    }
    return {
      t: 'glue', a: b, st: g.baselineskipst ?? 0, sto: g.baselineskipsto ?? 0,
      sh: g.baselineskipsh ?? 0, sho: g.baselineskipsho ?? 0, sub: 2,
    };
  }

  // ------------------------------------------------------- float dispatch

  #floatHt(f) {
    return f.h + f.d;
  }

  /** \@addtocurcol — the float was just declared at the current position. */
  #handleFloat(e) {
    const f = e.f;
    let inserted = false;
    let inline = false;
    const fpstype = f.place.bang ? f.place.bits : f.place.bits | 16;
    if (fpstype !== 8 && fpstype !== 24) {
      // \@flsettextmin (+ accumulated h-float heights)
      let textmin = f.place.bang ? 0 : (this.geo.textfraction ?? 0.2) * this.colht;
      textmin += this.textfloatsheight;
      let reqcolroom = Math.max(textmin, this.pageht) + this.#floatHt(f);
      if (this.colroom > reqcolroom) {
        // \@flsetnum \@colnum
        if (this.colnum === 0 && f.place.bang) this.colnum = 1;
        if (this.colnum > 0) {
          const sameTypeDeferred = this.deferlist.some((d) => d.type === f.type);
          if (!sameTypeDeferred) {
            const sameTypeInBot = this.botlist.some((d) => d.type === f.type);
            if (sameTypeInBot) {
              inserted = this.#addToBot(f, reqcolroom);
            } else {
              if (f.place.bits & 1) {
                const req2 = reqcolroom + this.intextsep.w;
                if (this.colroom > req2) {
                  // inline `h` placement: the float becomes text material
                  this.colnum--;
                  this.textfloatsheight += this.#floatHt(f) + 2 * this.intextsep.w;
                  this.midlist.push(f);
                  // \@addtocurcol commits here-floats under \nointerlineskip
                  // (\@tempdima\prevdepth … \prevdepth\@tempdima): NO
                  // interline glue before the float box — the real node
                  // stream carries the \intextsep pair only (farm: corpus/03
                  // showed a phantom \lineskip per committed float)
                  const inject = [
                    { t: 'pen', v: this.lastPen >= INF_BAD ? INF_BAD : this.interlinepenalty },
                    { t: 'glue', a: this.intextsep.w, st: this.intextsep.st, sto: this.intextsep.sto, sh: this.intextsep.sh, sho: this.intextsep.sho },
                    { t: 'box', u: floatAsUnit(f) },
                    { t: 'pen', v: this.interlinepenalty },
                    { t: 'glue', a: this.intextsep.w, st: this.intextsep.st, sto: this.intextsep.sto, sh: this.intextsep.sh, sho: this.intextsep.sho },
                  ];
                  if (e.vmode) {
                    // \ifnum\outputpenalty<-\@Mii \vskip-\parskip\fi
                    const ng = negGlue(this.parskip);
                    inject.push({ t: 'glue', a: ng.w, st: ng.st, sto: ng.sto, sh: ng.sh, sho: ng.sho });
                  }
                  this.pending.unshift(...inject);
                  inserted = true;
                  inline = true;
                }
              }
              if (!inserted) inserted = this.#addToTopOrBot(f, reqcolroom);
            }
          }
        }
      }
    }
    if (process.env.TDOM_DEBUG_FLOATS) {
      console.error(`float ${f.id} [bits=${f.place.bits}] at pageht=${this.pageht.toFixed(1)} colroom=${this.colroom.toFixed(1)} -> ${inserted ? (inline ? 'inline' : 'top/bot') : 'defer'}`);
    }
    if (!inserted) this.deferlist.push(f);
    if (!inline) {
      // \@specialoutput tail: \addpenalty\interlinepenalty at the anchor
      // (\nobreak instead while @nobreak is in force, i.e. after a heading)
      this.pending.unshift({
        t: 'pen',
        v: this.lastPen >= INF_BAD ? INF_BAD : this.interlinepenalty,
      });
    }
  }

  /** \@addtotoporbot — reqcolroom arrives from the caller, like \@reqcolroom. */
  #addToTopOrBot(f, reqcolroom) {
    if (f.place.bits & 2) {
      if (this.topnum === 0 && f.place.bang) this.topnum = 1;
      if (process.env.TDOM_DEBUG_FLOATS) {
        console.error(`  toporbot ${f.id}: topnum=${this.topnum} sep=${this.toplist.length ? this.floatsep.w : this.textfloatsep.w} colroom=${this.colroom} req+sep=${reqcolroom + (this.toplist.length ? this.floatsep.w : this.textfloatsep.w)} toproom=${this.toproom} ht=${this.#floatHt(f)}`);
      }
      if (this.topnum > 0) {
        const sep = this.toplist.length ? this.floatsep.w : this.textfloatsep.w;
        // \@flcheckspace \@toproom \@toplist
        if (
          this.colroom > reqcolroom + sep &&
          (this.toproom > this.#floatHt(f) || f.place.bang)
        ) {
          const collision =
            this.midlist.some((d) => d.type === f.type) ||
            this.botlist.some((d) => d.type === f.type);
          if (!collision) {
            // \@flupdates
            this.topnum--;
            this.colnum--;
            this.toproom -= this.#floatHt(f) + sep;
            this.colroom -= this.#floatHt(f) + sep;
            this.toplist.push(f);
            return true;
          }
        }
      }
    }
    return this.#addToBot(f, reqcolroom);
  }

  /** \@addtobot */
  #addToBot(f, reqcolroom) {
    if (!(f.place.bits & 4)) return false;
    if (this.botnum === 0 && f.place.bang) this.botnum = 1;
    if (this.botnum <= 0) return false;
    const sep = this.botlist.length ? this.floatsep.w : this.textfloatsep.w;
    if (!(this.colroom > reqcolroom + sep)) return false;
    if (!(this.botroom > this.#floatHt(f) || f.place.bang)) return false;
    // \@flupdates (+ \global\maxdepth\z@ in \@addtobot — depth detail only)
    this.botnum--;
    this.colnum--;
    this.botroom -= this.#floatHt(f) + sep;
    this.colroom -= this.#floatHt(f) + sep;
    this.botlist.push(f);
    return true;
  }

  // ------------------------------------------------------ page completion

  /**
   * fire_up: contents[0..breakIndex) become the page; the breakpoint item is
   * consumed/discarded per TeX rules; later items (and their inserts) are
   * re-queued for the next page.
   */
  #firePage(breakIndex, breakPen, pending = null) {
    const placed = this.contents.slice(0, breakIndex);
    const rest = this.contents.slice(breakIndex);
    if (this.dumpRec) {
      this.dumpRec.push(dumpPageRecord(placed, breakPen, this.goal, this.total));
    }
    // stored entries after the break re-enter the stream, followed by the
    // item that was in flight when the page fired (document order!); the
    // discard rules of the fresh page then drop what TeX would drop.
    const requeue = [];
    for (const c of rest) {
      if (c.topskip) continue;
      requeue.push(c.e);
    }
    if (pending) requeue.push(pending);
    const feetOnPage = this.feet.filter((fe) => placed.includes(fe));
    this.#emitPage(placed, feetOnPage);

    // \@opcol: fresh column state, then \@startcolumn (float pages +
    // deferred float retry), then text resumes
    this.#startColumnState();
    this.#resetPage();
    while (this.#tryFloatColumn(false)) {
      /* successive float pages */
    }
    // \@startcolumn: retry the deferred floats for the new column (skipped
    // while finishing — the end-of-document path flushes via float pages)
    if (this.deferlist.length && !this.finishing) {
      const defer = this.deferlist;
      this.deferlist = [];
      for (const f of defer) this.#addToNextCol(f);
    }
    // re-feed the leftover items through the normal contribution path
    if (requeue.length) this.pending.unshift(...requeue);
    // page boundary complete: record the resume point and arm the resync
    // probe for the next loop iteration
    if (!this.finishing) {
      this.snapshots.push(this.#snapshot());
      this.justFired = true;
    }
  }

  /**
   * Resync succeeded at a boundary: the previous run's remaining pages
   * replay verbatim. Reuse the page objects when nothing shifted (their
   * cached display lists survive); clone with adjusted number/folio when
   * the edit changed the page count (their content is identical, but the
   * printed folio genuinely differs).
   */
  #spliceOldPages(prevRun, oldSnap, folioDelta, suffixShift) {
    const numberDelta = this.pages.length - oldSnap.pageCount;
    const tail = prevRun.pages.slice(oldSnap.pageCount);
    for (const p of tail) {
      if (numberDelta === 0 && folioDelta === 0) {
        this.pages.push(p);
      } else {
        this.pages.push({
          ...p,
          number: p.number + numberDelta,
          folio: p.folio + folioDelta,
          dl: undefined,
        });
      }
    }
    // carry the old suffix's resume points (shifted) for the NEXT edit
    let seen = false;
    for (const s of prevRun.snapshots) {
      if (s === oldSnap) {
        seen = true;
        continue;
      }
      if (!seen || s.si < oldSnap.si) continue;
      this.snapshots.push({
        ...s,
        si: s.si + suffixShift,
        folio: s.folio + folioDelta,
        pageCount: s.pageCount + numberDelta,
      });
    }
    return true;
  }

  /** \@addtonextcol */
  #addToNextCol(f) {
    let inserted = false;
    const fpstype = f.place.bang ? f.place.bits : f.place.bits | 16;
    if (fpstype !== 8 && fpstype !== 24) {
      const textmin = f.place.bang ? 0 : (this.geo.textfraction ?? 0.2) * this.colht;
      const reqcolroom = this.#floatHt(f) + textmin;
      if (this.colroom > reqcolroom) {
        if (this.colnum === 0 && f.place.bang) this.colnum = 1;
        if (this.colnum > 0) {
          const sameTypeDeferred = this.deferlist.some((d) => d.type === f.type);
          if (!sameTypeDeferred) inserted = this.#addToTopOrBot(f, reqcolroom);
        }
      }
    }
    if (process.env.TDOM_DEBUG_FLOATS) {
      console.error(`nextcol ${f.id} colroom=${this.colroom.toFixed(1)} ht=${this.#floatHt(f).toFixed(1)} -> ${inserted ? 'placed' : 'defer'}`);
    }
    if (!inserted) this.deferlist.push(f);
  }

  /** \@tryfcolumn — attempt to build a float page from the defer list. */
  #tryFloatColumn(force) {
    if (!this.deferlist.length) return false;
    const colht = this.colht;
    const fpmin = force ? -Infinity : this.fpmin;
    const failed = [];
    let acc = null;
    let i = 0;
    while (i < this.deferlist.length && !acc) {
      const f = this.deferlist[i];
      const pOk = force || (f.place.bits & 8);
      if (!pOk || failed.some((d) => d.type === f.type) || this.#floatHt(f) > colht) {
        failed.push(f);
        i++;
        continue;
      }
      const group = [f];
      const fail2 = [];
      let total = this.#floatHt(f);
      for (let j = i + 1; j < this.deferlist.length; j++) {
        const g = this.deferlist[j];
        const gOk = force || (g.place.bits & 8);
        if (
          !gOk ||
          failed.some((d) => d.type === g.type) ||
          fail2.some((d) => d.type === g.type) ||
          total + this.#floatHt(g) + this.fpsep.w > colht
        ) {
          fail2.push(g);
          continue;
        }
        group.push(g);
        total += this.#floatHt(g) + this.fpsep.w;
      }
      if (total > fpmin) {
        acc = group;
        this.deferlist = [...failed, ...fail2];
      } else {
        failed.push(f);
        i++;
      }
    }
    if (!acc) return false;
    if (this.dumpRec) {
      this.dumpRec.push({ floatpage: true, ids: acc.map((f) => f.id) });
    }
    this.#emitFloatPage(acc);
    this.#startColumnState();
    return true;
  }

  // --------------------------------------------------------- page assembly

  /**
   * \@makecol + \@combinefloats + the final \vbox to \@colht glue setting.
   * Produces absolute draw entries (baseline y in text-area coordinates).
   */
  #emitPage(placed, feet) {
    const g = [];   // vertical elements: {kind:'glue',spec}|{kind:'box',...}
    const toplist = this.toplist;
    const botlist = this.botlist;
    this.pageFeet = feet;
    this.pageTop = toplist.slice();
    this.pageBot = botlist.slice();
    this.pageEvs = placed.filter((c) => c.e.t === 'ev').map((c) => ({ bid: c.e.bid, i: c.e.i }));
    this.pageTls = placed.filter((c) => c.e.t === 'tl').map((c) => ({ bid: c.e.bid, i: c.e.i }));

    // -- top floats (\@cflt): [box + floatsep]… -floatsep + textfloatsep
    for (let i = 0; i < toplist.length; i++) {
      g.push({ kind: 'float', f: toplist[i] });
      g.push({ kind: 'glue', spec: i === toplist.length - 1 ? this.textfloatsep : this.floatsep });
    }
    // -- text body
    for (const c of placed) {
      const e = c.e;
      if (e.t === 'box') {
        if (e.u.isFloat) g.push({ kind: 'float', f: e.u.isFloat }); // inline `h`
        else g.push({ kind: 'unit', u: e.u });
      } else if (e.t === 'glue') {
        g.push({ kind: 'glue', spec: glueOf({ w: e.a, st: e.st, sh: e.sh, sto: e.sto, sho: e.sho }) });
      } else if (e.t === 'kern') {
        g.push({ kind: 'glue', spec: glueOf(e.a) });
      }
      // ins entries occupy no space in the text body
    }
    // -- footnotes (\@makecol): \vskip\skip\footins, \footnoterule, inserts
    if (feet.length) {
      g.push({ kind: 'glue', spec: this.footskip });
      if (this.footruleUnit) {
        for (const it of this.footruleUnit) {
          if (it.kind === 'glue') g.push({ kind: 'glue', spec: it.spec });
          else g.push({ kind: 'unit', u: it.u });
        }
      }
      for (const fe of feet) {
        // insert contents are spliced verbatim (no interline glue between
        // insertions — footnote struts carry the spacing, like TeX)
        g.push({ kind: 'mini', units: fe.e.units, height: fe.e.hc, d: fe.e.d ?? 0 });
      }
    }
    // -- bottom floats (\@cflb): textfloatsep + [box + floatsep]… -floatsep
    if (botlist.length) {
      g.push({ kind: 'glue', spec: this.textfloatsep });
      for (let i = 0; i < botlist.length; i++) {
        g.push({ kind: 'float', f: botlist[i] });
        if (i < botlist.length - 1) g.push({ kind: 'glue', spec: this.floatsep });
      }
    }
    // -- \@makecol's final packaging: \dimen@=\dp\@outputbox …
    //    \vskip-\dimen@ cancels the trailing depth before \@textbottom
    let dpLast = 0;
    for (let i = g.length - 1; i >= 0; i--) {
      const el = g[i];
      if (el.kind === 'unit') { dpLast = el.u.d; break; }
      if (el.kind === 'float') { dpLast = el.f.d; break; }
      if (el.kind === 'mini') {
        dpLast = el.d ?? 0; // real \dp of the insert material (ins node)
        break;
      }
    }
    if (dpLast) g.push({ kind: 'glue', spec: { w: -dpLast, st: 0, sh: 0, sto: 0, sho: 0 } });
    // -- \@textbottom (raggedbottom: \vskip 0pt plus .0001fil — LuaTeX
    //    order 2, sharing an order with any \newpage/\vfil on the page)
    if (this.raggedbottom) {
      g.push({ kind: 'glue', spec: { w: 0, st: 0.0001 * FIL, sto: 2, sh: 0, sho: 0 } });
    }
    this.#layoutAndPush(g, this.colht);
  }

  /** \@vtryfc float page: \@fptop [\@fpsep box]… \@fpbot in a vbox to colht. */
  #emitFloatPage(group) {
    this.pageTop = group.slice();
    const g = [];
    g.push({ kind: 'glue', spec: this.fptop });
    g.push({ kind: 'glue', spec: negGlue(this.fpsep) });
    for (const f of group) {
      g.push({ kind: 'glue', spec: this.fpsep });
      g.push({ kind: 'float', f });
    }
    g.push({ kind: 'glue', spec: this.fpbot });
    this.#layoutAndPush(g, this.colht);
  }

  #emitEmptyPage() {
    this.#layoutAndPush([], this.colht);
  }

  /** Distribute glue exactly like vpack-to-goal, then place baselines. */
  #layoutAndPush(elems, goalHeight) {
    if (process.env.TDOM_DEBUG_LAYOUT) {
      console.error(`--- page ${this.pages.length + 1} elems:`);
      for (const el of elems) {
        if (el.kind === 'glue') console.error(`  glue ${el.spec.w} st=${el.spec.st}@${el.spec.sto}`);
        else if (el.kind === 'unit') console.error(`  unit h=${el.u.h} d=${el.u.d} "${(el.u.ln?.runs ?? []).filter((r) => r.t).map((r) => r.t).join('').slice(0, 30)}"`);
        else console.error(`  float ${el.f.id} h=${el.f.h}`);
      }
    }
    // natural size + stretch/shrink pools
    let natural = 0;
    const st = new Array(ORDERS).fill(0);
    const sh = new Array(ORDERS).fill(0);
    for (const el of elems) {
      if (el.kind === 'glue') {
        natural += el.spec.w;
        st[el.spec.sto ?? 0] += el.spec.st ?? 0;
        sh[el.spec.sho ?? 0] += el.spec.sh ?? 0;
      } else if (el.kind === 'unit') {
        natural += el.u.h + el.u.d;
      } else if (el.kind === 'float') {
        natural += el.f.h + el.f.d;
      } else if (el.kind === 'mini') {
        natural += el.height;
      }
    }
    const excess = goalHeight - natural;
    if (process.env.TDOM_DEBUG_GLUESET) {
      console.error(`glueset page ${this.pages.length + 1}: natural=${natural.toFixed(4)} goal=${goalHeight.toFixed(4)} excess=${excess.toFixed(4)} st=[${st.map((v) => v.toFixed(3))}] sh=[${sh.map((v) => v.toFixed(3))}]`);
    }
    let order = 0;
    let ratio = 0;
    let shrinking = false;
    if (excess > 0) {
      order = st[4] ? 4 : st[3] ? 3 : st[2] ? 2 : st[1] ? 1 : 0;
      ratio = st[order] > 0 ? excess / st[order] : 0;
    } else if (excess < 0) {
      shrinking = true;
      order = sh[4] ? 4 : sh[3] ? 3 : sh[2] ? 2 : sh[1] ? 1 : 0;
      ratio = sh[order] > 0 ? Math.min(-excess / sh[order], order === 0 ? 1 : Infinity) : 0;
    }
    const setGlue = (spec) => {
      let v = spec.w;
      if (!shrinking && ratio && (spec.sto ?? 0) === order) v += (spec.st ?? 0) * ratio;
      if (shrinking && ratio && (spec.sho ?? 0) === order) v -= (spec.sh ?? 0) * ratio;
      return v;
    };

    const draw = [];
    const identity = [];
    let y = 0;
    for (const el of elems) {
      if (el.kind === 'glue') {
        y += setGlue(el.spec);
      } else if (el.kind === 'unit') {
        y += el.u.h;
        draw.push({ u: el.u, y });
        identity.push(el.u);
        y += el.u.d;
      } else if (el.kind === 'float') {
        identity.push(el.f);
        for (const fu of el.f.units) {
          draw.push({ u: fu, y: y + fu.yRel, float: el.f });
        }
        y += el.f.h + el.f.d;
      } else if (el.kind === 'mini') {
        for (const fu of el.units) {
          draw.push({ u: fu, y: y + fu.yRel });
          identity.push(fu);
        }
        y += el.height;
      }
    }
    const folio = this.pendingFolio ?? this.folio;
    this.pendingFolio = null;
    this.folio = folio + 1;
    const page = {
      number: this.pages.length + 1,
      folio,
      draw,
      identity,
      startUnit: identity[0] ?? null,
      feet: this.pageFeet ?? [],
      topFloats: this.pageTop ?? [],
      botFloats: this.pageBot ?? [],
      evs: this.pageEvs ?? [],
      tls: this.pageTls ?? [],
    };
    this.pageFeet = null;
    this.pageTop = null;
    this.pageBot = null;
    this.pageEvs = null;
    this.pageTls = null;
    this.pages.push(page);
  }
}

/** Carried-item equality across runs: stream/unit/float objects by
 * identity (clean blocks keep them), synthetic glue/penalties by value. */
function sameCarryItem(a, b) {
  if (a === b) return true;
  if (!a || !b || a.t !== b.t) return false;
  switch (a.t) {
    case 'glue':
      return (
        a.a === b.a && (a.st ?? 0) === (b.st ?? 0) && (a.sto ?? 0) === (b.sto ?? 0) &&
        (a.sh ?? 0) === (b.sh ?? 0) && (a.sho ?? 0) === (b.sho ?? 0) && (a.sub ?? 0) === (b.sub ?? 0)
      );
    case 'pen':
      return a.v === b.v;
    case 'kern':
      return a.a === b.a;
    case 'box':
      return a.u === b.u;
    case 'fm':
      return a.f === b.f;
    default:
      return false; // ins/ev/tl/eject: identity only
  }
}

/** Text of a box unit's glyph runs (comparison key for compare-breaks). */
function unitText(u, limit = 48) {
  let s = '';
  for (const r of u.ln?.runs ?? []) {
    if (r.rule) continue;
    if (typeof r.t === 'string') {
      s += r.t;
    } else {
      for (const g of r.g ?? []) {
        const cp = Array.isArray(g) ? g[0] : g?.c;
        if (typeof cp === 'number') s += String.fromCodePoint(cp >= 0xe000 && cp < 0xe020 ? cp - 0xe000 + 32 : cp);
      }
    }
    if (s.length >= limit) return s.slice(0, limit);
  }
  return s;
}

/** One fired page's body stream, natural values — compare-breaks format. */
function dumpPageRecord(placed, pen, goal, total) {
  const nodes = [];
  for (const c of placed) {
    const e = c.e;
    if (e.t === 'box') {
      nodes.push({
        k: 'box',
        h: e.u.h ?? 0,
        d: e.u.d ?? 0,
        t: e.u.isFloat ? '<float>' : unitText(e.u),
      });
    } else if (e.t === 'glue') {
      nodes.push({
        k: 'glue', w: e.a ?? 0, st: e.st ?? 0, sto: e.sto ?? 0,
        sh: e.sh ?? 0, sho: e.sho ?? 0, sub: e.sub ?? 0, ...(c.topskip ? { ts: 1 } : {}),
      });
    } else if (e.t === 'kern') {
      nodes.push({ k: 'kern', w: e.a ?? 0 });
    } else if (e.t === 'pen') {
      nodes.push({ k: 'pen', v: e.v ?? 0 });
    } else if (e.t === 'ins') {
      nodes.push({ k: 'ins', h: e.h ?? 0 });
    }
  }
  return { pen, goal, total, nodes };
}

/** A committed inline float participates in the text stream as one big box. */
function floatAsUnit(f) {
  f.__unit ??= {
    blockId: f.blockId,
    li: -1,
    h: f.h,
    d: f.d,
    isFloat: f,
    ln: { descent: f.d, boxH: f.h, runs: [], gfxChunk: null },
  };
  return f.__unit;
}

/**
 * The class's \footnoterule recipe (measured items from the driver) as
 * layout elements: kerns become glue, rules become drawable units.
 * Memoized per geometry object so page identities survive rebuilds.
 */
const footruleCache = new WeakMap();
function footruleUnitFor(geo) {
  if (footruleCache.has(geo)) return footruleCache.get(geo);
  const out = computeFootrule(geo);
  footruleCache.set(geo, out);
  return out;
}

function computeFootrule(geo) {
  const items = geo.footruleitems;
  if (!items) return null;
  const out = [];
  for (const it of items) {
    if (it.k === 'kern' || it.k === 'glue') {
      out.push({ kind: 'glue', spec: glueOf(it.a ?? 0) });
    } else if (it.k === 'box') {
      out.push({
        kind: 'unit',
        u: {
          blockId: '_footrule',
          li: -1,
          h: it.h ?? 0,
          d: it.d ?? 0,
          ln: { descent: it.d ?? 0, boxH: it.h ?? 0, runs: it.runs ?? [], gfxChunk: null },
        },
      });
    }
  }
  return out;
}

/** Adopt unchanged page objects (display lists survive by identity). */
export function reconcile(newPages, oldPages) {
  let reused = 0;
  const pages = newPages.map((np) => {
    const op = oldPages[np.number - 1];
    if (op && op.number === np.number && sameIdentity(op, np)) {
      reused++;
      return op;
    }
    return np;
  });
  return { pages, reused, rebuilt: pages.length - reused };
}

function sameIdentity(a, b) {
  const ia = a.identity ?? [];
  const ib = b.identity ?? [];
  if (ia.length !== ib.length) return false;
  for (let i = 0; i < ia.length; i++) if (ia[i] !== ib[i]) return false;
  const da = a.draw ?? [];
  const db = b.draw ?? [];
  if (da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) {
    if (da[i].u !== db[i].u || Math.abs(da[i].y - db[i].y) > 0.01) return false;
  }
  return true;
}

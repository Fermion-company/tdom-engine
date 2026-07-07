import { fnv1a } from '../hash.js';
import { formatFolio } from './util/tex.js';

/**
 * Regenerate the contents files (toc / lof / lot) from the toclines the
 * daemon captured off \addcontentsline — the entries are TeX's own,
 * already expanded with the class's real numbering; the orchestrator
 * substitutes only the page number, which it owns (it builds the pages).
 */
export function computeToc(pages, blocks, initialStyle) {
  // toc entries print the FOLIO (roman front matter, arabic body...), not
  // the physical page index — take it from the page specs, formatted with
  // the kernel's \@arabic/\@roman/... transcriptions
  const specs = pageSpecs(pages, blocks, initialStyle);
  const folioText = new Map(specs.map((s) => [s.page, formatFolio(s.folio, s.fmt)]));
  const blockPage = new Map();
  for (const page of pages) {
    for (const d of page.draw ?? []) {
      const bid = d.u?.blockId;
      if (bid && !blockPage.has(bid)) blockPage.set(bid, page.number);
    }
    for (const f of page.floats ?? []) {
      const bid = f.blockId ?? f.id?.split('#')[0];
      if (bid && !blockPage.has(bid + '#float')) blockPage.set(bid + '#float', page.number);
    }
  }
  // toclines are stream-anchored (tdom:tl markers): the entry's page is
  // the page its marker landed on, exact even inside multi-page blocks
  const tlPage = new Map();
  for (const page of pages) {
    for (const r of page.tls ?? []) tlPage.set(`${r.bid}:${r.i}`, page.number);
  }
  const files = { toc: [], lof: [], lot: [] };
  for (const block of blocks) {
    (block.galley?.toclines ?? []).forEach((tl, idx) => {
      const ext = tl.e ?? 'toc';
      if (!files[ext]) files[ext] = [];
      if (tl.l === '@raw') {
        // \addtocontents material (inter-group \addvspace etc.): replayed
        // verbatim in document order between the entries
        files[ext].push(tl.t);
        return;
      }
      // float captions (lof/lot) sit on the page the float landed on when
      // known; everything else on the page its stream marker reached
      const page =
        (ext !== 'toc' ? blockPage.get(block.id + '#float') : undefined) ??
        tlPage.get(`${block.id}:${idx}`) ??
        blockPage.get(block.id) ??
        1;
      // 4th (destination) argument required by LaTeX 2020-10 and later
      files[ext].push(`\\contentsline {${tl.l}}{${tl.t}}{${folioText.get(page) ?? page}}{}%`);
    });
  }
  const contents = {};
  for (const [ext, lines] of Object.entries(files)) {
    contents[ext] = lines.join('\n') + '\n';
  }
  return { hash: fnv1a(JSON.stringify(contents)), contents };
}

export function pageSpecs(pages, blocks, initialStyle) {
  // events ride the node stream as markers, so each page's event list
  // (page.evs) is exact even when one block spans several pages
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const specs = [];
  let style = initialStyle;
  let fmt = 'arabic';
  let folio = 1;
  let lmark = '';
  let rmark = '';
  for (const page of pages) {
    let thisstyle = null;
    // TeX mark semantics: \leftmark = botmark's left (LAST mark on the
    // page), \rightmark = firstmark's right (FIRST mark on the page, or
    // the carried value when the page has no marks)
    const rmarkAtStart = rmark;
    let firstRight = null;
    for (const ref of page.evs ?? []) {
      // synthetic events (blank verso pages) carry their payload inline
      const ev = ref.bid ? blockById.get(ref.bid)?.galley?.events?.[ref.i] : ref;
      if (!ev) continue;
      if (ev.k === 'style') style = ev.a;
      else if (ev.k === 'thisstyle') thisstyle = ev.a;
      else if (ev.k === 'pagenum') {
        fmt = ev.a;
        folio = 1; // \pagenumbering resets the page counter (kernel behavior)
      } else if (ev.k === 'mark') {
        lmark = ev.a;
        if (firstRight === null) firstRight = ev.b;
        rmark = ev.b;
      } else if (ev.k === 'markr') {
        if (firstRight === null) firstRight = ev.a;
        rmark = ev.a;
      }
    }
    specs.push({
      page: page.number,
      // the page builder owns folio assignment (it inserts blank versos
      // and applies \pagenumbering resets in stream order)
      folio: page.folio ?? folio,
      fmt,
      style: thisstyle ?? style,
      lmark,
      rmark: firstRight ?? rmarkAtStart,
    });
    folio = (page.folio ?? folio) + 1;
  }
  return specs;
}

export function hfJobBody(specs) {
  const L = ['\\makeatletter'];
  // \pageref{LastPage} in headers/footers: the label lastpage would write
  // at \enddocument is the LAST page's folio — a value the page builder
  // owns outright (\pageref prints the second group of \r@LastPage)
  const last = specs[specs.length - 1];
  if (last) {
    const lp = formatFolio(last.folio, last.fmt);
    L.push(`\\global\\@namedef{r@LastPage}{{}{${lp}}}`);
  }
  for (const s of specs) {
    L.push(`\\global\\c@page=${s.folio}`);
    L.push(`\\gdef\\thepage{\\csname @${s.fmt}\\endcsname\\c@page}`);
    L.push(`\\def\\leftmark{${s.lmark}}`);
    L.push(`\\def\\rightmark{${s.rmark}}`);
    // reset then apply the page style (an unknown style leaves all empty)
    L.push('\\def\\@oddhead{}\\def\\@evenhead{}\\def\\@oddfoot{}\\def\\@evenfoot{}');
    L.push(`\\csname ps@${s.style}\\endcsname`);
    L.push('\\let\\TDOMhd\\@oddhead\\let\\TDOMft\\@oddfoot');
    L.push('\\if@twoside\\ifodd\\c@page\\else\\let\\TDOMhd\\@evenhead\\let\\TDOMft\\@evenfoot\\fi\\fi');
    L.push(
      `\\setbox\\z@\\vbox{\\hsize\\textwidth\\hb@xt@\\textwidth{\\normalcolor\\TDOMhd}}` +
        `\\directlua{tdom_hf_box(0, ${s.page}, 'h')}`
    );
    L.push(
      `\\setbox\\z@\\vbox{\\hsize\\textwidth\\hb@xt@\\textwidth{\\normalcolor\\TDOMft}}` +
        `\\directlua{tdom_hf_box(0, ${s.page}, 'f')}`
    );
  }
  L.push('\\directlua{tdom_hf_flush()}');
  return L.join('\n');
}

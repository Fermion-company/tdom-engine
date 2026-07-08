import { braceImbalance, labelDefBody, startsVertical } from './util/tex.js';

export function buildIsolatedRenderSource({
  preamble,
  labelTable,
  geometry,
  hrefTable,
  entry,
  prevPd,
  prevNobreak,
  blockText,
}) {
  const L = [];
  L.push(preamble.trimEnd());
  L.push('\\begin{document}');
  L.push('\\makeatletter\\pagestyle{empty}\\hoffset=-1in\\voffset=-1in');
  for (const [key, val] of labelTable) {
    if (key.startsWith('cite:')) L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
    else L.push(`\\global\\@namedef{r@${key}}${labelDefBody(key, val, geometry?.hyperref === 1, hrefTable?.get(key))}`);
  }
  for (const [name, val] of Object.entries(entry)) {
    L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${val}}\\fi`);
  }
  // float capture, exactly like the resident driver: the environment
  // body is typeset into a box with \@xfloat's setup, and a Lua-side
  // copy is kept so each float ships as its own page (2..N) after the
  // galley — same protocol as the resident RENDER path
  // NB: inline Lua under LaTeX catcodes — no '%', '#' or backslash
  // characters (see #isoCompile); TeX tokens are built via string.char
  L.push('\\newbox\\TDOMisofbox');
  L.push('\\directlua{tdom_iso_fbox=\\number\\TDOMisofbox tdom_iso_floats={} tdom_iso_nf=0 ' +
    'tdom_iso_feet={} tdom_iso_nfeet=0 ' +
    'function tdom_iso_float() local b = tex.box[tdom_iso_fbox] ' +
    'if b then tdom_iso_nf = tdom_iso_nf + 1 tdom_iso_floats[tdom_iso_nf] = node.copy_list(b) end end ' +
    'function tdom_iso_load_box(b) ' +
    'tex.box[255] = b ' +
    'tex.pagewidth = math.max(b.width or 0, 65536) ' +
    'tex.pageheight = math.max((b.height or 0) + (b.depth or 0), 65536) end ' +
    'function tdom_iso_load_float(i) local b = tdom_iso_floats[i] ' +
    'if not b then return end tdom_iso_floats[i] = false tdom_iso_load_box(b) end ' +
    'function tdom_iso_load_foot(i) local b = tdom_iso_feet[i] ' +
    'if not b then return end tdom_iso_feet[i] = false tdom_iso_load_box(b) end ' +
    // page map matches the resident RENDER path: galley, floats,
    // then footnote insert bodies
    'function tdom_iso_ship_floats() ' +
    'local BS = string.char(92) ' +
    'local lines = {} ' +
    'for i = 1, tdom_iso_nf do ' +
    "table.insert(lines, BS .. 'directlua{tdom_iso_load_float(' .. i .. ')}') " +
    "table.insert(lines, BS .. 'shipout' .. BS .. 'box255') end " +
    'for i = 1, tdom_iso_nfeet do ' +
    "table.insert(lines, BS .. 'directlua{tdom_iso_load_foot(' .. i .. ')}') " +
    "table.insert(lines, BS .. 'shipout' .. BS .. 'box255') end " +
    'if lines[1] then tex.print(lines) end end}');
  L.push('\\def\\TDOMHplacement{H}');
  for (const env of ['figure', 'table']) {
    // [H] (float.sty) is inline material, not a float — same dispatch
    // as the resident driver: hand it back to the original environment
    L.push(`\\expandafter\\let\\csname TDOMorig${env}\\expandafter\\endcsname\\csname ${env}\\endcsname`);
    L.push(
      `\\renewenvironment{${env}}[1][tbp]` +
        `{\\gdef\\TDOMfp{#1}\\ifx\\TDOMfp\\TDOMHplacement` +
        `\\csname TDOMorig${env}\\endcsname[H]` +
        `\\else\\def\\@captype{${env}}\\ifhmode\\@bsphack\\fi` +
        '\\global\\setbox\\TDOMisofbox\\vbox\\bgroup\\hsize\\columnwidth\\@parboxrestore\\@floatboxreset\\fi}' +
        '{\\par\\vskip\\z@skip\\egroup' +
        '\\directlua{tdom_iso_float()}' +
        '\\ifhmode\\@Esphack\\fi}'
    );
  }
  L.push('\\makeatother');
  // same dormant-page technique as the resident daemon: typeset on the
  // real MVL (state-faithful spacing), then harvest, vpack and ship
  L.push('\\vsize=\\maxdimen');
  L.push('\\holdinginserts=1');
  L.push('\\maxdeadcycles=200');
  L.push('\\hbox to0pt{}');
  L.push('\\special{tdom:isostart}');
  L.push(`\\directlua{tex.nest[0].prevdepth=${Math.round(prevPd)}}`);
  // see #isoCompile: vertical-env blocks keep the @nobreak flag instead
  // of \noindent, so their own before-skip glue survives
  if (prevNobreak) L.push(startsVertical(blockText) ? '\\makeatletter\\@nobreaktrue\\makeatother' : '\\noindent');
  L.push(blockText.trimEnd() + '}'.repeat(Math.max(0, braceImbalance(blockText))));
  L.push('\\par');
  L.push(
    '\\directlua{' +
      'tex.triggerbuildpage() ' +
      'local head = tex.lists.page_head ' +
      'tex.lists.page_head = nil tex.lists.contrib_head = nil ' +
      'local INS = node.id("ins") local WH = node.id("whatsit") ' +
      'local SP = node.subtype("special") ' +
      // everything up to and including the isostart marker is pre-body
      // machinery (begin-document whatsits, \topskip glue, the seed box)
      'while head do ' +
      'local ismark = head.id == WH and head.subtype == SP and head.data == "tdom:isostart" ' +
      'local nxt = head.next head.next = nil if nxt then nxt.prev = nil end node.free(head) head = nxt ' +
      'if ismark then break end end ' +
      'local out, tail = nil, nil local n = head ' +
      'while n do local nxt = n.next n.next = nil n.prev = nil ' +
      // footnote bodies ship as their own pages after the floats (kept
      // even when empty so page indices stay aligned with the galley's
      // ins items)
      'if n.id == INS then local c = n.head or n.list ' +
      'local b if c then b = node.vpack(node.copy_list(c)) else b = node.new("hlist") end ' +
      'tdom_iso_nfeet = tdom_iso_nfeet + 1 tdom_iso_feet[tdom_iso_nfeet] = b ' +
      'node.free(n) else if tail then tail.next = n n.prev = tail else out = n end tail = n end n = nxt end ' +
      // page 1 must ALWAYS exist (floats follow at 2..N): an empty
      // galley (float-only block) would make \shipout void = no page
      // and shift every float's page index
      'local b = out and node.vpack(out) or node.new("hlist") ' +
      'tex.box[255] = b tex.pagewidth = math.max(b.width or 0, 65536) ' +
      'tex.pageheight = math.max((b.height or 0) + (b.depth or 0), 65536)}'
  );
  L.push('\\shipout\\box255');
  L.push('\\directlua{tdom_iso_ship_floats()}');
  L.push('\\csname @@end\\endcsname');
  return L.join('\n') + '\n';
}

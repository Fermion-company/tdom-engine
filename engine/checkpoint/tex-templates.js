import { luaStr, labelDefBody, braceImbalance, startsAddvspace, startsVertical } from './util/tex.js';
import { parseVec } from './util/galley.js';

export function buildDriverSource({
  preamble,
  daemonPath,
  port,
  workDir,
  counters,
  labelTable,
  hrefTable,
  geometry,
}) {
  const L = [];
  L.push(preamble.trimEnd());
  L.push('\\begin{document}');
  L.push(`\\directlua{dofile('${luaStr(daemonPath)}')}`);
  L.push('\\makeatletter');
  L.push(
    `\\directlua{tdom_boot(${port}, '${luaStr(workDir)}', {${counters
      .map((c) => `'${c}'`)
      .join(',')}})}`
  );
  // label / ref recording shims (typesetting behavior unchanged).
  // cleveref resolves \cref through a SECOND aux macro (r@<key>@cref,
  // written next to every \newlabel) — capture its value at \label time
  // exactly like the plain one, or a resident run prints ?? forever.
  const crefCapture =
    '\\ifcsname cref@currentlabel\\endcsname' +
    "\\directlua{tdom_label_cref('\\luaescapestring{#1}'," +
    "'\\luaescapestring{\\detokenize\\expandafter{\\cref@currentlabel}}')}\\fi";
  // \enlargethispage: record a stream marker for the JS page builder
  // (the dormant page ignores the real effect); the original still runs.
  L.push('\\let\\TDOMenlarge\\enlargethispage');
  L.push('\\renewcommand\\enlargethispage{\\@ifstar\\TDOMenlargeS\\TDOMenlargeN}');
  L.push(
    '\\newcommand\\TDOMenlargeS[1]{\\TDOMenlarge*{#1}' +
      '\\begingroup\\dimen@=\\dimexpr#1\\relax\\directlua{tdom_enlarge(\\number\\dimen@,1)}\\endgroup}'
  );
  L.push(
    '\\newcommand\\TDOMenlargeN[1]{\\TDOMenlarge{#1}' +
      '\\begingroup\\dimen@=\\dimexpr#1\\relax\\directlua{tdom_enlarge(\\number\\dimen@,0)}\\endgroup}'
  );
  L.push('\\let\\TDOMlabel\\label');
  L.push(
    "\\renewcommand\\label[1]{\\TDOMlabel{#1}\\directlua{tdom_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}')}" +
      crefCapture + '}'
  );
  // amsmath routes display-math labels through \ltx@label (captured at
  // package load, before our shim) — intercept that path too
  L.push('\\ifdefined\\ltx@label\\let\\TDOMltxlabel\\ltx@label');
  L.push(
    "\\def\\ltx@label#1{\\TDOMltxlabel{#1}\\directlua{tdom_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}')}" +
      crefCapture + '}\\fi'
  );
  L.push('\\let\\TDOMref\\ref');
  L.push("\\renewcommand\\ref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMref{#1}}");
  L.push('\\let\\TDOMpageref\\pageref');
  L.push("\\renewcommand\\pageref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMpageref{#1}}");
  L.push('\\ifdefined\\eqref\\let\\TDOMeqref\\eqref');
  L.push("\\renewcommand\\eqref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMeqref{#1}}\\fi");
  // \cref/\Cref read r@<key>@cref — record the dependency under that key
  // so label movements retypeset the referencing block (comma lists split
  // Lua-side); resolution itself stays cleveref's
  L.push('\\ifdefined\\cref\\let\\TDOMcref\\cref');
  L.push("\\renewcommand\\cref[1]{\\directlua{tdom_ref_cref('\\luaescapestring{#1}')}\\TDOMcref{#1}}\\fi");
  L.push('\\ifdefined\\Cref\\let\\TDOMCref\\Cref');
  L.push("\\renewcommand\\Cref[1]{\\directlua{tdom_ref_cref('\\luaescapestring{#1}')}\\TDOMCref{#1}}\\fi");
  // toc/lof/lot entries are TeX's own: capture what \addcontentsline
  // would write, expanded exactly like \protected@write expands it (the
  // class's real \numberline{\thechapter.\thesection} formatting) — the
  // orchestrator later substitutes only the page argument it owns
  L.push('\\let\\TDOMaddcontentsline\\addcontentsline');
  L.push(
    '\\renewcommand\\addcontentsline[3]{' +
      // modern kernels route \addcontentsline through \addtocontents —
      // flag the window so the @raw capture skips the duplicate
      '\\directlua{tdom_in_acl=true}\\TDOMaddcontentsline{#1}{#2}{#3}\\directlua{tdom_in_acl=false}' +
      '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
      '\\protected@edef\\TDOM@tocentry{#3}' +
      "\\directlua{tdom_tocline('\\luaescapestring{#1}','\\luaescapestring{#2}'," +
      "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
  );
  // \addtocontents carries the NON-entry contents material (\chapter's
  // \addvspace{10pt} between groups in lof/lot/toc, tocloft adjustments…)
  // — captured verbatim and replayed in document order between the
  // \contentsline entries, or the contents pages come out compressed
  L.push('\\let\\TDOMaddtocontents\\addtocontents');
  L.push(
    '\\renewcommand\\addtocontents[2]{\\TDOMaddtocontents{#1}{#2}' +
      '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
      '\\protected@edef\\TDOM@tocentry{#2}' +
      "\\directlua{tdom_tocline('\\luaescapestring{#1}','@raw'," +
      "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
  );
  // page-style layer events: the orchestrator reconstructs each page's
  // exact header/footer state from these (the boxes themselves are later
  // typeset by TeX in a header job — nothing is invented)
  L.push('\\let\\TDOMpagestyle\\pagestyle');
  L.push(
    "\\renewcommand\\pagestyle[1]{\\TDOMpagestyle{#1}\\directlua{tdom_event('style','\\luaescapestring{#1}','')}}"
  );
  L.push('\\let\\TDOMthispagestyle\\thispagestyle');
  L.push(
    "\\renewcommand\\thispagestyle[1]{\\TDOMthispagestyle{#1}\\directlua{tdom_event('thisstyle','\\luaescapestring{#1}','')}}"
  );
  L.push('\\let\\TDOMpagenumbering\\pagenumbering');
  L.push(
    "\\renewcommand\\pagenumbering[1]{\\TDOMpagenumbering{#1}\\directlua{tdom_event('pagenum','\\luaescapestring{#1}','')}}"
  );
  L.push('\\let\\TDOMmarkboth\\markboth');
  L.push(
    '\\renewcommand\\markboth[2]{\\TDOMmarkboth{#1}{#2}' +
      '{\\protected@edef\\TDOM@mka{#1}\\protected@edef\\TDOM@mkb{#2}' +
      "\\directlua{tdom_event('mark','\\luaescapestring{\\detokenize\\expandafter{\\TDOM@mka}}'," +
      "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@mkb}}')}}}"
  );
  L.push('\\let\\TDOMmarkright\\markright');
  L.push(
    '\\renewcommand\\markright[1]{\\TDOMmarkright{#1}' +
      '{\\protected@edef\\TDOM@mka{#1}' +
      "\\directlua{tdom_event('markr','\\luaescapestring{\\detokenize\\expandafter{\\TDOM@mka}}','')}}}"
  );
  // \cleardoublepage decides on a blank verso via \ifodd\c@page — but the
  // dormant run never ships pages, so \c@page is meaningless here. Emit a
  // marker instead: the page builder OWNS folios and inserts the blank
  // (with \thispagestyle{empty}, as the classes do) exactly when the
  // assigned folio demands it.
  L.push(
    "\\renewcommand\\cleardoublepage{\\clearpage\\directlua{tdom_event('cleardouble','odd','')}}"
  );
  // jsclasses (ltjsbook & co) have a whole clear-to-parity family that
  // \frontmatter/\mainmatter/\chapter use directly — shim each with its
  // parity target (right/left mapping assumes yoko direction; tate docs
  // flip these — TODO when vertical typesetting lands)
  for (const [name, parity] of [
    ['pltx@cleartooddpage', 'odd'],
    ['pltx@cleartoevenpage', 'even'],
    ['pltx@cleartorightpage', 'odd'],
    ['pltx@cleartoleftpage', 'even'],
  ]) {
    L.push(
      `\\ifdefined\\${name}\\def\\${name}{\\clearpage\\directlua{tdom_event('cleardouble','${parity}','')}}\\fi`
    );
  }
  // \cite: record dependencies on bibliography keys
  L.push('\\let\\TDOMcite\\cite');
  L.push("\\renewcommand\\cite[2][]{\\directlua{tdom_cites('\\luaescapestring{#2}')}" +
    '\\ifx\\relax#1\\relax\\TDOMcite{#2}\\else\\TDOMcite[#1]{#2}\\fi}');
  // float capture: the environment body is typeset into a box with EXACTLY
  // the setup of LaTeX's \@xfloat (\hsize\columnwidth \@parboxrestore
  // \@floatboxreset — and no injected \centering), so the captured box is
  // byte-identical to what the real output routine would have placed. An
  // anchor \special marks the declaration point for the page builder.
  L.push('\\newbox\\TDOMfloatbox');
  L.push('\\directlua{TDOM_FLOATBOX=\\number\\TDOMfloatbox}');
  L.push('\\newcount\\TDOMfloatn');
  L.push('\\def\\TDOMHplacement{H}');
  for (const env of ['figure', 'table']) {
    // float.sty's [H] is NOT a float: \float@endH typesets the box inline
    // (\vskip\intextsep \box \vskip\intextsep) so it participates in page
    // breaking like any paragraph. Hand [H] back to the untouched original
    // environment — \@float@HH re-\lets \end<env> inside the group, so the
    // capture end-code below never runs for it.
    L.push(`\\expandafter\\let\\csname TDOMorig${env}\\expandafter\\endcsname\\csname ${env}\\endcsname`);
    L.push(
      `\\renewenvironment{${env}}[1][\\csname fps@${env}\\endcsname]` +
        `{\\gdef\\TDOMfp{#1}\\ifx\\TDOMfp\\TDOMHplacement` +
        `\\csname TDOMorig${env}\\endcsname[H]` +
        `\\else\\def\\@captype{${env}}\\ifhmode\\@bsphack\\fi` +
        '\\global\\setbox\\TDOMfloatbox\\vbox\\bgroup\\hsize\\columnwidth\\@parboxrestore\\@floatboxreset\\fi}' +
        `{\\par\\vskip\\z@skip\\egroup\\global\\advance\\TDOMfloatn\\@ne` +
        `\\special{tdomfloat:\\number\\TDOMfloatn}` +
        `\\directlua{tdom_float(\\number\\TDOMfloatn,'\\TDOMfp','${env}')}` +
        `\\ifhmode\\@Esphack\\fi}`
    );
  }
  // \tableofcontents reads the toc the orchestrator maintains; never write
  L.push('\\renewcommand\\@starttoc[1]{{\\makeatletter\\@input{\\jobname.#1}}}');
  // live bibliography: define \b@<key> as \bibitem runs so \cite resolves
  L.push('\\ifdefined\\@bibitem\\let\\TDOMbibitem\\@bibitem');
  L.push("\\def\\@bibitem#1{\\TDOMbibitem{#1}\\directlua{tdom_bib('\\luaescapestring{#1}','\\luaescapestring{\\the\\value{enumiv}}')}}\\fi");
  L.push('\\ifdefined\\@lbibitem\\let\\TDOMlbibitem\\@lbibitem');
  L.push("\\def\\@lbibitem[#1]#2{\\TDOMlbibitem[#1]{#2}\\directlua{tdom_bib('\\luaescapestring{#2}','\\luaescapestring{#1}')}}\\fi");
  // page-builder geometry: every parameter the output routine uses is read
  // from the live TeX run — glue parameters travel with their full
  // stretch/shrink specification (\gluestretch etc. are LuaTeX primitives)
  const glueParam = (name, expr) =>
    `\\directlua{tdom_glue('${name}',\\number\\dimexpr${expr}\\relax,` +
    `\\number\\gluestretch${expr},\\number\\glueshrink${expr},` +
    `\\number\\gluestretchorder${expr},\\number\\glueshrinkorder${expr})}`;
  L.push(glueParam('footinsskip', '\\skip\\footins'));
  L.push(glueParam('topskip', '\\topskip'));
  L.push(glueParam('floatsep', '\\floatsep'));
  L.push(glueParam('textfloatsep', '\\textfloatsep'));
  L.push(glueParam('intextsep', '\\intextsep'));
  L.push(glueParam('fptop', '\\@fptop'));
  L.push(glueParam('fpsep', '\\@fpsep'));
  L.push(glueParam('fpbot', '\\@fpbot'));
  L.push('\\directlua{tdom_num(\'topfraction\',\\topfraction)}');
  L.push('\\directlua{tdom_num(\'bottomfraction\',\\bottomfraction)}');
  L.push('\\directlua{tdom_num(\'textfraction\',\\textfraction)}');
  L.push('\\directlua{tdom_num(\'floatpagefraction\',\\floatpagefraction)}');
  L.push('\\directlua{tdom_num(\'topnumber\',\\value{topnumber})}');
  L.push('\\directlua{tdom_num(\'bottomnumber\',\\value{bottomnumber})}');
  L.push('\\directlua{tdom_num(\'totalnumber\',\\value{totalnumber})}');
  L.push('\\directlua{tdom_num(\'interlinepenalty\',\\interlinepenalty)}');
  L.push('\\directlua{tdom_num(\'footinsfactor\',\\count\\footins)}');
  L.push('\\directlua{tdom_dim(\'atmaxdepth\',\\number\\dimexpr\\@maxdepth\\relax)}');
  // \raggedbottom leaves \@textbottom = \vskip\z@\@plus.0001fil; flushbottom
  // keeps it \relax — the page builder needs to know which world it's in
  L.push('\\ifx\\@textbottom\\relax\\directlua{tdom_num(\'raggedbottom\',0)}' +
    '\\else\\directlua{tdom_num(\'raggedbottom\',1)}\\fi');
  L.push("\\if@twoside\\directlua{tdom_num('twoside',1)}\\else\\directlua{tdom_num('twoside',0)}\\fi");
  // hyperref changes the \r@… label format to five groups — the injection
  // sites must know which world they write for
  L.push("\\ifcsname Hy@Warning\\endcsname\\directlua{tdom_num('hyperref',1)}\\else\\directlua{tdom_num('hyperref',0)}\\fi");
  // the class's real \footnoterule, measured (kerns+rule items, verbatim)
  L.push('\\setbox0=\\vbox{\\hsize=\\textwidth\\footnoterule}');
  L.push('\\directlua{tdom_footrule(0)}');
  L.push('\\directlua{tdom_geo()}');
  // pre-known labels so forward references resolve in one pass after reboots
  for (const [key, val] of labelTable) {
    if (key.startsWith('cite:')) {
      L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
    } else {
      L.push(`\\global\\@namedef{r@${key}}${labelDefBody(key, val, geometry?.hyperref === 1, hrefTable?.get(key))}`);
    }
  }
  // font warmup: load the common face set into checkpoint 0
  L.push('\\setbox0=\\vbox{\\hsize=\\textwidth The quick brown fox 0123456789');
  L.push('\\textbf{bold} \\textit{italic} \\texttt{mono} \\textsc{Caps}');
  L.push('$a^2+b_i \\alpha\\beta\\gamma \\int_0^\\infty \\sum \\frac{1}{2} \\sqrt{x} \\left(\\frac{A}{B}\\right)$');
  L.push('\\scriptsize tiny \\normalsize}');
  // measure the unicode math twin so OMX substitutions align exactly
  L.push('\\font\\TDOMtwinmath={file:latinmodern-math.otf} at 10pt\\relax');
  L.push("\\directlua{pcall(function() tdom_twin_metrics(font.id('TDOMtwinmath')) end)}");
  L.push('\\makeatother');
  L.push('\\pagestyle{empty}');
  // cancel TeX's 1in shipout origin so render children produce tight pages
  L.push('\\hoffset=-1in');
  L.push('\\voffset=-1in');
  // Dormant page builder: blocks are typeset on the REAL main vertical
  // list (full state continuity — \prevdepth, \everypar, penalties), the
  // page never fills (\vsize=\maxdimen), inserts stay in the stream
  // (\holdinginserts), and a dummy box keeps the page "started" so TeX
  // never discards inter-block glue. tdom_report() harvests the nodes.
  // The output routine only ever fires on force-ejects (\newpage & co);
  // tdom_absorb_output puts the material back and plants a break marker.
  L.push('\\vsize=\\maxdimen');
  L.push('\\holdinginserts=1');
  L.push('\\maxdeadcycles=200');
  // the REAL LaTeX output routine, saved before the dormant absorb takes
  // over: iso fork children restore it for splitting environments
  // (mdframed / breakable tcolorbox / longtable / multicols only break
  // pages inside \output — see #isoCompile splitMode)
  L.push('\\newtoks\\TDOMrealoutput');
  L.push('\\TDOMrealoutput=\\output');
  L.push('\\output={\\directlua{tdom_absorb_output()}}');
  // a real box first: flips the page builder's internal page_contents
  // flag to box_there (unreachable from Lua); tdom_seed then swaps the
  // list for the marker dummy
  L.push('\\hbox to0pt{}');
  L.push('\\prevdepth=-1000pt');
  L.push('\\directlua{tdom_seed()}');
  L.push('\\def\\TDOMloop{\\directlua{tdom_wait()}\\TDOMloop}');
  L.push('\\TDOMloop');
  L.push('\\end{document}');
  L.push('');
  return L.join('\n');
}

export function buildStateJobBody({ iso, counters, hyperref }) {
  const L = ['\\makeatletter'];
  for (const name of counters) {
    const v = iso.state[name];
    if (v !== undefined) L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${v}}\\fi`);
  }
  for (const l of iso.labels ?? []) {
    // stale-first passes real galley labels through here, which can
    // include \bibitem captures (cite: keys) — those live under b@
    if (l.k.startsWith('cite:')) {
      L.push(`\\global\\@namedef{b@${l.k.slice(5)}}{${l.v}}`);
    } else {
      L.push(`\\global\\@namedef{r@${l.k}}${labelDefBody(l.k, l.v, hyperref, l.h)}`);
    }
  }
  L.push(iso.state['tdom@nobreak'] === 1 ? '\\global\\@nobreaktrue' : '\\global\\@nobreakfalse');
  L.push('\\makeatother');
  L.push(`\\directlua{tex.nest[0].prevdepth=${Math.round(iso.state['tdom@pd'] ?? -65536000)}}`);
  return L.join('\n');
}

export function buildVolatilePrelude({ stateVecJson, counters, hyperref }) {
  const prevVec = parseVec(stateVecJson);
  if (!prevVec.length) return '';
  const state = {};
  counters.forEach((c, i) => {
    state[c] = prevVec[i] ?? 0;
  });
  state['tdom@pd'] = prevVec[prevVec.length - 3] ?? -65536000;
  state['tdom@nobreak'] = prevVec[prevVec.length - 2] ?? 0;
  return buildStateJobBody({ iso: { state, labels: [] }, counters, hyperref }) + '\n';
}

export function buildIsoCompileSource({
  ck0,
  preamble,
  jobdirForBody,
  labelTable,
  entry,
  counters,
  geometry,
  blockText,
  prevPd,
  prevNobreak,
  prevLsSp,
  realOutput,
  strut,
}) {
  const L = [];
  if (!ck0) {
    L.push(preamble.trimEnd());
    L.push('\\begin{document}');
  } else {
    // the fork inherits the root's DORMANT regime (ckpt:0 is frozen right
    // after the dormant setup — \pagegoal=\maxdimen, seed material on the
    // page). Reset to the REAL height with TeX's own machinery: fire ONE
    // discarding output routine so the page truly EMPTIES (page_contents
    // flag included — unreachable from Lua), then the next contribution
    // re-derives \pagegoal from the restored \vsize. Without this, a
    // real-output child never fills a page and dies on "Output routine
    // didn't use all of \box255".
    L.push(`\\vsize=${Math.max(1, geometry?.textheight ?? 550).toFixed(4)}bp`);
  }
  L.push('\\makeatletter\\pagestyle{empty}\\hoffset=-1in\\voffset=-1in');
  if (ck0) {
    L.push('\\output={\\global\\setbox\\voidb@x\\box255}');
    L.push('\\hbox to0pt{}\\penalty-10000');
    // re-assert the job cwd right before the ship: package code in the
    // block body can wander the process cwd, and the PDF output file
    // opens wherever the FIRST \shipout finds it (observed: child PDFs
    // landing in the root's workDir instead of the jobdir)
    L.push(
      `\\AddToHook{shipout/before}{\\directlua{pcall(function() lfs.chdir('${jobdirForBody}') end)}}`
    );
  }
  for (const [key, val] of labelTable) {
    if (key.startsWith('cite:')) L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
    else L.push(`\\global\\@namedef{r@${key}}${labelDefBody(key, val)}`);
  }
  for (const [name, val] of Object.entries(entry)) {
    L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${val}}\\fi`);
  }
  // capture labels the block defines (value = \@currentlabel at \label);
  // cleveref's r@<key>@cref companion is captured alongside, like the
  // resident driver does
  const isoCrefCapture =
    '\\ifcsname cref@currentlabel\\endcsname' +
    "\\directlua{tdom_iso_label_cref('\\luaescapestring{#1}'," +
    "'\\luaescapestring{\\detokenize\\expandafter{\\cref@currentlabel}}')}\\fi";
  const isoHref = "'\\luaescapestring{\\ifcsname @currentHref\\endcsname\\@currentHref\\fi}'";
  // save-macro names must NOT collide with the resident daemon's own
  // shims (\TDOMlabel & co, boot driver): a fork-mode iso inherits those
  // wrappers, and \let\TDOMlabel\label would overwrite the root's saved
  // original with the wrapper itself — infinite recursion on first \label
  L.push('\\let\\TDOMisolabel\\label');
  L.push(
    "\\renewcommand\\label[1]{\\TDOMisolabel{#1}\\directlua{tdom_iso_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}'," + isoHref + ')}' +
      isoCrefCapture + '}'
  );
  L.push('\\ifdefined\\ltx@label\\let\\TDOMisoltxlabel\\ltx@label');
  L.push(
    "\\def\\ltx@label#1{\\TDOMisoltxlabel{#1}\\directlua{tdom_iso_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}'," + isoHref + ')}' +
      isoCrefCapture + '}\\fi'
  );
  // ref-use recording: a rescued block that references a label must be
  // re-rescued when that label's value changes (the cache key carries the
  // referenced values — see #rescueBlock)
  L.push('\\let\\TDOMisoref\\ref');
  L.push("\\renewcommand\\ref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMisoref{#1}}");
  L.push('\\let\\TDOMisopageref\\pageref');
  L.push("\\renewcommand\\pageref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMisopageref{#1}}");
  L.push('\\ifdefined\\eqref\\let\\TDOMisoeqref\\eqref');
  L.push("\\renewcommand\\eqref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMisoeqref{#1}}\\fi");
  L.push('\\ifdefined\\cref\\let\\TDOMisocref\\cref');
  L.push("\\renewcommand\\cref[1]{\\directlua{tdom_iso_ref_cref('\\luaescapestring{#1}')}\\TDOMisocref{#1}}\\fi");
  L.push('\\ifdefined\\Cref\\let\\TDOMisoCref\\Cref');
  L.push("\\renewcommand\\Cref[1]{\\directlua{tdom_iso_ref_cref('\\luaescapestring{#1}')}\\TDOMisoCref{#1}}\\fi");
  // toc/lof/lot entries born inside the rescued block (longtable captions,
  // sectioning inside output-hijack envs …) — captured exactly like the
  // resident driver captures them, or the contents pages miss the entry
  L.push('\\let\\TDOMisoacl\\addcontentsline');
  L.push(
    '\\renewcommand\\addcontentsline[3]{' +
      '\\directlua{tdom_iso_in_acl=true}\\TDOMisoacl{#1}{#2}{#3}\\directlua{tdom_iso_in_acl=false}' +
      '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
      '\\protected@edef\\TDOM@tocentry{#3}' +
      "\\directlua{tdom_iso_tocline('\\luaescapestring{#1}','\\luaescapestring{#2}'," +
      "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
  );
  L.push('\\let\\TDOMisoatc\\addtocontents');
  L.push(
    '\\renewcommand\\addtocontents[2]{\\TDOMisoatc{#1}{#2}' +
      '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
      '\\protected@edef\\TDOM@tocentry{#2}' +
      "\\directlua{tdom_iso_tocline('\\luaescapestring{#1}','@raw'," +
      "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
  );
  L.push('\\makeatother');
  // dormant page over the REAL \vsize: material stays on one galley (the
  // absorb hands it back), while \pagegoal/\vsize read true page geometry
  // so multicols & co. balance exactly as in print
  // NB: inline \directlua bodies are read with LaTeX catcodes — no '%'
  // (comment) and no '#' (macro parameter) may appear in the Lua source.
  L.push(
    '\\directlua{' +
      'tdom_iso = { labels = {}, counters = {}, toclines = {}, refs = {}, ntl = 0, fires = 0, ships = 0 } ' +
      'tdom_iso_in_acl = false ' +
      // amsmath hands \ltx@label the key WITH braces — strip one pair
      'function tdom_iso_unbrace(s) ' +
      'if s and s:sub(1, 1) == "{" and s:sub(-1) == "}" then return s:sub(2, -2) end ' +
      'return s end ' +
      'function tdom_iso_label(k, v, h) table.insert(tdom_iso.labels, { tdom_iso_unbrace(k), v, h }) end ' +
      'function tdom_iso_label_cref(k, v) table.insert(tdom_iso.labels, { tdom_iso_unbrace(k) .. "@cref", v }) end ' +
      'function tdom_iso_counter(k, v) tdom_iso.counters[k] = tonumber(v) or 0 end ' +
      'function tdom_iso_ref(k) table.insert(tdom_iso.refs, k) end ' +
      // comma-list split for \cref keys (inline Lua forbids a literal '%',
      // so the character class is assembled via string.char)
      'function tdom_iso_ref_cref(keys) ' +
      'local P = string.char(37) ' +
      'for k in string.gmatch(keys or "", "[^," .. P .. "s]+") do ' +
      'table.insert(tdom_iso.refs, k .. "@cref") end ' +
      'end ' +
      // tocline capture mirrors the resident daemon: record the expanded
      // entry AND drop a stream marker so multi-page rescues anchor each
      // entry to its true page (inline Lua: no '#'/'%', hence ntl counter)
      'function tdom_iso_tocline(e, l, t) ' +
      'if l == "@raw" and tdom_iso_in_acl then return end ' +
      'table.insert(tdom_iso.toclines, { e, l, t }) ' +
      'tdom_iso.ntl = tdom_iso.ntl + 1 ' +
      'pcall(function() ' +
      'local m = node.new("whatsit", node.subtype("special")) ' +
      'm.data = "tdom:tl:" .. (tdom_iso.ntl - 1) ' +
      'node.write(m) end) ' +
      'end ' +
      'function tdom_iso_absorb() ' +
      'tdom_iso.fires = tdom_iso.fires + 1 ' +
      // runaway page builder (splitting env making no progress — usually a
      // bogus page context): material is DISCARDED, so the harvest must
      // not be trusted — count it and let the node side fail the compile
      'if tdom_iso.fires > 50 then tdom_iso.discarded = (tdom_iso.discarded or 0) + 1 tex.box[255] = nil return end ' +
      'tex.deadcycles = 0 ' +
      'if tdom_iso.ships == 0 then tdom_iso.preabsorbs = (tdom_iso.preabsorbs or 0) + 1 end ' +
      'local b = tex.box[255] ' +
      'local list = nil ' +
      'if b then list = b.list b.list = nil tex.box[255] = nil end ' +
      'if list then ' +
      // an absorbed fire IS a real page break: leave an eject marker at
      // the boundary so the harvested stream carries the break position
      'local mk = node.new("whatsit", node.subtype("special")) ' +
      'mk.data = "tdom:eject:-10000" ' +
      'local t0 = node.tail(list) t0.next = mk mk.prev = t0 ' +
      'local oldc = tex.lists.contrib_head ' +
      'if oldc then mk.next = oldc oldc.prev = mk end ' +
      'tex.lists.contrib_head = list ' +
      'end ' +
      'pcall(function() tex.pagetotal = 0 end) ' +
      'end}'
  );
  L.push('\\holdinginserts=1');
  L.push('\\maxdeadcycles=200');
  if (!realOutput) L.push('\\output={\\directlua{tdom_iso_absorb()}}');
  // material taller than the page inside an output-hijack env (multicols'
  // own routine) ships REAL pages — count them so the harvest knows the
  // pre-body machinery (and the isostart marker) left with page 1
  L.push('\\AddToHook{shipout/before}{\\directlua{tdom_iso.ships = tdom_iso.ships + 1}}');
  L.push('\\hbox to0pt{}');
  if (strut > 0.01) L.push(`\\vskip ${strut.toFixed(4)}bp`);
  L.push('\\special{tdom:isostart}');
  L.push(`\\directlua{tex.nest[0].prevdepth=${Math.round(prevPd)}}`);
  // \lastskip primer: a rescued block opening an \addvspace-emitting env
  // (tcolorbox/mdframed before-skip) must MERGE against the previous block's
  // trailing skip, but the isostart whatsit above resets \lastskip to 0.
  // Re-establish it here (after isostart, marked with LASTSKIP_ATTR so the
  // harvest drops the primer — it is already in the previous block's galley).
  if (prevLsSp > 0 && startsAddvspace(blockText)) {
    L.push(
      `\\directlua{local g=node.new('glue') g.width=${Math.round(prevLsSp)} ` +
        `node.set_attribute(g, 8124, 1) node.write(g)}`
    );
  }
  // \noindent only for blocks that CONTINUE a paragraph (start with text).
  // A block opening a vertical environment (\begin{tcolorbox|mdframed|…})
  // must NOT be forced into horizontal mode — that suppresses the env's own
  // \vskip before-skip (tcolorbox breakable) and drops leading glue. Carry
  // the real \if@nobreak flag instead so the env clears it exactly as print.
  if (prevNobreak) L.push(startsVertical(blockText) ? '\\makeatletter\\@nobreaktrue\\makeatother' : '\\noindent');
  L.push(blockText.trimEnd() + '}'.repeat(Math.max(0, braceImbalance(blockText))));
  L.push('\\par');
  for (const name of counters) {
    L.push(
      `\\ifcsname c@${name}\\endcsname\\directlua{tdom_iso_counter('${name}',\\number\\value{${name}})}\\fi`
    );
  }
  L.push(
    '\\makeatletter\\csname if@nobreak\\endcsname' +
      "\\directlua{tdom_iso_counter('tdom@nobreak',1)}\\else" +
      "\\directlua{tdom_iso_counter('tdom@nobreak',0)}\\fi\\makeatother"
  );
  // harvest: strip pre-body machinery + inserts, record per-item dims
  // (real break opportunities for the page builder), vpack and ship.
  // Same inline-Lua constraint: no '%'/'#' characters (LaTeX catcodes).
  L.push(
    '\\directlua{' +
      "tdom_iso_counter('tdom@pd', math.floor(tex.nest[0].prevdepth or 0)) " +
      'tex.triggerbuildpage() ' +
      'local head = tex.lists.page_head ' +
      'tex.lists.page_head = nil tex.lists.contrib_head = nil ' +
      'local INS = node.id("ins") local WH = node.id("whatsit") ' +
      'local HL = node.id("hlist") local VL = node.id("vlist") ' +
      'local GL = node.id("glue") local KE = node.id("kern") ' +
      'local SP = node.subtype("special") ' +
      // pre-body machinery precedes the marker ONLY when no page shipped;
      // otherwise it (and the marker) left with page 1 already
      'if tdom_iso.ships == 0 then ' +
      'while head do ' +
      'local ismark = head.id == WH and head.subtype == SP and head.data == "tdom:isostart" ' +
      'local nxt = head.next head.next = nil if nxt then nxt.prev = nil end node.free(head) head = nxt ' +
      'if ismark then break end end ' +
      'end ' +
      'local out, tail = nil, nil local n = head ' +
      'while n do local nxt = n.next n.next = nil n.prev = nil ' +
      // drop footnote inserts AND the \lastskip primer (attr 8124): the
      // primer only set \lastskip for the leading \addvspace merge
      'if n.id == INS or node.has_attribute(n, 8124) then node.free(n) else if tail then tail.next = n n.prev = tail else out = n end tail = n end n = nxt end ' +
      'local SP2BP = 65781.76 ' +
      'local function bp(sp) return math.floor(((sp or 0) / SP2BP) * 1000000 + 0.5) / 1000000 end ' +
      // no literal backslash may appear in inline Lua (TeX would tokenize
      // and expand it as a control sequence) — build it via string.char
      'local BS = string.char(92) local DQ = string.char(34) ' +
      'local function jq(s) ' +
      's = tostring(s) ' +
      's = s:gsub(BS, BS .. BS) ' +
      's = s:gsub(DQ, BS .. DQ) ' +
      'return DQ .. s .. DQ end ' +
      'local items = {} ' +
      'local m = out ' +
      'while m do ' +
      'if m.id == HL or m.id == VL then table.insert(items, \'{"k":"box","h":\' .. bp(m.height) .. \',"d":\' .. bp(m.depth) .. \'}\') ' +
      'elseif m.id == GL or m.id == KE then local a = (m.id == GL and m.width or m.kern) or 0 ' +
      'if a ~= 0 then table.insert(items, \'{"k":"glue","a":\' .. bp(a) .. \'}\') end ' +
      'elseif m.id == WH and m.subtype == SP and m.data and m.data:sub(1, 8) == "tdom:tl:" then ' +
      'table.insert(items, \'{"k":"tl","n":\' .. (tonumber(m.data:sub(9)) or 0) .. \'}\') ' +
      'elseif m.id == WH and m.subtype == SP and m.data and m.data:sub(1, 11) == "tdom:eject:" then ' +
      'table.insert(items, \'{"k":"eject","v":\' .. (tonumber(m.data:sub(12)) or -10000) .. \'}\') end ' +
      'm = m.next end ' +
      // empty remainder (env ended exactly at a page break): ship a
      // zero box so the last PDF page always exists for the node side
      'local b = out and node.vpack(out) or node.new("hlist") ' +
      'local f = io.open("state.json", "w") ' +
      'local labs = {} ' +
      'for _, kv in ipairs(tdom_iso.labels) do ' +
      'table.insert(labs, "[" .. jq(kv[1]) .. "," .. jq(kv[2]) .. ((kv[3] and kv[3] ~= "") and ("," .. jq(kv[3])) or "") .. "]") end ' +
      'local tls = {} ' +
      'for _, kv in ipairs(tdom_iso.toclines) do table.insert(tls, "[" .. jq(kv[1]) .. "," .. jq(kv[2]) .. "," .. jq(kv[3]) .. "]") end ' +
      'local rfs = {} ' +
      'for _, k in ipairs(tdom_iso.refs) do table.insert(rfs, jq(k)) end ' +
      'local cnts = {} ' +
      'for k, v in pairs(tdom_iso.counters) do table.insert(cnts, jq(k) .. ":" .. v) end ' +
      'f:write(\'{"w":\' .. bp(b.width) .. \',"h":\' .. bp(b.height) .. \',"d":\' .. bp(b.depth) .. ' +
      '\',"ships":\' .. tdom_iso.ships .. ' +
      '\',"discarded":\' .. (tdom_iso.discarded or 0) .. ' +
      '\',"preabsorbs":\' .. (tdom_iso.preabsorbs or 0) .. ' +
      '\',"labels":[\' .. table.concat(labs, ",") .. \'],"toclines":[\' .. table.concat(tls, ",") .. ' +
      '\'],"refs":[\' .. table.concat(rfs, ",") .. ' +
      '\'],"state":{\' .. table.concat(cnts, ",") .. ' +
      '\'},"items":[\' .. table.concat(items, ",") .. \']}\') ' +
      'f:close() ' +
      'tex.box[255] = b ' +
      'tex.pagewidth = math.max(b.width or 0, 65536) ' +
      'tex.pageheight = math.max((b.height or 0) + (b.depth or 0), 65536)}'
  );
  L.push('\\shipout\\box255');
  L.push('\\csname @@end\\endcsname');
  return L.join('\n') + '\n';
}

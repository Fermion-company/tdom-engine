import { luaStr, labelDefBody } from './util/tex.js';

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

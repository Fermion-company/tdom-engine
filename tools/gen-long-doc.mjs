// Generate a long synthetic document for scaling benchmarks.
//   node tools/gen-long-doc.mjs [sections] > samples/bench-long.tex
// Plain paragraphs + sectioning + equations + itemize: cheap blocks (no
// rescue environments), so the measurement isolates the engine's own
// per-edit scaling from block-content cost.

const SECTIONS = Number(process.argv[2] ?? 120);

const out = [];
out.push(`\\documentclass[11pt,a4paper]{ltjsarticle}
\\usepackage{luatexja}
\\usepackage{amsmath,amssymb}
\\usepackage[margin=22mm]{geometry}
\\title{長大文書スケーリングベンチマーク}
\\author{TDOM Engine}
\\begin{document}
\\maketitle
\\tableofcontents
`);

for (let s = 1; s <= SECTIONS; s++) {
  out.push(`\\section{ベンチマーク節 ${s}}`);
  out.push('');
  for (let p = 0; p < 6; p++) {
    out.push(
      `これは第${s}節の段落${p + 1}である。長大文書における増分更新の計測のための本文で、` +
        `編集箇所と依存範囲だけが再計算されることを確認する。The quick brown fox jumps over the lazy dog. ` +
        `インライン数式 $f_{${s}}(x) = x^{${p + 1}} + ${s}x + ${p}$ を含み、日本語の禁則処理も通常どおり働く。` +
        `この段落は他の段落と相互参照を持たず、純粋にページを埋めるために存在する。`
    );
    out.push('');
  }
  out.push(`\\begin{equation}\\label{eq:bench-${s}}`);
  out.push(`  \\int_0^\\infty e^{-${s}x} \\, dx = \\frac{1}{${s}}`);
  out.push('\\end{equation}');
  out.push('');
  out.push(`式\\ref{eq:bench-${s}}は第${s}節の基準式である。`);
  out.push('');
  out.push('\\begin{itemize}');
  out.push(`  \\item 第${s}節の項目その1`);
  out.push(`  \\item 第${s}節の項目その2`);
  out.push('\\end{itemize}');
  out.push('');
}

out.push('\\end{document}');
out.push('');
process.stdout.write(out.join('\n'));

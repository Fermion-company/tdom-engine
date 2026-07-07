import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tmpDir = path.join(root, 'tmp', 'pdfs');
const outDir = path.join(root, 'output', 'pdf');
mkdirSync(tmpDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const fullFiles = [
  'docs/README.md',
  'docs/00-first-read.md',
  'docs/01-tex-background.md',
  'docs/02-overview.md',
  'docs/03-checkpoint-engine.md',
  'docs/04-renderer-and-fonts.md',
  'docs/05-shared-substrate.md',
  'docs/06-correctness-performance.md',
  'docs/07-glossary.md',
  'docs/08-canonical-exact-layer.md',
  'docs/09-visual-fidelity-gate.md',
  'docs/10-edit-hot-path.md',
  'docs/11-shipping-chain.md',
];
const simpleFiles = ['docs/00-first-read.md'];
const simpleMode = process.argv.includes('--simple');
const files = simpleMode ? simpleFiles : fullFiles;
const outputStem = simpleMode ? 'tdom-engine-overview' : 'tdom-engine-docs';
const title = simpleMode ? 'TDOM Engine かんたん全体像' : 'TDOM Engine 実装地図';
const subtitle = simpleMode ? 'まず読む短い版' : '現行 Markdown docs PDF 版';
const sourceLabel = simpleMode ? 'docs/00-first-read.md' : 'docs/README.md, docs/00--11';

function esc(s) {
  return String(s)
    .replace(/𝛼/g, '@@MATHALPHA@@')
    .replace(/≤/g, '@@MATHLEQ@@')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}_$&#%])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/@@MATHALPHA@@/g, '\\ensuremath{\\alpha}')
    .replace(/@@MATHLEQ@@/g, '\\ensuremath{\\leq}');
}

function protectCode(s, { breakableCode = true } = {}) {
  const codes = [];
  const text = s.replace(/`([^`]+)`/g, (_, code) => {
    const id = `@@CODE${codes.length}@@`;
    codes.push(breakableCode ? `\\texttt{\\seqsplit{${esc(code)}}}` : `\\texttt{${esc(code)}}`);
    return id;
  });
  return { text, codes };
}

function inline(s, opts = {}) {
  let { text, codes } = protectCode(s, opts);
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = esc(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}');
  text = text.replace(/\*([^*]+)\*/g, '\\emph{$1}');
  for (let i = 0; i < codes.length; i++) {
    text = text.replace(`@@CODE${i}@@`, codes[i]);
  }
  return text;
}

function headingTextForPdf(s) {
  return String(s)
    .replace(/^\d+(?:\.\d+)*\.?\s+/, '')
    .replace(/^第\s*\d+\s*章\s*/, '');
}

function splitTableRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableToTex(lines) {
  const rows = lines.map(splitTableRow).filter((r, i) => i === 0 || !isTableSep(lines[i]));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const widths =
    cols === 2
      ? ['0.28\\textwidth', '0.64\\textwidth']
      : cols === 3
        ? ['0.20\\textwidth', '0.25\\textwidth', '0.45\\textwidth']
        : Array.from({ length: cols }, () => `${(0.9 / cols).toFixed(2)}\\textwidth`);
  const spec = widths.map((w) => `>{\\raggedright\\arraybackslash}p{${w}}`).join('');
  const out = [`\\begin{longtable}{${spec}}`, '\\toprule'];
  rows.forEach((r, i) => {
    const cells = Array.from({ length: cols }, (_, k) => inline(r[k] ?? ''));
    out.push(cells.join(' & ') + ' \\\\');
    out.push(i === 0 ? '\\midrule' : '');
  });
  out.push('\\bottomrule', '\\end{longtable}');
  return out.filter(Boolean).join('\n');
}

function flushParagraph(buf, out) {
  if (!buf.length) return;
  out.push(inline(buf.join(' ').replace(/\s+/g, ' ').trim()), '');
  buf.length = 0;
}

function mdToTex(md, fileIndex) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  const para = [];
  let i = 0;
  let inCode = false;
  let code = [];
  let firstHeading = true;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushParagraph(para, out);
      if (!inCode) {
        inCode = true;
        code = [];
      } else {
        out.push('\\begin{Verbatim}[breaklines=true,breakanywhere=true,fontsize=\\small,frame=single,framerule=.2pt,framesep=3pt]');
        out.push(...code);
        out.push('\\end{Verbatim}', '');
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      code.push(line.replace(/\\end\{Verbatim\}/g, '\\end\\{Verbatim\\}'));
      i++;
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph(para, out);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flushParagraph(para, out);
      const table = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) table.push(lines[i++]);
      out.push(tableToTex(table), '');
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      flushParagraph(para, out);
      const level = h[1].length;
      const title = inline(headingTextForPdf(h[2]), { breakableCode: false });
      if (level === 1) {
        if (fileIndex === 0 && firstHeading) {
          out.push(`\\chapter*{${title}}`, `\\addcontentsline{toc}{chapter}{${title}}`, '');
        } else {
          out.push(`\\chapter{${title}}`, '');
        }
        firstHeading = false;
      } else if (level === 2) {
        out.push(`\\section{${title}}`, '');
      } else if (level === 3) {
        out.push(`\\subsection{${title}}`, '');
      } else {
        out.push(`\\subsubsection{${title}}`, '');
      }
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph(para, out);
      out.push('\\begin{itemize}[leftmargin=2em]');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        out.push(`\\item ${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}`);
        i++;
      }
      out.push('\\end{itemize}', '');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph(para, out);
      out.push('\\begin{enumerate}[leftmargin=2em]');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        out.push(`\\item ${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}`);
        i++;
      }
      out.push('\\end{enumerate}', '');
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushParagraph(para, out);
      out.push('\\begin{quote}', inline(line.replace(/^\s*>\s?/, '')), '\\end{quote}', '');
      i++;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushParagraph(para, out);
      out.push('\\bigskip\\hrule\\bigskip', '');
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushParagraph(para, out);
  return out.join('\n');
}

const body = files
  .map((f, idx) => {
    const md = readFileSync(path.join(root, f), 'utf8');
    return `% ===== ${f} =====\n` + mdToTex(md, idx);
  })
  .join('\n\n');

const tex = String.raw`\documentclass[a4paper,11pt,oneside,openany]{ltjsbook}
\usepackage[top=24mm,bottom=26mm,left=22mm,right=22mm]{geometry}
\usepackage{luatexja}
\usepackage{luatexja-fontspec}
\usepackage{fontspec}
\setmainfont{Latin Modern Roman}
\setsansfont{Latin Modern Sans}
\setmonofont{Menlo}[Scale=0.84]
\setmainjfont{Hiragino Mincho ProN}
\setsansjfont{Hiragino Sans}
\setmonojfont{Hiragino Sans}[Scale=0.84]
\usepackage{xcolor}
\usepackage{hyperref}
\usepackage{xurl}
\usepackage{longtable}
\usepackage{array}
\usepackage{booktabs}
\usepackage{enumitem}
\usepackage{fvextra}
\usepackage{seqsplit}
\hypersetup{colorlinks=true,linkcolor=blue!45!black,urlcolor=blue!45!black}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.6em}
\emergencystretch=2em
\setlength{\tabcolsep}{4pt}
\setlength{\LTpre}{0.6em}
\setlength{\LTpost}{0.8em}
\renewcommand{\arraystretch}{1.25}
\DefineVerbatimEnvironment{Verbatim}{Verbatim}{breaklines=true,breakanywhere=true}
\begin{document}
\frontmatter
\begin{titlepage}
\centering
\vspace*{35mm}
{\Huge ${esc(title)}\par}
\vspace{8mm}
{\Large ${esc(subtitle)}\par}
\vfill
{\large 生成元: ${esc(sourceLabel)}\par}
\end{titlepage}
\tableofcontents
\mainmatter
` + body + String.raw`
\end{document}
`;

const texPath = path.join(tmpDir, `${outputStem}.tex`);
writeFileSync(texPath, tex, 'utf8');
for (let i = 0; i < 2; i++) {
  execFileSync('lualatex', ['-interaction=nonstopmode', '-halt-on-error', texPath], {
    cwd: tmpDir,
    stdio: 'inherit',
  });
}
copyFileSync(path.join(tmpDir, `${outputStem}.pdf`), path.join(outDir, `${outputStem}.pdf`));
console.log(path.join(outDir, `${outputStem}.pdf`));

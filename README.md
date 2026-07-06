# TDOM Engine — TeX DOM Runtime

> **Engine-core build.** This repository is the realtime-preview core
> extracted from `fermion-tex-engine`. The UI is exactly the TeX source
> editor, the live preview that converges to the real LuaLaTeX render, and
> the Engine Inspector, so the screen demonstrates the engine itself. All
> the document-editing UI (menu, word editor, insert builder, structure,
> refs, drawing, tables, AI, code-file workbench, click-to-edit overlay,
> MathLive) has been removed — `web/app.js` is a thin client that only
> draws. The full editor lives on in `fermion-tex-engine`.

A **resident, incremental TeX/LaTeX typesetting runtime** built around two
absolute conditions:

1. **The final display always equals real LuaLaTeX output.** Every page
   converges to a *canonical render* — a plain `lualatex` compile of the
   actual source, run asynchronously to its aux fixpoint and served as
   per-page SVG. The JS page builder, the glyph display lists and every
   other clever thing in this repository are *provisional* layers that the
   canonical render is allowed to override, never the other way around.
2. **Normal edits never reprocess the whole document synchronously.** The
   engine keeps the document state alive between keystrokes in a
   **fork-checkpointed resident LuaLaTeX**: every block boundary is a
   copy-on-write process snapshot of the complete TeX state, an edit
   resumes from the nearest snapshot and retypesets only the edited block
   plus its dependency frontier — measured **keystroke-to-patched-page
   latency: ~29 ms** (typesetting itself: 4–14 ms).

```text
            edit (ms)                        converge (async)
┌────────┐ ───────────▶ ┌───────────────────┐ ───────────────▶ ┌───────────────────┐
│ Editor │              │ provisional layer │                  │ canonical layer   │
└────────┘              │ checkpoint chain  │                  │ plain lualatex    │
                        │ + JS pagebuilder  │                  │ → PDF → page SVG  │
                        └───────────────────┘                  └───────────────────┘
                          paints instantly,                      ALWAYS wins once
                          may approximate                        it has landed
```

A **safety gate** decides whether a document may use the structured
(provisional) layer at all. Page-mechanism-hostile constructs (shipout
hooks, `twocolumn`, `\marginpar`, `\includepdf` …), preambles the resident
daemon cannot boot, and any verified provisional/canonical mismatch demote
the document (or the offending blocks) to the **opaque path**: the display
becomes the canonical LuaLaTeX pages themselves — still editable, still
converging, never wrong. Unknown structure is not a failure mode; it is
content rendered from LuaLaTeX's own output.

A second, orthogonal **visual fidelity gate** (`fidelity.js`) protects the
provisional layer's LOOKS: browser SVG text may only draw lines proven to
match LuaLaTeX output (the actual TeX font file served, no math, no
unencoded glyphs). Math lines, legacy CM / OpenType-math glyphs, and
anything uncertain render as **high-fidelity chunks** instead — the edited
block re-typeset by the resident checkpoint child, shipped as a tight PDF
and swapped in as SVG within ~100–200ms, while the previous exact pixels
hold the band ("a moment stale but clean" always beats "fast but wrong").
Verified divergence and browser font-load failures demote regions
per-block, sticky until their source changes.

## Quick start

```bash
git clone https://github.com/Fermion-company/tdom-engine.git
cd tdom-engine
npm start        # no npm install needed — zero dependencies
# open http://127.0.0.1:4633
```

Pick a starter from the **template selector** in the header
(`templates/*.tex`): an English academic article, a Japanese article
(luatexja, real kinsoku line breaking), math notes (theorem environments,
align, matrices) or a minimal skeleton — each preloaded with a table of
contents, numbered math, floats, footnotes, cross-references and a
bibliography so every live feature is one edit away. Adding your own
template is just dropping a `.tex` file with a `%% name:` header into
`templates/`.

Requirements (**mandatory** — the final display must equal real LuaLaTeX
output, which no fallback engine can promise):

- **Node.js 18+**
- **TeX Live + poppler**:
  - macOS: `brew install --cask mactex-no-gui && brew install poppler`
  - Debian/Ubuntu: `apt install texlive-latex-extra texlive-luatex poppler-utils`
  - needs `lualatex` and `pdftocairo` on PATH (`pdftotext`/`pdfinfo`
    recommended: they power the exactness verification and paper-size
    detection)

Run the test suite with `npm test` (the LuaLaTeX integration tests skip
automatically when no TeX installation is found).

## Compare view (pdf.js ↔ live preview)

The **比較** button in the header opens `/compare`, a full-bleed side-by-side
page: on the **left**, the *real* PDF — the canonical compile of the current
source (`/pdf`), rendered by a vendored [pdf.js](web/pdfjs/); on the
**right**, the engine's live preview. Both columns render at one shared
width so page *N* sits pixel-for-pixel over page *N*; scroll is synced and
the engine side stays live over SSE. This is the visual counterpart to the
built-in verification pass and the `tools/verify-layout.mjs` referee.

**Full implementation guide (Japanese):** [docs/](docs/README.md) —
a chapter-by-chapter walkthrough of the entire codebase, written for
readers without prior TeX internals knowledge. Chapter 8 covers the
canonical/provisional two-truth architecture added in this build.

---

TeX / LaTeX互換の入力を受け取り、**文書状態を常駐保持**し、**ソース変更差分から表示差分を生成**する、
インクリメンタルTeX組版ランタイムです。

エディタでも、latexmkのラッパーでも、PDFリロードでもありません。
本体は中央にいる**組版エンジン**であり、エディタとビューアはただの薄いクライアントです。

## 2つの絶対条件と2層の真実

このエンジンには順位のついた**2つの表示層**があります。

| | canonical層（権威） | provisional層（速度） |
|---|---|---|
| 実体 | 素の`lualatex`をauxが安定するまで実行した**実出力** | fork checkpoint常駐TeX + JS出力ルーチン |
| 更新 | 編集後に非同期・デバウンス（ホットパス外） | キーストローク同期（実測29ms） |
| 表示 | ページ単位SVG（`/canonical/n.svg`、viewport単位で遅延変換） | グリフ座標display list + 精密チャンク |
| 権限 | **常に勝つ**。リロード後の表示・PDF書き出しもこの層 | canonicalが未着のページだけを埋める |

編集されたページは即座にprovisionalへ戻り、canonicalの再コンパイルが
着地した瞬間にexactへ収束します。編集されていないページはcanonicalの
ピクセルを保持したまま一切再計算されません。プレビュー上部のバッジが
現在の状態（`✓ exact` / `preview 収束中` / `exact fallback`）を常時表示します。

## Safety gate と opaque モード

structured（provisional）層が扱ってよい文書かを保守的に判定します。

- **静的判定** (`engine/checkpoint/safety.js`): shipout hook・`\twocolumn`・
  `\marginpar`・`\includepdf`・eso-pic系パッケージなど、JSページビルダーが
  再現できない**ページ機構**を検出 → 文書全体をopaqueへ。
- **動的判定**: プリアンブルのboot失敗・組版フェーズの全面失敗 → opaqueへ
  demote（そのプリアンブルのままでは再試行しない。直せば自動で復帰）。
- **一致検証**: canonical着地時に`pdftotext`のページテキストと
  provisionalのグリフ流をトークン包含率で照合し、乖離したページの
  ブロックをexactレンダー経路（隔離rescue）へ恒久demote。
- **ブロック単位のopaque**（従来からの機構): multicols/longtable/
  breakable tcolorbox/TikZ等は隔離コンパイルの実PDFピクセルで表示。

opaqueモードでも編集は継続できます。表示は常に最後に成功した
canonicalページで、TeXエラーは実エラーメッセージ付きで表示されます。
**未知の構造は失敗ではなく、LuaLaTeX出力そのままで正しく表示される対象**です。

## checkpointバックエンド（provisional層の実体）

**fork()チェックポイント式の常駐lualatex。** エンジンプロセスは一度も再起動せず、
全ブロック境界がfork()による**完全なTeX状態のスナップショット**（コピーオンライト）
として常駐します。編集は直近のチェックポイントから再開され、キーストロークの
表側コストは：

```text
fork (0.2ms) + 変更ブロックのKnuth-Plass組版 (1-5ms) + 収束検証1ブロック
+ ノードリスト直接抽出 + ローカルソケットJSON
= 実測 組版3.7-14ms / キー入力→画面パッチ 29ms
```

ホットパスには**プロセス起動もプリアンブル再処理もフォント再ロードもPDFも
外部変換も存在しません**。表示リストはTeX自身のグリフ座標を運び、ブラウザは
**TeXが使ったのと同じフォントファイル**で描画します。

- **ライブ出力ルーチン**（`pagebuilder.js`）: 脚注・figure/tableフロート・
  目次・文献・前方/後方参照をTeXの実値でライブ配置。
- **複数ファイル**: `\input`/`\include`をブロック展開しファイル監視で自動更新。
- **巨大文書**: スパースチェックポイント + viewport遅延のcanonical変換で、
  通常編集の体感速度は文書全体の長さに比例しません。
- **日本語**: `\usepackage{luatexja}`で禁則込みの実組版（編集5ms級は不変）。
- プリアンブル変更 → 正直なフル再構築（ルート再起動 ~1秒）。

## アーキテクチャ（ファイル対応）

```text
Canonical Render      engine/checkpoint/canonical.js  素lualatex aux固定点コンパイル
                                                      → ページSVG遅延変換 / PDF書き出し
Safety Gate / Verify  engine/checkpoint/safety.js     structured可否の静的判定・検証トークン
Orchestrator          engine/checkpoint/engine-v3.js  checkpoint連鎖・依存追跡・demote制御
Live output routine   engine/checkpoint/pagebuilder.js TeXページビルダー+LaTeX出力ルーチンのJS転写
In-TeX daemon         engine/checkpoint/daemon.lua    ソケット通信・fork・ノードリスト収穫
fork(2) shim          engine/checkpoint/tdomfork.c    71行のCブリッジ
Source Store          engine/source-store.js          テキストバッファ + 範囲編集
Source DOM            engine/segmenter.js             ブロック分割・ハッシュdiff・ID安定化
常駐サーバー           server.js                       /edit /doc /chunk /canonical /pdf /events
Thin client           web/app.js                      provisional描画 + canonical収束 + Inspector
```

## エンジンAPI

```js
const eng = new CheckpointEngine({ workDir: '.tdom-v3', docDir: 'samples' });
await eng.open(texSource);        // フルビルドはこの1回（以後常駐）
await eng.edit(start, end, text); // 差分 → dirtyレポート + パッチ（+ canonical再スケジュール）
eng.getDOM();                     // ブロック/依存/ラベル/ページ/mode の観測
eng.getDisplayLists();            // provisional表示リスト
eng.canonical.info();             // {rev, pageCount, inFlight, error, ...}
await eng.canonical.pageSVG(n);   // 実LuaLaTeXページのSVG
await eng.exportPDF();            // canonical層のPDF（ソース不変ならキャッシュ）
```

## 成功条件との対応

1. **最終表示 = LuaLaTeX実出力** — canonical層が非同期に必ず追いつき、
   ページ単位で上書き表示。リロード後・PDF書き出しも同一の実出力。
2. **未知プリアンブルでも壊れない** — boot失敗はopaque demoteで吸収し、
   canonicalが表示を持つ。TeXエラーは実メッセージで表示。
3. **通常編集はO(編集箇所+依存frontier+可視出力)** — 編集ブロックと
   収束frontierだけをfork再開で再組版。無変更のblock/page/chunkは
   identityとキャッシュを保って再利用。
4. **viewport外のexact renderは編集をブロックしない** — canonical変換は
   ページ要求時（`loading="lazy"`）に行われ、コンパイル自体もホットパス外。
5. **provisionalが間違っていても最終的にexactが勝つ** — 一致検証が乖離
   ブロックをopaqueへ降格し、以後は実ピクセルで表示。

## 既知の制限

- structured層は twocolumn・marginpar 等を**扱いません**（設計どおり
  opaque fallbackへ）。これらの文書はcanonicalページのみで表示され、
  リアルタイム性は失われますが表示は常に正確です。
- opaqueモードの編集反映はcanonicalコンパイル1回分（文書規模に依存、
  数秒〜）の遅延を持ちます。
- 検証パスは`pdftotext`が無い環境ではスキップされます（canonical層の
  視覚的優先は変わらないため、最終表示の正しさには影響しません）。

# 11. shipping chain（incremental canonical）

この章は `engine/checkpoint/shipping.js` と `shipd.lua` が実装する第二の常駐 lualatex — ページ境界 checkpoint 付きの実ラン — の地図である。`TDOM_SHIP=1` で有効。

## 11.1 何であるか

cold canonical（08章）は編集のたび全文書を再コンパイルする最終監査である。shipping chain は**同じ「本物の出力」を、編集されたページ以降だけ**作り直す:

- 実 preamble・実 output routine のまま文書を1回走らせる。
- `\shipout` のたびに (a) **pager 子**がそのページだけを単ページ PDF として実 ship、(b) 親は `\DiscardShipoutBox`（親の PDF は永遠に未オープン）、(c) **resume checkpoint 子**を fork（ページ境界の完全な TeX 状態＋消費 unit カーソル）。
- 編集の最初の変更 unit がある checkpoint のカーソルより後なら、そこから RESUME — 以降のページだけが新世代として再 ship される。

再開後も「同じランの続き」なので、ページは再実装ゼロの LuaLaTeX 出力そのものである。

## 11.2 供給と再開カーソル

本文はソケット経由で **segmenter の \par 完結ブロック単位**で供給される（`SNEED n` → `SLINE len` payload）。環境が feeder ループの反復を跨がないことが halign 系（align/tabular）を壊さない不変量。行単位供給は input levels 爆発と環境破壊で不可（実証済み）。最終 unit は `\end{document}` 自身で、ランは `\enddocument` を通って終わる（最終 `\clearpage` が最後のページを ship する）。

`SSHIP page nline gen` の nline が再開カーソル。TeX は先読みするので、ページ k の checkpoint のカーソルはページ k+1 の材料まで進んでいることがある — 再開可否は「最初の変更 unit がカーソルより厳密に後」で判定する（保守的で健全）。

## 11.3 seed（1パスで収束させる）

boot 時に engine が注入する:

- **label**: `labelTable` の値＋暫定ページ番号（`\pageref` 用）→ `r@`/`b@`(cite) 定義。
- **contents**: `#computeToc` の .toc/.lof/.lot。

ship ラン内の `\label` はフックで捕獲され（`SLABEL`）、seed と食い違ったら **後方波及**（前のページが古い値を印字している可能性）として `shipStale` — cold が真実を持ち、chain は idle 後に修正 seed で再 boot する。

## 11.4 プロセス生涯の要点（踏んだ地雷）

| 事実 | 帰結 |
| --- | --- |
| `\DiscardShipoutBox` は shipout/after を発火させない | 簿記は全て shipout/before 側にある |
| output routine 内の `\end` は不正 | pager は「ship 済みフラグ→次の feeder 段（トップレベル）で終了」 |
| `finish_pdffile` はファイル完全 flush 前に発火し得る | ページ完成は **pager プロセスの exit（socket close）**で検知する |
| fork 子は親の socket fd を継承する | 子は自分の接続を張る前に継承 fd を閉じる（親の死活検知のため） |
| `\enddocument` は `\jobname.aux` を再 input する | pager dir に空 aux を置く |
| 深部で仕事中の feeder は DIE を読まない | resume は旧 feeder を SIGKILL で即時プリエンプト |

世代（gen）が resume ごとに進み、旧世代の遅延 SSHIP/SPAGED/ページ pixel は gen 照合で無視される。

## 11.5 資源

resume checkpoint はプロセスである。SSHIP のたび、直近 `TDOM_SHIP_RECENT`(16) ページは密に、それ以前は `TDOM_SHIP_GRID`(8) の倍数境界だけ残して DIE。グリッドへ落ちた位置への編集は最大 GRID−1 ページの余分な再 ship（各数十 ms）で賄う。

## 11.6 表示への接続

- engine: `#shipUpdate`（編集ホットパス末尾、unit diff＋socket 1行で安価）→ resume / 800ms デバウンス付き再 boot。`onShipPage({page, gen, srcRev})`。
- server: SSE `{kind:'ship', page, gen, srcRev}`、`GET /ship/:n.svg`（pdftocairo 遅延変換、gen+rev 付き URL は immutable キャッシュ）。
- client: ページごとに ship の鮮度（`srcRev ≥ pageDirtyRev`）と cold の鮮度を比べ、新しい方を `img.canon` の src にする。ship ページは canonical と同じ忠実度クラス（本物の LuaLaTeX ページ）なので、既存のオーバーレイ機構をそのまま使う。バッジの「exact」判定は cold 基準のまま。

## 11.7 現行の制約

- **hyperref 系文書**: hyperref は `\begin{document}` で PDF オブジェクトを
  書き、root の PDF がship前に開く（resident 側の `pdfOpenedAtRoot` と同じ
  現象）。pager の lazy-open 前提が成立しないため、feeder の初回ステップで
  検知（`SPDFROOT`）して chain を止め、cold canonical が表示を持つ（phase 1
  以前と同じ挙動、再 boot ストームなし）。回避候補（未実装）:
  begin-document 時の PDF 書き出しを遅延させる hypersetup 構成の注入。
- **label 乖離**: seed（engine の labelTable）と ship 実測が食い違うと
  `shipStale`（表示は cold が持つ）。走行はそのまま完走させて全真値を収穫し、
  1回の再 boot（予算3回）で収束させる。この検出器は resident 側の
  \frontmatter/\mainmatter 章番号バグを発見した実績がある。

## 11.8 テスト

`tests/shipping.test.js` — slice 1: 全ページが cold 2-pass とテキスト一致 / slice 2: 末尾編集の resume 波が新ソースの cold と一致し、prefix ページは gen0 の PDF のまま / slice 3: engine 統合（編集→`onShipPage` 着弾→SVG 供給→label 無波及）。

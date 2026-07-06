# 第8章 Canonical Exact Layer — 2層の真実と安全ゲート

この章は、2026-07 の大改修で導入された**表示の権威構造**を説明します。
第3章までのcheckpointエンジンは「速い側の層」として全面的に生き残って
いますが、その位置づけが変わりました。

## 8.1 何が問題だったか

改修前のエンジンは、JSページビルダー（`pagebuilder.js`）が組み立てた
display list を**最終表示そのもの**として扱っていました。ページビルダーは
TeXの出力ルーチンの忠実な転写であり検証もされていましたが、原理的には
「JS側の再実装が最終真実」という構造です。これは次の2点で危険でした。

1. ページビルダーが再現できない機構（shipout hook・twocolumn・
   marginpar…）を含む文書では、**表示が静かに間違う**。
2. 間違ったときに、それを検出して正す**上位の権威が存在しない**。

改修後の絶対条件は「最終表示は常に素のLuaLaTeX実出力と一致する」です。

## 8.2 2層の真実

```text
┌─────────────────────────────────────────────────────────┐
│ canonical層 (engine/checkpoint/canonical.js)            │  ← 権威
│   素のlualatexをaux固定点まで実行（最大3パス）           │
│   → canon-<id>.pdf → ページ単位SVG（要求時に遅延変換）   │
└─────────────────────────────────────────────────────────┘
                    ▲ 常に勝つ（ページ単位で上書き）
┌─────────────────────────────────────────────────────────┐
│ provisional層 (engine-v3.js + pagebuilder.js)           │  ← 速度
│   fork checkpoint常駐TeX、キーストローク同期パッチ       │
└─────────────────────────────────────────────────────────┘
```

`CanonicalRenderer` は編集のたびに `schedule(source, srcRev)` を受け取り、
デバウンス（既定350ms）・直列化・**latest-wins**（コンパイル中に届いた
編集は、完了後に最新ソースをもう1回だけコンパイル）で動きます。編集の
同期パスに入るのは「最新ソースを控えてタイマーを張る」ことだけです。

- **ページ数**はログの `Output written on … (N pages` から取得。
- **紙面サイズ**は `pdfinfo`（MediaBoxは圧縮オブジェクト内にあるため
  バイト走査では見えない）。
- **ページSVG**は `pdftocairo -f n -l n` を**要求されたページだけ**変換
  （クライアントの `<img loading="lazy">` と合わせて viewport-aware）。
  PDFはコンパイルidごとに保持され、次のコンパイルとレースしない。
- **失敗時**は直前の成功コンパイルを保持し、TeXの実エラー行を報告。
  打鍵途中の壊れたソースで表示が消えることはない。

### rev の二重系列

非同期パッチ（TikZチャンク差し替え等）は表示リストの `rev` を進めますが
ソースは変わりません。canonical層の追いつき判定を `rev` で行うと永遠に
「古い」ことになるため、**ソース改訂だけを数える `srcRev`** を別に持ち、
canonicalのスケジュール・検証・クライアントの鮮度判定はすべて `srcRev`
軸で行います。

## 8.3 クライアントの収束機構 (web/app.js)

各ページは2層のDOMです。

```html
<div class="page is-final">
  <svg>…provisional glyphs…</svg>       <!-- 下: 打鍵同期 -->
  <div class="chunkwin">…</div>          <!-- 下: 精密チャンク -->
  <img class="canon" loading="lazy">     <!-- 上: LuaLaTeX実出力 -->
</div>
```

- ページ`n`がcanonicalを表示する条件:
  `pageDirtyRev.get(n) ≤ canonical.rev`（dirtyマークは replace-page
  パッチ適用時に `srcRev` で記録）。
- canonical着地（SSE `canonical` イベント）で、カバーされたdirtyマークを
  消し、provisionalに存在しないページのシェルを作り、鮮度が完全なら
  provisionalだけの余剰ページを `phantom` として隠す（**ページ数の権威も
  canonical**）。
- リロード時、収束済みなら `canonical.rev === srcRev` なので初回描画から
  全ページexact（成功条件7）。
- opaqueモードではprovisional層を持たず、canonicalページのみを表示。

## 8.4 Safety gate (engine/checkpoint/safety.js)

structured層はJSで**ページ組み立てだけ**を再実装しているため、危険なのは
未知マクロではなく「ページ機構に触る構造」です。ゲートは3段構えです。

1. **静的**: eso-pic/atbegshi/pdfpages等のパッケージ、`\output`再定義、
   shipout hook、twocolumn、本文中の `\marginpar`/`\newgeometry`/
   `\enlargethispage`/`\includepdf` → 文書全体をopaqueへ。
2. **動的**: プリアンブルboot失敗・組版フェーズ全面失敗 → opaqueへ。
   demoteはそのプリアンブルhashに**粘着**し、打鍵ごとに失敗bootを
   繰り返さない（プリアンブルを直せば自動でstructuredに復帰）。
3. **検証** (`#verifyAgainstCanonical`): canonicalが現行`srcRev`に追い
   ついた時点で、`pdftotext`のページテキストとprovisionalのグリフ流を
   照合。トークンは**ラテン語系は単語・CJKは文字bigram**（行分割・
   ハイフネーション・リガチャ正規化に頑健）で、provisionalトークンの
   canonicalページへの**多重集合包含率**が0.8を下回ったページのブロック
   を `poisoned` へ登録 → 以後そのブロックは隔離rescue（実PDFピクセル）
   で表示される。**structured→opaqueの一方向demote**であり、無理に
   structuredへ戻すことはしない。

multicols・longtable・breakable tcolorbox・TikZは従来どおり**ブロック
単位のexact経路**（第3章の隔離rescue／レンダー子）で処理されるため、
文書全体をopaqueにはしません。fallbackの粒度は
「ブロック → ページ → 文書」の順で常に最小を選びます。

## 8.5 Opaqueモード

```text
編集 → SourceStoreに適用（O(編集量)） → canonical再スケジュール → 即return
```

opaqueモードのエンジンは常駐プロセスツリーを解放し、レポートは
`mode: 'opaque'` と理由を運びます。表示は最後に成功したcanonicalページ
のまま、新しいコンパイルが着地するたびに差し替わります。編集の反映は
コンパイル1回分遅れますが、**表示が間違うことは構造的にあり得ません**。
LuaLaTeXが受理する文書はすべて表示でき、拒否する文書は実エラーが
そのまま出ます。

## 8.6 ホットパス保証 — stale-first rescue

隔離rescueコンパイル（フルプリアンブルで数秒）は、いかなる経路でも
編集の同期パスに入らない。

- **stale-first**: rescue対象ブロックに前回のガレーがあれば、それを
  即座に再利用して表示し（provisional層は一時的に古くてよい —
  canonicalが最終ピクセルを保証する）、前回の出口状態からstate jobで
  継続チェックポイントを作ってチェーンの整合を保ち、正確な隔離
  コンパイルは**非同期キュー**（`rescueQueue` + `#pumpRescues`）で実行
  する。着地したらチェーンロック下で採用・収束・SSE再パッチ。
- **チェーンロック** (`#locked`): update・バックグラウンドチェーン
  再構築・rescue採用は同一ロックで直列化される。採用の収束チェーンは
  ブロック単位で `bgAbort` をチェックし、**編集が来たら即座に譲って
  自分を再キュー**する（編集のロック待ちは最悪でも1ブロック分）。
- **page-context固定点も非同期**: オフセットが動いた分割環境の
  再rescueは採用後の `#queueMovedOffsets` が非同期に反復する。
  フォアグラウンドのpagectxパスはstale-firstにより実質無料になった。
- canonicalコンパイル・SVG変換・検証はすべて非同期で、`/edit` の応答を
  待たせない（`/pdf` もエンジンのミューテーションキューを通らない）。
- **隔離レンダーはアイドルゲート付きの最低優先度**: hyperrefがrootで
  PDFを開く文書では、gfxブロックの精密チャンクがブロックごとの
  フルコンパイル（このプリアンブルで各~110秒）になる。rescueキューが
  空・canonicalが非コンパイル中・最終編集から3秒以上、の全条件が
  揃うまで実行を待つ。CPU飽和はfork型常駐組版を数十倍遅くするため、
  ここを絞らないとキーストロークが分単位に劣化する（実測で確認済み）。
  exactの保証はcanonical層が持つので、チャンクの遅延は表示品質にしか
  影響しない。
- 変換済みページSVGはコンパイルid付きURL（`/canonical/n.svg?c=<id>`）で
  immutableキャッシュされ、スクロールで再変換しない（LRU 400ページ）。

実測（70ページ/285ブロックのストレス文書）: 文挿入 11.3s→2.3s、
rescue環境内への入力 4.1s→2.3s、定常キーストローク 45〜300ms
（バックグラウンド収束中は数百ms、アイドル時は2桁ms）。

## 8.7 削除されたもの

v0（内部エンジン）と v1（ブロック独立コンパイル）のバックエンドは削除
されました。「LuaLaTeXなしでの互換表示」は非目標であり、絶対条件1と
両立しないためです。第5章はアーキテクチャ史として残っています
（コードはコミット `341afa3` 以前に存在）。

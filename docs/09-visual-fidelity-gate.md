# 09. 視覚忠実度ゲート

この章は、`engine/checkpoint/fidelity.js` と `engine-v3.js` の exact chunk
経路の地図である。safety gate が page assembly を structured path に入れて
よいかを判定するのに対し、fidelity gate は glyph 表示で描いてよい行か、
exact chunk に寄せる行かを判定する。

## 9.1 glyph 表示がそのまま信用されない理由

provisional 層の glyph display list は、TeX 自身から取った座標を browser SVG
`<text>` で描く。座標は TeX 由来だが、字形のソースには次の分岐がある。

1. **legacy CM (Type1)**: ブラウザは Type1 を読めないため mathmap.js が
   Latin Modern 双子へ置換（＝フォント置き換え。近いが exact ではない）。
2. **OpenType math (unicode-math)**: サイズバリアント・extensible 部品は
   cmap に無いグリフ（PUA/private slot）で、ブラウザは正しく描けない。
3. **フォント配信失敗**: `@font-face` が読めなければ静かに Times 系へ
   fallback する。

このため、glyph 表示は safe と判定できる行だけで使われる。判定不能な行は
exact chunk または canonical-only に寄る。

## 9.2 3層の表示ティア（再定義）

```text
1. canonical page layer     LuaLaTeX full output（最終権威・第8章）
2. high-fidelity chunk      編集された block / line / float / footnote を
   layer                    checkpoint子の tight \shipout → pdftocairo SVG
                            で描く（ピクセル＝実PDF）
3. safe glyph layer         TeXと一致すると判定できた行だけの SVG <text>
                            （実フォントファイル配信・shaping全停止）
```

glyph layer は「速いから使う」のではなく「**速くて壊れないと証明できた
から使う**」層になりました。判定不能はすべて 2 に落ちます。

## 9.3 判定 (engine/checkpoint/fidelity.js)

分類は3値です。

| verdict | 意味 |
|---|---|
| `safe-glyph` | ブラウザSVG textで描いてもTeX出力と十分一致 |
| `exact-preview-required` | TeX由来のexact chunkが必要（glyph は高々ブリッジ） |
| `canonical-only` | provisionalを信用しない。canonical page を待つ |

入力は2系統あります。

- **daemon.lua の行フラグ**（TeXのノードリスト自身から採取）
  - `it.x` — その行に math ノード・math フォント（`mathparameters` を持つ
    OpenType MATH、または legacy CM 名）のグリフが含まれる
    → その行は exact chunk 必須
  - `it.xb` — cmap 外グリフ（非legacyのPUA 0xE000–0xF8FF、plane 15/16 の
    0xF0000+、0x110000以上）を含む → glyph ブリッジも禁止。ビューアは次の完成した紙面を待つ
  - run の `m=1` — inline math の開始・終了ノード間から採取した数式由来
    マーカー。フォント名ではなく TeX の数式境界を使うため、`\mathrm`、
    `\mathit`、`\mathbf` のように本文系フォントを使う数式も識別できる
- **フォント配信ティア**（`#registerFont` が決定、runごとに参照）
  - `native` — TeXが実際に使った .otf/.ttf がディスクに実在し配信される
  - `twin` — legacy CM の Latin Modern 双子（mathmap.js）。置換なので
    exact 扱いにはしない（ブリッジは可）
  - `none` — 配信不能（双子の無いType1、実在しないファイル、ブラウザが
    ロード失敗を報告したファミリ）→ exact 必須＋ブリッジ禁止

数式は**フォントが健全でも原則 exact-preview-required** です（math ノード
/ math フォント検出が font 判定より優先）。未知の font id も `none` 扱い
（判定不能は必ず下に倒す）。

## 9.4 行粒度の chunk banding

ブロック全体を画像化するのではなく、行の内容と chunk の鮮度に応じて
表示を分けます。

- RENDER プロトコルはブロック galley 全体を 1 ページとして ship する
  （既存機構）。`buildStream` は `it.x` の行にだけ、そのブロック chunk 内
  オフセット（`yOff`）を窓にした `gfxChunk` 参照を張る。
- 数式行の周りの散文行は glyph のまま — display math と math-only 行は
  **line chunk** になる。
- stale な whole-block chunk があるときも、普通の散文行は現在の glyph を
  出す。古い block 画像が編集直後の本文を覆わない。
- fresh chunk が届いても exact 判定された行だけを chunk window にする。
  同じ block の安全な散文行は glyph のまま残すため、隣接する `\texttt` や
  `\textit` が数式レンダー待ちになったり、後から画像へ置換されたりしない。
- 本文と inline math が同じ行に混在する場合、`itemFlags` の bit 4 が立つ。
  fresh chunk 待ちの display list は本文 glyph と透明な math run を持つ。
  ビューアはその未完成ページを公開せず、直前の完成した紙面を保持する。
  全数式の exact chunk・フォント・文字座標・ソース範囲が揃ってから、
  影響するページ群を同時に切り替える。ページ減少は確定PDFの提示まで保留する。
- float は float ページ（2..1+F）、**脚注は新設の footnote ページ
  （2+F..1+F+N）**に ship され、`b13#1` / `b13@fn0` のキーで独立に
  banding される（数式入り脚注も exact）。
- 隔離rescue済みブロック（multicols 等）は従来どおり per-item chunk。

## 9.5 表示の優先順位

打鍵直後の各 exact 行は、良い方から:

1. **fresh chunk** — 現 galley の実PDFピクセル
2. **stale chunk** — 直前レンダーのピクセル（`st:1` でマーク）。
   「一瞬古いが綺麗」は許容、「速いが汚い」は不許容
3. **glyph bridge** — 非数式の exact-required 行だけ、全グリフが少なくとも
   写像可能（twin可・PUA不可）なら chunk 到着までの橋として表示。数式 run
   自体は常に透明
4. **前の完成ページを保持** — `xb` 行・降格ブロック・exact chunk 待ちの数式。
   未完成の display list は画面に出さず、次の exact ページまたは完成した
   provisional ページを待つ。chunk URL の版が変わった応答も採用しない

chunk の鮮度は `unitsSig` が chunk 版数＋fresh/stale ビットを持つので、
到着時に帯だけが差し替わります（第8章のバンド収束と同じ経路）。

## 9.6 レンダーポンプと3つの chunk ソース

`#queueRender` / `#pumpRenders`: ブロックごと latest-wins、**新しく編集
されたブロック優先（LIFO）**、並列度は既定2（`TDOM_RENDER_CONCURRENCY`）。
foreground update 中は一時停止し、チェーンロックには決して入らない —
**文書全体はもちろん、chunk レンダーすら編集の同期パスに乗らない**。

chunk のソースは3つで、**役割分担が固定**されています。

1. **常駐 RENDER = hot/changed block 用**（fork＋再組版＋pdftocairo）。
   `#scheduleBackground()` は、その編集で dirty になった block 数が
   `TDOM_RENDER_HOT_MAX` 以下のときだけ needsRender block を pump に積む。
   さらに async chain pass で実際に changed になった block も render queue
   に積まれる。boot 直後の大量 cold backlog や遠い stale block を全文 sweep
   しない。RENDER はその block 位置の checkpoint を必要とするため、
   **render hold** が off-grid checkpoint の退役を一時的に保留する。
   タイムアウト（`TDOM_RENDER_TIMEOUT`、既定20s）時は子を `SIGKILL` し、
   隔離経路へ引き継ぐ。
2. **canonical crop = コールドブロックの一括ソース**
   （`#cropCanonicalChunks`）: canonical が現行 `srcRev` に追いつき
   ページ数が一致し、段落の全行を source・SyncTeX・PDF の文字配置で
   照合できた場合だけ、canonical ページSVGから chunk を切り出す。
   1パスの照合上限は `TDOM_CANON_CROP_MAX`=40。ページ数や本文の一致
   だけでは切り出さない。数式・画像・副作用・未検証の描画がある場合は
   常駐または隔離レンダーを使う。切り出した文字座標はSVGと一緒に保持し、
   canonical の旧世代が破棄された後も同じ chunk を編集できるようにする。
3. **隔離レンダー**（フルプリアンブル、アイドルゲート付き最低優先度）:
   ドリフトで crop が届かないブロックの最後の受け皿。ポンプのレーンは
   占有しない（fire-and-forget）— ゲートが何分も閉じたままでも、編集
   ブロックの常駐レンダーは止まらない。

`tools/verify-layout.mjs` は canonical のコンパイルと隔離レンダーキューも
待ってから比較する。常駐ポンプの終了だけでは表や数式の exact chunk が
未着のことがあるため、到着後に追加された chain・render・header の処理も待つ。

## 9.7 検証による自動降格

canonical 着地時の一致検証（第8章 §8.4）が fidelity にも接続されました。

- glyph 描画がズレたブロック → `exact` 降格: 以後 glyph 特権を失い、
  chunk のみ（ブリッジも禁止）。従来どおり rescue にも poisoned 登録。
- **すでに exact ピクセルを表示していた**（rescued / block-exact）のに
  ズレたブロック → 配置そのものが誤り → `canonical-only` 降格:
  provisional を表示候補から外し、直前の紙面を保持して canonical page を待つ。
- 降格は `fnv1a(block.text)` に粘着し、**ソースが変わるまで戻らない**。
- ブラウザ側も `document.fonts.load()` で各 `@font-face` の実ロードを
  検証し、失敗を `POST /font-fail` で報告 → `demoteFontFamily()` が
  そのファミリを `none` に落として該当行を chunk へ切り替える
  （Times fallback が画面に残らない）。差分 report / async patch は同じ更新で
  font manifest を送る。未ロード family の run は `data-font-pending` で透明にし、
  実フォントの decode が完了してからだけ表示する。

## 9.8 実装対応表

| 表示対象 | 現在の実装 |
|---|---|
| display math がTeX品質 | math 行は exact chunk |
| inline math 段落の編集中に本文が古い chunk に隠れない | 全数式の exact chunk とフォントが揃うまで完成済みページを保持（§9.4） |
| 隣接する `\texttt` / `\textit` が遅れて差し替わらない | safe 行を構造化 glyph のまま維持＋font manifest を同時配送 |
| CM / LM / unicode-math / CJK が fallback しない | フォントティア＋`xb` 検出＋font-fail 降格 |
| TikZ / PDF literal は常にTeX由来 | 従来の `blk_gfx`（変更なし） |
| canonical 到着で大ジャンプしない | chunk ピクセル＝実PDFピクセル |
| full compile を同期で待たない | レンダーポンプと canonical は非同期 |
| ズレた領域の自動降格 | §9.7（source変更まで粘着） |

Inspector には gate の集計（safe / exact / canon-only / 降格数 / chunk
待ち数）が常時表示されます（`stats.fidelity`）。

## 9.9 直接編集の座標

`pdf-edit-geometry.js` は PDF.js の text operator から文字送り・kerning・CTM を読む。
canonical・render chunk・shipping PDF は同じ抽出器を使い、crop の原点を差し引く。
`/canonical/glyphs`、`/chunk-glyphs`、`/ship-glyphs` は表示世代を照合する。
TeX64は同梱PDF.jsの場所を `TDOM_PDFJS_PATH` で渡す。

`web/direct-edit-geometry.js` は文字と MathLive の要素を実 PDF の glyph に対応させる。
数式は SyncTeX の範囲内から式全体の記号構成を照合し、分子・分母・添字・行列の
配置で同じ記号を区別する。入力値や表示面が取得中に変わった座標は採用しない。
増分描画の文字位置はその chunk の実 PDF と SVG から取得し、canonical / shipping
PDF に切り替わったら座標もその世代へ切り替える。隔離組版されたブロックにも
ソースの編集範囲を渡す。クリックの照合中に届いた打鍵はカーソルの確定後に適用する。
表示したchunkの文字座標とソースsnapshotは紙面と一緒に保持し、エンジンが次の版へ
進んでも失わない。別文書への切替は `documentEpoch` でも照合する。
`/dom` は編集キューの後で範囲と原文をまとめて読む。`sources` は root の原文と
実際に展開した子ファイルの原文を別々に保持し、展開済み本文と混同しない。
未閉鎖構文で旧block範囲を保持している間は `sourceCurrent=false` とし、
新しい表示snapshotには採用しない。編集payloadの `sourceText`・範囲・`sourceRev` は
セッション開始時の表示snapshotへ固定し、ホストが現在のソースへ範囲を移す。

canonical 到着時の入力面の再配置は、開始時の原文へそのセッションの置換だけを
適用した結果が新しい原文と一致するとき、その範囲で証明する。途中の自分の打鍵は
旧表示を保持して待ち、別の変更で範囲を証明できない場合は入力面を閉じる。
同値の式・文字列や近い行を代わりに選ばない。同じソース版でも照合中に紙面が
差し替わったクリックは破棄する。旧PDFの別箇所へすぐ移った場合の入力継続と
再配置時の挙動は、複数箇所の編集・IMEを含む実画面確認で検証する。

数式の局所的な編集では元ソースの改行・空白と命令の区切りを保持する。
同じ式・文字列の繰り返しはソースと実際の描画の対応をまとめて照合する。
カーソル・選択・候補位置をこの座標から描き、透明な入力面のブラウザ座標とは分ける。
IME の未確定文字は入力開始時の PDF 座標へ下線付きで重ねる。変換中はソースへ送らず、
候補の選択・確定・取消キーを WYSIWYG や編集セッションの操作として消費しない。

現在の glyph 抽出は横書きが対象。縦書き・Type3・回転した個別 glyph は誤った水平
カーソルに変換しない。合字内部の文字境界は実 glyph の送りを分割する。

未取得の数式・画像・脚注・float は display list の `pending-exact` で通知する。
高さがまだ分からない初回rescueはページ全体の完成判定を保留し、高さを推測しない。
画像・フォント・座標・ソース対応の準備後にだけ次の紙面を表示する。

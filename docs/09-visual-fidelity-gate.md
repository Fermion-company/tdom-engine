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
    0xF0000+、0x110000以上）を含む → glyph ブリッジすら禁止（空白の方が
    「間違った字形」よりまし）
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

ブロック全体を画像化するのではなく、**数式を含む行だけ**が chunk 帯に
なります。

- RENDER プロトコルはブロック galley 全体を 1 ページとして ship する
  （既存機構）。`buildStream` は `it.x` の行にだけ、そのブロック chunk 内
  オフセット（`yOff`）を窓にした `gfxChunk` 参照を張る。
- 数式行の周りの散文行は glyph のまま — inline math 段落では「数式の行
  だけがTeXピクセル、他はグリフ」という**line chunk** が実現される。
- float は float ページ（2..1+F）、**脚注は新設の footnote ページ
  （2+F..1+F+N）**に ship され、`b13#1` / `b13@fn0` のキーで独立に
  banding される（数式入り脚注も exact）。
- 隔離rescue済みブロック（multicols 等）は従来どおり per-item chunk。

## 9.5 表示の優先順位

打鍵直後の各 exact 行は、良い方から:

1. **fresh chunk** — 現 galley の実PDFピクセル
2. **stale chunk** — 直前レンダーのピクセル（`st:1` でマーク）。
   「一瞬古いが綺麗」は許容、「速いが汚い」は不許容
3. **glyph bridge** — 全グリフが少なくとも写像可能（twin可・PUA不可）な
   行だけ、chunk 到着までの橋として表示
4. **blank** — `xb` 行・降格ブロック。間違った字形は一瞬でも出さない

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
   **ページ数が一致**したとき、stale な chunk を持つ全ブロック（1パス
   上限 `TDOM_CANON_CROP_MAX`=40）へ **canonical ページSVGからの
   切り出し**を登録する。コンパイルゼロ — オーバーレイが既に持つ
   ピクセルを chunk 座標系に写すだけで、次の編集の stale-exact 帯が
   グリフ近似ではなく実LuaLaTeXピクセルになる。ページ数がドリフトした
   文書では絶対に切り出さない（誤ったピクセルを登録しない）。
3. **隔離レンダー**（フルプリアンブル、アイドルゲート付き最低優先度）:
   ドリフトで crop が届かないブロックの最後の受け皿。ポンプのレーンは
   占有しない（fire-and-forget）— ゲートが何分も閉じたままでも、編集
   ブロックの常駐レンダーは止まらない。

## 9.7 検証による自動降格

canonical 着地時の一致検証（第8章 §8.4）が fidelity にも接続されました。

- glyph 描画がズレたブロック → `exact` 降格: 以後 glyph 特権を失い、
  chunk のみ（ブリッジも禁止）。従来どおり rescue にも poisoned 登録。
- **すでに exact ピクセルを表示していた**（rescued / block-exact）のに
  ズレたブロック → 配置そのものが誤り → `canonical-only` 降格:
  provisional を空白にして canonical page に任せる。
- 降格は `fnv1a(block.text)` に粘着し、**ソースが変わるまで戻らない**。
- ブラウザ側も `document.fonts.load()` で各 `@font-face` の実ロードを
  検証し、失敗を `POST /font-fail` で報告 → `demoteFontFamily()` が
  そのファミリを `none` に落として該当行を chunk へ切り替える
  （Times fallback が画面に残らない）。

## 9.8 実装対応表

| 表示対象 | 現在の実装 |
|---|---|
| display math がTeX品質 | math 行は exact chunk |
| inline math 段落で数式部分が崩れない | 行粒度 banding（§9.4） |
| CM / LM / unicode-math / CJK が fallback しない | フォントティア＋`xb` 検出＋font-fail 降格 |
| TikZ / PDF literal は常にTeX由来 | 従来の `blk_gfx`（変更なし） |
| canonical 到着で大ジャンプしない | chunk ピクセル＝実PDFピクセル |
| full compile を同期で待たない | レンダーポンプと canonical は非同期 |
| ズレた領域の自動降格 | §9.7（source変更まで粘着） |

Inspector には gate の集計（safe / exact / canon-only / 降格数 / chunk
待ち数）が常時表示されます（`stats.fidelity`）。

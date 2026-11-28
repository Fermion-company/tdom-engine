# 第4章 描画層 — TeXのグリフ座標をブラウザで寸分違わず再現する

対象ファイル：`engine/checkpoint/mathmap.js`、
`web/app.js`、`web/style.css`、`server.js` のフォント配信部、
および `engine-v3.js` の `#displayList()` / `#registerFont()`。

## 4.1 問題設定

第3章のガレー抽出で、私たちは「どのフォントの・どの文字を・どの座標に
置くか」をTeX自身の計算結果として持っています。残る問題は、それを
ブラウザに**同じ字形・同じ位置**で描かせることです。素朴にHTMLテキスト
として流すとブラウザが独自に行分割・カーニング・リガチャを行い、
TeXの結果と乖離します。

解法は3つの契約から成ります：

1. **フォントはTeXが使ったファイルそのものを配る**
2. **ブラウザの整形機能をすべて無効化する**
3. **位置調整の情報はrun分割として運ぶ**（第3章§3.7）

## 4.2 フォント配信

デーモンはガレー中に初出のフォントごとに
`{file: 実ファイルパス, name, size}` を報告します（`note_font`）。
オーケストレータの `#registerFont()` はこれを次の2つに正規化します：

- **family鍵**：ファイル内容ハッシュから `f-xxxxxxxx`（代替が要る
  レガシーフォントは `twin-<代替ファイル名>`）
- **配信パス**：`fontFiles: family鍵 → 絶対パス`

ブラウザは `/doc` で鍵一覧を受け取り、`injectFonts()` が

```css
@font-face {
  font-family: 'f-7cb4ba9a';
  src: url('/font/f-7cb4ba9a');
  font-display: block;
}
```

を動的に注入します。つまり**Latin Modernも原ノ味フォント（luatexja）も、
TeX Liveのディスクにある実ファイルがそのままブラウザフォントになり
ます**。`server.js` は `Cache-Control: immutable` を付けるので、
2回目以降のロードはネットワークにすら出ません。

## 4.3 ブラウザ整形の無効化と描画

ページはSVGで組み立てます（`app.js` `svgFor()`）。glyphsコマンド1つが
`<text>` 要素1つです：

```html
<text x="133.77" y="182.15" font-size="9.963"
      font-family="f-7cb4ba9a"
      style="font-kerning:none;font-variant-ligatures:none;letter-spacing:0"
      xml:space="preserve">machinery.</text>
```

- `font-kerning:none` — TeXのカーニングはkernノードとしてrun分割に
  反映済み。ブラウザに二重適用させない
- `font-variant-ligatures:none` — リガチャはTeX（HarfBuzz/luaotfload）が
  すでに実行済みで、runの文字列には「ﬁ」のような**合字コードポイント
  そのもの**が入っている。ブラウザの再合字は不要かつ有害
- run内部の字送りはフォントのadvance幅そのもの＝TeXの計算と同一
  ソースなので、開始xさえ合っていれば残りはピクセル未満の丸め差しか
  生じない

rule/folioコマンドは `<rect>`/`<text>` に、チャンク（精密SVG）は
ページdiv上の**クリップ窓つき`<img>`オーバーレイ**になります：

```html
<div class="chunkwin" style="left:21.8%;top:70.9%;width:56.1%;height:11.1%">
  <img src="/chunk/b13%231.svg?v=2" style="margin-top:-9.3%">
</div>
```

`margin-top` のパーセントがコンテナ**幅**基準であることを利用して、
チャンク内オフセット `sy` を解像度非依存に表現しています（この
CSSの仕様上の癖は意図的な採用です）。

## 4.4 数式フォント問題 — Type1をブラウザは描けない

現代のlualatexでも、**数式**の既定フォントは1980年代のComputer Modern
（Type1形式：cmmi10, cmsy10, cmex10, cmr10...）です。ブラウザの
`@font-face` は Type1 を一切サポートしません。ここが「実フォント配信」
戦略の唯一の破れ目で、`mathmap.js` が埋めます。

### 二重の変換

**（a）字形の置換**：Latin Modern は Computer Modern の公式後継
（同じメトリクス思想でOpenType化されたもの）です。そこで

| レガシーフォント | 双子（OTF） |
|---|---|
| cmmi\*（数式イタリック） | latinmodern-math.otf |
| cmsy\*（数式記号） | latinmodern-math.otf |
| cmex\*（大型演算子・括弧） | latinmodern-math.otf |
| cmr / cmbx / cmti / cmsl / cmtt / cmss / cmcsc（OT1テキスト） | lmroman / lmmono / lmsans 等の対応OTF（サイズは 5 / 6 / 7 / 8 / 9 / 10 / 12 / 17pt の最近傍） |

**（b）スロット→Unicodeの写像**：Type1時代のフォントは256スロットの
独自配置で、例えば cmmi10 のスロット0x19は「π」、cmsy10 の0x31は
「∞」です。`mathmap.js` はOML（数式イタリック）・OMS（記号）・OMX
（大型）・OT1（テキスト）の4エンコーディングについてスロット→
Unicodeコードポイントの静的表を持ちます（例：OML 0x0b→𝛼、
OMS 0x14→≤、OMX 0x5A→∫）。display list生成時に `remapText()` が
文字列を写像し、family鍵を双子に差し替えます。

### JSONを生き延びるためのPUAシフト

スロット値が32未満のグリフ（ギリシャ小文字の大半！）は、そのまま
文字列にするとJSONの制御文字として除去されてしまいます。デーモンは
**0xE000+slot（私用領域）にシフトして送信**し、`remapText()` が
受信側で 0xE000..0xE01F を元のスロットに戻してから表を引きます
（第6章・罠12）。

### cmexの幾何学とTWIN計測

cmex（大型記号）はさらに厄介で、**グリフのインクが基準点より下に
垂れ下がる**という特殊なメトリクス設計です（Σや√の大型版）。Unicode
双子は普通のベースライン設計なので、単純置換すると縦位置がずれます。

そこで2つの実寸を突き合わせます：

- **TeX側の実寸**：デーモンがglyphノード処理時にフォント表から
  高さ/深さを取り、runに `gh/gd` として添付
- **双子側の実寸**：起動時にdriver.texが `latinmodern-math.otf` を
  実際にロードし、`tdom_twin_metrics()` が全グリフの高さ/深さを
  TWINメッセージで送信（オーケストレータの `twinMetrics`）

display list生成時、cmex由来のrunは
`y' = y − gh + twinHeight(cp)·(size/10)` で**インク上端を厳密に一致**
させます。それでも「大型の可変サイズ字形（3段階の√など）はUnicodeに
1字しかない」という本質的ギャップが残るため、大型スロット
（0x10–0x4F, 0x58–0x77）を含むブロックは `blk_gfx=true` として
**精密レンダー層が最終表示を保証**します（即時層は近似・第3章§3.10）。

## 4.5 ブラウザ側の残りの仕事（web/app.js）

クライアントは徹底して薄く作られています：

- **編集送信**：textareaの旧値と新値の共通prefix/suffixから最小の
  `{start,end,text}` を計算してPOST。IME（日本語入力）中は
  compositionendまで送信を保留。checkpointバックエンドではデバウンス
  なし（毎打鍵送信——直列プロミスチェーンが自然にバースト合流させる）
- **パッチ適用**：`replace-page` のSVG・chunk・フォント・入力座標・ソース対応を画面外で用意し、
  取引ごとに、すべて揃ってから影響するページ群を同時に差し替える。`pending-exact` やstale chunkがある間は直前の完成した紙面を保持する。ページ数の減少には描画可能な差し替えが必要で、空の更新やページ数だけでは削除しない。engine は末尾の表示内容が同じでも、縮小時にはその表示リストを再送する。
  canonical 提示時には、同じ原文版の resident ページ数が一致し、whole-page `pending-exact` がないかも記録する。不一致の resident layout は次の編集でも物理ページの根拠にせず、旧 canonical の紙面を保持して表示待ちを通知する。同じ版の resident が後から完成すればこの判定を更新できる。通常文書で一致していた layout からの増減は、準備済みの差し替えと末尾削除を同じ取引で反映する。
  取引は `provisionalCommitGroups` が決める。連続するページ（改ページを越えて流れる内容）、同じ block を描くページ（新しい表示リスト同士、または一方の新しい表示リストと、他方の最後に差し替えた表示リスト・段取り中の表示リストのどちらかで同じ block。変わらない float のページを挟んで段落が分かれた・丸ごと移った場合）、1 つの編集のページ（report の `dirtySourceNodes`・`removedSourceNodes` の block を描く・描いていたページ。段落の分割・結合は block id を変える）が 1 つの取引になる。canonical のページ数が分かっていて resident と一致し、段取り中のページにすべて殻があれば、揃った取引から先に差し替える。前の打鍵のページや、編集が触った柱などの離れたページが exact 画素を待っていても、今打っているページを待たせない（同じ取引に入っていれば待つ）。その間、離れたページの番号が一時的に遅れることはある。ページ数が分からない・合わない間、ページの削除を伴う間、直接編集中は、従来どおり全ページを一度に差し替える。文書リセットの直後は紙面が空から始まり、exact 画素を待つページは見られるまで場所が無く、見られることもなかった（ホストが読者のページへ戻そうとしても 5 ページしか無かった、tex64-internal #121）。resident のページ数が canonical と一致し、layout 待ちのページが無ければ、resident の全ページに殻を作る。 resident のページで layout 待ちがなくなれば、resident のページ数がページの場所（shell）を作る。見えているページの exact ink を待つ間も先に作るので、挿入で後ろへ送られた最後のページ（裏表紙など）にも届く。shell は場所にすぎず、ページはその組が揃ったときに確定する。canonical の最新の compile が失敗していてこの版の compile も走っていない間（`canonicalCountStalled`）は、canonical のページ数を使わず、最初の canonical の前と同じく resident のページ数だけで伸び縮みする。そのとき canonical だけが塗れるページ（`canon`）は、ページ数も隣のページも引き止めない（tex64-internal #121）。この版の compile を待って保留した取引（縮みなど）は、その compile の失敗の知らせで試し直す（`retryCommitAfterCanonicalStall`。失敗が最後の出来事でも、次の編集や描画を待たない）。
- **SSE**：`update`（他ウィンドウの編集）と `patches`（レンダー子完了
  やバックグラウンド連鎖からの非同期差分）を受けて同じ適用経路へ。
  report と patches は engine の一つの番号（`rev`、レイアウトの版）で並ぶ。
  patches はその版のページ数（`pageCount`）と source revision（`srcRev`）を
  持ち、`/doc` は返す表示リストの版（`layoutRev`）とその source revision
  （`layoutSrcRev`）を持つ。viewer は、ページ集合
  （ページ数・末尾の削除・末尾への追加）を、それを述べた最も新しい版のものに
  し、各ページには送られた最も新しい表示リストを残す。後から届いた古い版の
  report や `/doc` は、それ以後に触られていないページの表示リストだけを持ち込み、
  ページ集合は変えない（patches 5 で戻ったページ 3 を report 4 が消していた）。
  layout 待ちの印を消すために読み直す `/doc` も、`layoutSrcRev` が適用済みの
  revision と違えば取らない。
  viewer がまだ適用していない source revision の patches は、その revision の
  report が届くまで持っておき、report の表示リストの後に revision の順で当てる。
  先に描くと、その ink が前の revision のクリック対応を使っていた（line 47 の ink
  に line 12）。ページの ink とクリック対応は、同じ source revision の表示リストと
  対応が揃ったときだけ一緒に替わる。それまでページは前の紙面のまま、その紙面自身の
  revision のクリック対応で操作できる。持っている patches より後の revision の
  report が来たら、patches の revision の report は失われている（frozen の report
  で取られなかった場合も同じ）。patches はその後の revision の下では描かずに捨て
  （古い表示リストが新しい対応で描かれていた）、表示リストを `/doc` から取り直す。
  取り直すまで、report はそれより前に段取りしたページを自分の revision へ持ち越さ
  ない。失われた report がそのページを変えたかもしれないので、そのページも前の
  紙面のまま。3 s たっても report が来なければ `/doc` を読む。その report が
  patches の revision 以上で、表示リストも同じ revision（`layoutSrcRev`）なら、
  表示リストと report を一緒に取る。以前はここで patches を前の revision の対応の
  まま描き、report が来るまで line 47 の ink のクリックが line 12 へ飛んだ。更新とその
  report の間に読んだ `/doc` は表示リストだけが次の revision なので取らず、patches
  は持ったまま待つ。その後にまた patches を持てば、その 3 s 後にまた読む。report
  も patches も来なければ読み直さず、紙面はそのまま操作できる。文書リセット
  （文書の切り替え、engine の再起動）は始めに、持っている patches とその時計、
  取り直しを捨て、新しい文書を `/doc` から読む。SSE がつなぎ直したときは、その間に
  送られた report が失われたかもしれないので patches を捨て、`/doc` から取り
  直す。取り直しは取れるまで report が来るたびに試し、`/doc` を読むのは 3 s に
  一度まで
- **直接編集**：通常のクリックは表示世代のPDF文字座標と `/dom` のソース範囲を
  対応させて文字・数式を編集する。Cmd/Ctrl付きクリックはソースへ移動する。
  このリリースから止めている（`directEditingOn()`、docs/13）。
- **読み手の位置**（`web/view-anchor.js`、app.js の viewAnchor）：紙面を替える
  取引の直前に読み手の位置を取り、同じタスクの中で戻す。位置は表示リストの
  行（block id とその中の行番号）と、その行の組版範囲の中の割合、表示域の中の
  y。直前の編集の行が表示域にあればそれが位置で、表示域に収まっている間は紙面を
  動かさず、出たときだけ元の y へ戻す。なければ表示域の中央の行をそのまま戻す。
  exact 画素だけのときはページとその中の割合。読むのは表示域のページと前後 2 枚
  だけで、取引の後は測らない（取引はページの箱を動かさないので、取引前の箱と
  新しい表示リストから位置が出る）。行が別のページへ移るときは、移り先のページ
  を同じ取引に入れる（準備ができていなければ読み手のページを最大 1 s 待たせる。
  以前は読み手の行が古いページから消え、移り先がまだ古い表示のままの間に位置を
  失い、ページの挿入で 1110 px 動いた）。canonical の世代は改ページが違うので、
  確定の前に読み手の行（resident の行はその revision の snapshot の原文行、
  exact 画素は表示中の世代の SyncTeX）を `/synctex/jump` で新しい世代の上に探し
  （0.8 s まで）、その行のページを同じ世代の取引に入れ、確定と同じタスクで
  戻す（以前は 152 px 動いた）。canonical の改ページで動いた編集の行もそのまま
  戻す。見つかった位置が読み手の今の行のものでなければ（その間に読み手が
  スクロールした）、確定時に取ったページとその中の割合を、確定後に測り直した
  ページの箱で保つ。SyncTeX を持たない shipping のページと、1 枚だけで載る
  exact のページでは、読み手の行の文字列をそのページの glyph の行
  （`/ship-glyphs`・`/canonical/glyphs`）に探す（ページに一度だけ現れる最初の
  行から最後の行まで。1 枚のときは 300 ms まで待つ）。ズームは表示域の中央の点を、幅の変わるリサイズも同じ点を保つので、
  `#pages` はブラウザのスクロールアンカーを使わない（`overflow-anchor: none`。
  ページの中身の差し替えには効かず、リサイズではページの上端を保つだけだった）。
  Jump・ホストの受け渡し・紙面上のエディタが動いている間と、読み手が自分で
  スクロールした後は、それらが優先する
- **Engine Inspector**：毎編集のレポート（dirtyチェーン・依存・
  キャッシュ/再利用統計・フェーズ別時間・履歴）を右ペインに描画。
  「この1文字で何がdirtyになったか」を常時目視できるようにするためのUI

---

次章は、現行チェックポイントエンジンが使う共有基盤です。

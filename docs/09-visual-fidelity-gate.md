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

display list は、行の内容と chunk の鮮度に応じて描画素材を分ける。
ビューアへの提示は、素材が揃った影響ページ群を単位に行う。

- RENDER プロトコルはブロック galley 全体を 1 ページとして ship する
  （既存機構）。`buildStream` は `it.x` の行にだけ、そのブロック chunk 内
  オフセット（`yOff`）を窓にした `gfxChunk` 参照を張る。
- 数式行の周りの散文行は glyph のまま — display math と math-only 行は
  **line chunk** になる。
- stale な whole-block chunk がある場合も、display list の普通の散文行は
  現在の glyph を持つ。ただし、ビューアは stale chunk を含む新ページを
  公開せず、直前の完成ページを保持する。
- fresh chunk は exact 判定された行だけの window になる。同じ block の
  安全な散文行や `\texttt` / `\textit` は glyph のまま保持し、完成した
  数式素材と同じページ群の提示時に更新する。
- 本文と inline math が同じ行に混在する場合、`itemFlags` の bit 4 が立つ。
  fresh chunk 待ちの display list は本文 glyph と透明な math run を持つ。
  ビューアはその未完成ページを公開せず、直前の完成した紙面を保持する。
  全数式の exact chunk・フォント・文字座標・ソース範囲が揃ってから、
  影響するページ群を同時に切り替える。ページ減少は確定PDFの提示まで保留する。
- float は float ページ（2..1+F）、**脚注は新設の footnote ページ
  （2+F..1+F+N）**に ship され、`b13#1` / `b13@fn0` のキーで独立に
  banding される（数式入り脚注も exact）。
- 隔離rescue済みブロック（multicols 等）は従来どおり per-item chunk。

## 9.5 ページ提示と素材の鮮度

画面は完成した canonical / shipping PDF、または必要な素材を揃えた
provisional ページ群を提示する。stale chunk（`st:1`）・未取得の exact
素材・透明な math run が残るページ群は公開せず、直前の完成ページを保つ。

provisional の素材には、現 galley の fresh chunk と安全な本文 glyph を使う。
非数式の exact-required 行も、全グリフを写像できる場合だけ glyph を使える。
数式 run 自体のブラウザ描画は透明に保ち、実PDFの chunk を待つ。
chunk の鮮度は `unitsSig` の版数と fresh/stale ビットで追跡し、URL の版が
変わった応答は採用しない。到着した素材は画面外で組み立て、フォント・文字座標・
ソース範囲まで揃えてから、影響する全ページを同じ処理内で切り替える。

## 9.6 レンダーポンプと3つの chunk ソース

`#queueRender` / `#pumpRenders` はブロックごとの latest-wins を保ち、現世代の
foreground で変わった bounded hot 集合を cold queue より先に処理する。
同じ優先度内では LIFO、並列度は既定2（`TDOM_RENDER_CONCURRENCY`）。
hot 集合は同じ紙面の提示に必要な隣接 block も含み、最終編集から
`TDOM_RENDER_QUIET_MS`（既定120ms）後に処理する。boot/reboot・過去世代・
deferred chain は、有効な shipping baseline がある場合の優先時間（既定900ms）を
維持する。foreground update 中は一時停止し、chunk レンダーは編集の同期パスに入れない。

chunk のソースは3つで、**役割分担が固定**されています。

1. **常駐 CAPTURE / RENDER = hot/changed block 用**。
   display math は foreground JOB が保持した node list を post-block checkpoint
   から CAPTURE し、本文の再組版を省く。保持 list の退役・世代不一致時は
   pre-block checkpoint の RENDER（fork＋再組版）へ戻る。PDFからSVGへの変換は共通。
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
空の行列セルはMathLiveの行・列・親要素と、実glyphで照合したSyncTeXの行基線・列位置を使う。
空の分子・分母は `/canonical/source-boxes` が同じPDF世代のSyncTeXから返す空hboxを使う。
分数の2つの兄弟hboxを印字された反対側のglyphと照合し、空欄の基線を確定する。
この取得は文書epochと世代を固定し、読み込み中の世代回収・文書切替に対応する。
不明なSyncTeX形式や曖昧な対応は採用せず、透明な入力面の空欄座標から推測しない。
行列・分数の後ろの構造的なカーソルは、全行・分子分母の実boxと祖先IDから、
外部の印字を含まない最小のhboxを照合し、delimiterやkernを含む右端と基線へ置く。
対応を証明できない構造境界を最後のセルや分母の文字位置として描かない。
空セル・空分子分母へのクリックも、同じ実boxで証明した空境界をhit候補へ加え、
最寄りの印字された分子や隣のセルの位置に置き換えない。
空境界の判定は1回の操作内でMathLiveのDOMを読まない全atom metadataと親枝・実boxの索引を共有する。
数式の印字照合だけがブラウザのglyph boundsを読み、同じ操作の範囲拡張では再読しない。
索引は操作終了時に破棄し、打鍵・Undo・PDF世代変更を越えて位置をキャッシュしない。
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
編集済みの旧領域への再訪では、下記の保存済みアンカーで確認した現在の原文を
最初の打鍵前に新セッションの送信基準として固定する。

クリック開始時は、その位置の透明な一時textareaへ同期フォーカスし、キー・貼付・
native `beforeinput` / `input` を保持する。WYSIWYG・文字位置の準備とIMEの確定を待ち、
入力面のカーソルへ順番に渡す。MathLive forkの公開 `focus()` は内部状態を先に変え、
実keyboard sinkへのDOMフォーカスを60ms遅らせるため、入力の引渡し時は
`.ML__keyboard-sink` にも同期フォーカスする。初期化中の `input` は編集として送らない。
文字キーのkeydownは横取りせず、native入力またはIME開始を待つ。確定した通常の
ASCII入力だけをWYSのキー処理へ渡し、IME確定文字はまとまった文字として挿入する。
既存の入力面から別の箇所へ移る間は、旧入力面のblurだけではセッションを終了せず、
新しい範囲が確定してから引き渡す。文字位置の照合が終わる前に次の箇所へ入力した場合は、
クリックごとの入力を別々に保持し、先の編集を送ってから次を開く。数式の文字対応も
ソースからモデルへの対応も証明できない場合は、末尾へ挿入せず入力を保持する。
まだ表示中の旧入力面へ戻るクリックも同じ順序で扱い、先の編集がその入力面を
取り除いても、保持した紙面のページ・範囲から開き直す。
行列などの空欄に使うMathLiveのplaceholderはモデルと選択位置に残し、保存用の
`latex-without-placeholders` だけから除く。確定PDFとの比較では空placeholderを
非印字として扱い、ソース差分の位置合わせはplaceholderも含む厳密なトークン比較を使う。
環境名やtext引数内の空白は有意として扱い、空白を保持した差分適用後も保存値を再照合する。
構造変更で余白が別のbrace内へ入る場合は、その回の正しい数式直列化を使う。
紙面からの数式カーソル・選択範囲の適用は、MathLiveの現在のUndo状態の選択も更新する。
内容の履歴を増やさず、全変更をUndoした後も最初にクリックした数式内の位置へ戻す。
行列の行・列コマンドは変更が完了してから内容と選択を一緒に記録し、Undo/Redoの
途中でも、その段階のセル位置を復元する。変更のないコマンドで履歴を増やさない。
モデル状態の復元では空の最終行も保持し、TeX解析時の末尾空行除去を繰り返さない。
必要な数式やページ・編集位置を証明できず旧紙面を保持する場合は、現在の文書epochと
source版を指定して確定表示を要求する。その版の既存予約だけをdisplay cadenceへ早め、
重複要求・失敗による追加組版や、後続の無関係な版への需要持越しは行わない。
完成したresidentページ群の提示が先に成功した場合は、表示側ごとの需要IDを解消し、
全需要がなくなった未開始予約を通常のauthority cadenceへ戻す。実組版中は中断しない。
埋め込みの状態表示は予約待ちと実組版、画面内の旧紙面の保持を区別する。
完成したprovisional面を表示できている間のauthority確認待ちは描画中にしない。
実画面では、クリックと同じ操作内の初回キー・native文字入力について、保存された値と
挿入位置と、別の編集箇所へ続けて入力したときの順序を確認する。
純粋関数やVMの確認は、実際のフォーカス・描画・入力イベントの
順序を保証しないため、このGUI確認の代わりにはしない。

埋め込み表示ではセッション開始時に一度 `edit-anchor` を要求し、ホストの編集履歴で
現在位置へ移した範囲と、その時点の原文を表示用の基準として返す。前の編集がまだ
旧PDFに反映されていなくても、この基準へ追従できる。返信待ちも入力を受け付け、
activation・文書epoch・session・request・開始sourceRevが一致する返信だけを採用する。
原文の返信は開始時の一度だけで、毎打鍵では増やさない。
終了済みの同領域へ戻る場合は、最大32件の前回セッションと `previousSessionId` を使い、
ホストが開始原文・範囲・現在の最終置換を照合する。確認した本文を復元してから
待機中の入力を渡す。本文は実入力の選択範囲、数式は live atom の `modelId` で
旧紙面のカーソルを移し、反復文字の対応を前後一致だけで決めない。
Undo / Redo は内部snapshotから実 atom identity を戻し、挿入・削除で偶然同じ
全文になった場合を Undo とみなさない。
canonical 到着時の入力面の再配置は、この基準の原文へそのセッションの置換だけを
適用した結果が新しい原文と一致するとき、その範囲で証明する。途中の自分の打鍵は
旧表示を保持して待ち、別の変更で範囲を証明できない場合は入力面を閉じる。
同値の式・文字列や近い行を代わりに選ばない。同じソース版でも照合中に紙面が
差し替わったクリックは破棄する。旧PDFの別箇所へすぐ移った場合の入力継続と
再配置時の挙動は、複数箇所の編集・IMEを含む実画面確認で検証する。
同一ページのcanonical更新では入力要素を挿し直さない。改ページは `moveBefore` と
MathLiveの移動callbackで入力状態を保持し、消える旧ページは入力面の転送後に削除する。
状態保持移動に未対応のブラウザではIME確定までページ移動を待つ。
編集中の入力面が別ページへ移った場合だけ、旧caretの画面内Yをできる限り保って
スクロールを追従させる。新glyphのcaret取得後に補正し、その間の手動スクロールは優先する。
クリック位置の照合と入力引渡し中は、canonical・provisional chunk・shippingの提示と
表示層の切替を保留する。通常のソース通知は順序を保持し、連続クリックの最後の
引渡し後に最新状態へ進める。明示的な文書切替だけは待たずに旧入力と保留通知を破棄する。
表示済canonicalとresidentのページ構成が違う場合は、residentに削除通知がなくても
増分ページ群を保持する。編集中のページを置換する際も、同じ原文範囲と全文の文字座標が
そのページに一意に残ることを確認する。改ページやUndo途中で証明できない配置は、
canonicalのページ群と入力面がまとめて移るまで提示しない。

数式の局所的な編集では元ソースの改行・空白と命令の区切りを保持する。
同じ式・文字列の繰り返しはソースと実際の描画の対応をまとめて照合する。
本文のクリックとcanonical後の再配置は同じ出現対応を使う。forward SyncTeXの原文範囲と
実際のword boxで絞り、整合する逆位置があれば更に限定する。逆位置が次の空行を指しても
forwardの証明を失わない。同じ行の複数出現は全数一致後にソース列順とPDF順を対応させる。
改ページ前の近い文字列へ寄せず、出現数や位置が矛盾した場合は対応を採用しない。
カーソル・選択・候補位置をこの座標から描き、透明な入力面のブラウザ座標とは分ける。
IME の未確定文字は入力開始時の PDF 座標へ下線付きで重ねる。変換中はソースへ送らず、
候補の選択・確定・取消キーを WYSIWYG や編集セッションの操作として消費しない。

現在の glyph 抽出は横書きが対象。縦書き・Type3・回転した個別 glyph は誤った水平
カーソルに変換しない。合字内部の文字境界は実 glyph の送りを分割する。

未取得の数式・画像・脚注・float は display list の `pending-exact` で通知する。
高さがまだ分からない初回rescueはページ全体の完成判定を保留し、高さを推測しない。
画像・フォント・座標・ソース対応の準備後にだけ次の紙面を表示する。

# 08. canonical 正本層

この章は、`engine/checkpoint/canonical.js` と、それを使う safety/verification/opaque 経路の地図である。

## 8.1 canonical renderer

`CanonicalRenderer` は、実 source をそのまま `lualatex` に渡して PDF を作る正本 layer である。チェックポイントエンジンの display list は編集直後の preview であり、PDF export と最終的な page pixels は canonical layer から来る。

主な public method は次である。

| method | 内容 |
| --- | --- |
| `schedule(source, rev)` | debounce/cooldown 付きで compile を予約する |
| `ensure(source, rev)` | 現 source の compile を強制し、成功 result を返す |
| `settle()` | pending/running compile を drain する |
| `info()` | rev/id/pageCount/paper/passes/ms/error などの snapshot |
| `pageSVG(page, id)` | 指定 compile id の page SVG を lazy 生成する |
| `pageTexts(id)` | `pdftotext` で page text を返す |
| `pdfBytes()` | 最後に成功した PDF bytes を返す |

compile は aux family の hash が安定するまで回る。上限は `MAX_PASSES = 3` である。page SVG は `pdftocairo` により要求された page だけ変換し、LRU cache に載る。paper size は `pdfinfo` から取得する。

## 8.2 scheduling

canonical scheduling は latest-wins である。compile 中に新しい source が来た場合、完了後に最新 source が pending として残る。

structured mode では `pressure = 'authority'` で、基本 debounce に加えて前回 compile time に比例した cooldown を持つ。opaque mode では `pressure = 'display'` になり、canonical compile 自体が表示更新なので debounce 中心で動く。

編集がすでに先へ進んだ source の compile が失敗した場合（打ちかけのコマンドの時点で始まった compile など）、紙面は何も作られていない。その後の版の compile は cost cooldown を待たず、書き手の休止（authority では `idleMs` と最大 staleness、display では `displayDebounceMs`）だけを待つ（`failedBehindRev`）。この免除は失敗が続く間に 1 回だけで、免除された compile も失敗すれば通常の cooldown に戻り、compile が着地すると再び使える。失敗した版かそれより後の版の generation が着地したら（失敗の後の PDF 書き出し `ensure()` など）免除はもう要らないので消し、次の編集は通常の cooldown を待つ。以前は 30 ページの冊子で 47 s の compile の失敗のあと 94 s 待ち、その間 canonical だけが塗るページ（ノート罫など）が欠けたままだった（tex64-internal #121）。

最初の baseline は resident の boot walk を待たない。`engine.open()` は walk の前に、open が公開する revision（`srcRev + 1`）でその source を予約する。canonical は resident tree を使わないので、walk と並んで走る（316 ページの実文書では walk 76 s と 3 pass の baseline 125 s が直列で、どちらも終わるまで打鍵を anchor できなかった）。walk の最後の `schedule()` は同じ revision・同じ bytes なので、走行中ならそのまま、着地済みなら `#reconcile` で終わり、2 本目の compile も待機中の debounce のやり直しも作らない（同じ bytes で失敗済みの revision も組み直さない）。walk より先に着地した世代は、その `#reconcile` が arrival hook（検証・crop・checkpoint 予算）を現行 revision で呼び直す。Build lease 中の `schedule()` はこの省略をせず、Build 取り込みが所有する pending job を必ず作る。Build を取り込む open では先行させない（`TDOM_CANON_EARLY_BASELINE=0` で従来どおり walk の後に予約）。初回の open では並走する 3 pass の compile の分だけ walk が遅くなる（316 ページの実文書で `/open` 88 s → 117 s）が、アプリの viewer は開いた直後、現在の revision の canonical が着地するまで live 面に切り替えない（web/app.js は開いた時点の全ページを一つの取引として段取りし、枠の exact chunk が揃わないページがある限り確定しない）ので、表示までの時間は `/open` と最初の canonical の遅い方で決まり、先行させた方が短い（最初の canonical は開始から 216 s → 153 s）。開き直しでは §8.2b' の aux で 1 pass になり、`/open` はほぼ変わらず（69 s → 70 s）、canonical は `/open` の完了時点で着地済みになる（109 s → 70 s）。open が例外で終わった場合は予約した revision を消費済みにし、後の編集が同じ revision 番号で別の source を公開しないようにする。

`GET /pdf` は `engine.exportPDF()` 経由で `canonical.ensure()` を呼ぶ。表示用 checkpoint state から PDF を作る経路はない。

### 8.2a content identity（世代の再束縛）

generation の同一性は「root source のバイト列」と「compile が読んだ project input のバイト列」で決まる。
root は `srcHash` が、input は `inputManifest`（logical path → sha256、`-recorder` の `canon.fls` から採取。
Build 取り込みでは `.fls` 検証済みの records から受け取る）が担う。

`inputEpoch` は子ファイル編集・外部変更（バイト列が変わった通知だけ。docs/13 §13.4）・bibliography 更新のたびに単調増加するが、その epoch ごとに
「どの logical path を無効化したか」を `inputInvalidations` に記録する。ある generation について、

1. root が `srcHash` と一致し、
2. generation の epoch 以降に無効化された path がすべて既知で、
3. その path がすべて manifest に含まれ、現在 TeX が読むバイト列（overlay があれば overlay、なければ disk）の sha256 が manifest と一致する

とき、その generation は現在 revision の exact compile である。`schedule()` はこれを同期的に判定し、
`last` を現在 rev / epoch に再束縛して pending job を捨てる（`info().rebound` が回数）。編集応答の
`canonical.rev === srcRev` になり、次の anchor はどのブロックでも即座に certified base を持てる。
Build 直後に別章を編集して元に戻す往復はこれで recompile を要しない。

証明できない場合（manifest なし、`unknown` な変更集合、compile が読んでいない path の変更、読めない入力、
記憶上限を超えた古い epoch）は従来どおり fail closed で再 compile する。再束縛は `last` にのみ行い、
より古い retained generation へは戻さない。compile 中に入力が無効化された generation は manifest を持たない。

### 8.2b Build seed の配置

通常 Build を取り込む `commitBuildGeneration` は、検証済みの aux/toc/lof/lot/out を canonical の作業
ディレクトリへ `canon.*` として配置し、Build に無い拡張子の古いファイルは消す。Build 後の最初の canonical
compile は Build が収束させた aux 群から始まるので、本文編集なら 1 pass で fixpoint に達する。

### 8.2b' 開き直したプロジェクトの aux

最後に昇格した compile の aux 系（aux・toc・lof・lot・out）は、プロジェクト（`docDir` と main ファイル）ごとに
canonical 作業ディレクトリの `aux-seeds/<key>.json` へ、その compile の preamble のハッシュと一緒に保存する。
アプリの作業ディレクトリは起動をまたいで残るので、次に同じプロジェクトを開いたときは `engine.open()` が最初の
compile の前に `restoreProjectSeeds()` でそれを `canon.*` として置き、最初の baseline は多くの場合 1 pass で
fixpoint に達する（316 ページの実文書で 3 pass → 1 pass）。種は pass を省くだけで、compile は aux 系が
変わらなくなるまで回り続ける（latexmk が既存の aux から始めるのと同じ）。

aux にはパッケージ自身が命令を書く（biblatex の `\abx@aux@…` など）ので、別の preamble の aux は
`-halt-on-error` の下で compile を止め得る。置くのは preamble が保存時と同じときだけで、それでも種ありの
compile が失敗したら保存分を捨てて種なしで 1 回だけ compile し直す。`\include` は子ごとの aux を書き、
pass ループの fixpoint 判定は `canon.*` しか見ないので、子 aux を書いた compile の種は保存しない
（古い子 aux を読んだまま 1 pass で止まり得る）。Build を取り込む open は Build 自身の種を使い、
参考文献や preamble 入力の変更による内部の開き直しは従来どおり空の aux から始める。
`TDOM_CANON_PROJECT_SEEDS=0` で無効、保存は 64 プロジェクトまで（mtime の古い順に削除）。

### 8.2c Build lease と resident bootstrap

`POST /canonical/build-lease/acquire` は `pendingDocumentReset`（/open の resident 起動中）・`shipBooting`・
`warming` の間は 409 `resident-bootstrap-active` を返し、`blockedBy` にどの段階かを載せる。`warming`
だけが理由なら、先に `engine.yieldWarmForBuild()` でキャレット warm walk を次のブロック境界で止めてから
判定する（到達境界は pin され、次の warm はそこから再開する）。/open の resident 起動そのものは中断しない
（設計案は issue #52 の引き継ぎ §4A）。

### 8.2d pass 間の譲り渡し

`#drain` が起動した scheduled compile は、各 LuaLaTeX pass の正常終了時に「より新しい rev の pending job
がある」か「再束縛で `last.rev` が自分の rev を追い越した」場合、追加 pass と publish を中止して最新へ進む
（`tdomSuperseded`、エラーとして報告しない）。最初の baseline と `ensure()`（export・Build）は対象外で、
依頼された snapshot を必ず組む。1 pass で fixpoint に達した compile はそのまま publish される。

## 8.3 client convergence

`server.js` は canonical compile が着地すると SSE `canonical` event を送る。client は compile id を付けて `/canonical/:n.svg?c=<id>` を取りに行く。stale id なら 404 になり、現在の id で取り直す。

表示側は provisional layer、exact chunk layer、canonical page layer を重ねる。source rev が一致した canonical page は最終表示として勝つ。編集で dirty になった page/band だけが provisional に戻り、次の canonical 着地で消える。

## 8.4 safety gate

`safety.js` は document-level に structured path を壊す構造を検出する。危険なのは未知 macro ではなく、page assembly を document-wide に変える構造である。

現在 document-level unsafe に入るもの:

- `flowfram`、`eso-pic`、`everypage`、`background`、`xwatermark`、`draftwatermark`、`atbegshi` などの shipout/page paint 系 package。
- custom `\output`、raw `\shipout`、shipout hook、`\AtBeginDvi`。
- 列状態だけでは表現できない独自の出力ルーチン変更。
- `\newgeometry`、`\enlargethispage`。
- `\balance`。

`pdfpages` package の読み込み自体は unsafe ではない。実際の `\includepdf` は block-level rescue 対象である。

標準 class option の `twocolumn` と本文中の `\onecolumn` / `\twocolumn` は document-level unsafe ではない。resident LuaLaTeX はこれらの実定義を実行し、TeXプリミティブで出力箱を吸収して、active column mode と実 `\columnwidth` を各 checkpoint に保存する。表示面は canonical PDF のまま、TeXの edit-region scanner が可視本文と証明した変更だけを SyncTeX で物理ページ・物理列へ重ねる。同じ段落に装飾コマンドやコメントがあっても、内部段落は行数不変かつ先行行同一なら変更行以降を差し替え、terminal block は同じ証明の下で1行だけ増える場合も扱う。それ以外の再改行、未確定構文、数式、graphics、副作用を伴う block は last-good PDF を保持して real output shipping または次の canonical に任せる。`\marginpar` / `\marginnote` は本文 galley を保持する canonical-only block である。

## 8.5 block-level rescue

`engine-v3.js` の `OUTPUT_HIJACK_RE` に一致する block は、文書全体を opaque にせず exact block として扱われる。現在の対象は、`multicols`、`paracol`、`longtable`、`landscape`、`mdframed`、`framed`、`shaded`、breakable `tcolorbox`、`\includepdf` である。

rescue block は stale-first で表示される。前回の galley/chunk があればそれを保持し、isolated exact compile は async queue で進む。

前回の galley が無い初回 rescue は、測った箱を持たない placeholder になる。placeholder は後続のページ割りを動かし得るので、一つでも残っていれば組んだ全ページが表示不可（`pendingExact`）になる（`pagebuilder.js` `buildPages`）。そのため boot（reboot を含む）の walk は、fork runner（checkpoint 0 と real-output root）が生きている間、初回 rescue をその場で compile して採用する（`#bootIsoCompile`、compile 時間の合計で `TDOM_BOOT_RESCUE_MS` 既定 45 s まで。超えた分と fork が無い場合（cold compile は 1 件 5 s を超える）は従来どおり placeholder と async queue）。316 ページの実文書では multicols 31 個が fork-real で 1 件 約 1 s、`/open` が 70 s 台から 90 s 台に延びる代わりに、/open の時点で常駐側が 316 ページ・queue 0 になる（従来は placeholder が全ページを約 4 分塞ぎ、開いた直後の打鍵は最初の canonical まで表示されなかった）。boot walk は pagination 前（page offset 0）に compile するので、実際の offset が違う block はディスクキャッシュから採用した結果と同じく moved-offset pass が再 rescue する。

async queue は文書順に進むが、編集した block と caret の block（`/warm`）を含むページにある queue 中の rescue（そのページの `pendingExact` と block）を `rescueFocus` として先に取り、打鍵後の静寂待ち（800 ms）も省く（compile は lock の外、採用の walk は打鍵に block 境界で譲るのは同じ）。採用が chain lock を待っている間は grid 充填 pass が次の block 境界で譲る（docs/03）。

foreground 完了と caret focus の更新は pump の待機を解除し、現在の focus・入力 key を再確認させる。通知前の200ms pollの残りは待たない。ISO組版は直列であり、完成PDFのうち描画入力が変わったページのSVG化だけを最大2本の `pdftocairo` で進める。すべての変換完了まで採択せず、失敗時も実行中の変換を回収してからretryする（`iso-pages.js`、docs/10 §10.8）。

isolated compile の結果はプロセスを跨いで保持する（`iso-disk-cache.js`、`<workDir>/isocache/<epoch>/<key>.json`（`iso-` 始まりの名前は server 起動時の stale artifact sweep に消されるので使わない） + chunk の PDF）。rescue key は compile が依存する入力（block text・入口 state・preamble・参照 label の値・page offset）をすべて含むので、同じ入力なら後のエンジンが結果を再利用できる。再オープン時は boot walk がその block を inline で adopt し（`rescueBlock` の cache hit 経路 = state job 1 本）、cold compile の drain を待たずに resident のページ数が canonical と揃う（316 ページの実文書では multicols 31 block × cold 5.4 s + adopt walk ≈ 5 分が消える）。boot walk は pagination 前に key を作る（page offset 0、galley なし）ので、実 offset で保存した結果は見つからない。そのため各結果に offset を含まない base link（text・入口 state・preamble）も置き、galley のない初回 rescue は base の結果を（参照 label の値が当時と同じなら）その場で adopt する。着地した offset が `compiledOff` と違えば moved-offset pass が通常どおり再 rescue する。key（full・base とも）には直前 block の trailing glue（幅・stretch/shrink とその order。iso compile が `\addvspace` の合流のために再現する入力で、state vector には幅しか無い）も含める。base 採用時は cache の `refVals` を現在の label 値と照合し（未定義の forward ref は後の label pass が key を変えて再 rescue する）、名前空間 `epoch` は daemon.lua / shipd.lua / tdomfork.c と iso 関連 JS（context・render source・runner・compile・result・pages・page-cache・rescue-block・rescue-cache・disk-cache）のハッシュ・engine version・`lualatex --version` を含み、toolchain や cache の意味論の更新後は古い結果を使わない。`TDOM_ISO_DISK_CACHE=0` で無効、既定の上限は 512 entry（mtime の古い順に削除）。

walk が rescue を通るたびに結果は cache から adopt し直される。memory の cache（既定 48 entry）が手放した結果を disk cache から読み直すと、PDF は同じ bytes の別の buffer になる。adopt し直した chunk が前と同じかどうかは PDF を bytes で比べ（`galley-adoption.js` の `samePdf`）、同じなら chunk も版もそのままにする。object で比べていた間は、通った rescue が全部新しい版になり、そのページが viewer に送り直された。30 ページの冊子で付録の前に 1 講を打つと 3〜31 ページが送り直され（c53846b でも 3〜6・17〜20 ページ）、まだ一度も描いていない exact block（cold な boot は queue しない）を持つページは、読者がそこで止まって warm が画素を作るか、次の canonical まで、古い紙面のままになった（tex64-internal #121 round 10、26 ページの Data の枠）。

isolated compile の runner は三種（`iso-context.js`）。**fork-absorb** は checkpoint 0 の子で、dormant regime を受け継いだまま iso absorb 用の `\output` を入れ、galley 素材（分割しない block）を組む。**fork-real** は real-output root の子で、LaTeX 本来の `\output`・`\vsize` のまま分割系 env（multicols / multicols* / longtable / mdframed / breakable tcolorbox）と `\includepdf` を組む。**cold** は単独の lualatex（root が無い opaque mode・fork の infra 失敗・その block の fork 子が一度死んだ `isoForkBroken`）。`realOutput = includesPdf || splitMode` が fork-real か fork-absorb かを決め、fork 子が artifact を残さず死んだ場合はどちらも cold に自動で退避して `isoForkBroken` に記録する（`readIsoCompileResult` は三者共通）。

real-output root（`daemon.lua` `tdom_real_root`、`TDOM_ISO_REAL_FORK=1` で有効、既定 off）は checkpoint 0 の**兄弟**プロセスで、driver が dormant 設定（`\vsize=\maxdimen`・absorb `\output`・seed box）を入れる**直前**に fork する。preamble は読込済みで、ページビルダーは一度も触られていないので、その子は cold と同じプログラム（preamble 抜き）で同じ結果を出す。checkpoint 0 から real output を走らせない理由は従来どおり（dormant のページ状態が luatexja で壊れる、tcolorbox が artifact も DISCARD も出さず待ち続ける）。メモリは COW 共有に依存するので、fork の直前に**親**側で full collect して heap を落ち着かせ（`tdom_seed` はこの floor を再利用して二度目の full collect をしない）、root 自身は待機中 `collectgarbage('stop')` で共有ページを汚さない（対話 job と同じ扱い）。root は接続前に sibling 内だけで見出し用の標準fontを準備する（docs/10 §10.8）。job 子は `collectgarbage('restart')` して普通に組む。root は ISO / PING / DIE / FAULT しか受けず、JOB / STEP は無視する（checkpoint state を持たないプロセスでの in-place typeset を禁じる）。`/status.rescue.realRoot` と `rootPid` が計測用に pid を出す。小規模 fixture の差分スイート（`tests/engine-v3.test.js`「fork-real rescues …」: 5 env × page offset 3 点で state・items・labels・chunk 幾何・SVG・PNG 画素が一致）と 316 ページ実文書の計測を通した（2026-09-20、`sandbox-copy`、macOS `footprint`: root 待機中 2.4〜11 MB、fork-real の job 子はピーク 302 MB の一時増分、checkpoint 0 は on/off とも ≈2 GB。rescue compile は cold 中央値 ≈5.6 s → fork-real 中央値 823 ms（31 block 合計 200 s → 26 s）、multicols 内の新規編集の exact 着地は 5.7 s → 1.8 s。初回 open の drain は 465 s → 430 s にしか縮まない — rescue 1 件の `totalMs` 中央値 12 s のうち compile は 0.8 s で、残りは adopt walk と lock 待ち。これは boot walk の inline 採用 / rescue frontier の pin で別途扱う）。engine の既定は off のまま、TeX64 アプリ側（`electron/services/tdom-engine.cjs`）が `TDOM_ISO_REAL_FORK=1` を渡す。

## 8.5a ページに描く絵（`current page` の overlay、表紙）

`remember picture, overlay` の TikZ で `current page` に描く絵（表紙・裏表紙、本文の段落の中からページの隅に置く印）は、block の exact render では正しくならない。exact render は block を tight page（block の高さ、文字幅の左右に用紙幅ずつの余白）に ship するので、`current page` はその tight page で、絵は見当違いの位置に描かれる。さらに display list は block の絵を自分の行の帯（±2 bp）からしか見せない。表紙の行は `\null` と高さ 0 の overlay の行なので、見当違いの絵の 4〜16 bp の帯だけが出て、ページの残りは白かった。canonical に無いページ（前にページを足した表紙）でだけ起き、c53846b も同じだった（tex64-internal #121 round 10）。`engine/checkpoint/page-art.js` が次の二段で扱う。

**判定（render 時）。** block の tight picture（page 1 の galley）が次のどちらかなら「ページに描く絵」（chunk の `farInk`）とする（`render-chunks.js`）。source は走査しない（macro が隠す）。

- 変換した SVG の ink（path の点・glyph の原点・image、transform 込み、clip 前）が tight page の外へ `FAR_INK_BP`（36 bp、`TDOM_COVER_FAR_BP`）以上はみ出す。
- block の絵が位置を読んだ（`\pgfsys@getposition`。`current page` は `pgfpageorigin` を、別の絵の node はその絵の mark を読む）。root が boot（`tdom_seed`）でこの命令を一度だけ包み、読んだ名前を記録する。RENDER の子は `tdomart-q.txt` に残し、JOB は galley に `posq` を付ける（CAPTURE は組み直さないので、その node を組んだ JOB の印で判定する）。tight page の外に丸ごと出た絵は poppler が SVG に何も残さないので、ink だけでは見つからない（`\thepage` を中央に置く overlay で確かめた）。

**A：正しくなり得ない絵は見せない。** `farInk` の block は、そのページでの行の位置に合う紙面の絵（下の B）が無い間、文字を持たない行（高さも深さも 0、または ink の run が無い行）を tight picture の窓から見せず、行の `pending-exact`（exact 画素を待つ行と同じ表示。viewer はその page を確定しない）にする。文字のある行は従来どおり tight picture の窓で見せる。そのため B が無い間は、同じ block の別ページの文字の行の背後に表紙の絵の一部が映り得る（tight picture の中で文字と重なっているので、文字に触れずには切り離せない）。

**B：紙面での render。** `farInk` の block は、自分の入口の checkpoint からもう一度 RENDER する（preamble を読み直さない）。本文の前に次を置く（`artPrelude`。どれも定義と Lua だけで node を作らない）。

- 計画 `TDOM_PAGE_ART`：pagebuilder がこの block の行を置いたページごとに、folio と、各行（galley の box を 0 から数えた番号）の版面の上端からの位置。
- `\hoffset=0pt\voffset=0pt`（driver は tight page のために -1in にしている。pgf の page の原点は `(\hoffset, \voffset)`）。文書自身の値は GEO の `hoffset`/`voffset` で、0 でない文書には B を作らない（preview の配置がそれを無視しているので、合う絵が無い）。
- `\pgfsys@markposition` を late_lua へ回す（`pdf.getpos()` は `\lastxpos`/`\lastypos` と同じ値。`tdompos.aux`）。2 pass 目からは前の pass の位置を `\pgf@sys@pdf@mark@pos@<id>` として定義する（`.aux` を読んだのと同じ。`\pgfsyspdfmark` 自体は rerun 検査の `\@newl@bel` が preamble 専用なので使えない）。
- `\leftmark`/`\rightmark` と `\pageref` を包んで、読んだら記録する（running mark は output routine のもの、label のページは resident の仮のページ割りのもので、full compile と同じとは限らない）。
- `\c@page` に最初のページの folio。dormant の output が発火するたびに、次の行のあるページの folio にする（`daemon.lua` の `tdom_page_art_absorbed`）。`\thepage` を書く絵、`\ifodd\value{page}` で描き分ける絵は、今のページの値で組まれる。

daemon（`ship_page_art`）は harvest した node のうち、計画に置かれた行をその位置に並べ（行の間の glue と penalty は捨て、行間の位置は計画から取る）、横は `\oddsidemargin`（preview が全ページをそう置くのに合わせる）、ページごとに 1 枚の PDF page を文書の用紙の大きさで ship する。pagebuilder がどこにも置かなかった行（`\clearpage` の空の box）は出さない。float と脚注は出さない（それらの絵は通常の render のまま）。

位置が前の pass と同じになるまで、最大 3 pass。最初の pass は、同じ galley の前の紙面の絵が落ち着いた位置から始める（ページ番号だけ動いた表紙は 1 pass で済む）。次のどれかなら失敗（A のまま）。

- 読んだ位置のうち、この render で記録されなかったもの（他の block の絵）がある。running mark か `\pageref` を読んだ。
- 子が ship した行の数、各行の高さと深さが galley と違う（その版の source が galley と違う組版をした）。
- 3 pass で位置が止まらない。`\hoffset`/`\voffset` が 0 でない。

成功したら各ページの SVG（用紙の大きさ、切り抜かない）を `<block>@art<k>`（`editPdf`/`editPage`、`editX`/`editY` は 0）にし、block 自身の chunk の record に `art`（計画の key、galley、ページごとの folio・行の位置・chunk 名、foot の帯に ink があるか、そのページに `\thispagestyle{empty}` があるか）を載せて版を上げる。版が上がると block の units が作り直され、その block のページの display list が作り直される。

**表示（`display-list.js` の窓、`pageArtCommands`）。** 窓の行の番号と版面での位置、ページの folio、block の galley が絵の記録と一致するときだけ、その絵を使う。

- ページに page-art の block の行しか無く（float・脚注・他の block の行が無い）、どの絵も foot の帯に ink が無いか、ページが `\thispagestyle{empty}` なら、各 block の絵を紙全体の窓で、ページの順に見せる（LaTeX は foot を本文の後に組むので、紙では foot が絵の上に来る。ここでは foot が絵の下になるので、foot のあるページで foot に掛かる絵は全面に出さない）。柱は窓の下の層に描かれ、絵の透明な所から見える。
- そうでなければ、block の行の帯（±2 bp）だけを紙面の絵から見せる。帯の外の絵は出ない（c53846b と同じ）。
- 一致しなければ A のまま、その block の B を求める（chunk map の `pageArtWanted`）。

位置が変われば（前にページを足した、行の位置が変わった）作り直す。ページ番号も偶奇も計画の key に入るので、ページ番号に依る絵は必ず今のページで組まれる。canonical が着地すれば、編集されていないページは canonical のページが勝つ（従来どおり）。

**判定の前の render。** 長い文書の boot（dirty block が `TDOM_RENDER_HOT_MAX` を超える walk）は block の exact render を queue しない（canonical がページを描く）。表紙もそのままでは一度も render されず、前にページを足すと判定する絵が無いので、`background-scheduler.js` は、行がどれも高さも深さも 0 の box である gfx の block（`\null` と overlay だけの表紙）だけを、その時に backlog として queue する。30 ページの冊子では表紙と裏表紙の 2 本。

**予定と寿命。** render は一度に 1 本（`pumpPageArt`）。update 中と、今の編集の exact render（cohort）が動いている間は待ち、最後の update の終わりから `TDOM_COVER_QUIET_MS`（450 ms、shipping の優先窓があればその長い方）待ってから始める（`lastEditAt` は update の始まりなので、150 ms 間隔で 50 ms かかる打鍵の隙間 100 ms でも始まってしまう）。他の block の render の backlog は待たない（RENDER が失敗し続ける block が後ろにあると、表紙も止まった）。測っていない galley の placeholder がページを占めている間（どのページも表示できず、後ろのページはまだ動く）は組まない。Build lease は `withReplaceablePreviewJob(engine, 'page-art', …)` で待つ。子の request は `rr@` で、編集の `preemptResidentRenders` が kill する。1 pass ごとに `TDOM_RENDER_TIMEOUT`（20 s）。失敗は計画ごとに 2 回まで（2 回目は 1 s 後）、編集に追い越されたものは 20 回まで。loop の各周は timer を経る（microtask だけで回る経路は無い）。絵は chunk map の中にあるので、block の削除（`<id>@` の key）、open（map ごと置き換え）、close で消える。tight picture が `farInk` 無しで着地したら `@art` を捨て、同じ galley の再 render は `art` を引き継ぐ。pdftocairo の子は `isoChildren` に入れ、close が kill する。`TDOM_COVER_ART=0` で A も B も無効（判定しない）、`a` で A だけ。`TDOM_PAGE_ART_KEEP=1` で pass の作業ディレクトリを残す。

既知の限界：running mark を `\botmark` などの primitive で直接読む絵、`\pageref` を通らないページ参照（cleveref の `\cpageref` など）は記録されず、resident の値で描かれる。block の中の自然な改ページ（`\clearpage` などの eject が無い所）の後で `\thepage` を読む絵は、改ページ前のページの folio で組まれる。twoside の偶数ページでも block の行は `\oddsidemargin` に置くので、本文の node に結ぶ線と `current page` に結ぶ線を併せ持つ絵は、偶数ページで full compile と左右がずれる（preview の本文の配置と同じ）。rescue される block（multicols など）は判定しない。`\AddToShipoutPicture`・eso-pic・background などは文書ごと opaque なので関係しない。測定と試験は docs/10 §10.4q、`tests/cover-overlay.test.js`。

## 8.6 verification

fresh canonical が現 source rev に追いついたとき、`#verifyAgainstCanonical()` が structured page text と canonical page text を照合する。

現在の実装:

- `pdftotext` が使えない場合は verification を skip する。canonical overlay は残る。
- token は `verifyTokens()` の文字 bigram である。Latin word と CJK bigram を別規則にする実装ではない。
- 同一 page に加えて ±1 page の window を見る。
- page count mismatch は report されるが、それだけで block demotion しない。
- window containment が 0.5 未満の確実な乖離だけを demotion 候補にする。
- demotion は block/chunk 単位で、document 全体を opaque にする処理ではない。

glyph layer がズレた block は exact-only へ降格する。すでに exact/rescue 表示だった block がズレた場合は canonical-only へ降格する。降格は block source hash に粘着し、source が変わるまで戻らない。

## 8.7 opaque mode

opaque mode では resident process tree を捨て、表示は canonical page だけになる。編集は source に適用され、canonical compile が schedule される。

opaque に入る主な経路:

- safety gate が document-level unsafe を検出した。
- structured boot が失敗した。
- full rebuild retry 後も structured typeset が失敗した。

boot 失敗は preamble hash に sticky になる。ただし `#scheduleStructuredReprobe()` により、一度だけ quiet delay 後の structured boot 再試行がある。preamble が変われば通常の structured 判定に戻る。

## 8.8 canonical crop

`#cropCanonicalChunks()` は、fresh canonical compile が現 source rev と一致し、かつ provisional page count と canonical page count が一致するときに動く。

切り出しには、段落の全行についてソース範囲・SyncTeX・実PDFの文字配置・増分ページの原点が一致する証明が必要である。画像・パス・透過などを含むページや数式・副作用を含むブロックはこの経路を使わず、常駐または隔離レンダーへ任せる。上限は `TDOM_CANON_CROP_MAX`、既定40ブロックの照合。世代ごとの文字座標もchunkと一緒に保持する。詳細は[表示忠実度](09-visual-fidelity-gate.md)を参照する。

## 8.9 shipping chain との関係

`TDOM_SHIP=1` のときは、`shipping.js` / `shipd.lua` による増分 canonical 経路も page SVG を供給する。これは実 output routine で ship された page pixels を届ける任意の経路である。

cold canonical は引き続き PDF export、verification、fallback の正本である。shipping chain が無効化された文書や、label 乖離で `shipStale` になった状態では、cold canonical が表示の権威を持つ。

## 8.10 旧バックエンド

v0/v1 バックエンドは現行リポジトリに存在しない。server から選択する経路もない。現行の fallback は、safety gate、block-level rescue、visual fidelity demotion、opaque mode、canonical layer の組み合わせである。

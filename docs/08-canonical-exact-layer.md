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

`GET /pdf` は `engine.exportPDF()` 経由で `canonical.ensure()` を呼ぶ。表示用 checkpoint state から PDF を作る経路はない。

### 8.2a content identity（世代の再束縛）

generation の同一性は「root source のバイト列」と「compile が読んだ project input のバイト列」で決まる。
root は `srcHash` が、input は `inputManifest`（logical path → sha256、`-recorder` の `canon.fls` から採取。
Build 取り込みでは `.fls` 検証済みの records から受け取る）が担う。

`inputEpoch` は子ファイル編集・外部変更・bibliography 更新のたびに単調増加するが、その epoch ごとに
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

isolated compile の結果はプロセスを跨いで保持する（`iso-disk-cache.js`、`<workDir>/isocache/<epoch>/<key>.json`（`iso-` 始まりの名前は server 起動時の stale artifact sweep に消されるので使わない） + chunk の PDF）。rescue key は compile が依存する入力（block text・入口 state・preamble・参照 label の値・page offset）をすべて含むので、同じ入力なら後のエンジンが結果を再利用できる。再オープン時は boot walk がその block を inline で adopt し（`rescueBlock` の cache hit 経路 = state job 1 本）、cold compile の drain を待たずに resident のページ数が canonical と揃う（316 ページの実文書では multicols 31 block × cold 5.4 s + adopt walk ≈ 5 分が消える）。boot walk は pagination 前に key を作る（page offset 0、galley なし）ので、実 offset で保存した結果は見つからない。そのため各結果に offset を含まない base link（text・入口 state・preamble）も置き、galley のない初回 rescue は base の結果を（参照 label の値が当時と同じなら）その場で adopt する。着地した offset が `compiledOff` と違えば moved-offset pass が通常どおり再 rescue する。key（full・base とも）には直前 block の trailing glue（幅・stretch/shrink とその order。iso compile が `\addvspace` の合流のために再現する入力で、state vector には幅しか無い）も含める。base 採用時は cache の `refVals` を現在の label 値と照合し（未定義の forward ref は後の label pass が key を変えて再 rescue する）、名前空間 `epoch` は daemon.lua / shipd.lua と iso 関連 JS（context・render source・runner・compile・result・rescue-block・rescue-cache・disk-cache）のハッシュ・engine version・`lualatex --version` を含み、toolchain や cache の意味論の更新後は古い結果を使わない。`TDOM_ISO_DISK_CACHE=0` で無効、既定の上限は 512 entry（mtime の古い順に削除）。

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

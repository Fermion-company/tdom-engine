# 03. チェックポイントエンジン

この章は、現在実行される `engine/checkpoint/engine-v3.js` 周辺の地図である。現行サーバーはこの engine だけを使う。

## 3.1 構成ファイル

| ファイル | 役割 |
| --- | --- |
| `engine/checkpoint/engine-v3.js` | Node.js 側の orchestration。差分 block、checkpoint、page build、exact chunk、opaque/canonical 連携を扱う |
| `engine/checkpoint/daemon.lua` | resident `lualatex` 内で動く Lua daemon。JOB/RENDER を受け、real MVL と metadata を返す |
| `engine/checkpoint/tdomfork.c` | LuaTeX から POSIX `fork()` / `_exit()` / `waitpid()` などを呼ぶ C shim |
| `engine/checkpoint/forkshim.js` | `tdomfork.c` を workDir に build する helper |
| `engine/checkpoint/pagebuilder.js` | 収穫した node stream からページを組む JavaScript page builder |
| `engine/checkpoint/canonical.js` | full `lualatex` の正本 compile と PDF/SVG/text 取得 |
| `engine/checkpoint/shipping.js` / `shipd.lua` | `TDOM_SHIP=1` で動く任意の増分 canonical 経路 |
| `engine/checkpoint/safety.js` | structured path に入れてよい文書かを判定する |
| `engine/checkpoint/fidelity.js` | glyph 表示と exact chunk の切り替え判定 |
| `engine/checkpoint/mathmap.js` | legacy math font の twin font mapping |
| `engine/checkpoint/mapped-inputs.js` | `\input` を展開してから段落を分割し、複数ファイルにまたがる block の元ソース位置を保持する |

`\input` の前後には段落境界を追加しない。空行・明示的な `\par`・sectioning が block の境界になる。複数ファイルを含む block の `sourceParts` は各テキスト範囲と元ファイル位置を持ち、DOM の `sourceRanges` と個々の `editRegions.source` に変換される。カーソル位置の warming もこの対応で対象 block を解決する。

## 3.2 プロセスモデル

Shipping の checkpoint も `TDOM_MAX_CHECKPOINTS` を上限とする。併用時の枠は、基準上限の2倍から現在の resident 数を差し引いて制限する（再開用 root は1個保持）。root・最新ページを優先し、古いページは間隔が最も狭い境界から間引く。resident の checkpoint 増加時にも Shipping を即時整理する。再開時は保持済み prefix を除いた残枠から tail の保存間隔を決め、最終 `\end{document}` の後には新しい checkpoint を作らない。編集中・描画中に保持する resident の一時枠は別途存続する。

root は `lualatex --shell-escape -interaction=nonstopmode driver.tex` として起動される。`--shell-escape` は `tdomfork.c` の共有ライブラリを `package.loadlib` するために使われる。

checkpoint 0 の準備完了は font warmup と初期 GC の後に通知する。background JOB の末尾では Lua の incremental GC を 2048KB 分進め、完了した cycle の使用量を基準にする。初期本文の最終 JOB で一度回収を完了させ、本文フォントを含む live heap を記録する。foreground は同じ root のどの block で確認した live heap も基準にし、そこから64MB以内なら collector を止めて atomic scan を延期する。font cache の再読込を毎回未回収ゴミと数えない。未回収分が基準から64MB増えた場合は full GC を行う。毎回同じ checkpoint から編集しても、8MBの増加ごとに日本語フォントを含む heap 全体を2回走査することはない。

macOS の foreground JOB と Shipping の編集継続は、その worker thread に `QOS_CLASS_USER_INITIATED` を設定する。非対話 JOB と Shipping の保存用待機では default に戻す。親アプリや起動方法の実行優先度に編集応答が左右されるのを抑え、他 OS のスケジューリングは変更しない。

```text
Node.js engine
  └─ root lualatex
      ├─ ckpt0
      ├─ ckpt1
      ├─ ckpt2 ...
      ├─ JOB child -> 組版後に次 checkpoint へ昇格
      ├─ CAPTURE child -> JOB が保持した node list を tight PDF に shipout
      └─ RENDER child -> block を再実行して tight PDF を shipout（fallback）
```

checkpoint は「ある block 境界まで処理済みの TeX プロセス」である。OS の copy-on-write `fork()` が TeX 状態の snapshot になるため、マクロ、catcode、counter、font、box register などを JavaScript 側で保存・復元しない。

cold prefix の walk は、直前に自身が作った未保持の continuation に限り `STEP` で進める。さらに、その block が直前の実行で native 成功済みで、deferred・frozen・rescue 中ではないことを必要とする。今回の `STEP` が新たに失敗した場合は、失敗後の TeX 状態を採用せず、残っている最寄りの祖先 checkpoint から通常の `JOB` だけで入力境界を一度再構築してから既存の state fallback を行う。ブロックごとの native 組版、galley/state 検証は従来と同じで、既存の保存状態・編集中の input・描画中の所有者では必ず fork する。保存対象の境界では直前の JOB node list も保持し、未変更の exact neighbor を再組版せず描画できる。

checkpoint の配置は、回収処理を除いた再組版時間で選ぶ。平均的な block に保存枠を集中させず、中央値の8倍かつ全体の再実行費用に対して十分重い block だけ両側を優先し、残りを費用の分位点へ配置する。末尾用の枠は終端の空白・改ページ処理より前、近い明示改ページがある場合は最後の本文ページの冒頭に置く。未測定 block には測定済み中央値を使い、boot の測定進行に応じて配置を更新する。新しい保存先がまだ存在しない間は、近い既存 checkpoint を枠内で残す。各 JOB の完了時に、次の処理に必要な continuation を残して保持数を整理する。

未作成の保存先を既存 checkpoint で代替する際、edit/render 用に別枠で保持する checkpoint は後回しにする。編集中の局所的な保存状態が文書全体の到達性を奪わない。page warming の完了地点も既存の editHold 上限内に残す。既に費用を計測した block の warming は配置費用を更新しないため、古い snapshot からの一時的な font 再読込で大域的な配置が変わらない。

## 3.3 driver.tex の注入内容

`engine-v3.js` の `#driverSource()` は、ユーザーの preamble の後に制御コードを注入する。主な内容は次である。

- `daemon.lua` の読み込みと `tdom_boot()`。
- galley 収穫用 box と geometry 送信。
- `\label`、`\ref`、`\eqref`、`\cref`、`\Cref`、`\cite`、bibliography、toc、float、page style、page numbering などの shim。
- `\cleardoublepage` や jsclasses parity clear の扱い。
- `\@starttoc`、`\bibitem`、`\lbibitem`、`addcontentsline` / `addtocontents` の捕捉。
- geometry、float spacing、footnote rule、header/footer job に必要な値の測定。
- 既知 label/ref の注入。
- font warmup と legacy math twin metrics の取得。
- TeX built-in page builder を眠らせるための設定。

この driver は表示用の structured path で使われる。PDF export の正本は `canonical.js` の full compile であり、この driver の出力ではない。

## 3.4 daemon protocol

通信は localhost TCP 上の行指向 protocol である。JSON payload は長さ付きで送られる。

**Node -> daemon**

| command | 内容 |
| --- | --- |
| `JOB <blockId> <newCkptIdx> <len> <captureToken\|-> <F\|B\|C> <liveFloorKb>` | block を組版し、結果を返して次 checkpoint になる。display math の hot job は node list を世代付きで保持する |
| `STEP` | 同じ walk が作った一時 continuation を次の block へ進める。JOB と同じ引数・結果で、保存用 checkpoint は消費しない |
| `CAPTURE <blockId> <token> <jobDir> <requestId>` | post-block checkpoint が保持する JOB node list を再組版せず shipout する |
| `RENDER <blockId> <jobDir> <len> <requestId>` | block を tight PDF として shipout する |
| `DROP_CAPTURE <blockId> <token>` | exact pixel が不要だった保持 node list を解放する |
| `DIE` | checkpoint を終了する |
| `PING` | 生存確認 |

**daemon -> Node**

| command | 内容 |
| --- | --- |
| `HELLO` | role/index/pid の通知 |
| `GEO` | paper/text/float/footnote などの geometry |
| `TWIN` | twin math font の glyph metrics |
| `GALLEY` | block の node-list 抽出結果 |
| `CKPT` | checkpoint 昇格通知と回収済み live heap の基準 |
| `FORKED` | 子 process pid 通知 |
| `DONE` | RENDER PDF 完了通知 |
| `CAPTUREMISS` | capture が無い、または編集世代が一致しないため fallback を要求 |
| `PONG` | 生存応答 |

JOB の子だけが `tdom_wait()` から抜け、`tex.print()` で挿入された block source を TeX に読ませる。親 checkpoint は待機 loop に残る。

## 3.5 galley

daemon は block を real main vertical list 上で組み、その結果を JSON として返す。galley には、行 box、glue、kern、penalty、insert、float anchor、label/ref、counter state、font metadata が含まれる。

glyph run は同一 font/size/color/baseline shift の連続として送られる。ただし kern/glue で必ず分割されるため、run 内の描画位置は font advance の積み上げで確定する。

large math glyph、OpenType math、PUA/unencoded glyph、PDF literal などは daemon 側で flag され、`fidelity.js` が glyph 表示か exact chunk かを決める。

resident RENDER / CAPTURE と isolated RENDER の PDF は、TeX の論理幅の左右に元の用紙幅だけ余白を持つ。`render-padding.txt` の実測余白を chunk の `xBp` と画像幅へ反映し、文字原点と sourcebox の論理幅を保つ。負の x 座標に描く枠線も PDF 化の時点で失われず、最終的な表示範囲は物理ページが切り取る。

## 3.6 `#updateInner()` の現行順序

`open()`、`edit()`、`refresh()` は最終的に `#updateInner()` に入る。現在の大きな流れは次である。

1. `safety.js` で document-level unsafe を判定する。unsafe なら opaque path へ行く。
2. preamble hash が変わっていれば root を boot し直す。boot 失敗は opaque demotion になる。
3. `segmentBody()` と `#expandIncludes()` で body を block 列にする。
4. `diffBlocks()` で旧 block 列と新 block 列を比較する。
5. 共通 prefix/suffix に基づき checkpoint を再キー化する。編集 window 内の checkpoint だけを破棄し、suffix 側は `vstale` として残す。
6. nearest checkpoint から foreground 組版を始める。
7. 編集 block と検証 block を組み、`galleyHash` と `stateVec` で収束を判定する。
8. foreground の budget を超える伝播は `pendingChain` に回す。
9. label 消滅、backward reference、toc fixed point を処理する。ただし chain work が pending のときは async pass 側へ送る。
10. page-context-sensitive rescue の offset 変化を queue する。
11. `pagebuilder.buildPages()` で page を組み、`reconcile()` で前回 page を再利用する。
12. header/footer job を schedule する。
13. dirty block の high-fidelity render と deferred chain を schedule する。
14. `canonical.schedule(source, srcRev)` で正本 compile を予約する。

structured safety は raw 本文だけでは判定しない。preamble と展開済み project body にある
ローカル定義（`newcommand` / primitive `def` / `let` / `newenvironment` / xparse 系）を軽量 lexer で読み、
`multicols`・`paracol`・`longtable`・`twocolumn` / `onecolumn`・強制列/改ページ・output routine
primitive などの page-building sink への依存を worklist で
固定点伝播する。使用された alias の ordered structural effect を一意に証明できる場合は、元 source
offset 上の virtual event として segmenter へ渡し、隠れた begin/end の内側を atomic layout block にする。
その block は JS page builder ではなく exact rescue / ShippingChain が担当し、preview policy は
`shipping-exact` になる。source/checkpoint は structured のまま保つが、resident page patch は表示せず、
complete replay PDF の ship wave だけを新しい物理ページへ昇格する。証明できない generation は
新しい page tree を公開せず last-known-good を保持し、full canonical を foreground では待たない。
コメント・inline verb・verbatim 系環境は解析対象外である。

foreground verification の現在の初期 budget は、galley divergence 用が 8 block、local state ripple 用が 4 block である。ここを超えた伝播は、編集応答の中で文書末尾まで歩かず async chain に送られる。

## 3.7 checkpoint suffix の扱い

現行実装は「編集位置以降を常に全破棄」ではない。

- 共通 prefix の checkpoint はそのまま残る。
- 共通 suffix の checkpoint は新 index に移され、`vstale` として残る。
- body 中の macro/definition edit や、検証 block で未追跡状態が流れたと判断された場合は suffix を信用せず、async rebuild に回す。
- counter だけが動いた場合は async settle に回す。

`vstale` checkpoint から JOB する場合は、counter、`\prevdepth`、`\if@nobreak`、`\lastskip` などの揮発状態を prelude で補正する。

## 3.8 page builder

`pagebuilder.js` は、daemon から受けた real node stream を page に割る。現在扱う主なものは次である。

- TeX の合法 break point と badness/penalty による page break。
- `\topskip`、`\maxdepth`、`\skip\footins`、footnote rule。脚注区切りの幅・伸縮は各ページの最初の脚注で一度だけ改ページ判断へ計上する。
- LaTeX float placement の主要経路。
- `\newpage` / `\clearpage` などの eject marker。
- raggedbottom / flushbottom の glue distribution。
- `\enlargethispage` の本文組版高とstar版の縮小。計測driverはmarkerを記録し、実際に出力するisolated childではLaTeXの元命令を使う。通常ページの紙面高・フッター位置は維持する。
- page boundary snapshot による incremental rebuild と page reuse。

warm/rescue の組版結果が同一でも、chunkの版が変わった場合は表示リストを再生成し、画像と入力座標が参照する版を揃える。

`/warm` は `offset` と任意の `filePath` を受け取り、そのソースファイルに属する block の前後を保持する。子ファイルの offset は子ファイルの本文長と照合し、親ファイルの同じ数値の位置へ置き換えない。`filePath` 省略時は従来どおり root を対象にする。

同じページに欠けている exact chunk があれば、その block まで同じ中断可能な chain を準備し、既存の並列数制限付き render pump へ渡す。`/warm` の `page` 指定はそのページの先頭 block を起点にする。viewer は canonical の表示確定後とスクロール停止後に表示中のページを準備する。入力や文書切替による世代変更は既存の abort 経路で優先される。

標準 class option の二段組と本文中の `\onecolumn` / `\twocolumn` は、page builder の結果を表示せず、resident LuaLaTeX の実定義・実列幅による行組みだけを canonical-addressed overlay に使う。列切替時の `\box255` はTeXプリミティブで通常boxへ移してから dormant pageへ戻し、active column mode / width を exit state vector に含める。overlay は編集位置が可視本文 region 内であることと、内部段落なら行数が変わらないことを確認し、TeXのline boxが変化したsuffixだけを物理列上で差し替える。mid-document geometry change と `\balance` は `safety.js` 側で structured path から外れる。margin note は canonical-only block である。footnote は扱うが、TeX と同じ page-spanning split を完全再現する実装ではない。

## 3.9 exact chunk の経路

exact chunk は主に四つの経路から来る。

| 経路 | 内容 |
| --- | --- |
| resident CAPTURE | display math の foreground JOB が既に組んだ node list を post-block checkpoint から copy-free で引き渡し、再組版せず shipout する |
| resident RENDER | warm pre-block checkpoint から block を再実行して tight PDF として shipout する（capture 非対象・miss 時の fallback） |
| canonical crop | source・SyncTeX・PDFの全行の位置を照合でき、未検証の描画がない場合に限りSVGから切り出す |
| isolated render | standalone `lualatex` で該当 block を compile し、rescue chunk を作る |

resident CAPTURE/RENDER は hot dirty block と async chain で実際に変化した block に寄せられる。大量の cold block を全文 sweep しない。dirty block 数が `TDOM_RENDER_HOT_MAX` を超える場合は hot render を抑制し、cold boot の全 checkpoint に node list を保持しない。

各 resident render は foreground JOB の block id とは別の単調増加 `requestId` を持つ。新しい編集が始まると、未着手の cold render queue と実行中の resident render を破棄し、現在の dirty block を空いた lane の先頭へ入れる。孤立 compile は結果を cache として再利用できるため、この preemption の対象外である。fork 通知が cancellation より遅れて到着した場合も `requestId` で識別して子 process を回収する。
render lane の終了時にも queue を再確認する。全 lane が終了判定を済ませてから pumping counter を下げるまでの間に新しい item が入っても、次の打鍵を待たず replacement pump を起動する。

CAPTURE の初期対象は `\[...\]`、`$$...$$`、equation/align/gather/multline 等の display math に限定する。token は source edit ごとに単調増加し、block id と token の両方が一致した場合だけ shipout する。capture child を fork した直後に checkpoint 親の list を解放し、次の JOB child は継承した古い list を組版前に破棄する。graphics、float、breakable box は backend/output-routine state の所有境界が異なるため、従来の RENDER/isolated 経路を使う。

通常driverとisolated rescueの吸収用output routineは、TeXの `\global\setbox...=\box255\relax` で出力boxを専用boxへ移してからLuaで回収する。`\relax` はbox番号の読み取りを終え、代入前に後続の `\directlua` が展開されることを防ぐ。isolated rescueの最終回収はpage listとcontribution listの両方を連結し、改ページ直後にcontribution側へ戻った本文も保持する。

通常の `\newpage`・`\clearpage`・`\cleardoublepage` は native の吸収処理で前後の素材と eject marker を保持し、命令名だけでは isolated rescue にしない。`\maketitle` の class 固有出力と、独自 output routine を使う環境は rescue 判定を維持する。

isolated render は idle-gated の低優先度経路である。`rescueQueue` が空、canonical が compile 中でない、直近編集から一定時間が経過、などの条件を見て動く。

## 3.10 HTTP 境界

現行 `server.js` は単一 engine instance を持つ。主要 endpoint は次である。

| route | 内容 |
| --- | --- |
| `GET /` | editor/preview UI |
| `GET /doc` | source、display list、geometry、font manifest、report |
| `POST /edit` | `{start,end,text}` の範囲編集 |
| `POST /open` | source/template で文書を開き直す |
| `GET /dom` | engine 観測用 JSON |
| `GET /canonical/:n.svg?c=<id>` | canonical PDF の page SVG |
| `GET /chunk/:id.svg` | exact chunk SVG |
| `GET /font/:key` | TeX が使った font file |
| `POST /font-fail` | browser font load failure の報告 |
| `GET /canonical.pdf` | 最後に成功した canonical PDF |
| `GET /pdf` | 現 source を canonical layer で ensure して PDF を返す |
| `GET /events` | SSE |
| `GET /status` | queue/canonical/mode の lightweight status |

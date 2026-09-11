# 10. 編集ホットパスの現行実装

この章は、`engine-v3.js` の編集 1 回で同期的に何が走り、何が非同期に回るかを示す地図である。

## 10.1 hot path の入口

`server.js` の `POST /edit` は `engine.edit(start, end, text)` を engine queue に入れる。engine 側では `#update()` が次を行う。

1. 直近編集時刻を記録する。
2. 実行中の background chain を abort する。
3. 必要なら in-flight background JOB を `SIGKILL` する。
4. chain lock を取り、`#updateInner()` を実行する。

編集応答は、この lock 内で作った patch/report を返す。canonical compile、exact chunk render、rescue compile、deferred chain は同期応答に載らない。

## 10.2 safety と boot

structured 文書の plain 本文が exact graphics の直前にある場合、単一段落の編集で
native closure・投入時 catcode・glyph fidelity を確認し、縦組版の全 item 寸法と報告済み
exit state が一致すれば、本文の更新を返してから隣接 graphics を settle pass で確認する。
応答の chainVerdict は `verify` であり、収束済みとは宣言しない。TeX hook の未報告状態が
あり得るため確認自体は省略しない。同じ段落への連続入力は未完了の確認を引き継ぎ、
裏処理で差分が見つかった場合や別の chain work が合流した場合は通常の保守的経路へ戻る。

`#updateInner()` は最初に document bounds と preamble hash を取り、`classifyDocument()` を呼ぶ。

- safety gate が unsafe なら `#opaqueUpdate()` へ行く。
- preamble hash が変わったら `#bootRoot()` で resident root を起動し直す。
- boot 失敗時は opaque に demote し、同じ preamble で毎打鍵 boot しない。

raw source に危険環境が見えなくても、ローカル macro / custom environment の定義依存が
page-building sink（環境、native column switch、強制列/改ページ、output routine primitive）へ到達する
alias は ordered effect certificate を作る。開始・終了効果を一意に証明できる call site は source offset
上の virtual event として segmenter に渡し、マクロで隠した `multicols` の内側を一つの atomic layout
block にする。ブロックは stale-first を保ったまま exact rescue / ShippingChain へ送り、full canonical は
background audit に限定する。証明不能な新 generation は page tree を公開せず last-known-good を保持する。
解析は source generation ごとに作り直し、未使用の危険定義は structured のままにする。

structured に復帰できる状態になったときは、opaque sticky を外して root を boot し直す。

### 10.2a 表示境界と権威境界

重い多段組文書では「すぐ見せられる範囲」と「正確だと宣言できる範囲」は一致しない。
一つの source offset や page number に両方の責務を持たせず、次の四境界を区別する。

| 境界 | 許されること | 必要な証明 |
| --- | --- | --- |
| `VisualCut` | 旧 exact page 上に編集近傍だけを provisional overlay として見せる | 旧 presentation slot 内に収まり、source region と line witness が一意 |
| `ResumeCut` | 新 generation の TeX replay を開始する | entry state、definition epoch、checkpoint lineage が一致 |
| `PageSealCut` | 一枚の新 exact page を表示候補にする | 完全 replay PDF 内で page ship が閉じ、世代と source snapshot が一致 |
| `TreeCommitCut` | page count と suffix page tree を新世代へ切り替える | 影響 suffix の complete bundle が揃い、generation CAS を通過 |

TeX の実行は編集 offset からではなく、その編集に因果的に先行する最寄りの certified `ResumeCut`
から始める。`multicols` の内部に checkpoint/resume 能力がない場合、開始 alias より前へ戻る。
一方 `VisualCut` は paragraph 内に置いてよいが、常に非権威であり、ページ数・後続ページ位置・
現在 generation の完成を主張しない。複数 generation の共存は presentation slot ごとの
last-known-good と pending 表示に限り、同じ page/tree を途中で splice しない。

現行 Phase A は、ordered effect を証明できた page-building alias を `shipping-exact` policy にする。
source/checkpoint の incremental 処理は維持するが、JS paginator の page patch は表示せず、直前の
exact page を保持して complete ShippingChain wave だけを原子的に昇格する。通常本文の編集応答では
表示不可能な resident state/rescue walk も行わず、source generation を先に ShippingChain へ渡す。
ただし埋め込み直接編集では、Shipping の原文・SyncTeX の世代対応と editor 転送の証明がないため
wave を表示せず直前の編集可能な面を保持し、既存の版・需要IDを使って canonical 表示を要求する。
Shipping replay の plain edit admission は brace depth 0 を要求しない。代わりに旧新の source partition が
同じで差分が一つの balanced unit に閉じること、選択した checkpoint の consumed-unit cursor がその unit
より前であることを要求する。したがって `\footnote{...}` や TikZ node の braced visible text も、その
argument 全体を再入力できる cut からだけ replay する。複数ページを生成する巨大 macro argument は一つの
unit のままなので、その unit を既に token list 化した内部 page checkpoint は選ばれない。math、comment、
control word、inline verb / verbatim、TeX 特殊文字は fail closed のままである。moving argument が `.lof`
などの出力 manifest を変えた generation は実行できても `TreeCommitCut` を通さず、旧 exact page を保つ。
通常の小文書は
`structured` のままなので、この保守策のために canonical 全文 compile を foreground で待たない。
Phase B では lexical paragraph children と `AtomicLayoutRegion` を分離し、領域内でも証明できる
plain-text edit だけを `VisualCut` overlay として先行表示する。

性能契約は、200行級の通常 `structured` 文書で provisional p95 120ms以内、exact/current p95
250ms以内（p99 400ms以内）を目標にする。100ページの `shipping-exact` 文書では source acceptance
p95 150ms以内、edited-page exact p95 850ms以内を目標にし、期限を外した generation は表示せず
last-known-good を保持する。

現行 ShippingChain は `\begin{document}` hook 完了後、最初の user source unit を読む直前に page 0 の
body-root checkpoint を作る。first page の plain edit は preamble を再実行せず、この root から全 body を
exact replay する。700ms の replay deadline を越えた edit は exact tree を昇格せず、Phase B の
`VisualCut` が入るまでは旧 exact pixels を保持する。source acceptance と新しい文字の即時描画は同義ではない。

## 10.3 diff と checkpoint rekey

body は `segmentBody()` と `#expandIncludes()` で block 列になる。`diffBlocks()` は旧 block 列と新 block 列の hash を比較し、dirty block、removed block、共通 prefix/suffix を返す。

現在の checkpoint 処理は次である。

- prefix 内の checkpoint はそのまま残す。
- suffix 内の checkpoint は index delta だけ移動し、`vstale` として残す。
- 編集 window 内の checkpoint は `DIE` で捨てる。
- `pendingChain`、`renderHold`、`editHold` も同じ index 移動に追従する。

つまり、現行実装は「編集位置以降を常に全破棄」ではない。suffix を残せる場合は残し、信用できないと分かった時点で async rebuild に回す。

## 10.4 bounded foreground

foreground は nearest checkpoint から始まる。各 block について `#typesetBlock()` を呼び、`#adoptGalley()` で galley、font、label/ref、state を採用する。

同じ cold prefix walk が作った一時 continuation は、前回の native 成功証明があり、deferred・frozen・rescue 状態でない block に限って `STEP` で直接消費する。`STEP` 中に今回初めて native error や timeout が起きた場合、失敗した continuation は捨て、通常予算で残る最寄りの正しい checkpoint から通常 `JOB` でその input を一度だけ復元する。その後に last-good exit state を入れる既存 fallback を行うため、壊れた TeX 状態を後続 block の入口として採用しない。

停止判定は次を見る。

| 判定 | 意味 |
| --- | --- |
| `clean` | clean block を組み直して `galleyHash` と `stateVec` が一致した |
| `counters` | galley は同じで counter などが動いた |
| `leak` | galley divergence が budget を超えた、または definition edit で suffix を信用できない |
| `walked` | 文書末尾まで必要な foreground walk をした |

現在の budget は、layout-coupled galley divergence が 8、local state ripple が 4 である。budget を超えた伝播は hot path で文書末尾まで追わず、`pendingChain` に入る。

## 10.5 definition edit

body block の `\def`、`\newcommand`、`\renewcommand`、`\let`、`\newenvironment`、`\newcounter`、`\setlength`、`\catcode`、`\pagestyle` などは、下流 block の意味を state vector だけでは追えない可能性がある。

そのため、編集 window の旧 text/new text に definition-bearing token がある場合、suffix trust は forfeited になり、verdict は `leak` 側へ寄る。rebuild は async chain に送られる。

## 10.6 deferred chain

`#queueChainWork(kind, from, labels)` は `settle` または `rebuild` を `pendingChain` に登録する。

| kind | 内容 |
| --- | --- |
| `settle` | counter などの動いた exit state を下流へ追い、clean block で一致したら止まる |
| `rebuild` | suffix を信用せず、下流を serial に再組版する |

`#scheduleBackground()` は、編集後 300ms の idle gate を待ってから `#runChainPass()` を lock 内で走らせる。次の編集が来ると `bgAbort` で止まり、進捗位置から後で再開する。

## 10.7 references と toc

label が動いたとき、後方で定義された label を前方 block が参照していることがある。foreground 中に `pendingChain` が無ければ、ref index から候補 block を取り、必要なものだけ再組版する。

`toc` は provisional pagination から `.toc` 内容を合成し、hash が動けば toc consumer block を再組版する。最大 3 pass である。chain work が pending のときは、`#chainAfterPass()` 側で同じ処理を行う。

## 10.8 page-context rescue

非同期 rescue の採択で後続の galley が変わった場合、その block の exact render も再予約する。旧 galley の描画が先に完了していても、修正された段落・数式・脚注の chunk を現在の galley 世代で作り直す。

`mdframed` や breakable `tcolorbox` のような block は、page 上の offset によって分割結果が変わることがある。

現行実装は foreground で長い re-rescue chain を走らせない。`#queueMovedOffsets()` が offset 差分を見て rescue queue に積み、exact pipeline が async に fixed point へ近づける。表示中は stale galley/chunk と canonical overlay が残る。

## 10.9 壊れた TeX の凍結と決定性の境界

chain と isolated rescue の両方に失敗する block（実 LuaLaTeX 自身が emergency stop するソース — 例: tikz node 内の壊れた色名が pgf 内部でカスケードして子プロセスを殺す）は `#brokenBlockGalley()` で凍結する。未閉鎖の条件文のような軽い破壊は daemon が job 境界で回復するので、ここには来ない。凍結は二形態ある。

- 直前まで正常だった block: 最後の正常 galley と**その exit state をそのまま**保持する。pixel も下流の番号も編集前から一切動かない（打鍵中の番号 churn と全文書 settle を防ぐ）。
- 履歴のない block（fresh boot が壊れたソースを読んだ場合）: 空 galley で凍結し、exit は entry の素通し。

galley 有りの block は stale-first 経路で async rescue に回り、その isolated compile が失敗している間も凍結として扱う。凍結の判定は `frozenBlockIds()` — hard freeze（`#brokenBlockGalley` が galley に付ける `tdomFrozen`）に加え、「現在の rescue key が isoFailCache にヒットする block」を**導出**する。async 側を粘着フラグにしないのは巻き添えのため: 壊れたウィンドウ中の bogus な page offset で正常テキストの分割系 block の compile が失敗しても、offset が正気に戻れば rescue key も戻り自動的に非凍結へ復帰する（テキスト起因の凍結は key がテキストを含むので、テキストが直るまで凍結のまま）。async rescue の superseded 判定（queue 時と pump 時の rescue key 不一致）は捨てずに現在 key で再 queue する — stale-first 採択が block を rescued に反転させた直後は pageOffset の実体化で key が必ずズレるためで、捨てると exact 化が永遠に来ない。

この二形態は**意図的に一致しない**。壊れたソースには LuaLaTeX 自身が PDF を出さないので収束すべき真値が存在せず、「incremental == fresh boot」の等式は compile 可能なソースにのみ適用される。referee（`tools/fuzz.mjs`）は `tdomFrozen` を見てそのバーストの等式判定をスキップし、バーストを逆編集で復元して治癒経路を検証する。凍結は該当 block のテキストが変わる編集で自然に解け、直後の収束で編集前と同一の署名に戻る（`tests/hot-path.test.js` の凍結 2 テストが固定化）。失敗した isolated compile は rescue key で negative cache され、chain pass が凍結 block を跨ぐたびに同じ失敗 compile を払い直さない。

isolated compile の dormant absorb には暴走上限（fires > 50）があり、上限に達すると材料が破棄される。破棄が起きた run は**成功として採択しない**（`state.json` の `discarded` を見て失敗扱い）。silently 空/欠損の galley を真実として採択すると、その galley 自身が作るページネーションの不動点に嵌って自己修復しなくなる（stress seed-21 burst 2 で発見 — 旧実装ではプレビューから box が消えていた）。失敗にすれば stale-first が直前の正常 pixel を保持し、入力が正気に戻れば rescue key も戻って isoCache の正常結果が再採択される。page-context strut も `\textheight` 内にクランプする。

暴走の主因だった構造的ギャップは splitMode で解消済みである: **分割系 env（mdframed / framed / shaded / longtable / multicols / breakable tcolorbox とプリアンブル定義の breakable 名）の分割は本物の output routine の中でしか走らない**ため、これらの block の isolated compile は `\includepdf` と同じく実 routine を残す。ページが満ちるたびに実ページが ship され、per-page chunk になる（先頭ページは entry strut の下でクロップし、pagebuilder が block の on-page offset に部分 box として置く。中間ページは全 textheight。full フラグは付けない — 通常の文書ページなので preview の page furniture がそのまま乗る）。最終の部分ページは routine が発火しないので page_head に残り、通常の remainder 収穫が正確な寸法で拾う。**分割が不要な box は routine が一度も発火せず、absorb 経路と byte 同一の galley になる** — 恒常 frozen だった stress 文書の 9 block（＋multicols/longtable の 1 block）はこれで exact 化され、boot 時の frozen は 0 になった。referee（fuzz）は依然、壊れた TeX の新規凍結のみ skip+revert し、discard class（残existすれば）は比較自体に判定させる。

## 10.10 render、shipping、canonical

`sourceClosure()` は `\loop\if...\repeat` の条件終端を認識する。字句的に閉じていないソースは `closure-deferred` として resident のブロック・紙面を保持するが、最新 `srcRev` の canonical を display cadence で必ず予約する。これには `external-include` も含む。字句解析ではマクロ定義と実行を完全に区別できないため、正否とエラーは LuaLaTeX が決める。保留中の旧ブロック範囲は直接編集へ渡さず、旧紙面を現在のソースとして検証・cropしない。canonical の `runningRev`・`scheduledRev`・`fallbackReason` で予約と実行の対象を確認できる。エラー終了時の部分PDFは採用せず、最後に成功したPDFと世代を保持する。

hot path の最後に `#shipUpdate(source)`、`canonical.schedule(source, srcRev)`、`#scheduleBackground(fgStop, dirtyBlocks, options)` が呼ばれる。

`#scheduleBackground()` は chain と resident render を予約する。

- pending chain があれば idle 後に chain pass を走らせる。
- 編集した source block と同じページの exact block は、foreground walk の前に input/capture 境界を最大8個保持する。walk 後にも未変更の exact neighbor を描画 queue に加える。boot で queue に入らなかった render hold と、描画済みの hold は通常の checkpoint 上限へ戻し、保持を再作成しない。
- dirty block 数が `TDOM_RENDER_HOT_MAX` 以下なら、needsRender な hot block を resident exact-render queue に積む。display math と native closure 済みの graphics（float/insert/eject を含まないもの）は foreground JOB の node list を post-block checkpoint に世代付きで保持し、queue 側は CAPTURE を先に試す。これにより block source の二重組版を避ける。保持 list が退役・世代不一致なら、pre-block checkpoint の従来 RENDER へ自動 fallback する。
- resident の PDF descriptor は boot で読み書き可能にし、各 JOB/CAPTURE/RENDER/ISO fork の直前に現在の bytes と位置を匿名ファイルへ複製する。子だけが複製先を継続し、出力時に専用 job directory へ移す。TikZ/hyperref が先に PDF object を作っていても cold compile は不要。装飾は過去画像を再利用せず、その編集で組版した node list を ship する。graphics の chunk identity には source hash も含め、寸法を変えない色・underlay 編集でも再描画する。エラーで凍結した galley は以前の paint identity を維持する。
- exact chunk の ship は、galley 抽出と同じく前ブロックの lastskip primer と最上位 topskip を除く。RENDER と isolated fallback も前ブロックの lastskip を復元してから組版するため、余白の max-merge と SVG の原点・高さが foreground JOB に一致する。
- 通常編集の foreground で変わった bounded hot 集合には現在の `srcRev` を付け、後着の cold queue より先に、最終編集から `TDOM_RENDER_QUIET_MS`（既定120ms）後に処理する。編集中の block だけでなく、同じ紙面の一括表示に必要な隣接 block も含める。boot/reboot・過去世代・deferred chain は、有効な shipping baseline がある場合の優先時間（既定900ms）を維持し、現世代 hot への後着 background enqueue は優先度を落とさない。
- 新しい編集は、前の edit/boot が残した resident render 子プロセスを preempt し、未着手 queue は保持する。旧世代の優先印は失効し、同時実行数（既定2）と checkpoint の上限は変えない。render fork は foreground JOB と衝突しない固有 request id で追跡する。

display list は本文 glyph と行単位の exact chunk を別素材として保持する。stale chunk・未取得の exact 素材・透明な math run が残る場合、ビューアはその新しいページ群を公開せず、直前の完成した紙面を保持する。fresh chunk は exact 判定された連続行だけの window にし、安全な散文行や `\texttt` / `\textit` は glyph のまま使う。全素材・文字座標・ソース範囲が揃ってから、影響するページ群を同時に提示する。MathLiveによる別フォントの数式描画で補わない。

各 edit report と async patch は、その時点の font manifest を page patch と同時に送る。client は新しい `@font-face` を登録し、face の decode が完了するまでページ群の提示を待つ。画面外の準備中に該当 run が透明でも、表示中の完成ページは保持する。

`canonical.schedule()` は source/rev を保存して timer を張るだけで、full `lualatex` compile は edit response を待たせない。完成した provisional 面を提示できる structured モードでは、初回だけ `debounceMs`（既定2500ms）で baseline を取得し、以降は最終編集後の `idleMs`（既定30s）とコスト比例 cooldown（factor 2、cap 600s）を満たしてから確定する。opaque モードでは `displayDebounceMs`（既定350ms）と display cooldown（factor 1、cap 60s）を使い、長文書の連続再組版を抑える。

欠けた数式・不一致のページ構成・編集位置の未証明などで新しい紙面を提示できない場合、client は `POST /canonical/display-demand` に現在の `documentEpoch`・`srcRev`・表示側の `demandId` を送る。その版の既存予約だけを display cadence へ早め、追加の組版は作らない。完成したresidentページ群を実際に提示できたら同IDの `fulfilled: true` を送り、全表示側の需要が解消した未開始予約だけを通常のauthority cadenceへ戻す。待機の起点は最終編集時刻を保つ。同版を再び保留した場合やiframeを再作成した場合は新IDで再取得でき、遅延したfulfilledは別表示側の需要を消さない。IDは128文字、現在の版の既出IDは最大64件とし、同IDの重複はtimerを延長・再有効化しない。開始済み・成功済み・失敗済みの組版を需要通知から追加・取消・再試行しない。需要は対象の完了・失敗・別版への更新・文書resetで終わり、後続の無関係な編集は通常のauthority cadenceに戻る。`canonical.info()` の `scheduledInMs` は予約までの残り時間、`compiling` は実組版中、`displayDemandRev` は需要対象の版を示す。`ensure()`（export 経路）は渡された snapshot だけを compile し、途中の打鍵を連続して追いかけない。

現在のforeground resident cohortが正確なchunkを生成中の場合だけ、需要で早めたtimerの開始を待たせる。queuedとactiveを同じ原文revisionで追跡し、activeはTeX完了後のPDF変換・cropまで含む。完了後は提示通知用に500msを確保し、待機全体はその原文予約から2000msまでとする。失敗・isolated fallback・対象cohortなしは待機しない。改ページ・ページ数不一致・編集位置の未証明・canonical-onlyの需要は `residentImpossible: true` で待機を外し、複数表示側のうち1つでもこの需要が残れば延期しない。入力先行・anchor返信待ち・読込失敗は一時状態として通常の上限付き待機を保つ。同じIDで許す変更は待機不可への昇格だけ。`ensure()`・`settle()`・opaque組版はこのtimer専用待機を通らない。

## 10.10b checkpoint 予算の硬い上限

structured page の差し替えには、その page の未変更部分も含む exact chunk が必要になる。foreground walk は source-dirty block の後で galley が収束しても、同じ既存 page の未準備 exact block までは続ける。前方の未準備 block も再開位置に含める。ただし入力 checkpoint が editHold / renderHold または全境界を収める通常予算で保持される block は、既存の RENDER から準備できるため walk を延長しない。renderHold の枠はこの page 群を優先し、そこへ到達するためだけに再実行した無関係な prefix の描画で埋めない。保持数の上限は変えず、準備済み chunk がある page の通常の収束停止は維持する。

`maxCheckpoints`（既定は env、主サーバは 8）は通常の常駐 checkpoint 骨格の予算である。骨格を block 数の等間隔にすると、編集点との間に巨大な TikZ / user macro block が一つあるだけで、無関係な地の文の毎打鍵がその block を再実行する（実測: 160 回の複合 macro 展開を跨いだ日本語 1 文字が 4.4 秒）。そこで各 block の cold typeset 高水位時間を記録し、最も高価な block の入力・出力境界を優先して残し、余りを重み付き分位へ配る。これは `tikzpicture` や `tcolorbox` の名前を判定する局所対応ではなく、未知 package / macro にも同じ実測原理で働く。上記 fixture では同じ編集が fresh-open 直後でも 15ms になった。
末尾用の保存枠は、終端の `\par`・skip・改ページだけの block より前に置く。通常の保存間隔内に明示的な改ページがあればその直後を選び、最後の本文と未変更の見出しを同じ短い walk で用意する。このソース上の手掛かりは保存位置にのみ使い、組版する token は省略しない。選択順は root、高コスト block の入力・出力境界、末尾 anchor、残枠の重み付き分位である。予算内に全候補が収まらない場合は末尾の予測可能性を優先するため、予算値によらず分位境界や最後の高コスト block の出力境界が外れ、末尾以外の編集が追加 block を再実行する場合がある。

ただし骨格選択だけでは生存 checkpoint 数の上限にならない。`#retireOffGrid(idx)` は「その JOB が処理した 1 index」しか退役させないので、mid-document から resume する pass（rescue pump・settle・chain・backward-ref）は各停止点に orphan checkpoint を残し、誰も retire しないまま生存集合が creep する（実測: budget 8 指定でも 25 個生存、boot 時 55 個超で 16GB 機が窒息）。`#enforceCheckpointCap()` が「ckpt0 ＋実測コスト骨格 ＋ editHold ＋ renderHold だけ残し、他は DIE」で畳み直す。`#updateInner()` 末（boot/edit walk 後）・`#asyncRescueOne` 後・`#runChainPass` の finally で呼ぶ。各 checkpoint は累積 dormant page を保持する常駐 lualatex なので、これは実メモリの上限である。

`#shipUpdate()` は `TDOM_SHIP=1` のときだけ意味を持つ。現在の root source と、実際に展開した project input bytes の immutable snapshot を shipping chain に渡し、unit diff から resume できるかを判定する。child-only refresh は root が同一でも `unchanged` ではない。単一の既知 literal `\input` だけを最初の reader より前から replay し、未知・複数・`\include` の変更は新しい canonical seed を待って baseline を作り直す。snapshot を受理していない generation は新 `srcRev` に対応付けず、後着 wave も current revision/snapshot の一致を満たさなければ公開しない。実際の page ship と SVG 化は非同期で、`onShipPage` と SSE `ship` として着地する。

canonical anchor は root 内の plain text に加え、既に読まれた単一 child file の単一 plain-text 差分を扱う。child の公開 DOM span は引き続き `null` とし、編集前の include bytes から差分を算出して、物理 `readPath`、child-local block span、galley witness を非公開 snapshot に固定する。対象は root からの単一 literal `\input` とし、現在の read trace に到達した root/child ごとに字句上の reader 数と trace 数が一致しない場合は採用しない。同じ child が複数 block instance に所有される場合、`sourceParts` を持つ場合、別 input の変更が同居する場合も anchor を作らない。連続入力は最初の canonical snapshot を継承し、input epoch・source revision・canonical generation・PDF/SyncTeX hash のいずれかが変わった後着 proof は公開しない。

block 全体が safe-glyph・副作用なし・全 box が単一行 witness、という条件を満たさない block（見出し box、tcolorbox などの枠つき box、graphics、toc line・label を持つ block）でも、編集がその中の plain な 1 行に閉じていれば anchor できる。box ごとに witness を取り、単一の plain glyph 行でない box は不透明として扱う。編集前に、plain 行の glyph run だけを除いた block の frame（不透明 box の全内容、glue・penalty・marker、plain 行の box 寸法と flag、gfx・float・label・ref・toc line・event、backend profile）を固定し、編集後の frame が完全に一致すること、変わった行が plain 行だけでその fidelity flag が 0 であること、structural state が一致することを要求する。証明は plain 行すべての一意な canonical 対応で行い、不透明 box は照合しない（再描画しないため）。graphics を含む block は全行が exact chunk へ回り表示リストに glyph を出さないので、変わった行は source hit box の位置から、その行の run を表示リストと同じ規則で描く。

frame が「変わっていない」ことの根拠は三つある。(1) resident の収穫は box ごとに描画系 whatsit（pdf literal・color stack・matrix・save/restore・special・late_lua）の種類・mode・順序と文字列 payload を `fx` として記録する（LuaTeX 1.24 は TeX が作った pdf literal の token list の中身を Lua に出さないので、その中身は種類と順序でのみ区別する。読めない中身が編集で変わらないことは (6)(7) で示す）。(2) block 本文に通常文字に見える active character（babel shorthand や独自の `\catcode 13`）がある場合は対象外にする（`tdomActive`）。TeX の特殊文字は編集側で既に拒否しているので、残る編集は文字の組版だけで、macro を実行しない。(3) resident 以外で作った galley（rescue）は `fx` も `tdomActive` も持たないので対象外。(4) resident の収穫より後に描画を足す shipout filter と、組版中の node list を見る filter は、callback 名と description の組がすべて既知の集合（LuaTeX-ja・luaotfload・luacolor・lua-ul の underline が実際に登録する組だけ。名前の接頭辞では認めない）に入る場合だけ許す。照合する登録は、`GEO` の `paintCallbacks`（前文での登録）と、計画時点の全 block の galley の `paintLate`（GEO より後にその lineage で登録されたもの）を合わせたもの。resident は driver の最初の行（前文より前）で `luatexbase.add_to_callback` を包んですべての登録を記録する（どの package も包む前の関数を持てないので、同じ block の中で登録して外したものも残る）。block の終わりには registry も読み直す。後の block で登録された shipout filter も同じページに効くので、編集した block だけでなく全 block を見る。galley のない block がある場合、報告がない場合、未知の組がある場合は対象外。(5) luacolor は属性に置いた色を shipout 時に書き込むので、resident の run の色には出ない。黒以外の属性値を持つ glyph・rule を含む box を `ca` として記録し（黒の値は root で luacolor に既登録の黒の値を問い合わせて得る）、変わった行が `ca` を持つときは（plain block でも）anchor しない。(6) 編集より後にある編集していない macro は、編集で変わった TeX の状態（`\badness`、`\prevgraf`・`\prevdepth`、ページの累計、最後の node の値）を読んで、収穫では中身を読めない literal を作れる。resident は main vertical list への移し替え（build_page）のたびにこれらを標本化し、block の state trail（hash）として frame に含める。trail が一致すれば、編集した段落より後のコードは同じ状態から走っているので、中身を読めない literal まで出力が同じになる。(7) 段落の途中（水平モード）の状態は標本化しないので、変わった行を含む移し替え（その段落と、段落が動かした display・`\vadjust`・insert）には、収穫で読める描画しか許さない（`fx`・`ca`・float・insert を持つ項目がないこと）。各 top-level 項目がどの build_page で移されたかは、標本化の時に node に付けた属性から取る（`epochs`）。証明の出所について: SyncTeX は段落の行 box とその中の glue/kern に段落を閉じた行（次の環境の行など）を付けるため、SyncTeX の行番号では prose 行と枠内の行を区別できない。そこで内容で区別する。不透明 box の glyph 列が plain 行の glyph 列を含むときは anchor しない。frame が不透明 box を固定しているので、canonical 上の枠内の行が plain 行の文面と一致することはない。この比較は resident の run の文字列で行い、証明は canonical の ToUnicode 文字列で行うので、不透明 box の文字が native の font file で、remap・math・PUA・U+FFFD を含まない場合に限る。

## 10.11 hot path から外れているもの

現行実装では、次は編集同期応答に載らない。

- canonical full compile。
- page SVG 変換。
- resident CAPTURE/RENDER の PDF/SVG 生成。
- isolated rescue compile。
- long suffix rebuild/settle。
- page-context rescue fixed point。
- canonical crop。
- shipping chain の boot、page ship、page SVG 変換。

これらは async patch、canonical SSE、または次回 `GET /doc` の state として反映される。

## 10.12 direct input の表示処理

文字入力、MathLive の選択変更、スクロール、ズーム、リサイズは同じフレーム予約を共有する。位置の調整が必要なフレームでは、その調整とカーソル描画を一度に行う。クリックで確定した位置と新しい PDF geometry の採択は同期で反映し、古い描画予約を取り消す。

未反映の入力に対しては、直前の紙面で証明したカーソル位置を保つ。新しいモデル全体の caret を計算してから捨てる処理は行わない。通常の選択表示はページ寸法を一度読み、全マーカーを detached fragment に作って一度で置き換える。選択文字数に比例して layout read と DOM write を交互に行わない。IME 未確定文字だけは、候補位置に必要な実ブラウザ寸法を表示後に読む。

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
exact replay する。replay deadline は 700ms を下限とし、直近の canonical 組版より 500ms 以上早く終われる
範囲だけ最大3000msまで延長する。延長中は表示要求の canonical を開始せず、重い TeX 処理を並走させない。
replay が拒否された時点で待機を解除し、完成した complete PDF は別の表示期限内に全ページを読み込んでから
原子的に昇格する。期限を越えた edit は exact tree を昇格せず、Phase B の `VisualCut` が入るまでは旧 exact
pixels を保持する。source acceptance と新しい文字の即時描画は同義ではない。

## 10.3 diff と checkpoint rekey

body は `segmentBody()` と `#expandIncludes()` で block 列になる。`diffBlocks()` は旧 block 列と新 block 列の hash を比較し、dirty block、removed block、共通 prefix/suffix と、編集 window 内の未変更 block の対応を返す。

現在の checkpoint 処理は次である。

- prefix 内の checkpoint はそのまま残す。
- suffix と、離れた編集領域の間の未変更 block の入口は `boundaryMap` の新 index へ移動し、`vstale` として残す。
- 置換領域の入口も残す。直前の未変更 block の出口なので、次の block の本文が変わっても入口まで捨てる必要はない。削除だけの領域には入口を追加せず、後続 block の対応と衝突させない。
- 対応のない編集領域内部の checkpoint は `DIE` で捨てる。
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
| `cold` | dirty block に届く前の clean prefix 再生が時間予算を超えた（§10.4a） |
| `walked` | 文書末尾まで必要な foreground walk をした |

現在の budget は、layout-coupled galley divergence が 8、local state ripple が 4 である。budget を超えた伝播は hot path で文書末尾まで追わず、`pendingChain` に入る。

複数領域の編集では、途中の clean block の galley と exit state が一致し、定義変更・label 移動がなければ、次に必要な block の手前の保存済み checkpoint へ飛ぶ。実際に exact chunk が欠け、保持済み入口からの RENDER でも用意できない block だけが、このスキップを止める。編集ページ上にあるという理由だけで、描画済みの数式や graphics を再組版しない。state が変わった区間は引き続き順番に歩く。

### 複数編集領域の計測

複数領域の変更も文書順に処理する。キャレット warming は保存地点と exact pixel の準備に使い、編集領域の順番は変えない。未変更区間を飛ばす上記の条件は、warming の有無によらず同じである。

`tools/bench-multi-locus.mjs /tmp/long12.tex --caret=0.5` はキャレット位置を事前に warm し、`--caret=none` は warm せず計測する。`wallMs` は編集応答、`caretPublishMs` と `lastPublishMs` はキャレット領域と全編集領域の新しい block が実際の patch に出るまでの時間である。本文未処理・cold preview・frozen・旧 chunk の block は数えない。block が公開されても、ページ上の別 block に exact pixel が欠ければ viewer はページを差し替えられないため、`caretPagePublishMs` / `lastPagePublishMs` と `pageUnpublishedAtNextEdit` を別に報告する。ページ側は viewer と同じく `pending-exact`・canonical-only・math glyph・未準備／旧 chunk を拒否し、canonical display demand と同じ source revision の成功した canonical event も観測する。両指標に公開経路の件数を付け、ブラウザの画像取得・raster・paint 時間は含めない。各標本は全編集 block の公開または timeout を待ち、次の編集は `edit()` 完了から最低120ms後に送る。timeout 件数と最後の drain までを含む `totalNativeJobs` も報告する。

## 10.4a cold prefix の時間予算

nearest checkpoint が編集 block から遠い（caret warm が間に合わなかった、あるいは骨格の外の場所へ飛んだ）打鍵は、dirty block に届くまで clean block を順に再生する。316 ページの文書で 250 block を超えると 1 打鍵が 50 秒以上 HTTP を塞ぎ、その間の打鍵も同じ walk を最初からやり直していた。

foreground walk は、まだ source-dirty block が先にある状態で clean block を再生している間だけ、`TDOM_COLD_PREFIX_MS`（既定 1500、`0` で無効）を経過した時点で完了済み block 境界で止まり、verdict を `cold` にする。boot・reboot・retry の walk は対象外である。

- 止めた境界は `editHold` に pin する。到達済み prefix は次の walk が再利用する。
- 届かなかった source-dirty block は `coldDirty`（`stats.coldPending`）に記録する。その galley は text より古い。通常の打鍵はこれを追わない（自分の hot path を保つ）が、どの walk でもその block を再組版した時点で記録は消える（`#adoptGalley`）。
- `pendingChain` に `cold` を積む。chain pass は idle gate の後、`coldDirty` の先頭 block の nearest checkpoint から `#retypesetChain` で（STEP を使って）その block の入口まで進む。STEP は入力 checkpoint を消費するので、打鍵はふつうこの walk の子を kill しない（`coldWalking` 中は `bgAbort` を立てるだけで、caret warm と同じく次の block 境界で止まる）。到達境界を pin して次の pass で続きから進むので、打鍵が続いても 1 打ごとに進む。kill すると到達済み prefix が全部失われ、登録直後に死んだ peer を次の JOB が掴んで typeset 失敗 → 全 reboot（107 s）になった。例外は止まった後の最初の 1 打（直前の打鍵から 400 ms 超、`editGapMs`）で、caret warm の子と、打鍵が変えた入力がどれも別のファイルである cold walk・grid 充填の子（向かう block は `bgWalkTarget`）を、`#update` が lock を待つ前に `abortBackgroundJob` で kill する（`walk-preemption.js` の `editElsewhereThanWalk`。root の編集は root のファイル、入力不明の refresh は同じファイルとみなす）。ただし kill するのは、失う分（その walk が最後に残った境界から再生してきた分）が 150 ms 未満のときと、実行中の block の残り見込みが失う分より長いときだけ（`walkKillPaysOff`。どちらも intrinsic コストの 2 倍で見積もる。caret warm の step は checkpoint の GC に当たると intrinsic よりずっと長くなり、残りは見積もれない（以前の 64MB 基準の GC で、intrinsic の小さい block が 1.3〜3 s かかった。いまの基準では打鍵側の JOB が GC を払うことはまれ、docs/03 §3.2）。そこで caret warm の step がすでに 300 ms 走っていれば、失う分によらず kill する）。止まっている間に長く進んだ warm は、次の 1 打で捨てずに境界で止める。同じファイルへ向かう cold walk・grid は kill しない（その到達分が同じ場所の次の打鍵を hot にする）。打鍵が続く間も kill しない（1 打ごとに kill すると、warm も別ファイルの resume も進まなくなる）。kill された STEP は `bgAbort`・`bgActive` が立っているので `typeset-dispatch` が `restoreReplayInput` や rescue を走らせずに投げ直し、walk はそこで終わる（かつて打鍵が warm を kill すると、この組み直しの間 25 s 待たされたので境界停止にしていた）。途中まで組んだ時間は block のコスト標本にしない（最小値が残るので、重い block が軽く見えて keep set が動く）。`#reapDying` を待つ間に kill が来て子がまだ無かったときは、`#jobBlock` がその job を始めない。失うのはその walk の到達分だけで、cold walk と grid は次の idle gate で最後に残った境界から歩き直す。失う分を抑えるため、caret warm と cold walk は再生 `TDOM_WALK_RETAIN_MS`（既定 400 ms）ごとに 1 つ、境界を STEP で消費せず JOB で fork して `editHold` に pin する（walk ごとに最新の 1 つだけを持ち、前の分は外す）。行き着いた walk は最後の pin も外し、打鍵に止められた walk は次の walk の出発点として残す。grid 充填は pin しない（別ファイルの打鍵でしか kill されず、target ごとに pin すると editHold から打鍵位置の pin を押し出す）。打鍵の側はその境界を使わず、自分の walk と cold preview で出る。316 ページで別の章へ飛んだ打鍵は、前の章の cold walk や飛んだ先の caret warm が重い block を 1 つ組み終えるまで 1.2〜2.6 s 待っていた。さらに打鍵は lock を取るまで `editPending` を立てる。warm はこれが立っている間は開始せず `bgAbort` も戻さない（打鍵の直前に届いた warm が同じ bgTask 待ちから先に起き、flag を消して lock を取り、194 block を歩き切るまで打鍵が 56 s 待った）。cold pass と deferred chain の idle gate も `editPending` で止まる。kill する経路（fork JOB の子）では、CKPT を先に登録済みの子が map に残らないよう `abortBackgroundJob` と `#jobBlock` の失敗処理がその pid の checkpoint entry を即座に外す（socket close で外れる前に次の打鍵が nearest checkpoint として掴み、12 s の job timeout → retry reboot になった）。
- 入口に着いたら chain pass は `resume` を返し、scheduler が chain lock の外で `#update({ editLabel: 'cold-resume' })` を走らせる。prepare は `coldDirty` を dirtySource に合流させ、通常の foreground（今度は hot）・finalize を行う。`srcRev` は進めず（canonical / shipping の generation は元の打鍵が予約済み）、`rev` だけ進めて `onDeferredUpdate(report)` で公開する。cold 中に積まれた settle/rebuild は `carry` として resume の verdict の後に再登録する。carry の `from` も `pendingChain.from` と同じく編集ごとに index を付け替える。組版する block が残っていない resume（別の打鍵が cold block を消した）も、`null` を返す前に carry を再登録する。
- resume の walk も予算で cold stop するが、自分の dirty block（`coldDirty`・`coldIds`・galley の無い block）を 1 つ組版するまでは止まらない（lock を待つ打鍵があれば止まる）。lock を待つ打鍵（`keystrokePending`。`editPending` と違い、待っている cold resume は数えない）があれば、resume も foreground walk も予算を待たずに次の clean 境界で止まる（打鍵が resume の予算 1.5 s を使い切るまで 3.7 s 待った）。foreground walk は出発点でも止まり、preview も待たない（新しい打鍵の text の方が新しい）。walk は chain pass が着いた境界より前から始まることがある（入口境界が保持されていない exact 近傍 block への `firstDisplay` の拡張、別の walk が組版済みの `coldIds` の block）。そこで止まると同じ block がそのまま積み直され、次の resume も同じ場所から始まる。この規則により、打鍵が途切れていれば resume を重ねるたびに対象の block は少なくとも 1 つずつ減る。
- 打鍵が resume より先に chain lock に入った場合、その打鍵が block を組版し、resume は dirty なしで `null` を返す（何も公開しない）。
- cold resume の report には `stats.coldWalk`（再生の from/target/歩いた block 数/ms/block ごとの ms と、予算停止からの gate・lock・walk 完了・resume 開始・publish までの `timeline`）が載る。実測（316 ページ、上限 12、warm なし）: 応答 1.7–1.9 s、overlay 8.5–9.8 s のうち walk が 6.3 s（27 block、うち 1 block がメモリ圧で 4.1 s）。walk の長さは keep set の境界に checkpoint 実体が無いことが原因だったので、docs/03 の grid 充填 pass で埋める。cold 打鍵の待ち時間の理論値は「最寄り境界から dirty block までの再生コスト」で、grid が埋まっていれば平均で区間コストの半分、最悪で区間 1 つ分（上限 12・この文書で ≈ 3 s / 6 s）。
- cold pass の idle gate は shipping 優先窓（900 ms）を待たず 300 ms。isolated rescue の adopt walk（`#asyncRescueOne`、chain lock を数秒保持）は `coldDirty` / pending `cold` / `editPending` の間は開始せず、走行中なら block 境界で譲って queue に戻る（実測: cold stop の 0.8 s 後に gate を過ぎた cold pass が rescue の walk に lock を取られ 8 s 待った）。
- 打鍵は chain lock を待つ前に `editPending` を立てる。caret warm と chain pass はこれが立っている間は開始せず、走行中なら次の block 境界で譲る（warm が先に lock を取り `bgAbort` を消してしまい、打鍵が prefix 全体の再生を待たされた: 実測 56 s）。止まった後の最初の 1 打が warm や別ファイルへの walk を kill する例外は §10.4a の上。
- caret warm（ホストは打鍵直後にも `/warm` を送る）は deferred chain を先取りして止める。warm walk が完了・中断したら `pendingChain` が残っていれば scheduler に返す（`#kickPendingChain`）。warm がその block を組版済みなら cold pass は再生なしで `resume` に進み、`coldIds` に残した block を（今度は hot に）組み直して report と anchor を出す。

server は cold な編集応答に `canonicalAnchorRefused: 'cold-prefix'` を付け、anchor の文脈（edit・base snapshot・lineage・accept 時刻）を `pendingColdAnchor` に置く。同じ block への続く cold 打鍵が lineage を継げるよう、base があれば `coldPending` の lineage entry（pages なし）を残す。deferred update が同じ `srcRev`・documentEpoch・anchorEpoch で届いたら、その文脈で `planTerminalCanonicalAnchor` → 通常の lineage 登録 → `resolveTerminalCanonicalAnchor` を行い、`update` を broadcast する。先に新しい打鍵が公開していた（`rev` が古い）deferred report は捨てる。`/status` の `cold` に未組版 block と walk の進捗が出る。

## 10.4b cold preview

cold stop の応答は編集 block をまだ組んでいないので、打鍵が紙面に出るのは resume の後になる（316 ページ、上限 12・grid 充填済み: 1.4〜4.7 s。ほぼ全部が最寄り境界からの再生距離）。cold preview は、その間の編集 block を walk の出発点の checkpoint から直接組んで先に見せる。

- 条件: source-dirty block が 1 つだけ、定義の編集（§10.5）でない、rescue 対象の環境（§10.8）でない、今の text で `poisoned` でも deep-lineage の壁（`chainTimeouts`）の中でもない、cold resume 自身の walk でない、そして同じページに exact 画素の要る cold な block が他に無い（`firstDisplay`〜`lastDisplay` が編集 block だけ。ほかに要る block があれば、walk がそこへ着くまでページは描けない）。そのうえで、walk の出発点から編集 block までの推定再生コスト（clean block の `typesetCostMs` の和）が `TDOM_COLD_PREVIEW_FROM_MS`（既定 500。推定は最小標本なので、実際の再生は概ねその 2 倍）を超えたとき。
- 出発点の checkpoint に、編集 block の JOB をもう 1 本送る。本文は通常の JOB と同じで、前に vstale lineage と同じ `#volatilePrelude`（直前 block の exit vector から counter・`\prevdepth`・`\if@nobreak`）、label 定義、`\lastskip` primer を付ける。直前の exit が `@nobreak` なら `\@afterheading` も付ける（本来の lineage には見出しの `\everypar` が残っている）。見出し以外が立てた `@nobreak` や、`\everypar` に題を持つ run-in 見出しでは近似になるが、どちらも置き換えられる。子の checkpoint 番号は `-1` で、`peer-message.js` は待たれていない `CKPT` を受理しないので、子は galley を返したあと DIE される。GALLEY を返さずに子が消えたら即座に失敗にし、使わなかった preview の子は kill する（walk が例外で抜けたときは次の update が kill する）。待ちきれずに timeout した preview の子も kill する（まだ FORKED が届いていなければ届いたときに）。
- 間の clean block を再生しないので、1 block 分の組版で済む（316 ページで 0.15〜0.40 s。再生は 2〜4 s）。間の block が変える untracked state（マクロ定義・フォント宣言など）は入らない。316 ページの 6 箇所では、font 参照の正規化前の番号を除いて galley が一致した。
- walk は budget に加えて、preview が届いた時点でも完了済み block 境界で cold stop する。ただし残りの推定再生が閾値の半分以下なら、そのまま歩き切る。preview が届く見込みの時点（編集 block の組版コスト＋100 ms。`TDOM_COLD_PREVIEW_WAIT_MS` 未満のときだけ）でもなお残りが閾値の半分を超えるなら、walk は次の clean block を組まずに今の境界（出発点を含む）で preview を待ち、届いたらそこで cold stop する。両方の子が同じ core を取り合い、重い block 1 つの STEP は preview より長いため、並べて歩くと preview も応答も遅れた。preview が失敗するか `TDOM_COLD_PREVIEW_WAIT_MS` を過ぎたら、そのまま歩く。次の clean block の推定再生（`typesetCostMs` の 2 倍）が 500 ms を超え、組めば budget を越える（組んだ直後に cold stop する）ときは、preview がまだ出ていれば、その block を組まずに境界で preview を待つ。待つのはその推定再生の時間まで（preview の timeout は越えない）で、届いても届かなくてもそこで cold stop する（届かなければ下の budget 停止と同じく待ち続ける。preview が失敗したときだけ歩き続ける）。重い block を組むと、その間打鍵を待たせるうえ preview の子と core を取り合った（316 ページで 1 つの box が負荷下で 3.1 s。tex64-internal #104）。組まずに残した block は、次にそこへ着いた walk が組む（待つのは block ごとに 1 回で、`heavyWaitId`）。連打の間は次の打鍵が前の応答の後ろに並んでいて cold pass の idle gate が来ないので、毎回待つと停止点がその境界から動かなかった（316 ページで 6 打続けて同じ境界で待った）。間が空けば cold pass が idle gate の後に組み、その step は kill しない（毎打鍵 kill すると、打鍵が続く間その block を越えられず、resume がいつまでも来なかった）。どちらの場合も、その block の再生は最初の打鍵から次の打鍵へ移るだけで、合計は増えない。到達境界は §10.4a と同じく pin され、resume がその先を歩く。budget で止まったときは、preview を `TDOM_COLD_PREVIEW_WAIT_MS`（既定 1000）まで待つ。編集 block の入口で止まったときは preview を使わない。
- preview は `tdomColdPreview` 付きの galley として adopt する。block は `coldDirty` に残り、自分の lineage で組む walk（resume・caret warm・chain）が置き換える。その walk が preview を「変化なし」と見て、下流を確かめずに収束しないようにするため、次の 2 点を守る。
  - 各 walk（foreground・`#retypesetChain`・chain pass）は、preview の galley を比較の witness にしない（`before.hash` を持たない）。置き換えた walk は必ず次の block を確かめに進む。
  - block の `stateVec` は編集前のまま残す。後続 block はその exit state を前提に組まれているので、置き換えた walk は native の exit state をそれと比べ、counter が動いていれば §10.4 どおり下流へ運ぶ。
- graphics を含む galley（`gfx`）だけは、identity に `cold-preview` を加える。preview の画素は別 lineage の state（checkpoint と block の間の `\tcbset` など）で描かれていることがあるので、置き換えた galley には使わず描き直す。glyph と数式の chunk はそのまま引き継ぐ。
- label の索引は preview では更新しない。label を消した・変えた打鍵は、置き換えた walk の索引更新で消え、そこで参照の再組版へ回る。
- exact 画素の要る block は、render pump が preview を組んだのと同じ peer（index はその後の編集で動いていてよい）から同じ prelude で RENDER する（`render-pump.js`、`renderStats.coldPreviews`）。その peer は preview の開始から、この RENDER が終わるか、walk が preview を置き換えるか、30 s 経つまで退役させない（`coldPreviewHolds`。これが無いと、walk の最初の JOB の off-grid 退役や grid 充填の cap で先に消え、画素は resume の後の native RENDER まで出なかった）。peer が無ければ block 自身の checkpoint、それも無ければ isolated render に回す。preview が次の打鍵の新しい text に持ち越された場合は描かない。直前の打鍵から 400 ms 以上空いた打鍵（止まった後の最初の 1 打。`editGapMs`）では、この RENDER を preview の JOB の直後に同じ peer・prelude・text で送っておき（`startResidentRender`、`TDOM_COLD_PREVIEW_EARLY_RENDER=0` で無効）、pump は preview が adopt された後にその PDF を切り出すだけにする（`render.timings` の `earlyMs`）。打鍵が続く間は pump の quiet gate に任せ、打鍵ごとに RENDER を起こして kill することはしない。preview が使われなかったとき、walk が preview を置き換えたとき、30 s 経ったときは、pump が取っていなければ子を kill してディレクトリを消す。次の打鍵の preempt で kill された早出しは、pump が通常の RENDER で描き直す。
- preview は証明の入力にしない。次の打鍵の `previousGalley` には preview の前の galley を渡す。resident edit admission・plain preview・canonical anchor の base の witness にも使わない。壊れた TeX の last-good 保持（`broken-galley.js`）と stale-first rescue の複製では印を外す。
- `coldDirty` は文書ごとの状態で、open と resident tree の破棄で空にし、resume が失敗したときも空にする（rescue pump は `coldDirty` が空くのを待つ）。
- 応答の `stats.coldPreview` には block・推定再生コスト・preview の所要時間・walk 時間・adopt の有無が、`/status` の `coldPreviews` には adopt 数が出る。`TDOM_COLD_PREVIEW=0` で無効になる。
- `/edit` の応答と SSE `update` の `timing` には、打鍵の client 時刻・server の受信・engine の完了（epoch ms）に加えて、`lock`（`#update` に入った時刻と lock を取れた時刻、そのとき chain を持っていたもの `heldBy`: update・warm・cold・grid と実行中の job の block と経過 ms）、`walk`（foreground walk の出発点・編集範囲と、block ごとの ms と印。c=clean・d=dirty、x=galley か exit state が変化、r=rescue、p=その時点で preview が届いていた、w=重い block の手前で preview を待った ms）、`coldWalk`（直近の cold walk の block ごとの ms）が出る。
- 実測（316 ページ、上限 12、grid 充填済み、warm なしで 6 章へ 1 打鍵）: 紙面に出るまで 0.82〜1.43 s（従来 1.35〜4.7 s）。内訳は応答 0.38〜0.61 s と、その 0.4〜0.8 s 後に届く exact 画素の late patch。

## 10.4c 編集 block の先行 RENDER

exact 画素の要る block（`needsRender`）を編集すると、render pump は foreground update が終わるのを待ってから、その block の入口の checkpoint から RENDER する（`engine.updating` の間は pump が止まる）。walk が編集 block の手前の block を組み直す打鍵では、walk の時間に RENDER の組版がそのまま足されていた（316 ページ・高負荷: 2 block の walk 0.8〜0.9 s の後に RENDER 0.6〜0.8 s）。

- 編集 block の JOB を送った直後に、同じ checkpoint へ RENDER を送る（`startResidentRender`）。本文は JOB と同じ prelude（label 定義と `\lastskip` primer）＋本文なので、画素の参照番号も galley と揃う。本文が変わった block は必ず fork の JOB で組まれる（walk が STEP で消費するのは最初の dirty block より前の clean block だけ）ので、RENDER の入力は残っている。
- 条件: update（cold resume を含む）の中で、本文が変わった block（`sourceChanged`）で、`needsRender`、この JOB の node list から pump が CAPTURE できる block（`mayCaptureNativeBlock`: display math と、float も改ページも無い native の gfx block）でない、checkpoint が vstale でない。そのうえで lock を取った 1 回の update に 1 本まで（`updateSeq`・`earlyRenderUpdate`）、止まった後の最初の 1 打（`editGapMs` 400 ms 超）で、後ろに打鍵が待っていないとき。打鍵が続く間は pump の quiet gate に任せる。ただし続けて打つ最初の 1 打は単独の打鍵と区別できないので、その RENDER は次の打鍵で kill されて無駄になる（打鍵の続きごとに 1 本）。`TDOM_COLD_PREVIEW_EARLY_RENDER=0` で §10.4b と一緒に止まる。
- JOB が返した galley に `tdomEarlyRender` として付け、pump はその galley が block に付いていて本文が同じときだけ、その PDF を切り出す（`render-pump.js`）。後の update が block を別の state で組み直して galley が替われば使わない。次の打鍵の preempt では子が kill され、PDF の置き場は galley が替わったとき（`#adoptGalley`）か 30 s 後に消える。JOB が失敗したときもその場で捨てる。last-good 保持と stale-first rescue の複製では印を外す。置き場を作れなかったときは送らず、pump がふだんどおり描く。
- pump が自分で送る RENDER も、galley を組んだ JOB の prelude（`tdomRenderPrelude`。vstale でない checkpoint の JOB だけが残す）を本文の前に付けるので、先行 RENDER が kill された打鍵でも参照番号は galley と揃う。isolated rescue などその prelude の無い galley は、従来どおり primer だけを付ける。

## 10.4d 打鍵の JOB を受ける予備の子（spare continuation）

編集 block の JOB は、その block の入口の checkpoint から fork した子が組む。fork したばかりの子には二つの費用が毎打鍵かかっていた。

- **フォントの読み直し**: block が文書の中でその font を最初に使う場所（最初の数式、最初の太字、`\LaTeX` ロゴの小さい A など）だと、入口の checkpoint はその font を持たないので、JOB のたびに読み込む。389 ページの本の章ウィンドウでは、3 行の地の文が 18 ms のうち 17 ms を 6 pt の 1 書体の読み込みに使っていた（同じ子でもう一度組むと 1.5 ms）。章ウィンドウは各章が前文の font だけで始まるので、特に当たりやすい。
- **ページの読み込み直し**: 子の page table は空で、親と共有するメモリを読むたびに fault が起きる（同じ段落で 4,400 回、kernel 時間 5 ms）。fault の費用は fork の世代が深いほど上がる（1 世代 1.7 µs、400 世代 15 µs / page）。

そこで、編集 block の JOB を渡したあと、checkpoint は次の打鍵の JOB を受ける子を先に fork しておく（`daemon.lua` の `SPARE`、`tdomfork.c` の「a spare continuation」）。

- engine は、編集で本文が変わった block の JOB に `K` を付ける（`keystrokeSource`。open と reboot では付けない）。checkpoint は `K` の JOB を渡したあと 8 ms 何も来なければ予備の子を fork する（`fk.spare_fork`）。先行 RENDER など続けて来る命令を先に通すためである。
- 予備の子は、(1) 直前の JOB が checkpoint に無くて持っていた font を、TeX に頼まれたとおりの名前と大きさで、同じ順に読み込む（group の中の `\font\tdomwarmfont=… at …sp`。名前は文書の catcode に左右されないよう plain な文字で渡す）。(2) 直前の JOB の page table にあったページを 1 byte ずつ読む。(3) pipe で JOB を待つ。次の `K` の JOB は fork せずにこの子へ渡す（`fk.spare_send`）。
- font は資源であり、少し前に読み込んであっても段落の組み結果は変わらない。同じ順に読み込めば font 番号も同じになる（単体の LuaLaTeX で、19 書体を先に読み込んだ版と読み込まない版の出力 SVG が一致することを確かめた）。順が変わった場合は番号だけが変わる。galley は自分の font 表を持つので表示は変わらない。
- JOB は `fontList`（checkpoint の `font.max()` より上の font の「大きさ 名前」）、`fontLoads`（JOB 自身が読み込んだ数）、`spare`（予備の子が先に読んだ pages と fonts）を galley に付けて返す。caret が block に来たとき（`warmEditOffset` が ready）、engine はその block の `fontList` を付けて `SPARE` を送るので、最初の 1 打にも予備の子がある。
- ページの一覧は、JOB を終えて checkpoint になった子が、15 ms 何も来なくなってから取る（`fk.hints_record`。自分の page table を答える sysctl `vm.self_region_footprint` と `mach_vm_page_range_query`）。page table 全体を歩くので本では 0.1〜0.5 秒かかる。同じ場所（同じ checkpoint 番号）では 10 秒に 1 回までとし、命令が来たら中断する。JOB が**書いた**ページ（予備の子で先に複製を作れば copy-on-write の fault も減る）は調べない。ページごとの記録（`mach_vm_page_info`）を読むと、系統全体が共有する memory object を世代の数だけ lock する。89 世代目の checkpoint では一覧 1 回に 1 秒かかり、その間、同じ文書の JOB・予備の子・RENDER が lock を待って止まった（72 ページの本の数式段落で、紙面が 5 打鍵ぶん動かなかった）。
- 予備の子は checkpoint の状態の写しである。checkpoint が STEP で先へ進むとき、fault 注入を受けたときは捨てる。checkpoint が終われば pipe が閉じて予備の子も終わる。予備の子を持つ pipe の書き口は checkpoint だけが持つ（他の子は fork 直後に閉じる）。
- 読み込んでも JOB がまた読み込む font（package が自分で定義した font。一覧に同じ行が 2 度出る）がある場所では、先読みをやめる（`fk.fonts_put(tag, false)`）。先読み中に TeX の error が出た予備の子は、それ以上読み込まない。
- (4) font を読み込んだあと、予備の子はその checkpoint の直前の打鍵の本文から、TeX が文字（catcode 11・12）と空白として読む文字だけを取り出し（命令・波括弧・`$`・`%`・active 文字は除く）、`\begingroup\globaldefs=-1` の中の捨てる `\vbox` で一度組む（`warm_text`）。LuaTeX-ja の表、node の確保、Lua の文字列が温まる。`\globaldefs=-1` で global な代入も group の終わりで戻り、段落の命令は一つも実行しない。72 ページの本の段落で子の組版 8.4 → 6.0〜6.7 ms、fault 550 → 250。`TDOM_NO_WARM=1` で止める。和文・脚注・label・太字・数式・active 文字を含む段落で、打鍵ごとの galley と終状態が通常の fork と一致することをテストで確かめている。
- `vm.self_region_footprint` の無い環境（古い macOS、Linux）では `fk.hints_init()` が false を返し、従来どおり毎回 fork する。`TDOM_NO_SPARES=1` は全体を、`TDOM_NO_FONT_AHEAD=1` は font の先読みだけを止める。`TDOM_TRACE_JOB=1` では JOB ごとの user / kernel 時間、fault 数、読み込んだ font 名が `[job-gc]` に出る。

実機（packaged beta、389 ページの本の章ウィンドウ、150 ms 間隔の打鍵）: TeX 側の組版 23 → 6 ms、打鍵から紙面まで中央値 48 → 30 ms。

一覧は系統全体で 1 つ（最後に打った段落のもの）である。font の使用を消しても、その段落で打ち続ける間は一覧に残る。予備の子は先読みした font を自分のメモリに持つ（和文 1 書体で 10〜20 MB）。

## 10.4e galley の中の空の罫の送り方

LuaTeX-ja は和文の文字と文字の間に空の罫（`empty_rule`、幅 0）を 1 つずつ置く。daemon はそれを 1 つずつ、engine が「描かれない」と証明するための生の証拠（RuleRunV2: 16 項目。node の属性の一覧 `ra` を含む）付きで送る。和文の段落の galley の bytes の 6 割がこれである（4 行の段落で 45 KB 中 27 KB。文字の run は 15 KB）。1 行の中の罫は場所 `x` と属性の 1 項目（文字クラス）だけが違い、2〜5 種類が交互に並ぶ。

- engine へ送る galley（`jenc_wire`）では、同じ run の一覧の中で先に丸ごと書いた罫と `x` 以外が同じ罫を `{"rq":[j,x]}` と書く（`j` はその一覧の中で丸ごと書いた罫を 0 から数えた番号。直近 8 個から探す）。engine は message を読んだその場で（`peer.js` → `rule-pack.js`）罫を丸ごとに戻す。項目も並びも同じなので、galley の hash、layout witness、証明は丸ごと送ったときと同じになる。`jenc` 自体の bytes（reference encoder と一致）は変えていない。`TDOM_NO_RULE_PACK=1` で全部を丸ごと送る。
- 属性の一覧の署名（`rule_attr_signature`）は、1 回の walk の間、属性 list ごとに覚える（同じ属性の node は list を共有する）。

72 ページの本の 4 行の段落で、送る bytes は 44.6 → 22.9 KB、2 行の地の文で 34.3 → 16.1 KB。子の中の時間は encode で約 0.2 ms、harvest で 0.5〜0.8 ms 減る。罫そのものを daemon で捨てれば約 3 ms 減るが、`stableRunLayoutRecord` が layout witness に空の罫を含めている（`run-semantics.js`）ので捨てない。

## 10.4f 打鍵が続く間は編集 block の RENDER を出さない

組み合わせ表示（docs/09 §9.5a）のできる block を続けて打つと、これまでは打鍵ごとに RENDER を 1 本、JOB と一緒に送っていた（#103 の held。前の 1 本が飛んでいる間は送らない）。絵 1 枚には約 110 ms かかる（子が段落を組んで PDF を出すまで約 70 ms。うち約 50 ms は本文の和文 font を含む 5 書体の埋め込み。pdftocairo と切り出しに 32〜38 ms）。150 ms 間隔の打鍵では次のことが起きていた。

- 絵が次の打鍵に間に合わなくなると（72 ページの本の 4 行の段落で約 2 秒後から）、遅れて届いた絵のためにページが 1 打鍵に 2 回届き、子の仕事が次の打鍵の JOB と重なる（組版 16 → 21〜31 ms）。
- 他の仕事で CPU が埋まっていると、この重なりで打鍵が 2〜3 倍遅くなる。

一方、組み合わせ表示の行は、block 自身の絵が届く前と後で見た目が変わらない（docs/09 §9.5b。本文は glyph、数式は照合済みの絵か字形）。打鍵ごとの絵は、読む人には見えない差し替えのために作っていた。

そこで、次の 2 つを満たす打鍵では、JOB と一緒の RENDER を送らない（`render-pump.js` の `typedInBurst`、`block.renderDeferred`）。

1. 前の打鍵からの間隔が `BURST_GAP_MS`（400 ms。`#jobBlock` が「打鍵が続いている」とみなす境と同じ）以下である。
2. block の直前の galley が組み合わせ表示で見せられていた（`block.composedFor === block.galleyHash`。`stream.js` が行を組み合わせたときに記す）。

- 絵は pump が作る。block の今の galley が組み合わせ表示で見せられている間は、最後の打鍵から `BURST_PAUSE_MS`（450 ms）待つ。打鍵が止まると RENDER が 1 本だけ出て、block 自身の絵が届く。
- 組み合わせられなかった galley（一度も描いていない glyph を数式に打った、など。ページは前の galley を見せていて、打った文字は出ていない）は、update が終わりしだい待たずに描く（`deferredRenderQuietMs` が 0）。次の打鍵は 2 を満たさないので、従来どおり JOB と一緒に RENDER を送る。
- 止まった後の最初の 1 打、間隔が 400 ms を超える打鍵、組み合わせ表示のできない block（図・box・float・脚注・rescue）は、従来どおりである。
- 紙面の上で editor が開いている間も従来どおりである。その editor（`web/app.js` の `provisionalStageKeepsEditor`）は、数式の位置を block 自身の絵で確かめるので、前の絵からの切り出しを見せるページを commit しない。表示側が絵の glyph の位置（`/chunk-glyphs`）を読むのは、この editor が開いているときと、それを開く click のときだけなので、server はその読み出しを engine に伝える（`notePaperEditor`）。そこから `PAPER_EDITOR_MS`（30 秒）の間は、どの打鍵も RENDER を送り、待たせてあった絵もすぐ描く。
- `composedFor` は、block がその場で編集されたときだけ次の block object へ引き継ぐ（`segmenter.js` の `diffBlocks`。`exactHistory` と同じ条件）。
- 手元の絵の galley は `exactHistory` に残り続ける（`holdExactGalley` は描かれた galley を捨てない）。打鍵が続く間、切り出しの元は打ち始めの絵のままである。
- `TDOM_RENDER_EVERY_KEY=1` で従来の動作に戻る。`TDOM_BURST_GAP_MS` と `TDOM_BURST_PAUSE_MS` で境と待ち時間を変えられる。`renderStats.burstSkipped`（RENDER を送らなかった打鍵）と `renderStats.afterBurst`（pump が後から作った絵）で数えられる。

実機（packaged beta、72 ページの本、150 ms 間隔で 30 打鍵、打った文字が紙面に出るまでの中央値。同じ build で `TDOM_RENDER_EVERY_KEY=1` と交互に 2 往復）:

- 4 行の段落の行末: 従来 45 ms（28/30 打鍵）と 53 ms（30/30） → 27 ms と 28 ms（どちらも 30/30）。16 打鍵目からの遅れが無くなった。
- 数式の中: 従来 45 ms（30/30）と 69 ms（28/30） → 31 ms と 31 ms（どちらも 30/30）。
- 章ウィンドウ（389 ページの本）の数式の中: 従来 31 ms と 29 ms → 26 ms と 28 ms（どれも 30/30）。
- 30 打鍵の間に送る RENDER は 30 本 → 1〜2 本、止まった後に 1 本。
- 紙面の上の editor を開いたまま、その数式へ 150 ms 間隔で 12 打鍵（1 ページの文書。打鍵は source の側から入れた）: RENDER を送らなかった打鍵は 0 で、`TDOM_RENDER_EVERY_KEY=1` のときと同じく 1 打鍵に 1 本。editor を開かずに同じ打鍵をすると、字形の揃った 9 打鍵目から送らない。
- 30 打鍵目の画面（組み合わせ表示）と、止まって block 自身の絵が届いた後の画面の差は、段落の範囲で 91 画素（40/255 以上。2560×1640 の画面）。

## 10.4g 打鍵のたびに文書やページの全体へ触れていた処理

1 文字の打鍵でも、文書の長さやページの文字数に比例する仕事が 2 つ残っていた。どちらも 1 ファイル 30 ページの文書（和文の地の文。1 ページ 1,470 command、195 KB）で見つけた。

- **shipping chain への問い合わせ**（`ship-pacing.js` の `deferShipUpdate`）: 表示できる打鍵の replay は打鍵が止まるまで持っておく。持っている間に次の打鍵が来ると、chain に「今の source は chain の source と 1 unit しか違わないか」を尋ねていた（`replayableFrom`）。chain はそのために root の source 全体を unit に切り直す（30 ページで 2.5 ms。ページ数に比例する）。1 ファイルの文書では、これが打鍵ごとに走っていた。持っている打鍵と同じ block をその場で変えただけの打鍵（block の追加・削除・分割・結合が無く、間に別の revision も無い）では尋ねない。engine は update ごとに「その場で変えた 1 つの block」の id を渡す（`#updateInner` の `editedInPlace`）。尋ねなくても正しさは変わらない。持っていた text を replay するとき `resume()` が unit を切って比べ直し、2 つ以上違えば reboot を求める。`TDOM_SHIP_CHECK_EVERY_KEY=1` で毎回尋ねる。
- **ページの display list**（`display-list.js`）: 打鍵のあったページは毎回 command を全部作り直し、ページ全体の JSON を hash していた。変わるのは 1〜2 行である。glyph と罫だけの行の command は行（`stream.js` が block ごとに持つ unit）に付けて覚え、同じ場所に立っている間はそのまま使う（`LINE_COMMANDS`）。ページの hash は command ごとの hash（command に付けて覚える）をつないだものにした。内容だけで決まる点は同じで、新しい command だけを直列化する。font の表は行の下で変わらない（family の降格は全 block の行を作り直す）。`TDOM_NO_LINE_REUSE=1` で従来どおり全部作る。

engine だけで測ると、この文書の打鍵の paginate は 3.5 ms → 1.1 ms（同じ負荷で交互に 2 往復）。実機（packaged beta、150 ms 間隔で 30 打鍵、同じ build で交互に 2 往復）では、打った文字が紙面に出るまで 29 ms と 34 ms → 26 ms と 25 ms、engine の時間は 15〜18 ms → 12 ms。

## 10.4h 紙面の差し替え：変わっていない行の要素を残す

viewer（`web/app.js`）は、打鍵のあったページの SVG を毎回まるごと作り、古い SVG と入れ替えていた。変わるのは 1〜2 行でも、browser はページの全要素を作り直し、配置し直し、描き直す。和文の密なページ（1 文字 1 要素で約 1,500 要素）では、入れ替えのあとの layout が 1 打鍵に 13〜18 ms かかっていた（viewer の profile。入れ替えの時刻より後なので、「紙面に出るまで」の計測には入っていなかった）。TeX が段落を組む時間より長い。

- ページの SVG は「開始 tag、SVG に描く command 1 つにつき 1 要素、終了 tag」の列として作る（`svgParts`）。commit したページはこの列を覚える（`div.provisionalSvgParts`）。SVG の子はこの列の順に並び、ほかに子を足したり消したりする code は無い。
- 次のページを stage するとき、列の先頭と末尾で前のページと同じ部分を数え（`svgPartsCut`）、**違う部分だけ**を HTML として解析する。commit では、古い SVG をそのまま残し、違う部分の要素だけを入れ替える（`spliceSvgChildren`）。同じ列なら同じ要素である。要素を作ったあとに変わるのは font の読み込み待ちの印だけで、比較からは外す。
- stage のあとでページが別のものに替わっていたら（stage が比べた列と commit 済みの列が違う）、commit の時に SVG 全体を作って比べ直す（`patchProvisionalSvg`）。用紙が違う、子の数が列と合わない、などのときは従来どおりまるごと入れ替える。chunk の窓（`<div class="chunkwin">`）は従来どおり毎回作り直す。
- `globalThis.__tdomWholePageCommit = true` で、従来どおり全体を作って入れ替える。

実機（packaged beta、1 ファイル 30 ページの文書の密なページ、150 ms 間隔で 30 打鍵）:

- viewer の 1 打鍵あたりの時間: 入れ替え後の layout 13.2 ms → 0.03 ms、stage（HTML の解析）4.3 ms → 1.0 ms、受信から commit まで 5.3 ms → 1.9 ms。
- 打った文字の commit まで（中央値）: 26 ms → 18 ms。その変更を含む描画 frame が終わるまで（変更の 2 frame 後の `requestAnimationFrame`）: 46 ms → 28 ms。
- 30 打鍵のあと、ページの SVG は同じ列から作り直した SVG と一致する（`outerHTML` の比較）。

## 10.4i 1 ファイルの長い文書で打鍵のたびに全文へ触れていた処理

1 ファイル 2,600 段落（191 ページ、826 KB）の文書を packaged app の engine の CPU profile で見ると、1 文字の打鍵で source 全体を読む処理が並んでいた（章ごとの file に分かれた本では root が小さいので目立たない）。

- **local な alias の走査**（`structural-aliases.js` の `maskIgnored`・`collectDefinitions`・`usedStructuralAliases`）: 3 つとも source を 1 文字ずつ進んでいたが、何かをするのは `\`（mask では `%` も）の位置だけである。次の `\` まで `indexOf` で飛ぶ。sink に届く定義が文書に 1 つも無ければ、use の走査はしない（use を記録するのはそういう定義だけ）。結果は変わらない: 手元の TeX source 692 個と TeX Live の package・文書 676 個（15.5 MB）で、前の実装と 4,104 通りの結果がすべて一致。6.7 ms → 約 1 ms。
- **canonical の source hash**（`canonical.js` の `schedule`）: 「直前の generation はこの text の compile か」「走っている job はこの text のものか」を確かめるために、root の全文の hash を打鍵ごとに 2 回取っていた（4.3 ms）。hash と一緒に text の長さを覚え、長さが違えば hash を取らずに「違う」と答える。走っている job・失敗した job の revision が今の revision でなければ、そもそも尋ねない。
- **打鍵のあったページの近くの block 探し**（`update-helpers.js` の `editPageRenderIds`）: 全ページの全行から配列を 2 つずつ作っていた（1.8 ms）。該当する block のあるページだけ配列を作る。
- **source の text の送り方**（`server.js` の `serializeDom`・`domDeltaBody`、`web/app.js` の `applySnapshotDelta`）: snapshot は source file の全文を持つ。打鍵のたびに全 file の text を JSON にし、打った file は全文を viewer へ送っていた（この文書で 29 万字、event は 578 KB）。text が前と同じ file は前の JSON を使い、変わった file は「どこから何文字消して何を入れるか」（`engine/text-splice.js` の `textSplice`）だけを送る。viewer は持っている text に当てはめ、当てはめられなければ snapshot 全体を取り直す。`TDOM_NO_SOURCE_SPLICE=1` で全文を送る。

実機（この文書の中ほどで 150 ms 間隔 30 打鍵）: engine 21.5 ms → 14〜15 ms、打った文字の commit まで 44 ms → 35 ms（§3.5a の修正の前は、ページ数の食い違いで resident のページが出ず 0/30）。このとき残っていた snapshot の作成（`dom` 段 6〜7 ms: 打った位置より後の block は root の中の offset が動くので、1,300 個の entry を作り直して比べていた）は §10.4k で外した。

## 10.4j overlay の file を打鍵のたびに読み直さない

保存していない editor の内容は overlay の file として TeX へ渡る。overlay は server が書き直すたびに変わり、書かれた時刻だけでは「変わっていない」と言えない（時刻の刻みが粗い filesystem では、同じ刻みの中の 2 回の書き込みが同じ時刻になる）ので、展開のたびに毎回読んでいた（`mapped-inputs.js`・`include-expander.js`）。本の 1 章だけを live にする host は残りの章を空の overlay で送るので、打鍵のたびに約 40 個の file を読んでいた（packaged app の engine の profile で 1.0〜1.5 ms）。file を読む block（`\input`・`\include` の行）は、中身の同一性のためにもう一度読んで hash していた。

- overlay は、読んだときと同じ時刻・同じ大きさで、**読んだ時点ですでに `OVERLAY_REST_MS`（3 秒）以上書かれていなかった**ものだけ cache から取る（`include-cache.js` の `includeTextCurrent`、cache の `settled`）。読んだ後の書き込みは、その時刻より新しい時刻を必ず持つ。書かれたばかりの overlay（打っている章）は従来どおり毎回読む。project 自身の file の規則（書かれた時刻）は変えていない。
- 中身の hash は、直前の展開が読んだ（または持っている）text から 1 度だけ取る（`overlayContentSig`）。file の時刻か大きさが違えば読む。
- `TDOM_READ_OVERLAYS_ALWAYS=1` で毎回読む。

章ウィンドウの打鍵で、engine の `readFileSync` は 1.0 → 0.36 ms、`prepareUpdate` は 3.1 → 2.75 ms（同じ build で交互に 1 往復）。

## 10.4k snapshot：動いただけの block を作り直さない・送らない

打鍵のたびに viewer へ届く snapshot（source map）は、block ごとの entry の列である。1 ファイルの文書では、打った位置より後の block はすべて root の中の offset が動く。191 ページ・2,600 block の文書の中ほどで 1 文字打つと、engine は 1,300 個の entry を作り直し、server はそれを JSON にして前の版と比べ、viewer へ 86 KB 送っていた。改行を 1 つ打つと、後ろの block は行番号も変わるので 1,300 個が丸ごと送られた（0.9 MB）。

- **entry は core と place に分かれる**（`inspector.js` の `buildDomSnapshot`）。core は block が何であるか（種類、図、source の行と桁、label、edit region）、place は block がどこにあるか（列の中の番号、載っているページ、root の中の offset）。core が前のままかどうかは、作り直さずに確かめる: block が持つ object（galley、fidelity、edit region の list、text）が同じで、行と桁が root の行頭表（`SourceStore.lineStarts`）に照らして同じなら、前の core である。place だけが動いた block の entry は、前の entry と core の部品をすべて共有する新しい object になり、`domEntriesDifferInPlaceOnly` が中身を読まずにそう判定できる。複数の file にまたがる block、`\maketitle` を持つ block（前付の region が付く）は従来どおり毎回作る。
- **行だけがずれた block**（上に行が増えた・減った）。core を前の core から作る: source と edit region の行だけを動かした複製で、残りの部品は共有する。何行ずれたかは core の `source` をさかのぼれば分かる（`domEntryLinesMovedBy`。viewer が数版前の snapshot を持っていても足し合わせる）。
- **block の載っているページ**（`pagesOfBlocks`）。全ページの全行（この文書で 7,800 行）を毎回読んでいた。engine の memo に置き、行の list が別の object になったページ（打鍵 1 回で 1 ページ）だけを読み直して、そのページの block の list だけを作り替える。渡した list は書き換えない（前の snapshot の entry が持っている）。ページ番号が昇順でない紙面は毎回読む。
- **送り方**（`server.js` の `domDeltaBody`、`web/app.js` の `applySnapshotDelta`）。送るまで何も JSON にしない（全文の JSON は、前の版を持たない viewer に全体を送るときだけ作る）。block の列は「前の列の先頭 `head` 個、名前を挙げた block、末尾 `tail` 個」（`cut`）で表し、block は名前ではなく位置で指す。丸ごと送る block は `blocks` と位置の `at`。同じだけ動いた block の並びは 1 つの run にまとめる: `shift` は `[from, to, by, places]`（root の中の offset が `by` 文字、列の番号が `places` だけ先）、`lines` は `[from, to, down]`（行が `down` 行だけ下）。ページが変わった block は 1 個ずつ（`moved`、位置で指す）。viewer は持っている snapshot に当てはめ、どれか 1 つでも当てはまらなければ全体を取り直す。core から作っていない entry（`.bbl` の block など）は、従来どおり JSON で比べる。
- `SourceStore` の行頭表は、edit のたびに全文を 1 文字ずつ見て作っていた。行末から次の行末へ `indexOf` で進む。

engine と server・viewer の該当 code だけを通した計測（上の文書の中ほど、12 打鍵の中央値）:

| 打鍵 | server 側（snapshot を作って差分にする） | viewer 側（読んで当てはめる） | 送る量 |
|---|---|---|---|
| 1 文字 | 11.1 → 1.7 ms | 1.0 → 0.14 ms | 86 KB → 1.5 KB |
| 改行 1 つ | 13.6 → 3.6 ms | 3.8 → 0.5 ms | 895 KB → 0.9 KB |
| 新しい段落 | 3.0 ms | 0.3 ms | 6.2 KB |

3 種類の打鍵とも、viewer が当てはめた snapshot・server の snapshot・何も覚えていない状態から作った snapshot が、block ごとに一致する（JSON の byte まで）。

## 10.4l event stream：ページの描画命令を変更として送る

update の event は、触れたページの display list を丸ごと運ぶ。打鍵で変わるのは 1〜2 行なのに、密なページ（72 ページの本の 1 ページで 2,000 命令、約 200 KB）では、打鍵のたびに全命令を JSON にして stream へ書き、viewer が読んで parse し、全命令の要素（SVG の断片）を書き出していた。engine が update を返してから viewer に event が届くまでが、普通のページより 3〜4 ms 長かった。

- **命令の JSON は命令と一緒に持つ**（`server.js` の `jsonOfCommand`）。命令は list が作られた後は変わらない（変わらなかった行の命令は build をまたいで同じ object: §10.4g）ので、JSON にするのは新しい命令だけになる。
- **stream ごとの差分**（`cutAtLists`・`broadcastAtLists`・`streamListJson`）。`/events?lists=cut` で開いた stream について、server はページごとに「その stream へ最後に送った list」を覚える。次にそのページの list を送るときは、先頭から一致する命令（`head` 個）と末尾から一致する命令（`tail` 個）を省き、間の命令だけを `{n, base, of, head, tail, mid}` として list の位置に入れる（`base` は基準の list の番号、`of` はその命令数、`n` はこの list の番号）。その stream で初めてのページは `{n, all}`。一致は object の同一性で見て、違う object は JSON で比べる。
- **食い違いが起きない理由**。基準は「同じ stream に、順に流したもの」だけで、`/doc` など stream の外で渡した list は基準にしない。viewer は event を parse した直後、その event を表示に使うかどうかに関係なく list を組み立てて覚える（`web/app.js` の `resolveStreamLists`）。stream が接続し直されたら両側とも空から始める。それでも当てはまらない list が来たら（`base`・`of` が合わない）、viewer は stream を取り直して文書を読み直す。
- **viewer の要素**。組み立てた list の先頭と末尾の命令は、viewer が持っている object そのものである。命令の要素も命令と一緒に持ち（`pieceOfCommand`。要素が命令の外に依存するのは font が届いたかどうかだけ）、変わらなかった行の要素は書き出さない。
- stream を自分で読むほかの client（test、`lists=cut` を付けない接続）と、`/edit` の応答の report は、従来どおりの list を受け取る。`TDOM_LISTS_WHOLE=1` で全 client に従来の list を送る。

`tests/server-api.test.js` は、cut の stream と通常の stream を同時に開いて打鍵し、cut の stream を viewer の code で組み立てた event が通常の stream の event と一致することを確かめる。要素の文字列は、実ページ 96 回分（128,682 命令、font が届く前・途中・後）で前の実装と一致した。

## 10.4m 打ち始めの 1 打鍵：同じ galley を受け取り直しても units を捨てない

block の units（`units.js`。page builder が並べるもので、units が同じ object であることが「そのページは変わっていない」の根拠になる）は、galley を adopt するたびに捨てて作り直していた（`galley-adoption.js`）。打鍵の後、engine は打った block から先を組み直して checkpoint を作り直す。開いた直後も同じである。その walk が通った block は、**前と同じ中身の galley** を受け取り直すだけなのに units が別の object になり、次の pagination は「そこから先のページが全部変わった」と見て、ページを組み直し、display list を作り直していた。払うのは次の打鍵、つまり打ち始めの 1 打鍵である。

- 191 ページ・2,600 block の 1 ファイル文書: 開いた後の最初の打鍵の前に 2,491 block、3 秒休んだ後の打鍵の前に 1,150 block の units が入れ替わっていて、その打鍵は 184 ページ・92 ページを作り直した（engine だけの計測で `paginate` 段 361 ms・167 ms。続く打鍵は 1〜2 ms）。packaged app の同じ文書では最初の打鍵の `paginate` が 64 ms。
- 10 ページの文書でも、最初の打鍵が 10 ページ中 6 ページを作り直していた。

`adoptGalleyBlock` は、adopt した galley が units の元になった galley と同じ（hash が同じ）で、`stream.js` の `buildStream` が読むほかのもの（fidelity の中身、rescued・gfx・needsRender、galley の backend、自分の絵が届いているかどうか）も変わっていなければ、units をそのまま残す（`unitsStillHold`）。絵が前の galley のもののまま（`buildStream` が毎回「何で代えるか」を決め直す場合）、組み立てた絵（synth）が残っている場合、rescue の chunk を持ってきた galley、stale のまま持ち越した galley、paint 待ち・cold preview の galley は、従来どおり作り直す。`TDOM_REBUILD_UNITS_ALWAYS=1` で毎回捨てる。

上の 191 ページの文書で、最初の打鍵・休んだ後の打鍵とも、作り直すのは打った段落のある 1 ページだけになった（`paginate` 2.3 ms・1.7 ms）。`tests/units-kept.test.js` は、開いた直後と休んだ後の打鍵が段落のあるページだけを差し替えること、できあがったページが開き直した engine のページと一致することを確かめる（`TDOM_REBUILD_UNITS_ALWAYS=1` では落ちる）。

## 10.4n 後ろのページを全部動かす打鍵：近いページだけ先に、残りは小分けで

段落が 1 行増える（減る）打鍵は、その後ろの改ページすべてをまたいで 1 行ずつ送る。改ページを強制するもの（章の切れ目など）に当たるまで、後ろのページは全部変わる。191 ページ・2,600 段落の 1 つの流れの中ほどでは 96 ページである。ここに 3 つの問題が重なっていた。

- **engine**: その打鍵の中で 96 ページの display list を作っていた（`paginate` 段 150〜190 ms。打鍵に答える thread の上）。
- **server**: 96 ページの list を 1 つの event（18 MB）で送っていた。event stream は 1 client あたり 8 MB より多く溜めると接続を切る（`SSE_MAX_BUFFER`。止まった client のために溜め続けないための上限）。この event はそれを超えるので、**viewer の stream が切られ、EventSource が繋ぎ直すまでの約 3 秒、どの打鍵も紙面に出なかった**（packaged app、70 打鍵のうち行が増えた打鍵から 20 打鍵）。切られた event の中身（後ろのページ）は viewer に届かないままだった。
- **viewer**: 届いたページは見えていなくても全部組み立てていた（markup、parse、差し替え、browser の layout）。stage は revision ごとのものなので、commit されるまでは打鍵のたびに作り直してもいた。

直したのは 2 か所である。

- **1 回の update が作る display list は、編集位置に近い 4 ページまで**（`page-patches.js` の `buildPagePatches` の `limit`、`EAGER_PAGES`）。残りのページは「owed」として、viewer が今その番号のページに何を表示しているか（最後に送った list の hash）だけを覚える。engine は打鍵の合間に 4 ページずつ作って async の経路（`kind: 'patches'`）で送る（`engine-v3.js` の `#pumpOwedPages`。直前の編集位置に近いページから。update が走っている間は待つ）。owed のページは、後から作った list が viewer の表示と同じなら送らない。次の打鍵は自分のページだけを作り、まだ owed のページは pump に任せる。headers が全ページで変わったとき・async の到着が後ろを全部動かしたとき（`async-repaginate.js`）も同じ扱いになる。boot は従来どおり全ページを一度に作る。`getDisplayLists()`（`/doc`）は owed のページの list もその場で作って返す。`TDOM_EAGER_PAGES=0` で従来どおり全部一度に、`=<n>` で枚数を変える。
- **viewer は、4 ページ以上を組み立てる update では、pane に近くないページを組み立てない**（`web/app.js` の `renderPage` の `mayDefer`、`nearSight`）。見えているページから 2 ページより遠く、すでに何かを表示しているページは、中身を持たない stage になる。commit にとっては「見えていない、まだ ready でないページ」で、何とも結ばれず、今の表示を保つ（§4.5 の `away`。exact pixel を待つ見えないページと同じ）。scroll・resize で pane に近づいたら、後回しにした list で組み立てる（`stageDeferredNearSight`）。canonical のページが先に届けば組み立てない。何も表示していないページ（文書の最初の表示）は従来どおり全部組み立てる。`globalThis.__tdomStageAllPages = true` で常に全部。

engine だけの計測（上の文書、行が増える打鍵）: 223 ms → 39〜44 ms（`paginate` 193 → 10〜11 ms）、その打鍵の report は 17.9 MB → 0.75 MB。残りの 92 ページは 23 回の event（最大 0.77 MB）に分かれ、打鍵の 0.3〜0.4 秒後までに届く。届いた list を順に当てはめた結果は、engine の全ページの list と一致する。`tests/owed-pages.test.js` は `buildPagePatches` の規則を場合ごとに確かめ、TeX を通して「打鍵の応答は近い 4 ページ、残りは後から、全ページが届く、開き直した engine のページと行が一致する」を確かめる。`tests/deferred-pages.test.js` は viewer 自身の stage・commit の code で、近いページだけが組み立てられ、後回しのページが表示を保ち、近づくと組み立てられることを確かめる。

## 10.5 definition edit

body block の `\def`、`\newcommand`、`\renewcommand`、`\let`、`\newenvironment`、`\newcounter`、`\setlength`、`\catcode`、`\pagestyle` などは、下流 block の意味を state vector だけでは追えない可能性がある。

そのため、編集 window の旧 text/new text に definition-bearing token がある場合、suffix trust は forfeited になり、verdict は `leak` 側へ寄る。rebuild は async chain に送られる。

## 10.6 deferred chain

`#queueChainWork(kind, from, labels, queuedAt, through = from)` は `settle` または `rebuild` を `pendingChain` に登録する。

| kind | 内容 |
| --- | --- |
| `settle` | counter などの動いた exit state を下流へ追い、clean block で一致したら止まる |
| `rebuild` | suffix を信用せず、下流を serial に再組版する |

`#scheduleBackground()` は、編集後 300ms の idle gate、または最初の登録から `TDOM_CHAIN_MAX_STALE`（既定2000ms）の期限を待って `#runChainPass()` を lock 内で走らせる。登録時刻 `queuedAt` は仕事の合流・中断・cold carry の再登録でも引き継ぐ。期限を過ぎた仕事は打鍵間の空き時間で再開し、新しい打鍵による preemption と lock の優先順位は維持する。期限は開始の待機上限で、伝播全体の完了時間ではない。最低優先の grid 充填には期限を適用しない。次の編集が来ると `bgAbort` で止まり、進捗位置から後で再開する。最後の round の後に仕事が残り、pass が前に進んでいれば（grid は境界を実体化した数で見る）、同じ gate の後ろで次の task を走らせる（無操作のまま 8 回まで）。進んでいない grid の計画は捨て、次の予約で `gridMissing` から立て直す（以前は残った仕事を次の編集まで誰も走らせず、chain を待つ呼び出しが止まった）。

settle は再開位置 `from` に加え、合流した伝播の最も後ろの未検証位置 `through` を保持する。新しい仕事との合流では `from` の最小値と `through` の最大値を残し、両方を編集による index 変更と cold carry に引き継ぐ。収束は両位置を通過してから判定する。早い位置で再現できた clean block だけでは、離れた後続の伝播が完了した証拠にならない。`from` の境界が退役していると pass はその手前の checkpoint から再生するが、そこで galley と exit state が一致しても、foreground が更新済みの block を再現しただけで、動いた state が収まった証拠にはならない（cold resume が何度か走ると、その pin が `editHold` から押し出されて起きる）。

`settle` / `rebuild` の blocks phase は `from` の continuation を所有し、cap と off-grid 回収の両方から保護する（`propagationCheckpointHold`）。Shipping 有効時は共有予算の optional coverage を先に減らし、無効時は既存の grid・edit/render hold に追加して保持する。次の編集がページ内の境界で `editHold` の 8 枠を埋めても、この所有権は残る。数値の `from` だけを保存すると、その continuation の回収後は古い grid 境界から同じ区間を再生する。低い ceiling で打鍵間に次の grid 境界まで届かない場合、この再生が入力停止まで繰り返されていた。再生途中で中断し `from` を手前へ戻すときは、元の `from` を `through` にも残す。更新済みの prefix を再現しただけで未検証の suffix まで収束したと判定しないためである。打鍵による JOB の中断と lock の優先順位は変わらない。

label が動いた伝播中に CAPTURE 可能な block の exact chunk が古い／未作成なら、`work.render` に block id・galley hash・入口境界を記録し、入口と出口を保持する。既存 render pump の `propagation` 項目は idle gate と通常の編集 cohort の待機を通らず、既存の並列数制限内で先に処理する。chain は 5ms ごとに中断を確認しながらその項目を待ち、次の打鍵が中断したら同じ所有者から再開する。CAPTURE が中断され RENDER へ戻る場合も、galley の JOB が使った volatile state・label 定義を含む prelude を再利用する。入口も出口も先に回収してしまうと、番号を更新した galley の画素が「入力停止から 3 秒後」の isolated render に回っていた。すでに foreground が galley を更新した block も、画素が古ければこの対象になる。

## 10.7 references と toc

label が動いたとき、後方で定義された label を前方 block が参照していることがある。foreground 中に `pendingChain` が無ければ、ref index から候補 block を取り、必要なものだけ再組版する。

`toc` は provisional pagination から `.toc` 内容を合成し、hash が動けば toc consumer block を再組版する。最大 3 pass である。chain work が pending のときは、`#chainAfterPass()` 側で同じ処理を行う。編集（boot・reboot・retry 以外）で目次が動いたときは、編集した block の載るページに目次が無ければ、この場で組み直さず `engine.tocOwed` を立てる（`deferToc`）。scheduler は打鍵が止まって quiet gate を過ぎてから目次の block から settle を積み、`#chainAfterPass()` が同じ固定点を回して公開する。すぐ積まないのは、編集 block より前から始まる chain work が pending だと、以後の打鍵が prose keystroke として扱われず、後ろの block の検証を待ってから見せることになるため。非同期の再ページ割りが見つけた目次のずれも同じく owed にする。`#chainAfterPass()` は目次の block を組み直し終えてから `tocHash` を更新する（途中で打鍵に止められたら、次の pass がもう一度組む）。打鍵が止まって積まれた目次だけの settle（`tocOnly`）は、終わる前に打鍵が来れば owed に戻す（積まれたままだと、以後の打鍵はまた後ろの段落の検証を待つ）。打鍵が続いている間（最後の打鍵から 300 ms 以内）に期限切れで始まった pass も、目次は組まずに owed にして残す（目次の組み直しは本で 0.5 s かかり、打鍵の合間ごとに始まっては次の打鍵に止められていた）。prose keystroke の判定は、labels の無い after 段の settle（残りは目次だけで、`plainBlockId` が残っていれば後ろの段落は変わらなかった）を妨げにしない。72 ページの本で行が 1 行増える打鍵は、見出しが次のページへ移って目次の組み直しに 0.5〜3.7 s かかり、後ろの打鍵もそれを待っていた。

## 10.7a 柱とノンブルの job が届いたとき

見出しが別のページへ移る、ページ数が変わる、といった編集のあとは、柱とノンブルを組む job（`header-scheduler.js`）が走り、届くと `asyncRepaginate` が display list を作り直す。作り直すのは、**そのページ自身の柱・ノンブルが変わったページだけ**である（`header-footer.js` の `pageHfSig`。ページの display list は `dl.hfSig` に自分のページの entry の署名を持ち、`buildPagePatches` はそれが変わったページだけを組み直す）。

以前は map 全体の署名で比べていたため、job が届くたびに全ページの display list を、打鍵を受けるスレッドの上で一度に作り直していた（72 ページの本で 20〜45 ms。柱が変わったのは数ページ）。段落に 1 行足す打鍵のたびに起きる。最初の job（open 直後。全ページが仮のノンブルから本物の柱へ変わる）は今も全ページを作り直す。

## 10.8 page-context rescue

非同期 rescue の採択で後続の galley が変わった場合、その block の exact render も再予約する。旧 galley の描画が先に完了していても、修正された段落・数式・脚注の chunk を現在の galley 世代で作り直す。

`mdframed` や breakable `tcolorbox` のような block は、page 上の offset によって分割結果が変わることがある。

現行実装は foreground で長い re-rescue chain を走らせない。`#queueMovedOffsets()` が offset 差分を見て rescue queue に積み、exact pipeline が async に fixed point へ近づける。表示中は stale galley/chunk と canonical overlay が残る。

rescue pump は一度に一件だけ処理する。編集・caret の対象ページの rescue は quiet gate を通らず、foreground 完了と caret focus の更新で待機を即座に解除する（`rescue-scheduling.js`）。起床後に対象 id と最新の cache key を読み直し、待機中の編集や別 block の cold resume があれば再び譲る。backlog は従来の800ms（有効な shipping baseline があれば shipping 優先窓）を保持する。200ms の poll は通知のない状態変更のための上限であり、編集完了後に必ず払う待ち時間ではない。

multicols の内側は段落や textbox ごとに分割せず、一つの layout block として実 output routine で組み直す。この rescue は resident RENDER の120ms gate、isolated **render** の3秒 gateとは別経路である。救済PDFが完了した後の SVG 変換は `iso-pages.js` の2レーンで処理し、全ページが揃ってから従来どおり galley/chunk を採択する。変換失敗時も実行中のもう一件を待ってから失敗を返すため、cold retry やディレクトリ削除と競合しない。ページ数によらず converter は最大2本、ISO組版は直列のままである。

real-output root は接続を通知する前に、その sibling 内の捨てる box で標準の `large`・`Large` の roman/sans/bold を準備する。ISO child が毎回見出し用フォントを初期化する費用を起動時へ移す。通常の resident checkpoint はこの準備を通らず、font attribute の識別子も従来どおりである。root の前文・寿命・保持数は変えず、本文の箱・counter・label・列幅を再利用する機構ではない。`TDOM_ISO_FONT_WARM=0` で停止できる。

ISO の `DONE` は `stop_run` で stdio を flush してから送る。`finish_pdffile` は font stream と EOF の生成より前なので完了通知には使わない。受信側の EOF 検査は残すが、正常終了では25msのreadiness pollを待たない。

複数ページの救済PDFは、`iso-page-cache.js` が `qpdf` のJSONからページごとの完全な描画入力を照合する。内容streamだけでなく、font本体、image、form、継承されたresources・用紙寸法・crop・rotationと、その間接参照先をSHA-256に含める。counter・label・列幅・fontの変更は、今回LuaLaTeXが生成したPDFの変化として判定する。任意のTeX状態から未変更を推測しない。未知のcatalog機能、循環・欠損参照、解析の上限超過、`qpdf`不在・失敗は全ページ変換へ戻る。再利用するのは同じページ番号のSVG bytesだけで、今回のPDF・編集座標・galleyと完成bundleの採択は従来どおり更新する。

cache はengineごとに最大8MiB・64ページで、終了時に解放する。`TDOM_ISO_PAGE_CACHE=0` は無効化、`TDOM_ISO_PAGE_CACHE_VERIFY=1` はcache hitも再変換し、全SVG bytesの一致を検査する。`tools/bench-rescue-latency.mjs` は変換数・cache hit/miss・DONE時のEOFを記録し、`--import ./tools/profile-iso.mjs` は計測専用の環境・font・shipout別wall/CPU/heap標本を残す。

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

- pending chain があれば idle または伝播の待機期限後に chain pass を走らせる。
- 編集した source block と同じページの exact block は、foreground walk の前に input/capture 境界を最大8個保持する。walk 後にも未変更の exact neighbor を描画 queue に加える。boot で queue に入らなかった render hold と、描画済みの hold は通常の checkpoint 上限へ戻し、保持を再作成しない。
- dirty block 数が `TDOM_RENDER_HOT_MAX` 以下なら、needsRender な hot block を resident exact-render queue に積む。display math と native closure 済みの graphics（float/insert/eject を含まないもの）は foreground JOB の node list を post-block checkpoint に世代付きで保持し、queue 側は CAPTURE を先に試す。これにより block source の二重組版を避ける。保持 list が退役・世代不一致なら、pre-block checkpoint の従来 RENDER へ自動 fallback する。
- resident の PDF descriptor は boot で読み書き可能にし、各 JOB/CAPTURE/RENDER/ISO fork の直前に現在の bytes と位置を匿名ファイルへ複製する。子だけが複製先を継続し、出力時に専用 job directory へ移す。TikZ/hyperref が先に PDF object を作っていても cold compile は不要。装飾は過去画像を再利用せず、その編集で組版した node list を ship する。graphics の chunk identity には source hash も含め、寸法を変えない色・underlay 編集でも再描画する。エラーで凍結した galley は以前の paint identity を維持する。
- exact chunk の ship は、galley 抽出と同じく前ブロックの lastskip primer と最上位 topskip を除く。RENDER と isolated fallback も前ブロックの lastskip を復元してから組版するため、余白の max-merge と SVG の原点・高さが foreground JOB に一致する。
- 通常編集の foreground で変わった bounded hot 集合には現在の `srcRev` を付け、後着の cold queue より先に、最終編集から `TDOM_RENDER_QUIET_MS`（既定120ms）後に処理する。編集中の block だけでなく、同じ紙面の一括表示に必要な隣接 block も含める。boot/reboot・過去世代・deferred chain は、有効な shipping baseline がある場合の優先時間（既定900ms）を維持し、現世代 hot への後着 background enqueue は優先度を落とさない。
- 新しい編集は、前の edit/boot が残した resident render 子プロセスを preempt し、未着手 queue は保持する。preempt した render の block も queue に戻す（優先印なし）。現在の編集の cohort の render が走っている間、backlog の render は始めない。旧世代の優先印は失効し、同時実行数（既定2）と checkpoint の上限は変えない。render fork は foreground JOB と衝突しない固有 request id で追跡する。

display list は本文 glyph と行単位の exact chunk を別素材として保持する。stale chunk・未取得の exact 素材・透明な math run が残る場合、ビューアはその新しいページ群を公開せず、直前の完成した紙面を保持する。fresh chunk は exact 判定された連続行だけの window にし、安全な散文行や `\texttt` / `\textit` は glyph のまま使う。全素材・文字座標・ソース範囲が揃ってから、影響するページ群を取引ごとに同時に提示する（取引の範囲は docs/04 §4.5）。MathLiveによる別フォントの数式描画で補わない。

各 edit report と async patch は、その時点の font manifest を page patch と同時に送る。client は新しい `@font-face` を登録し、face の decode が完了するまでページ群の提示を待つ。画面外の準備中に該当 run が透明でも、表示中の完成ページは保持する。

`canonical.schedule()` は source/rev を保存して timer を張るだけで、full `lualatex` compile は edit response を待たせない。完成した provisional 面を提示できる structured モードでは、初回だけ `debounceMs`（既定2500ms）で baseline を取得し、以降は最終編集後の `idleMs`（既定30s）か、正本に未反映の最古の編集から `maxStaleMs`（`TDOM_CANON_MAX_STALE`、既定20s）の早い方で予約する。いずれもコスト比例 cooldown（factor 2、cap 600s）を満たしてから開始する。20s は通常の打鍵ごとの再コンパイルを避けつつ、連続編集でも番号・参照・目次の更新機会を確保する間隔である。長い compile では cooldown が優先され、完了までには組版時間も加わる。初回 baseline の debounce にも同じ待機期限を掛ける。期限後の通常 authority compile は、新しい編集が来ても aux fixed point までの pass を打ち切らず、shipping の優先窓による停止も期限で解除する。実行中に届いた編集は、その最初の到着時刻を次の待機期限に引き継ぎ、次回 timer は完了時点の実測コストから cooldown を計算し直す。opaque モードでは `displayDebounceMs`（既定350ms）と display cooldown（factor 1、cap 60s）を使い、長文書の連続再組版を抑える。

欠けた数式・不一致のページ構成・編集位置の未証明などで新しい紙面を提示できない場合、client は `POST /canonical/display-demand` に現在の `documentEpoch`・`srcRev`・表示側の `demandId` を送る。その版の既存予約だけを display cadence へ早め、追加の組版は作らない。完成したresidentページ群を実際に提示できたら同IDの `fulfilled: true` を送り、全表示側の需要が解消した未開始予約だけを通常のauthority cadenceへ戻す。待機の起点は最終編集時刻を保つ。同版を再び保留した場合やiframeを再作成した場合は新IDで再取得でき、遅延したfulfilledは別表示側の需要を消さない。IDは128文字、現在の版の既出IDは最大64件とし、同IDの重複はtimerを延長・再有効化しない。開始済み・成功済み・失敗済みの組版を需要通知から追加・取消・再試行しない。需要は対象の完了・失敗・別版への更新・文書resetで終わり、後続の無関係な編集は通常のauthority cadenceに戻る。`canonical.info()` の `scheduledInMs` は予約までの残り時間、`compiling` は実組版中、`displayDemandRev` は需要対象の版を示す。`ensure()`（export 経路）は渡された snapshot だけを compile し、途中の打鍵を連続して追いかけない。

現在のforeground resident cohortが正確なchunkを生成中の場合だけ、需要で早めたtimerの開始を待たせる。queuedとactiveを同じ原文revisionで追跡し、activeはTeX完了後のPDF変換・cropまで含む。完了後は提示通知用に500msを確保し、待機全体はその原文予約から2000msまでとする。失敗・isolated fallback・対象cohortなしは待機しない。改ページ・ページ数不一致・編集位置の未証明・canonical-onlyの需要は `residentImpossible: true` で待機を外し、複数表示側のうち1つでもこの需要が残れば延期しない。入力先行・anchor返信待ち・読込失敗は一時状態として通常の上限付き待機を保つ。同じIDで許す変更は待機不可への昇格だけ。`ensure()`・`settle()`・opaque組版はこのtimer専用待機を通らない。

## 10.10b checkpoint 予算の硬い上限

structured page の差し替えには、その page の未変更部分も含む exact chunk が必要になる。foreground walk は source-dirty block の後で galley が収束しても、同じ既存 page の未準備 exact block までは続ける。前方の未準備 block も再開位置に含める。ただし入力 checkpoint が editHold / renderHold または全境界を収める通常予算で保持される block は、既存の RENDER から準備できるため walk を延長しない。renderHold の枠はこの page 群を優先し、そこへ到達するためだけに再実行した無関係な prefix の描画で埋めない。保持数の上限は変えず、準備済み chunk がある page の通常の収束停止は維持する。

`maxCheckpoints`（既定は env、主サーバは 8）は通常の常駐 checkpoint 骨格の予算である。初回 canonical 後は実ページ数+1でも上限を掛け、小文書だけを root＋1ページあたり最大1本へ縮める。骨格を block 数の等間隔にすると、編集点との間に巨大な TikZ / user macro block が一つあるだけで、無関係な地の文の毎打鍵がその block を再実行する（実測: 160 回の複合 macro 展開を跨いだ日本語 1 文字が 4.4 秒）。そこで各 block の cold typeset 高水位時間を記録し、最も高価な block の入力・出力境界を優先して残し、余りを重み付き分位へ配る。これは `tikzpicture` や `tcolorbox` の名前を判定する局所対応ではなく、未知 package / macro にも同じ実測原理で働く。上記 fixture では同じ編集が fresh-open 直後でも 15ms になった。
末尾用の保存枠は、終端の `\par`・skip・改ページだけの block より前に置く。通常の保存間隔内に明示的な改ページがあればその直後を選び、最後の本文と未変更の見出しを同じ短い walk で用意する。このソース上の手掛かりは保存位置にのみ使い、組版する token は省略しない。選択順は root、高コスト block の入力・出力境界、末尾 anchor、残枠の重み付き分位である。予算内に全候補が収まらない場合は末尾の予測可能性を優先するため、予算値によらず分位境界や最後の高コスト block の出力境界が外れ、末尾以外の編集が追加 block を再実行する場合がある。

ただし骨格選択だけでは生存 checkpoint 数の上限にならない。`#retireOffGrid(idx)` は「その JOB が処理した 1 index」しか退役させないので、mid-document から resume する pass（rescue pump・settle・chain・backward-ref）は各停止点に orphan checkpoint を残し、誰も retire しないまま生存集合が creep する（実測: budget 8 指定でも 25 個生存、boot 時 55 個超で 16GB 機が窒息）。`#enforceCheckpointCap()` が「ckpt0 ＋実測コスト骨格 ＋ editHold ＋ renderHold だけ残し、他は DIE」で畳み直す。`#updateInner()` 末（boot/edit walk 後）・`#asyncRescueOne` 後・`#runChainPass` の finally で呼ぶ。各 checkpoint は累積 dormant page を保持する常駐 lualatex なので、これは実メモリの上限である。

`#shipUpdate()` は `TDOM_SHIP=1` のときだけ意味を持つ。現在の root source と、実際に展開した project input bytes の immutable snapshot を shipping chain に渡し、unit diff から resume できるかを判定する。child-only refresh は root が同一でも `unchanged` ではない。単一の既知 literal `\input` だけを最初の reader より前から replay し、未知・複数・`\include` の変更は新しい canonical seed を待って baseline を作り直す。snapshot を受理していない generation は新 `srcRev` に対応付けず、後着 wave も current revision/snapshot の一致を満たさなければ公開しない。実際の page ship と SVG 化は非同期で、`onShipPage` と SSE `ship` として着地する。

canonical anchor は root 内の plain text に加え、既に読まれた単一 child file の単一 plain-text 差分を扱う。child の公開 DOM span は引き続き `null` とし、編集前の include bytes から差分を算出して、物理 `readPath`、child-local block span、galley witness を非公開 snapshot に固定する。対象は root からの単一 literal `\input` とし、現在の read trace に到達した root/child ごとに字句上の reader 数と trace 数が一致しない場合は採用しない。同じ child が複数 block instance に所有される場合、`sourceParts` を持つ場合、別 input の変更が同居する場合も anchor を作らない。連続入力は最初の canonical snapshot を継承し、input epoch・source revision・canonical generation・PDF/SyncTeX hash のいずれかが変わった後着 proof は公開しない。

block 全体が safe-glyph・副作用なし・全 box が単一行 witness、という条件を満たさない block（見出し box、tcolorbox などの枠つき box、graphics、toc line・label を持つ block）でも、編集がその中の plain な 1 行に閉じていれば anchor できる。box ごとに witness を取り、単一の plain glyph 行でない box は不透明として扱う。編集前に、plain 行の glyph run だけを除いた block の frame（不透明 box の全内容、glue・penalty・marker、plain 行の box 寸法と flag、gfx・float・label・ref・toc line・event、backend profile）を固定し、編集後の frame が完全に一致すること、変わった行が plain 行だけでその fidelity flag が 0 であること、structural state が一致することを要求する。証明は plain 行すべての一意な canonical 対応で行い、不透明 box は照合しない（再描画しないため）。graphics を含む block は全行が exact chunk へ回り表示リストに glyph を出さないので、変わった行は source hit box の位置から、その行の run を表示リストと同じ規則で描く。

frame が「変わっていない」ことの根拠は次のとおり。(1) resident の収穫は box ごとに描画系 whatsit（pdf literal・color stack・matrix・save/restore・special・late_lua）の種類・mode・順序と文字列 payload を `fx` として記録する（LuaTeX 1.24 は TeX が作った pdf literal の token list の中身を Lua に出さないので、その中身は種類と順序でのみ区別する。読めない中身が編集で変わらないことは (6)(7) で示す）。(2) block 本文に通常文字に見える active character（babel shorthand や独自の `\catcode 13`）がある場合は対象外にする（`tdomActive`）。TeX の特殊文字は編集側で既に拒否しているので、残る編集は文字の組版だけで、macro を実行しない。(3) resident 以外で作った galley（rescue）は `fx` も `tdomActive` も持たないので対象外。(4) resident の収穫より後に描画を足す shipout filter と、組版中の node list を見る filter は、callback 名と description の組がすべて既知の集合（LuaTeX-ja・luaotfload・luacolor・lua-ul の underline が実際に登録する組だけ。名前の接頭辞では認めない）に入る場合だけ許す。照合する登録は、`GEO` の `paintCallbacks`（前文での登録）と、計画時点の全 block の galley の `paintLate`（GEO より後にその lineage で登録されたもの）を合わせたもの。resident は driver の最初の行（前文より前）で `luatexbase.add_to_callback` を包んですべての登録を記録する（どの package も包む前の関数を持てないので、同じ block の中で登録して外したものも残る）。block の終わりには registry も読み直す。後の block で登録された shipout filter も同じページに効くので、編集した block だけでなく全 block を見る。galley のない block がある場合、報告がない場合、未知の組がある場合は対象外。(5) luacolor は属性に置いた色を shipout 時に書き込むので、resident の run の色には出ない。黒以外の属性値を持つ glyph・rule を含む box を `ca` として記録し（黒の値は root で luacolor に既登録の黒の値を問い合わせて得る）、変わった行が `ca` を持つときは（plain block でも）anchor しない。(6) 編集より後にある編集していない macro は、編集で変わった TeX の状態（`\badness`、`\prevgraf`・`\prevdepth`、ページの累計、最後の node の値）を読んで、収穫では中身を読めない literal を作れる。resident は main vertical list への移し替え（build_page）のたびにこれらを標本化し、block の state trail（hash）として frame に含める。trail が一致すれば、編集した段落より後のコードは同じ状態から走っているので、中身を読めない literal まで出力が同じになる。(7) 段落の途中（水平モード）の状態は標本化しないので、変わった行を含む移し替え（その段落と、段落が動かした display・`\vadjust`・insert）には、収穫で読める描画しか許さない（`fx`・`ca`・float・insert を持つ項目がないこと）。各 top-level 項目がどの build_page で移されたかは、標本化の時に node に付けた属性から取る（`epochs`）。証明の出所について: SyncTeX は段落の行 box とその中の glue/kern に段落を閉じた行（次の環境の行など）を付けるため、SyncTeX の行番号では prose 行と枠内の行を区別できない。そこで内容で区別する。不透明 box の glyph 列が plain 行の glyph 列を含むときは anchor しない。frame が不透明 box を固定しているので、canonical 上の枠内の行が plain 行の文面と一致することはない。この比較は resident の run の文字列で行い、証明は canonical の ToUnicode 文字列で行うので、不透明 box の文字が native の font file で、remap・math・PUA・U+FFFD を含まない場合に限る。

末尾 glyph の descender だけで plain 行の `h`/`d`、galley の合計高、最終 trail が変わる場合は、上の exact frame と混ぜず、旧レイアウト上の非権威 `VisualCut` を別に判定する。`epochs` は全項目で同一、変更行は 1 本、他の plain 行・不透明項目・副作用・構造状態は同一でなければならない。resident は build_page 標本ごとの `trailMarks` も返し、変更行の contribution epoch より前の mark をすべて照合する。galley の合計高の差が変更行の `(h+d)` 差と一致しない場合も拒否する。変更 epoch 以後の現世代 suffix は正確だと主張せず、旧 canonical pixels をそのまま残す。

VisualCut patch は旧 canonical generation/revision を保持し、通常の行消去範囲 `baseMask` と深い glyph まで含む `mask` を併記する。現在行は旧行の水平 slot 内に収め、複数 mask は重ねない。client は既存 canonical raster の `mask - baseMask` に触れる全 pixel を上限付きで検査し、背景色以外が 1 pixel でもあれば公開しない。イベントは `canonical-visual-cut` として通常の `canonical-anchor` から分離し、この raster 検査を持たない旧 client は未知イベントとして無視する。source revision、input epoch、base generation/revision、表示中 image、700/850ms の proof/publish deadline は従来どおりである。

canonical の行の証明（plain・mixed 共通、同じ証明を使う canonical crop も同じ）は、witness の glyph ごとに文字・大きさ・位置に加えて塗り色を照合する。resident の収穫は color stack を hbox の中（`walk_h`）でしか追わないので、縦モードの push（段落の前や前の block の `\color`）は canonical の行を塗っても run の色に出ない。luacolor を使わない xcolor 文書では、赤い canonical の行を黒の run で描き直し得た。paint index は pdf.js の operator list から glyph ごとの fill color を記録する（pdf.js はどの色空間の fill も `setFillRGBColor` の hex 文字列で渡す。ページの初期値は黒、save/restore と form の終わりで戻す。pattern・透明などそれ以外の fill は不明として、どの witness とも一致させない）。witness は run の色（色のない run は表示リストと同じく黒）を glyph ごとに持つ。黒の表現は揃える: resident はどの色モデルの黒も `#000000` にし、pdf.js は DeviceCMYK の `0 0 0 1 k` を多項式で `#2c2e35` にするので、後者を `#000000` として扱う。すべての glyph で一致しない行は証明しない。

**累積 lineage（複数ブロック）。** anchor は base generation G に対する「G 以降の全編集の delta」を 1 つの patch で公開する。server の `terminalAnchorLineage` は G に対して編集されたブロックごとに entry（base witness、変わった行、証明済み page patch）を持ち、`ledger`（G が resident の exact compile だった時点の全ブロックの source hash・galleyHash・構造的 exit state）を保持する。別ブロック Y の編集は、(1) lineage が途切れていない（G 以降の全打鍵が anchor された）、(2) Y のブロックが ledger と一致する（G が組んだままである）、の両方が成り立つときだけ、その時点で捕捉した Y の resident witness を G の base witness として `planTerminalCanonicalAnchor` に渡せる（`joinedBase`）。証明は Y の行だけを行い、`resolveTerminalCanonicalAnchor` は他ブロックの証明済み page patch と結合して 1 つの patch（`blockIds`）にする。ブロック間で mask が重なる場合は fallback にする。raster 証明の種類が混在する場合は patch 全体を VisualCut として送り、exact-frame のページは `baseMask = mask`（追加リングなし）で client の raster 検査を通す。client は patch 適用時に全 delta を原子的に置き換えるので、複数ページの overlay を同時に持つ。lease と provisional 抑止は `blockIds` で判定する。covering canonical が着地すれば全 delta が退役する。

anchor を作らなかった編集でも lineage は捨てない（`canonicalAnchorLineageKept`）。証明はつねに base 世代の witness と現在の galley の比較なので、拒否された中間打鍵があっても次の plan は完全な差分を持つ。捨てるのは canonical が現行になった復元（`canonical-current`）、reboot、base 世代が変わったときだけ。client も同様に、intent の無い report で既存 overlay を消さず last-good として保持する（同じ block なら 1 打鍵遅れの証明済み表示、別 block なら overlay のページだけ凍結して他ページの provisional は通す）。以前はどちらも overlay を消して古い base ページを露出し、続く打鍵も次の canonical まで anchor が付かなかった。

anchor を作らなかった編集の report には `canonicalAnchorRefused` に理由を入れる（`canonical-behind`・`base-generation`・`ledger-mismatch`・`mixed-frame-changed`・`edited-contribution-paint`・`paint-callbacks`・`mixed-active-chars` など、capture と plan の各条件に 1 つずつ）。client はこの項目を使わない。条件は fail-closed で数が多く、1 つ外れると表示は canonical を待つだけなので、TeX Live の更新で callback の description が変わった場合などに原因を追う手がかりはこれしかない。証明（SyncTeX・paint index の照合と予算）での失敗は従来どおり `canonical-anchor` の patch の status に出る。

canonical anchor（plain・mixed 共通）の契約の前提（信頼境界）: 既知の callback 集合（上の (4)）の外にある Lua・package のコード、任意の `\directlua`、canonical だけが走らせる実際の `\output` と shipout hook は、既に組まれた node list を読んで、その内容に応じて resident が観測しない描画（TeX が作る literal の中身など）を生成しない、と仮定する。この前提を満たさない文書では anchor の正しさを保証しない。これは resident の galley 再利用（block の出力は source と入口の状態で決まる）と同じ前提で、LuaTeX 1.24 では一般には検査できない。TeX が作った literal の中身は読めず、`\directlua` の実行を捕まえる hook も `debug.getinfo` もない。luatexja 自身が TeX macro から `tex.nest` を読む（`\ltj@@getparam@one{direction}` など）ので、list を読むコードの有無で文書を分けることもできない。block を分けても、後の block が前の block の page list を読めば同じことが起きるので、この前提は block 境界にも block 内にも同じようにかかる。

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

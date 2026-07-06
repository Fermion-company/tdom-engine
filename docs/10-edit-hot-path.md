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

`#updateInner()` は最初に document bounds と preamble hash を取り、`classifyDocument()` を呼ぶ。

- safety gate が unsafe なら `#opaqueUpdate()` へ行く。
- preamble hash が変わったら `#bootRoot()` で resident root を起動し直す。
- boot 失敗時は opaque に demote し、同じ preamble で毎打鍵 boot しない。

structured に復帰できる状態になったときは、opaque sticky を外して root を boot し直す。

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

`mdframed` や breakable `tcolorbox` のような block は、page 上の offset によって分割結果が変わることがある。

現行実装は foreground で長い re-rescue chain を走らせない。`#queueMovedOffsets()` が offset 差分を見て rescue queue に積み、exact pipeline が async に fixed point へ近づける。表示中は stale galley/chunk と canonical overlay が残る。

## 10.9 render と canonical

hot path の最後に `#scheduleBackground(fgStop, dirtyBlocks)` と `canonical.schedule(source, srcRev)` が呼ばれる。

`#scheduleBackground()` は二つの仕事を予約する。

- pending chain があれば idle 後に chain pass を走らせる。
- dirty block 数が `TDOM_RENDER_HOT_MAX` 以下なら、needsRender な hot block を resident RENDER queue に積む。

`canonical.schedule()` は source/rev を保存して timer を張るだけである。実際の full `lualatex` compile は edit response を待たせない。

## 10.10 hot path から外れているもの

現行実装では、次は編集同期応答に載らない。

- canonical full compile。
- page SVG 変換。
- resident RENDER の PDF/SVG 生成。
- isolated rescue compile。
- long suffix rebuild/settle。
- page-context rescue fixed point。
- canonical crop。

これらは async patch、canonical SSE、または次回 `GET /doc` の state として反映される。


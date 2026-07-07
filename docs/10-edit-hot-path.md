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

## 10.9 壊れた TeX の凍結と決定性の境界

chain と isolated rescue の両方に失敗する block（実 LuaLaTeX 自身が emergency stop するソース — 例: tikz node 内の壊れた色名が pgf 内部でカスケードして子プロセスを殺す）は `#brokenBlockGalley()` で凍結する。未閉鎖の条件文のような軽い破壊は daemon が job 境界で回復するので、ここには来ない。凍結は二形態ある。

- 直前まで正常だった block: 最後の正常 galley と**その exit state をそのまま**保持する。pixel も下流の番号も編集前から一切動かない（打鍵中の番号 churn と全文書 settle を防ぐ）。
- 履歴のない block（fresh boot が壊れたソースを読んだ場合）: 空 galley で凍結し、exit は entry の素通し。

galley 有りの block は stale-first 経路で async rescue に回り、その isolated compile が失敗している間も凍結として扱う。凍結の判定は `frozenBlockIds()` — hard freeze（`#brokenBlockGalley` が galley に付ける `tdomFrozen`）に加え、「現在の rescue key が isoFailCache にヒットする block」を**導出**する。async 側を粘着フラグにしないのは巻き添えのため: 壊れたウィンドウ中の bogus な page offset で正常テキストの分割系 block の compile が失敗しても、offset が正気に戻れば rescue key も戻り自動的に非凍結へ復帰する（テキスト起因の凍結は key がテキストを含むので、テキストが直るまで凍結のまま）。async rescue の superseded 判定（queue 時と pump 時の rescue key 不一致）は捨てずに現在 key で再 queue する — stale-first 採択が block を rescued に反転させた直後は pageOffset の実体化で key が必ずズレるためで、捨てると exact 化が永遠に来ない。

この二形態は**意図的に一致しない**。壊れたソースには LuaLaTeX 自身が PDF を出さないので収束すべき真値が存在せず、「incremental == fresh boot」の等式は compile 可能なソースにのみ適用される。referee（`tools/fuzz.mjs`）は `tdomFrozen` を見てそのバーストの等式判定をスキップし、バーストを逆編集で復元して治癒経路を検証する。凍結は該当 block のテキストが変わる編集で自然に解け、直後の収束で編集前と同一の署名に戻る（`tests/hot-path.test.js` の凍結 2 テストが固定化）。失敗した isolated compile は rescue key で negative cache され、chain pass が凍結 block を跨ぐたびに同じ失敗 compile を払い直さない。

isolated compile の dormant absorb には暴走上限（fires > 50）があり、上限に達すると材料が破棄される。破棄が起きた run は**成功として採択しない**（`state.json` の `discarded` を見て失敗扱い）。silently 空/欠損の galley を真実として採択すると、その galley 自身が作るページネーションの不動点に嵌って自己修復しなくなる（stress seed-21 burst 2 で発見 — 旧実装ではプレビューから box が消えていた）。失敗にすれば stale-first が直前の正常 pixel を保持し、入力が正気に戻れば rescue key も戻って isoCache の正常結果が再採択される。page-context strut も `\textheight` 内にクランプする。

暴走の主因だった構造的ギャップは splitMode で解消済みである: **分割系 env（mdframed / framed / shaded / longtable / multicols / breakable tcolorbox とプリアンブル定義の breakable 名）の分割は本物の output routine の中でしか走らない**ため、これらの block の isolated compile は `\includepdf` と同じく実 routine を残す。ページが満ちるたびに実ページが ship され、per-page chunk になる（先頭ページは entry strut の下でクロップし、pagebuilder が block の on-page offset に部分 box として置く。中間ページは全 textheight。full フラグは付けない — 通常の文書ページなので preview の page furniture がそのまま乗る）。最終の部分ページは routine が発火しないので page_head に残り、通常の remainder 収穫が正確な寸法で拾う。**分割が不要な box は routine が一度も発火せず、absorb 経路と byte 同一の galley になる** — 恒常 frozen だった stress 文書の 9 block（＋multicols/longtable の 1 block）はこれで exact 化され、boot 時の frozen は 0 になった。referee（fuzz）は依然、壊れた TeX の新規凍結のみ skip+revert し、discard class（残existすれば）は比較自体に判定させる。

## 10.10 render、shipping、canonical

hot path の最後に `#scheduleBackground(fgStop, dirtyBlocks)`、`#shipUpdate(source)`、`canonical.schedule(source, srcRev)` が呼ばれる。

`#scheduleBackground()` は二つの仕事を予約する。

- pending chain があれば idle 後に chain pass を走らせる。
- dirty block 数が `TDOM_RENDER_HOT_MAX` 以下なら、needsRender な hot block を resident RENDER queue に積む。

`canonical.schedule()` は source/rev を保存して timer を張るだけである。実際の full `lualatex` compile は edit response を待たせない。

`#shipUpdate()` は `TDOM_SHIP=1` のときだけ意味を持つ。現在の source を shipping chain に渡し、unit diff から resume できるかを判定する。実際の page ship と SVG 化は非同期で、`onShipPage` と SSE `ship` として着地する。

## 10.11 hot path から外れているもの

現行実装では、次は編集同期応答に載らない。

- canonical full compile。
- page SVG 変換。
- resident RENDER の PDF/SVG 生成。
- isolated rescue compile。
- long suffix rebuild/settle。
- page-context rescue fixed point。
- canonical crop。
- shipping chain の boot、page ship、page SVG 変換。

これらは async patch、canonical SSE、または次回 `GET /doc` の state として反映される。

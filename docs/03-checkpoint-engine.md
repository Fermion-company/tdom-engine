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

## 3.2 プロセスモデル

root は `lualatex --shell-escape -interaction=nonstopmode driver.tex` として起動される。`--shell-escape` は `tdomfork.c` の共有ライブラリを `package.loadlib` するために使われる。

```text
Node.js engine
  └─ root lualatex
      ├─ ckpt0
      ├─ ckpt1
      ├─ ckpt2 ...
      ├─ JOB child -> 組版後に次 checkpoint へ昇格
      └─ RENDER child -> tight PDF を shipout して終了
```

checkpoint は「ある block 境界まで処理済みの TeX プロセス」である。OS の copy-on-write `fork()` が TeX 状態の snapshot になるため、マクロ、catcode、counter、font、box register などを JavaScript 側で保存・復元しない。

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
| `JOB <blockId> <newCkptIdx> <len>` | block を組版し、結果を返して次 checkpoint になる |
| `RENDER <blockId> <jobDir> <len>` | block を tight PDF として shipout する |
| `DIE` | checkpoint を終了する |
| `PING` | 生存確認 |

**daemon -> Node**

| command | 内容 |
| --- | --- |
| `HELLO` | role/index/pid の通知 |
| `GEO` | paper/text/float/footnote などの geometry |
| `TWIN` | twin math font の glyph metrics |
| `GALLEY` | block の node-list 抽出結果 |
| `CKPT` | checkpoint 昇格通知 |
| `FORKED` | 子 process pid 通知 |
| `DONE` | RENDER PDF 完了通知 |
| `PONG` | 生存応答 |

JOB の子だけが `tdom_wait()` から抜け、`tex.print()` で挿入された block source を TeX に読ませる。親 checkpoint は待機 loop に残る。

## 3.5 galley

daemon は block を real main vertical list 上で組み、その結果を JSON として返す。galley には、行 box、glue、kern、penalty、insert、float anchor、label/ref、counter state、font metadata が含まれる。

glyph run は同一 font/size/color/baseline shift の連続として送られる。ただし kern/glue で必ず分割されるため、run 内の描画位置は font advance の積み上げで確定する。

large math glyph、OpenType math、PUA/unencoded glyph、PDF literal などは daemon 側で flag され、`fidelity.js` が glyph 表示か exact chunk かを決める。

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
- `\topskip`、`\maxdepth`、`\skip\footins`、footnote rule。
- LaTeX float placement の主要経路。
- `\newpage` / `\clearpage` などの eject marker。
- raggedbottom / flushbottom の glue distribution。
- page boundary snapshot による incremental rebuild と page reuse。

二段組、margin note、mid-document geometry change などは `safety.js` 側で structured path から外れる。footnote は扱うが、TeX と同じ page-spanning split を完全再現する実装ではない。

## 3.9 exact chunk の経路

exact chunk は主に三つの経路から来る。

| 経路 | 内容 |
| --- | --- |
| resident RENDER | warm checkpoint から block を tight PDF として shipout し、`pdftocairo` で SVG 化する |
| canonical crop | fresh canonical SVG から block band を切り出して chunk として登録する |
| isolated render | standalone `lualatex` で該当 block を compile し、rescue chunk を作る |

resident RENDER は hot dirty block と async chain で実際に変化した block に寄せられる。大量の cold block を全文 sweep しない。dirty block 数が `TDOM_RENDER_HOT_MAX` を超える場合は hot render を抑制する。

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

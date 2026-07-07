# 11. shipping chain（増分 canonical）

この章は、`engine/checkpoint/shipping.js` と `engine/checkpoint/shipd.lua` が実装する任意の増分 canonical 経路の地図である。`TDOM_SHIP=1` のときだけ `CheckpointEngine` に接続される。

## 11.1 何をする層か

通常の `canonical.js` は、現在 source 全体を `lualatex` で compile して正本 PDF を作る。shipping chain は、それとは別にもう一つ resident `lualatex` を起動し、実 output routine のまま page を ship する。

狙っている対象は「実 `lualatex` の page pixels」である。`pagebuilder.js` の再構成ではなく、実際の `\shipout` から単ページ PDF を作る。

## 11.2 起動条件

`engine-v3.js` の constructor は、環境変数 `TDOM_SHIP=1` のときだけ `new ShippingChain(...)` を作る。

有効時の主な接続は次である。

| 場所 | 内容 |
| --- | --- |
| `#makeShipping()` | `ShippingChain` を作り、page 着地・label 捕捉 callback を接続する |
| `#bootShipping()` | 現 source、label seed、toc/lof/lot seed で shipping chain を boot する |
| `#shipUpdate(text)` | 編集後 source を shipping chain に渡し、resume / reboot-needed を判定する |
| `server.js` | `onShipPage` を SSE `ship` として broadcast する |
| `GET /ship/:n.svg` | shipped page PDF を lazy に SVG 化して返す |
| `web/app.js` | cold canonical と shipped page の鮮度を比べ、使える方を page overlay に使う |

## 11.3 TeX 側の構造

`shipd.lua` は、通常の output routine を残したまま body unit を socket 経由で供給する。

shipout ごとの動き:

1. 親 process は `shipout/before` hook に入る。
2. pager 子を `fork()` する。pager 子だけがその page を実際に ship し、単ページ PDF を作る。
3. 親側は `\DiscardShipoutBox` で自分の PDF を開かない。
4. 親は page 境界の resume checkpoint 子を `fork()` する。
5. `SSHIP page nline gen` で、その page と消費済み unit cursor を Node 側へ報告する。

pager の完了は、TeX 内部 callback ではなく pager process の socket close で検出する。PDF の flush と競合しないためである。

## 11.4 供給単位

`ShippingChain#unitsOf()` は body を `segmentBody()` で block/unit に分け、最後に `\end{document}` を追加する。変数名や protocol 名には `line` が残っているが、現在の供給単位は行ではなく segmenter の unit である。

unit は `SNEED n` に対して `SLINE <len>` payload として送られる。環境が feeder loop の反復をまたがないため、`align` や `tabular` のような構造を途中で割らない。

`SSHIP` の `nline` は「その page 境界までに消費した unit cursor」である。編集後、最初に変わった unit より前の cursor を持つ checkpoint があれば、そこから tail を resume できる。

## 11.5 resume

`resume(newSource)` は、旧 unit 列と新 unit 列を先頭から比較する。

| 結果 | 意味 |
| --- | --- |
| `unchanged` | unit 列が変わっていない |
| `resumed` | page checkpoint から tail を再 ship できる |
| `reboot-needed` | 使える page checkpoint がない |

resume 時は世代 `gen` を進め、古い tail の checkpoint と page PDF を捨てる。旧 feeder が深い TeX 実行中で `DIE` を読まない場合は、pid があれば `SIGKILL` する。

## 11.6 label と seed

shipping boot 時、engine は現在の `labelTable` と provisional page から label seed を作る。toc/lof/lot も engine 側の `#computeToc()` 結果を seed として渡す。

ship run 内で `\label` が実行されると `SLABEL` が Node 側へ送られる。seed と異なる label 値が観測された場合、前の page が古い値を印字している可能性があるため、engine は `shipStale` にし、観測値を `shipLabelOverrides` に保存して再 boot を queue する。再 boot は preamble ごとに回数上限を持つ。

## 11.7 cache と resource

shipping chain は page PDF と page SVG cache を持つ。

- page PDF は `ship-g<gen>-p<page>/driver-ship.pdf` に置かれる。
- `pageSVG(page)` は `pdftocairo -svg` で lazy 変換する。
- SVG cache key は `gen:page` である。
- checkpoint process は直近 `TDOM_SHIP_RECENT` page と、`TDOM_SHIP_GRID` の倍数 page を残す。

## 11.8 無効化される場合

hyperref 系の文書では、`\begin{document}` 時点で root process が PDF object を書き、root の PDF が ship 前に開くことがある。この場合、pager 子が page ごとに独立 PDF を lazy open する前提が崩れる。

`shipd.lua` は初回 feeder step で `driver-ship.pdf` の存在を検出すると `SPDFROOT` を送り、shipping chain を止める。`engine-v3.js` はその preamble では shipping を disabled とし、cold canonical が表示を持つ。

## 11.9 server / client

page が ship され SVG として提供可能になると、engine は `onShipPage({page, gen, srcRev})` を呼ぶ。`server.js` はこれを SSE `{kind:'ship', page, gen, srcRev}` として配信する。

client は page ごとに次を比べる。

- cold canonical が現在 source rev に対して fresh か。
- shipping page がその page の dirty rev 以上の `srcRev` を持つか。

使える shipped page が cold canonical より新しければ、`/ship/:n.svg?g=<gen>&r=<srcRev>` を page overlay に使う。

## 11.10 テスト

`tests/shipping.test.js` は 3 件である。

| test | 見ているもの |
| --- | --- |
| slice 1 | boot で ship された各 page の text が cold compile と一致する |
| slice 2 | tail edit 後の resume wave が新 source の cold compile と一致し、prefix page の PDF は保持される |
| slice 3 | `CheckpointEngine` 統合で edit 後に `onShipPage` が着地し、`pageSVG()` が SVG を返す |

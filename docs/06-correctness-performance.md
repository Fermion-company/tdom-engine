# 06. 正確性確認・性能観測・現在の制限

この章は、現行実装がどこで正確性を確認し、どこに制限を持つかを整理する。将来の性能目標ではなく、現在のコードとテストから読める地図である。

## 6.1 正確性を支える経路

現行 engine は、すべてを自前組版で完全再現しようとしていない。低レイテンシの構造化表示と、canonical TeX 出力を組み合わせる。

| 経路 | 役割 |
| --- | --- |
| resident TeX daemon | 編集 block を速く再処理し、real MVL・refs・labels・font 情報を返す |
| page builder | TeX の page builder と LaTeX output routine 相当を JavaScript 側で再構成する |
| canonical layer | 通常の `lualatex` で PDF/SVG/text/paper 情報を作る正本 |
| visual fidelity gate | structured/exact chunk が canonical と食い違う block を demotion する |
| safety gate | page-global に危険な構文を structured path から外す |
| block-level rescue | 局所的に output routine を変える block を exact chunk として扱う |
| shipping chain | `TDOM_SHIP=1` のとき、実 output routine のページ境界 checkpoint から page SVG を再 ship する |

PDF export は canonical layer から出る。checkpoint 表示 state は編集体験のための高速表示であり、最終 PDF の正本ではない。

## 6.2 テスト

`npm test` は次の 6 ファイルを実行する。

| ファイル | 件数 | 主な対象 |
| --- | ---: | --- |
| `tests/canonical.test.js` | 9 | canonical PDF/SVG/text/paper、aux fixed point |
| `tests/engine-v3.test.js` | 14 | チェックポイントエンジン、編集、rescue/opaque、PDF export |
| `tests/fidelity.test.js` | 12 | verify token、page-window、demotion 判定 |
| `tests/hot-path.test.js` | 10 | 編集ホットパス、bounded verification、background chain、壊れた source の凍結 |
| `tests/server-api.test.js` | 2 | server API と DOM/PDF API |
| `tests/shipping.test.js` | 3 | shipping chain、page resume、engine 統合 |

合計は 50 件である。一部テストは `lualatex` など外部 TeX toolchain が無い環境では skip される。

## 6.3 safety gate の現在地

`engine/checkpoint/safety.js` は、document-level に structured path を壊す package/body token を検出する。現在の unsafe には、custom output routine、shipout hook、`twocolumn`、`marginpar`/`marginnote`、`newgeometry`、`enlargethispage`、`balance` などが含まれる。

`pdfpages` の読み込み自体は unsafe package ではない。`\includepdf` は block-level rescue の対象である。

## 6.4 block-level rescue

`engine-v3.js` の `OUTPUT_HIJACK_RE` に一致する block は、通常の構造化 chunk ではなく exact chunk として扱われる。現行対象は、`multicols`、`paracol`、`longtable`、`landscape`、`mdframed`、`framed`、`shaded`、breakable `tcolorbox`、`\includepdf` である。

これは文書全体を opaque にする処理ではない。局所 block を exact に寄せ、周辺 block は可能なら checkpoint path に残す。

## 6.5 visual fidelity gate

`fidelity.js` は canonical page text と chunk text から verify token を作り、近傍 page window で containment を見る。token は文字 bigram ベースで、ラテン語だけを単語、CJK だけを bigram と分ける実装ではない。

page count mismatch は report されるが、それだけで即座に文書全体を opaque にするわけではない。demotion は block/chunk 単位で起きる。

## 6.6 現在の制限

| 領域 | 現在の扱い |
| --- | --- |
| custom output routine | document-level unsafe として structured path から外れる |
| two-column / margin notes / geometry change | safety gate の対象 |
| block-local output hijack | block-level rescue で exact chunk 化 |
| footnote splitting | page builder は footnote を扱うが、TeX と同じ分割を完全再現する実装ではない |
| float placement | 代表的な placement は扱うが、package が output routine を置き換える場合は rescue/opaque 側 |
| shell escape | resident root は `tdomfork.c` の読み込みに `--shell-escape` を使う。canonical/isolated compile は shell-escape flag を渡さない |
| POSIX fork | resident daemon は `tdomfork.c` に依存するため、ネイティブ Windows 実行は現在の対象外 |
| external tools | `lualatex`、`pdftocairo`、`pdftotext`、`pdfinfo` の有無で canonical 取得範囲が変わる |
| shipping chain | `TDOM_SHIP=1` のときだけ動く。hyperref 系のように root が ship 前に PDF を開く文書では無効化され、cold canonical が表示を持つ |

## 6.7 性能値の読み方

docs では固定の性能保証値を置かない。実際のレイテンシは TeX toolchain、文書サイズ、dirty block 数、exact render の有無、canonical cooldown、外部 PDF tool の有無に依存する。

現行コード上の大きな挙動は次である。

- foreground verification には bounded budget がある。
- background chain は idle 後に走る。
- high-fidelity render は dirty block 数や render budget によって抑制される。
- canonical layer は cooldown と cache を持つ。
- shipping chain は有効時のみ idle boot / resume wave として動く。
- export PDF は表示 state ではなく canonical 経路で作る。

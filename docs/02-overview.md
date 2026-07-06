# 02. 現行エンジンの全体像

この章は、現在の `tdom-core` に存在する実装の地図である。旧構想ではなく、どのファイルがどの役割を持ち、編集から表示・PDF 出力まで何が起きるかを追う。

## 2.1 実行されるエンジン

現行サーバーは `server.js` から `engine/checkpoint/engine-v3.js` を直接使う。`TDOM_BACKEND` による v0/v1/checkpoint 切り替えは存在しない。

現在の実装単位は次の通り。

| 層 | 主なファイル | 役割 |
| --- | --- | --- |
| HTTP/API | `server.js` | 単一 engine instance、編集 API、DOM/PDF API、サンプル UI |
| source 管理 | `engine/source-store.js` | block id と source 本文の対応 |
| segmentation | `engine/segmenter.js` | LaTeX ソースを編集単位 block に分割 |
| checkpoint engine | `engine/checkpoint/engine-v3.js` | resident TeX、差分投入、checkpoint 再利用、表示 state |
| Lua daemon | `engine/checkpoint/daemon.lua` | TeX 内で JOB/RENDER を処理し、MVL・refs・labels・events を返す |
| fork shim | `engine/checkpoint/tdomfork.c` | LuaTeX から POSIX `fork()` を呼ぶ小さな C shim |
| page builder | `engine/checkpoint/pagebuilder.js` | TeX page builder / LaTeX output routine 相当の再構成 |
| canonical | `engine/checkpoint/canonical.js` | full `lualatex` による PDF/SVG/text/paper 情報の正本 |
| fidelity | `engine/checkpoint/fidelity.js` | exact chunk と構造化 chunk の視覚差分判定 |
| safety | `engine/checkpoint/safety.js` | unsafe package/body token 検出、verify token 生成 |
| math/font | `engine/checkpoint/mathmap.js` | legacy math font から Latin Modern twin への写像 |

## 2.2 編集から表示まで

編集 API は `POST /edit` で LaTeX ソースの範囲差分を受け取る。エンジン側では、おおまかに次の順に進む。

1. safety gate が document-level に危険な package/body token を調べる。
2. `segmenter.js` が source を block 列に分ける。
3. 前回 block 列との差分を取り、prefix/suffix で再利用できる checkpoint を付け替える。
4. resident TeX daemon に必要な block を JOB として投入する。
5. daemon は real MVL、labels/refs、toc lines、shipout events、font 情報などを返す。
6. `pagebuilder.js` が galley・float・footnote をページに組む。
7. 表示用 display list と chunk 情報が `GET /doc` と `GET /dom` から観測できる。
8. exact が必要な block は resident render、canonical crop、isolated render のいずれかで置き換わる。

「編集された箇所だけを再 TeX する」ために、engine は block hash と checkpoint を保持する。現在の実装は、単純に編集位置以降を全破棄するのではなく、共通 prefix/suffix に合わせて checkpoint を再キー化し、残せる状態を残す。

## 2.3 canonical 経路

canonical layer は通常の `lualatex` を一時ディレクトリで実行し、PDF を正本として扱う。そこから必要に応じて次を生成する。

| 取得物 | 経路 |
| --- | --- |
| PDF | `lualatex` fixed-point run |
| SVG page | `pdftocairo -svg` |
| page text | `pdftotext` |
| paper size | `pdfinfo` |
| block exact crop | canonical SVG から block bbox を crop |

canonical は aux fixed point を最大 3 pass で追う。`GET /pdf` は checkpoint 表示 state ではなく、この canonical 経路を使う。

## 2.4 safety と opaque/rescue

現行実装には二種類の退避経路がある。

| 種類 | 例 | 何が起きるか |
| --- | --- | --- |
| document-level unsafe | output routine を根本的に変える package、shipout hook、page builder を大域的に壊す body token | structured checkpoint 表示を避け、canonical/opaque 表示へ寄せる |
| block-level rescue | `multicols`、`paracol`、`longtable`、`landscape`、`mdframed`、`framed`、`shaded`、breakable `tcolorbox`、`\includepdf` | 該当 block を構造化せず exact chunk として扱う |

`pdfpages` の読み込み自体は document-level unsafe ではない。実際に `\includepdf` が現れる block は block-level rescue の対象になる。

## 2.5 公開 API の地図

`server.js` は単一 engine instance を持つ。主要 API は次である。

| API | 内容 |
| --- | --- |
| `GET /doc` | source、display list、geometry、font manifest、report |
| `POST /edit` | `{start,end,text}` の範囲編集 |
| `POST /open` | source/template で文書を開き直す |
| `GET /dom` | engine 観測用 JSON |
| `GET /canonical/:n.svg?c=<id>` | canonical page SVG |
| `GET /chunk/:id.svg` | exact chunk SVG |
| `GET /font/:key` | TeX が使った font file |
| `POST /font-fail` | browser font load failure の報告 |
| `GET /canonical.pdf` | 最後に成功した canonical PDF |
| `GET /pdf` | 現 source を canonical layer で ensure して PDF を返す |
| `GET /events` | SSE |
| `GET /status` | queue/canonical/mode の lightweight status |

フロントエンドは `web/` 配下にあり、DOM chunk を絶対配置に近い形で描画する。UI の仕様はこの engine docs の対象外である。

## 2.6 テストの地図

`npm test` は `node --test` で次を実行する。

| ファイル | 見ている対象 |
| --- | --- |
| `tests/engine-v3.test.js` | checkpoint engine、編集、opaque/rescue、export |
| `tests/canonical.test.js` | canonical fixed-point、SVG/text/paper 情報 |
| `tests/fidelity.test.js` | visual fidelity gate、token/window 判定 |
| `tests/hot-path.test.js` | 編集ホットパス、差分範囲、background chain |
| `tests/server-api.test.js` | HTTP API の基本動作 |

現在のテスト総数は 44 件である。

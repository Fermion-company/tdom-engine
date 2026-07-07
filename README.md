# TDOM Engine

TDOM Engine は、LaTeX を書いている最中の「少し直すたびに全文コンパイルを待つ」時間を減らすためのエンジンである。

編集直後は、起動したままの TeX を使って近くの本文だけを素早く組む。裏では普通の `lualatex` も走らせ、最終的な正しさは本物の LaTeX 出力で確認する。

このリポジトリはエンジン本体と薄い確認用 UI だけを含む。大きな文書編集 UI、構造編集、AI、図表エディタなどはここにはない。`web/app.js` は、エンジンが返す display list、chunk、canonical page を描画する薄いクライアントである。

## まず全体像

表示には、四つの道がある。

| 日本語での役割 | 実装名 | 内容 |
| --- | --- | --- |
| 速い仮表示 | checkpoint | 編集した近くの本文だけを再組版する |
| 正しい全体出力 | canonical | 普通の `lualatex` で PDF を作る |
| 危ない部分の画像差し替え | exact chunk | 数式や特殊環境などを本物の出力画像に置き換える |
| ページ単位の増分正本 | shipping chain | `TDOM_SHIP=1` のとき、実際のページ出力を途中から作り直す |

最初はこれだけ掴めばよい。英語名は実装上の名前であり、役割は上の日本語名の通りである。

## 現在の表示経路

表示には順位がある。

1. **正しい全体出力**  
   実 source を通常の `lualatex` で最後まで処理し、PDF と page SVG を作る。最終表示、reload 後の正確な表示、PDF export はこの層が正本である。

2. **速い仮表示**  
   `fork()` で保存した TeX の途中状態と `pagebuilder.js` で、編集直後の表示を作る。これは速度のための層であり、正本ではない。

3. **危ない部分の画像差し替え**  
   文字として安全に描けない行や block を、本物の LaTeX 出力から作った SVG 画像に置き換える。

4. **ページ単位の増分正本**  
   `TDOM_SHIP=1` のときだけ有効になる任意機能。実際の LaTeX のページ出力を、編集位置以降だけ作り直す。通常の `lualatex` 全体コンパイルは引き続き PDF export と検証の正本である。

## 安全判定と退避経路

`engine/checkpoint/safety.js` は、document-level に structured path を壊す構造を検出する。shipout hook、`twocolumn`、`\marginpar`、mid-document geometry change などは文書全体を opaque mode に送る。

一方、`\includepdf`、`longtable`、`multicols`、`landscape`、breakable `tcolorbox` などは block-level rescue の対象であり、文書全体を opaque にしない。

opaque mode でも編集は継続できる。表示は canonical page のみになり、TeX error は実 `lualatex` の error として返る。

## 起動

```bash
git clone https://github.com/Fermion-company/tdom-engine.git
cd tdom-engine
npm start
# http://127.0.0.1:4633 を開く
```

依存:

- Node.js 18+
- TeX Live の `lualatex`
- poppler の `pdftocairo`
- `pdftotext` と `pdfinfo` は検証・paper size 取得に使う
- `cc` は fork shim の初回 build に使う

`npm install` は不要である。npm 依存はない。

## サーバー API

| API | 内容 |
| --- | --- |
| `GET /doc` | source、display list、geometry、font manifest、report |
| `POST /edit` | `{start,end,text}` の範囲編集 |
| `POST /open` | source/template で文書を開き直す |
| `GET /dom` | engine 観測用 JSON |
| `GET /canonical/:n.svg?c=<id>` | canonical page SVG |
| `GET /ship/:n.svg?g=<gen>&r=<srcRev>` | shipping chain の page SVG |
| `GET /chunk/:id.svg` | exact chunk SVG |
| `GET /font/:key` | TeX が使った font file |
| `POST /font-fail` | browser font load failure の報告 |
| `GET /canonical.pdf` | 最後に成功した canonical PDF |
| `GET /pdf` | 現 source を canonical layer で ensure して PDF を返す |
| `GET /events` | SSE |
| `GET /status` | queue/canonical/mode の軽量 status |

## 主要ファイル

| ファイル | 役割 |
| --- | --- |
| `server.js` | HTTP/SSE server、単一 engine instance、toolchain check |
| `engine/checkpoint/engine-v3.js` | チェックポイントエンジン本体 |
| `engine/checkpoint/daemon.lua` | resident TeX 内 daemon |
| `engine/checkpoint/pagebuilder.js` | TeX page builder / LaTeX output routine 相当の再構成 |
| `engine/checkpoint/canonical.js` | cold canonical renderer |
| `engine/checkpoint/shipping.js` | 任意で有効化される増分 canonical 経路 |
| `engine/checkpoint/shipd.lua` | shipping chain の TeX 側 daemon |
| `engine/checkpoint/safety.js` | safety gate と verification token |
| `engine/checkpoint/fidelity.js` | glyph / exact / canonical-only 判定 |
| `engine/checkpoint/mathmap.js` | legacy math font mapping |
| `engine/segmenter.js` | LaTeX source の block 分割 |
| `engine/source-store.js` | source buffer |
| `web/app.js` | preview client |

## テスト

```bash
npm test
```

現行 `npm test` は 6 ファイル、50 件を実行する。

- `tests/canonical.test.js`
- `tests/engine-v3.test.js`
- `tests/fidelity.test.js`
- `tests/hot-path.test.js`
- `tests/server-api.test.js`
- `tests/shipping.test.js`

TeX toolchain が無い環境では、該当する integration test は skip される。

## 詳細 docs

実装地図は [docs/README.md](docs/README.md) から読む。まず [docs/00-first-read.md](docs/00-first-read.md) で全体像を掴む。これは設計方針やロードマップではなく、現在のコードを読むための地図である。

# TDOM Engine 実装地図

この `docs/` は、現在のリポジトリに存在する実装を読むための地図である。未実装案、性能目標、ロードマップはここには置かない。

実装と食い違う記述があれば、実装を正とする。特にこの版の実装は `checkpoint` バックエンド単独で動作しており、旧 v0/v1 バックエンドの選択機構は存在しない。

## まず掴むこと

このエンジンは、**速い仮表示**と**本物の LaTeX 出力**を組み合わせる。

- 編集直後は、常駐 TeX の途中状態を使って近くの本文だけを速く組む。
- 裏では普通の `lualatex` も走り、正しい PDF を作る。
- 仮表示が危ない部分は、本物の出力画像に差し替える。
- `TDOM_SHIP=1` のときは、ページ単位で本物の出力を途中から作り直す経路も使う。

英語の実装名でいうと、順に `checkpoint`、`canonical`、`exact chunk`、`shipping chain` である。最初から英語名を覚える必要はない。

## 読む順番

| 章 | 内容 |
| --- | --- |
| [00-first-read.md](./00-first-read.md) | まず全体像。日本語名で四つの道を掴む |
| [01-tex-background.md](./01-tex-background.md) | TeX の page builder / output routine / LuaTeX node list の前提 |
| [02-overview.md](./02-overview.md) | 現行エンジンの全体像、ファイル配置、API 経路 |
| [03-checkpoint-engine.md](./03-checkpoint-engine.md) | チェックポイントエンジン本体、Lua daemon、resident TeX、page builder |
| [04-renderer-and-fonts.md](./04-renderer-and-fonts.md) | DOM 表示、フォント忠実度、PDF/SVG 表示経路 |
| [05-shared-substrate.md](./05-shared-substrate.md) | 現行チェックポイントエンジンが使う共有基盤 |
| [06-correctness-performance.md](./06-correctness-performance.md) | テスト、正確性の確認経路、現在の制限 |
| [07-glossary.md](./07-glossary.md) | 用語集 |
| [08-canonical-exact-layer.md](./08-canonical-exact-layer.md) | canonical 正本層、安全ゲート、opaque 化、block rescue |
| [09-visual-fidelity-gate.md](./09-visual-fidelity-gate.md) | 視覚忠実度ゲートと exact chunk 降格 |
| [10-edit-hot-path.md](./10-edit-hot-path.md) | 編集ホットパス、checkpoint 再利用、非同期追従 |
| [11-shipping-chain.md](./11-shipping-chain.md) | shipping chain: `TDOM_SHIP=1` で有効なページ境界 checkpoint 付き実ラン |

最短で全体像だけ掴むなら、`00 -> 02 -> 03 -> 08 -> 09 -> 10 -> 11` の順で読む。TeX の内部に慣れていない場合だけ、最初に `01` を挟む。

## 現行実装の短い要約

- サーバーは `server.js` から現在のエンジン本体を直接使う。
- TeX は起動したまま待機し、編集された本文だけを追加で読む。
- 画面の仮表示は、TeX から取り出した行や余白の情報を JavaScript 側でページに並べて作る。
- 正確さが必要な場所は、普通の LaTeX が作った PDF/SVG から画像として貼る。
- 出力の仕組みを大きく変える構文は、仮表示をあきらめて正本表示へ逃がす。
- `TDOM_SHIP=1` では、実際のページ出力を途中から作り直す任意機能も動く。
- PDF 出力は常に普通の `lualatex` 経路を正本にする。

## 数字の扱い

この docs では、ファイル行数や速度値を固定仕様として扱わない。テスト数、公開 API、主要ファイル、実行時の分岐は現在のリポジトリから読める事実だけを書く。

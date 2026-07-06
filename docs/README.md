# TDOM Engine 実装地図

この `docs/` は、現在のリポジトリに存在する実装を読むための地図である。未実装案、性能目標、ロードマップはここには置かない。

実装と食い違う記述があれば、実装を正とする。特にこの版の実装は `checkpoint` バックエンド単独で動作しており、旧 v0/v1 バックエンドの選択機構は存在しない。

## 読む順番

| 章 | 内容 |
| --- | --- |
| [01-tex-background.md](./01-tex-background.md) | TeX の page builder / output routine / LuaTeX node list の前提 |
| [02-overview.md](./02-overview.md) | 現行エンジンの全体像、ファイル配置、API 経路 |
| [03-checkpoint-engine.md](./03-checkpoint-engine.md) | checkpoint エンジン本体、Lua daemon、resident TeX、page builder |
| [04-renderer-and-fonts.md](./04-renderer-and-fonts.md) | DOM 表示、font fidelity、PDF/SVG 表示経路 |
| [05-shared-substrate.md](./05-shared-substrate.md) | 現行 checkpoint engine が使う共有基盤 |
| [06-correctness-performance.md](./06-correctness-performance.md) | テスト、正確性の確認経路、現在の制限 |
| [07-glossary.md](./07-glossary.md) | 用語集 |
| [08-canonical-exact-layer.md](./08-canonical-exact-layer.md) | canonical exact layer、安全ゲート、opaque 化、block rescue |
| [09-visual-fidelity-gate.md](./09-visual-fidelity-gate.md) | visual fidelity gate と exact chunk demotion |
| [10-edit-hot-path.md](./10-edit-hot-path.md) | 編集ホットパス、checkpoint 再利用、非同期追従 |

## 現行実装の短い要約

- サーバーは `server.js` から `engine/checkpoint/engine-v3.js` を直接使う。
- TeX は常駐 `lualatex` daemon として起動し、編集ごとに差分 block を再投入する。
- 低レイテンシ表示は、TeX から取り出した real MVL と page builder の再構成で作る。
- 完全一致が必要な部分は canonical PDF/SVG を使い、部分 crop、resident render、isolated render を組み合わせる。
- 出力ルーチンを大きく変える構文は安全ゲートまたは block-level rescue に回る。
- PDF export は常に canonical `lualatex` 経路で作る。

## 数字の扱い

この docs では、ファイル行数や速度値を固定仕様として扱わない。テスト数、公開 API、主要ファイル、実行時の分岐は現在のリポジトリから読める事実だけを書く。

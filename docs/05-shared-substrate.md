# 05. 共有基盤

この章は、現行 checkpoint engine が使う共有基盤の地図である。現行リポジトリに存在しない旧バックエンドは、最後に不在情報としてだけ整理する。

## 5.1 現在存在するバックエンド

現在実行されるバックエンドは `engine/checkpoint/engine-v3.js` だけである。`server.js` はこの engine を直接生成する。

存在しないもの:

- `engine/v0` ディレクトリ
- `engine/v1` ディレクトリ
- `TDOM_BACKEND` による実行時切り替え
- v0/v1 への自動 fallback

## 5.2 共有ファイル

現行 checkpoint engine が使う共有ファイルは次である。

| ファイル | 役割 |
| --- | --- |
| `engine/segmenter.js` | LaTeX source を block 列に分割する |
| `engine/source-store.js` | block id と source 本文を保持する |
| `engine/hash.js` | block/source の stable hash を作る |

これらは複数バックエンドを切り替えるための層ではなく、現在の checkpoint engine の土台である。

## 5.3 segmenter

`segmenter.js` は、document source を編集・再 TeX の単位に切る。section や paragraph だけでなく、環境や display math の境界を意識して block を作る。

engine は block hash を使って、前回 source との共通 prefix/suffix を見つける。再利用できる checkpoint は、新しい block index に合わせて付け替えられる。

## 5.4 source store

`source-store.js` は、block id から source body を取り出すための store である。engine の表示 chunk や render job は、直接巨大な document 文字列を持ち回るのではなく、block id を介して必要な source を参照する。

## 5.5 hash

`hash.js` は、source/block の同一性判定に使う stable hash を提供する。checkpoint 再利用、dirty block 判定、render job の同一性確認は、この hash を前提に進む。

## 5.6 旧バックエンド名の扱い

古い説明に v0/v1 という名前が出てきても、それは現行実装の動作経路ではない。

| 古い呼び名 | 現在読むべき場所 |
| --- | --- |
| v0 incremental engine | 存在しない |
| v1 macro/shape pipeline | 存在しない |
| checkpoint engine | `engine/checkpoint/engine-v3.js` |
| backend fallback | `safety.js`、opaque 表示、block-level rescue、canonical layer |


# 12. リアルタイム表示忠実度の基準点（2026-08-27）

この章は、2026-08-27 に実画面で確認した表示忠実度の基準点と、その復元方法を
記録する。計画ではなく、現在の実装・履歴・検証事実のメモである。

## 12.1 Git の基準点

今回の統合は、次の二つの兄弟コミットを両方残す merge である。

| ref | 内容 |
| --- | --- |
| `c01c628` (`codex/fix-live-preview-fidelity`) | exact chunk の bleed、段落インデント二重適用防止、zero-area rule 除去 |
| `1a341fa` (`origin/dev`) | jump、tcolorbox、リアルタイム表示・ナビゲーションの後発修正 |
| `4cc2df0` | 上記二つを親に持ち、mixed text/math bridge と MathLive 対応まで含むコード基準点 |

リポジトリ外のバックアップは、Desktop の
`tdom-live-preview-fidelity-20260827.bundle` に全 ref を保存する。bundle 内の
`codex/backup-live-preview-fidelity-20260827` ブランチ、または
`backup/live-preview-fidelity-20260827` タグからこの文書込みの状態を復元できる。

## 12.2 表示方針（戻してはいけない不変条件）

1. canonical LuaLaTeX page が最終権威である。
2. display math と math-only 行は exact chunk を使う。
3. stale な whole-block chunk は、編集された現在の散文行を覆わない。
4. stale exact pixel が新しい数式を隠す間は、inline/display のどちらも
   source-level LaTeX から MathLive `<math-span>` で暫定表示する。
5. raw math run は位置と編集 hit geometry を残して透明化する。PUA/private
   glyph の四角や代替フォントを画面へ出さない。
6. 数式判定をフォント名だけに依存させない。`daemon.lua` が TeX の inline
   math boundary 間を run `m=1` として記録するため、`\mathrm`、`\mathit`、
   `\mathbf` なども同じ経路で扱う。
7. `/dom` の math source region と画面の math run/source-hit group が一対一に
   対応しない場合は推測しない。exact/canonical 経路へ fail closed する。
8. fresh exact chunk が届いたら bridge を捨て、実 PDF pixel に置き換える。
9. 一部の行だけ exact が必要な block でも、fresh whole-block chunk が届いた後は
   block 全体を連続した実 PDF pixel で表示する。行単位の crop 境界を残さない。

## 12.3 実装の分担

| ファイル | 現在の責務 |
| --- | --- |
| `engine/checkpoint/daemon.lua` | TeX math boundary を追跡し、数式由来 run に `m=1` を付与 |
| `engine/checkpoint/fidelity.js` | mixed native text/math を検出し `itemFlags` bit 4 を設定 |
| `engine/checkpoint/stream.js` | stale whole-block chunk から現在の safe/mixed 行だけを取り出す |
| `engine/checkpoint/display-list.js` | math run/source-hit と TeX の幅・高さ・深さ、stale 状態を SVG data 属性へ渡す |
| `engine/edit-regions.js` | inline/display math を source metadata の `display` で区別 |
| `engine/checkpoint/inspector.js` | `/dom` へ `display` と source-level LaTeX を公開 |
| `web/app.js` | math run group と source region を対応させ、`<math-span>` を同一フレームで描画 |
| `web/style.css` | bridge の重なり順、scale、pointer 透過、canonical 到着時の非表示 |

exact chunk 側では `engine/checkpoint/display-list.js` の 2bp bleed、block origin
への anchor、zero-area rule の非描画も同じ基準点に含む。これらは上付き文字の
欠け、ブラウザの fractional pixel clipping、段落字下げの二重適用、余計な縦線を防ぐ。

## 12.4 TeX64 アプリとの資産契約

TDOM は外部プロセスなので、Electron の仮想 `app.asar` 内を通常のファイル
パスとして読めない。TeX64 は MathLive と WYSIWYG の必要部分を
`app.asar.unpacked/Resources/web` に出し、`TDOM_HOST_WEB_ROOT` をその実パスへ
向ける。次の URL は配布版でも 200 でなければならない。

- `/host/mathlive/mathlive.min.js`
- `/host/mathlive/mathlive-static.css`
- `/host/web/math/wysiwyg/math-wysiwyg.js`

この契約が壊れると `<math-span>` が登録されず、mixed-line bridge が起動しない。

## 12.5 再現・確認に使ったケース

対象は、同じ block 内に inline math を含む散文と `align*` が並ぶ文章だった。

```tex
左側の区間 $-\sqrt2<x<0$ では $h(x)>0$ なので、曲線 $C$ が直線 $\ell$ より上にある。
よって左側の面積 $S_1$ は
\begin{align*}
  S_1 &= \cdots
\end{align*}
```

先頭へ一時的に `検` を挿入した直後、次を確認してから同じ `/edit` 経路で元に
戻した。

- `検左側の区間` が current glyph command に存在する。
- stale chunk は display math 部分だけを覆い、散文行を覆わない。
- 5つの inline math region が5つの `<math-span>` と一対一に対応する。
- 全 raw math run が透明になり、PUA の四角が出ない。
- fresh chunk/canonical 到着後は通常の実PDF表示へ収束する。

## 12.6 固定した回帰テスト

- `tests/fidelity.test.js`: 本文フォントを使う数式でも `m=1` により mixed 行になる。
- `tests/live-preview-regressions.test.js`: stale graphical block で safe/mixed 行は
  current、math-only 行は stale exact のままになる。
- `tests/edit-regions.test.js`: `$...$` と `\begin{math}` は inline、`\[...\]`
  と display math environment は display metadata を持つ。
- `tests/live-preview-regressions.test.js`: zero-area TeX rule は SVG に出ない。
- `tests/hot-path.test.js`: fresh partial-exact block は連続した whole-block
  chunk へ昇格し、display math の上下に行単位 crop 境界を残さない。
- `tests/hot-path.test.js`: display math の stale source-hit は math/stale geometry を持ち、
  新しい編集が resident render backlog を preempt する。

2026-08-27 のローカル確認では、上記 pure test 28件と bounded hot-path 14件が
成功した。TeX64 側では packaged MathLive path の service test 8件、署名済み
`/Applications/TeX64.app`、実画面の一時編集と復元を確認した。

## 12.7 bundle からの復元

新しいディレクトリへ復元する場合:

```bash
git clone /Users/majinkuu/Desktop/tdom-live-preview-fidelity-20260827.bundle tdom-core-restored
cd tdom-core-restored
git switch codex/backup-live-preview-fidelity-20260827
```

既存 clone へ ref だけ取り込む場合:

```bash
git fetch /Users/majinkuu/Desktop/tdom-live-preview-fidelity-20260827.bundle \
  refs/heads/codex/backup-live-preview-fidelity-20260827:refs/heads/codex/backup-live-preview-fidelity-20260827
```

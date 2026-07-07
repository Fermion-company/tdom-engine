# 08. canonical 正本層

この章は、`engine/checkpoint/canonical.js` と、それを使う safety/verification/opaque 経路の地図である。

## 8.1 canonical renderer

`CanonicalRenderer` は、実 source をそのまま `lualatex` に渡して PDF を作る正本 layer である。チェックポイントエンジンの display list は編集直後の preview であり、PDF export と最終的な page pixels は canonical layer から来る。

主な public method は次である。

| method | 内容 |
| --- | --- |
| `schedule(source, rev)` | debounce/cooldown 付きで compile を予約する |
| `ensure(source, rev)` | 現 source の compile を強制し、成功 result を返す |
| `settle()` | pending/running compile を drain する |
| `info()` | rev/id/pageCount/paper/passes/ms/error などの snapshot |
| `pageSVG(page, id)` | 指定 compile id の page SVG を lazy 生成する |
| `pageTexts(id)` | `pdftotext` で page text を返す |
| `pdfBytes()` | 最後に成功した PDF bytes を返す |

compile は aux family の hash が安定するまで回る。上限は `MAX_PASSES = 3` である。page SVG は `pdftocairo` により要求された page だけ変換し、LRU cache に載る。paper size は `pdfinfo` から取得する。

## 8.2 scheduling

canonical scheduling は latest-wins である。compile 中に新しい source が来た場合、完了後に最新 source が pending として残る。

structured mode では `pressure = 'authority'` で、基本 debounce に加えて前回 compile time に比例した cooldown を持つ。opaque mode では `pressure = 'display'` になり、canonical compile 自体が表示更新なので debounce 中心で動く。

`GET /pdf` は `engine.exportPDF()` 経由で `canonical.ensure()` を呼ぶ。表示用 checkpoint state から PDF を作る経路はない。

## 8.3 client convergence

`server.js` は canonical compile が着地すると SSE `canonical` event を送る。client は compile id を付けて `/canonical/:n.svg?c=<id>` を取りに行く。stale id なら 404 になり、現在の id で取り直す。

表示側は provisional layer、exact chunk layer、canonical page layer を重ねる。source rev が一致した canonical page は最終表示として勝つ。編集で dirty になった page/band だけが provisional に戻り、次の canonical 着地で消える。

## 8.4 safety gate

`safety.js` は document-level に structured path を壊す構造を検出する。危険なのは未知 macro ではなく、page assembly を document-wide に変える構造である。

現在 document-level unsafe に入るもの:

- `flowfram`、`eso-pic`、`everypage`、`background`、`xwatermark`、`draftwatermark`、`atbegshi` などの shipout/page paint 系 package。
- custom `\output`、raw `\shipout`、shipout hook、`\AtBeginDvi`。
- class option または本文中の `twocolumn`。
- `\marginpar`、`\marginnote`。
- `\newgeometry`、`\enlargethispage`。
- `\balance`。

`pdfpages` package の読み込み自体は unsafe ではない。実際の `\includepdf` は block-level rescue 対象である。

## 8.5 block-level rescue

`engine-v3.js` の `OUTPUT_HIJACK_RE` に一致する block は、文書全体を opaque にせず exact block として扱われる。現在の対象は、`multicols`、`paracol`、`longtable`、`landscape`、`mdframed`、`framed`、`shaded`、breakable `tcolorbox`、`\includepdf` である。

rescue block は stale-first で表示される。前回の galley/chunk があればそれを保持し、isolated exact compile は async queue で進む。

## 8.6 verification

fresh canonical が現 source rev に追いついたとき、`#verifyAgainstCanonical()` が structured page text と canonical page text を照合する。

現在の実装:

- `pdftotext` が使えない場合は verification を skip する。canonical overlay は残る。
- token は `verifyTokens()` の文字 bigram である。Latin word と CJK bigram を別規則にする実装ではない。
- 同一 page に加えて ±1 page の window を見る。
- page count mismatch は report されるが、それだけで block demotion しない。
- window containment が 0.5 未満の確実な乖離だけを demotion 候補にする。
- demotion は block/chunk 単位で、document 全体を opaque にする処理ではない。

glyph layer がズレた block は exact-only へ降格する。すでに exact/rescue 表示だった block がズレた場合は canonical-only へ降格する。降格は block source hash に粘着し、source が変わるまで戻らない。

## 8.7 opaque mode

opaque mode では resident process tree を捨て、表示は canonical page だけになる。編集は source に適用され、canonical compile が schedule される。

opaque に入る主な経路:

- safety gate が document-level unsafe を検出した。
- structured boot が失敗した。
- full rebuild retry 後も structured typeset が失敗した。

boot 失敗は preamble hash に sticky になる。ただし `#scheduleStructuredReprobe()` により、一度だけ quiet delay 後の structured boot 再試行がある。preamble が変われば通常の structured 判定に戻る。

## 8.8 canonical crop

`#cropCanonicalChunks()` は、fresh canonical compile が現 source rev と一致し、かつ provisional page count と canonical page count が一致するときに動く。

条件を満たす single-page block について、canonical page SVG から block band を切り出し、chunk cache に登録する。上限は `TDOM_CANON_CROP_MAX`、既定 40 block である。page count が drift しているときや block が page をまたぐときは crop しない。

## 8.9 shipping chain との関係

`TDOM_SHIP=1` のときは、`shipping.js` / `shipd.lua` による増分 canonical 経路も page SVG を供給する。これは実 output routine で ship された page pixels を届ける任意の経路である。

cold canonical は引き続き PDF export、verification、fallback の正本である。shipping chain が無効化された文書や、label 乖離で `shipStale` になった状態では、cold canonical が表示の権威を持つ。

## 8.10 旧バックエンド

v0/v1 バックエンドは現行リポジトリに存在しない。server から選択する経路もない。現行の fallback は、safety gate、block-level rescue、visual fidelity demotion、opaque mode、canonical layer の組み合わせである。

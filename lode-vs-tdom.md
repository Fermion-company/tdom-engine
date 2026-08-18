# Lode論文 × TDOM Engine — 徹底比較と新論文の実現可能性

- 対象論文: Clemens Lode, **"Real-Time LuaTeX: Recompiling Large Documents in 1ms"** (TUGboat 草稿、draft: 2026-06-13、`lode-realtime.pdf` 全4ページ)
- 対象コード: `tdom-core` HEAD `5aa14d9`(2026-08-16 時点)。engine/checkpoint 全40モジュール + `daemon.lua`(1406行) + `shipd.lua` + `server.js` + `web/` + `tests/` 6ファイル + `tools/` 11ファイル + `corpus/` 13ファイル + docs 全12章を精読(本体+調査エージェント5系統で全行読了)

---

## 0. 結論 — 3つの質問への答え

| 質問 | 答え |
| --- | --- |
| ① 今のリポは論文の延長にあるのか | **延長ではない。独立した収斂進化。** 同じテーゼ(「編集中に全文コンパイルは不要」)を共有するが、機構はほぼ全ての層で異なり、**TDOMの方が大きく先まで実装している**。リポ内にLode/texlodeへの言及はゼロ、系譜として引いているのはTeXpressoとTypstのみ |
| ② 取り入れてもっと良いものが作れるか | **アーキテクチャ面で輸入すべきものはほぼ無い。** ただし論文が突きつける「宿題」が3つある: **(a) microtype**(論文の看板機能、TDOMは完全未対応・未検証)、**(b) レイテンシ数値の計測・公表方法論**(TDOMは方針として数値を残していない)、**(c) HCI枠組み**(100ms/16ms)。小物として (d) cmap外グリフのアウトライン描画ブリッジも有用 |
| ③ 新しい論文を書けるか | **書ける。しかも強い。** 差別化軸は明確(§7): 検証された忠実度・大域効果の増分収束・無改造エンジン上のfork checkpoint・増分正本(shipping chain)。証拠インフラ(4審判スタック)は既に存在し、**不足しているのは性能の実測値だけ**。計測器具(`bench-typing.mjs`/`gen-long-doc.mjs`)も既にある |

---

## 1. 論文の要約

### 1.1 主張

1行にすると: **「行分割は段落局所的、改ページは大域的だが知覚的に即時である必要はない。だから編集した1段落だけを常駐LuaTeXで再コンパイルし(~1ms)、残りはバックグラウンドの全文コンパイルで収束させればよい」**。

- ワープロ(Word/InDesign/Google Docs)が数十年前からやっているパターンのLuaTeX版、という位置づけ。
- 「一時的な不整合(見ていないページの遅延)」を明示的なトレードオフとして受け入れる。
- エンジン無改造・素のTeX Live・full microtype対応を強調。

### 1.2 数値(論文のTable 1–4)

| 計測 | 値 |
| --- | --- |
| 段落1個の行分割時間(中央値) | 短(1行) 0.17ms / 中(4–5行) 0.70ms / 長(10行+) 1.99ms / インライン数式 0.20ms / ディスプレイ数式 0.11ms |
| 往復合計(LuaTeX+IPC+デシリアライズ) | 短 0.79ms / 中 6.11ms(LuaTeX本体が80%超) |
| セッション内500回連続コンパイル | 劣化なし(0.09–1.93ms) |
| Typst 0.14.2 比較(同一段落編集) | Typst: 12.6ms(10p)/76ms(100p)/206ms(300p) — **O(n)**。LuaLaTeX段落再コンパイル: 常に0.70ms — **O(1)** |

ベンチは `github.com/texlode/luatex-benchmark` で公開。HCI根拠として Card/Moran/Newell の100ms閾値と60Hzの16msフレーム予算を引用。

### 1.3 機構(texlode)

1. **常駐LuaTeX**: 起動~1秒を回避。段落ソースを受けて結果を返すプロセスを維持
2. **PDFを介さない出力**: 行分割後のノード構造からdisplay list(位置つきglyphストリーム、sp単位)を直接抽出。microtype調整も含めTeXの内部位置計算を再現し「標準LuaLaTeXと同一の出力」を主張。「前例のない内部規約のリバースエンジニアリング」と自己評価
3. **ブラウザ描画**: glyphストリームをopentype.js経由でHTML5 Canvasにパス描画
4. **バックグラウンド収束**: 全文コンパイルを周期実行し、ページ位置キャッシュを生成。高速パス段落は**キャッシュされた位置にオーバーレイ**。ページ番号・相互参照・floatは数秒で収束

### 1.4 論文自身が認めている限界

- 高速パスは**本文段落のみ**。脚注(ページ分割と結合)、カウンタ依存(`\ref`/`\thepage`)、周辺コードが設定する`\parshape`は分離コンパイル不能 → すべてバックグラウンド全文コンパイル行き
- 見ていないページは収束まで古いまま(temporary inconsistency)

### 1.5 論文が触れていない問題(=空き地)

- **検証がない**: 「出力は標準LuaLaTeXと同一」は主張であって、それを機械的に検査する仕組み・方法論の記述がない
- **改ページ・float・脚注・折り返し参照のライブ更新**: すべて全文コンパイル待ち(数秒)
- **表示の劣化制御**: 描けない字形・危険な構文をどう扱うかの体系がない(Canvas描画は常に描く)
- **増分の正本**: バックグラウンドは常に全文再コンパイル。文書が育つとこの収束時間はO(n)で伸びる — 皮肉にも自分がTypstに向けた批判と同型の問題が正本側に残る
- CJK/日本語組版への言及なし

---

## 2. TDOMの現在地(コード全読の要約)

### 2.1 4層アーキテクチャ

| 層 | 実装 | 役割 |
| --- | --- | --- |
| 速い仮表示(checkpoint) | `engine-v3.js` + `daemon.lua` + `pagebuilder.js` | fork checkpointから編集ブロックを実MVL上で再組版、JSでTeXの改ページを即時再実行 |
| 正しい全体出力(canonical) | `canonical.js` | 素の`lualatex`をaux不動点まで(≤3パス)。表示の最終権威・PDF出力の正本 |
| 危険部分の画像差し替え(exact chunk) | resident RENDER / canonical crop / isolated render | 数式行・TikZ・rescue環境を**実PDFピクセル**のSVGで表示 |
| ページ単位の増分正本(shipping chain) | `shipping.js` + `shipd.lua`(`TDOM_SHIP=1`) | 実output routineのままページ境界checkpointを取り、編集後は途中から再ship |

### 2.2 ホットパスの実像(`docs/10` + コード確認済み)

- checkpoint = **fork()した常駐lualatexプロセスそのもの**(71行のCシム`tdomfork.c`を`package.loadlib`。エンジン・カーネル無改造)。マクロ・catcode・カウンタ・フォント・box registerをJS側で保存/復元しない
- 編集1回 = 最寄りcheckpointからのreplay + 編集ブロック + **有界検証**(galley発散8個/局所状態4個まで)→ 3値verdict(`clean`/`counters`/`leak`)で停止。超過分は300msアイドル後の非同期チェーン(settle/rebuild)へ。次の編集は`bgAbort`+SIGKILLで即座に割り込む
- 編集位置ピン(`editHold`≤8)により定常打鍵は「fork 1回+ブロック1個組版」。テストは `blocksTypeset ≤ 2`・壁時計 <500ms を固定化
- 抽出は**実MVL**(`tex.lists.page_head`)から、改行後・**改ページ前**。dormant page builder(`\vsize=\maxdimen`+ダミーbox+`\holdinginserts=1`+output吸収)の下で「連続実行とバイト同一」の収穫契約。グルーは伸縮量・次数ごと運び、`pagebuilder.js`がtex.web §108のbadness計算・§679のinterline・LaTeX ltoutputのfloat配置・脚注・folio/parity(`\cleardoublepage`の空白verso合成まで)をJSで再実行。ページ境界スナップショットで増分再ページ(O(編集近傍))
- 相互参照は「生きたラベル表」: `\r@`/`\b@`をジョブごと注入、`tdomRefVals`で厳密記帳、後方参照はrefIndexで標的再組版、toc(≤3パス不動点)・ヘッダ/フッタ(実`\@oddhead`等をckpt0でTeX組版)・`\pagenumbering`までライブ

### 2.3 忠実度ドクトリン(「速くて汚い」は禁止)

- fidelity gate 3値: `safe-glyph`(実フォントファイル配信+ブラウザ整形全停止のSVG `<text>`) / `exact-preview-required`(実PDFピクセルchunk) / `canonical-only`
- **行粒度banding**: 数式を含む行だけがchunk帯、周囲の散文はglyphのまま
- 表示優先: fresh chunk > **stale chunk(前回の実ピクセル)** > glyph bridge > 空白。「一瞬古いが正確 > 速いが間違い」
- 検証: canonical着地ごとに文字bigram含有率で照合(≥0.8合格 / <0.5で確信的乖離のみ降格 / ±1ページ窓)。降格はソースhashに粘着。ブラウザのフォントロード失敗も`POST /font-fail`で還流し family ごと降格
- 数式フォント: OML/OMS/OMX/OT1スロット→Unicode静的表(`mathmap.js`) + Latin Modern双子 + TWIN実測メトリクスでcmexベースライン補正 + PUAシフト輸送

### 2.4 検証インフラ(4審判スタック) — 本リポの最大の資産

| 審判 | 何を証明するか | 精度 | 実行 |
| --- | --- | --- | --- |
| `verify-layout.mjs`(+`farm.mjs`) | **pseudo == real**: エンジンの全行ベースラインが実lualatex PDFのコンテンツストリーム(qpdf直読、pdftocairo非経由)と一致 | **0.1bp** | corpus 11文書、**298/298**、CIゲート |
| `compare-breaks.mjs` | **ノードストリーム同一**: `pre_output_filter`で実TeXの出力ルーチン発火ごとに自然グルー値・box寸法をダンプし、エンジンのページビルダーとLCS照合 | **0.02bp** | 手動/デバッグ |
| `fuzz.mjs` | **定義方程式**: シード付きランダム編集バースト後、増分エンジン状態 ≡ 同一ソースを新規起動したエンジン(全ブロックgalleyHash+stateVec)。壊れたTeXはfreeze semanticsでスコープし、逆編集で治癒経路も検証 | 完全一致 | CI(seed 1) |
| `tests/shipping.test.js` | ship済み各ページのpdftotext ≡ cold 2パスコンパイル | テキスト同一 | CI |

これに加えて `verify-edits.mjs`(現実的編集セッション後の display list vs 新規lualatex)、50件のテスト(hot-path 11件は有界性・決定性・凍結の固定化)、Engine Inspector(毎編集のdirty明細・キャッシュ統計・µs計時)。

### 2.5 制限(コードとdocsに記録されているもの)

- **microtype完全未対応**(リポ内に言及ゼロ。`margin_kern`/`expansion_factor`未処理)
- twocolumn / custom `\output` / shipout paint系 / `\newgeometry` / `\balance` → document-level opaque(編集は継続、表示はcanonical)
- 脚注の**ページまたぎ分割なし**(insert丸ごと)。insert class単一。`\enlargethispage*`のsqueeze無視。偶数ページの`\evensidemargin`は仮表示に未適用(canonicalが補正)
- hyperref系: 常駐shipout不可(isolated経路へ)、shipping chain無効化(`SPDFROOT`)
- luatexja深系譜の壁(fork系譜~25ページ超でin-chain jobがスピン)→ 3ストライク+25ブロック毎プローブ+非同期rescueで緩和
- POSIX fork依存(ネイティブWindows対象外)。checkpoint 1個 ~100–500MB(16GB機で実運用可能なようグリッド+キャップ+reap)
- 検証はテキストベース(幾何ではない): 全glyphが載って位置だけズレたページはbigram照合を通過し得る(0.1bp審判はfarm側にある)
- 性能数値は**リポに未記録**(docs/06 §6.7の方針)。目標値のみ: 打鍵→ページ更新 p95 ≤ 100ms、ship閲覧ページ ≤ 300ms

---

## 3. 機構対応表 — 論文 vs TDOM

| 問題 | Lode / texlode | TDOM |
| --- | --- | --- |
| 増分の単位 | 段落を**分離**コンパイル(文脈なし) | ブロック(\par境界、環境は不可分)を**全文脈つき**で(fork系譜が状態を運ぶ) |
| 常駐化 | 単一の常駐LuaTeXプロセス | fork checkpointの**プロセス木**(状態スナップショット群) |
| \parshape・カウンタ・フォント状態 | 分離不能 → 高速パス対象外 | checkpoint文脈により**構成上正しい** |
| 改ページ | 高速パスでは**やらない**(前回全文コンパイルの位置にオーバーレイ) | **毎打鍵JSで再実行**(tex.web移植+増分resume/splice、O(編集近傍)) |
| float / 脚注 / folio / ヘッダ | 全文コンパイル待ち | ライブ(ltoutput転写・insert会計・parity・実ヘッダboxのTeX組版) |
| \ref / toc / cite | 全文コンパイル待ち | 生きたラベル表+依存インデックス+後方参照パス+toc≤3パス不動点 |
| 出力検証 | なし(主張のみ) | bigram照合+自動降格、farm 0.1bp、compare-breaks 0.02bp、fuzz定義方程式 |
| 描けない字形・危険構文 | 体系なし(Canvasは常に描く) | 3値fidelity gate+行粒度banding+rescue+freeze+opaqueの**段階的劣化タキソノミー** |
| 正本(最終ピクセル) | 周期的**全文**再コンパイル(O(n)) | demand-paced canonical + **増分shipping chain**(ページ境界checkpointから尾部のみ再ship) |
| ブラウザ描画 | Canvas + opentype.jsパス | SVG `<text>` + **TeXが使った実フォントファイル配信**(整形無効化、失敗還流つき) |
| microtype | **対応を明言**(数値的に再現) | **未対応**(構造的にはexact chunkに逃げる設計だが本文には効かない) |
| 公表された性能値 | あり(0.09–1.99ms、O(1) vs Typst O(n)) | **なし**(計測器具はあるが方針として未記録) |
| CJK | 言及なし | luatexja/jsclasses対応、ja corpus、CJK bigram検証、原ノ味フォント配信 |
| エンジン改造 | なし | なし(Cシム1個をloadlib。TeXpressoとの決定的差) |

**共有しているテーゼ**(ここは完全に一致): 編集中に全文コンパイルは不要 / LuaTeXを常駐させる / ノード構造から直接取り出しPDFを迂回する / ブラウザで描く / 実コンパイルは裏で収束させる / ワープロと同じ「見ている場所だけ即時」パターン。

---

## 4. Q1: 今のリポは論文の延長にあるのか

**延長ではない。** 根拠:

1. **時系列と独立性**: リポは2026-07-04開始(それ以前の realtime preview プロジェクトのengine-focused port)。論文草稿は2026-06-13付だが未公刊(TUGboat Vol 0 (9999) = プレースホルダ)。`lode-realtime.pdf`は今日(8/16)untrackedで置かれたのが初出で、コード・docsのどこにもLode/texlodeへの言及がない。docs/01 §1.11が明示する系譜は**TeXpresso**(fork checkpoint発想の先行)と**Typst**(対極)のみ。
2. **機構の系統が違う**: Lodeの論文は§2で先行手法を「better checkpointing(TeXpresso) / smarter memoization(Typst) / faster engines(WASM)」と分類し、「そもそも全文コンパイルするな」を第4の道として提示する。TDOMは実は**「checkpointing × 全文コンパイルしない」の合成**であり、Lodeの分類表の外にいる。Lodeがcheckpointを「文書単位コンパイルを安くする道具」として退けた一方、TDOMはcheckpointを「**ブロック単位の文脈を正しく保つ道具**」として使った — 同じ部品の正反対の使い方。
3. **ただしテーゼは同じ**: 「行分割は段落局所・改ページは知覚的に非即時でよい」という中心的観察は両者共通(TDOMではsegmenterの\par境界設計とpagebuilder非同期化がそれに相当)。だからこの論文は**競合ではなく、TDOMの前提を独立に実証した補強材料**として使える。特に論文のTable 1(行分割~1ms)は、TDOMの「有界個数のブロックをin-contextで組み直しても単桁msに収まる」というホットパス設計の妥当性をそのまま裏書きする。

---

## 5. Q2: 論文を取り入れて、もっと良いものが作れるか

「作れる」。ただし輸入すべきはアーキテクチャではなく、**論文が可視化した弱点の潰し込みと、証拠の出し方**。優先順に:

### 5.1 microtype対応(最重要・唯一の機能面での明確な負け)

- 現状: `daemon.lua`のwalkは`margin_kern`ノード非対応・`expansion_factor`未読。font expansionはTeX側でグリフ幅を変えるが、ブラウザ配信フォントは基本advanceのまま → **run内で座標がドリフト**する。protrusionは行端がズレる。しかもbigram検証は幾何を見ないので**自動降格も効かない**(farmの0.1bp審判だけが捕まえる)。
- やること(段階式):
  1. `corpus/`にmicrotype文書を追加してfarmを走らせ、実際の乖離量を測る(まず事実確認。CI上で安全)
  2. 対応する場合: walk_hで`margin_kern`を通常kernとして処理し、`expansion_factor≠0`のglyphでrunを分割して座標を明示送信(runモデルの例外化)。twin側は等幅スケールで近似
  3. 当面の安全策: preambleにmicrotypeを検出したら該当行をexact chunk寄せ(数式と同じ扱い)にする1行ゲート
- 効果: 論文の看板機能に対する「未対応」を「対応(かつ**検証済み**)」に変えられる。逆にここを放置すると、新論文で「full fidelity」を主張した瞬間に一番刺されやすい穴になる。

### 5.2 レイテンシ計測の実施と公表(論文化の必須条件)

- 論文は数値で語り、ベンチレポを公開している。TDOMは方針(docs/06 §6.7)で数値を置いていないが、**論文にはこの方針は使えない**。
- 既にある器具で足りる: `bench-typing.mjs`(3箇所×p50/p95/max、typeset内訳つき)、`gen-long-doc.mjs`(規模スケーリング文書生成)、Inspectorのµs内訳、`resume wave: Nms`ログ。
- 追加すべき計測(§7.4に統合): 文書規模スケーリング(10/100/300pp — Lodeの表と直接比較可能な形式)、**time-to-verified**(編集→canonical ✓までの整合性ウィンドウ — 誰も報告していない指標で、TDOMのshipping chainが効く場所)、メモリ(checkpoint数×RSS)。
- 注意: AGENTS.mdの機械保護規則(ローカルでbench禁止)があるので、**CIに`npm run bench`ステップを足して artifacts に JSON を残す**のが正道。

### 5.3 HCI枠組みの採用(論文の書き方)

Card/Moran/Newellの100ms閾値・16msフレーム予算という評価軸は、TDOMのp95 ≤ 100ms目標(ROADMAP Phase 0 条件B)とそのまま噛み合う。新論文のイントロ/評価節でこの座標系を使う(先行として同じ物差しを使うことで比較可能性も出る)。

### 5.4 グリフアウトライン描画ブリッジ(小物・中効果)

論文のopentype.jsパス描画そのものは(選択可能テキスト・実フォント配信・整形無効化を既に持つ)TDOMの主経路より劣るが、**TDOMが「空白」に倒している`xb`行(PUA/cmap外グリフ)とfont-fail時のブリッジ**としては有用: フォントファイルからアウトラインを引いてパス描画すれば、chunk到着までの空白が消える。ドクトリンは維持(あくまでbridge層、exact chunkが最終)。

### 5.5 見送してよいもの

- **分離コンパイルtier**(Lode方式そのもの): fork不能環境(Windows)用の縮退モードとしては論理的にありうるが、opaque modeが既に「壊れない縮退」を提供しており、正確性の劣る第3のモードを増やす価値は薄い。
- **Canvas全面移行**: SVG+実フォントの現行方式の方が正確性・選択可能性・検証容易性で上。

---

## 6. TDOMが論文より先にいる点(=新規性の在庫)

新論文の貢献候補になりうるもの。いずれも**実装済み+テスト/審判で固定化済み**:

1. **無改造エンジン上のfork checkpoint**: TeXpressoはXeTeX改造が必要だった。TDOMは素のlualatexに71行のCシムをloadlibするだけ(`--shell-escape`)。「エンジンにfork(2)を教える」手法自体が単独で書ける
2. **文脈保存ブロック増分 + 自己検証収束**: stateVec(全カウンタ+`\prevdepth`+`\if@nobreak`+`\lastskip`)とgalleyHashによる収束判定、3値verdict、有界フォアグラウンド(8+4)、deferred chain(settle/rebuild)、定義編集のsuffix信頼没収 — 「TeX状態の増分再計算の計算体系」として提示できる。**定義方程式(増分≡新規起動)を反証可能な不変量としてfuzzerで殴り続けている**のが科学的に強い
3. **ライブ出力ルーチン**: 実ノードストリーム(自然グルー・伸縮次数つき)上でtex.web §108/§679とltoutput(float/脚注/folio/parity/ヘッダ)をJS転写し、ページ境界スナップショットで増分再ページ。「寸法を一つも発明しない」設計と0.02bp審判
4. **表示整合性ドクトリン**: 3値fidelity gate、行粒度banding、stale-first、フォント配信tier+失敗還流、検証による自動降格(ソースhash粘着)。「速くて間違った表示を一瞬も出さない」を機構として定式化
5. **増分正本(shipping chain)**: 実output routineのままページ境界でfork checkpoint、pager子の単ページPDF、`\DiscardShipoutBox`親、ラベルseed+truth-harvester再boot。**正本自体をO(尾部)にする**のは、Lodeの「周期全文コンパイル」の明確な上位互換。ユーザーのメモリにある「invisible canonical」ゴールのphase 1
6. **段階的劣化タキソノミー**: document-level unsafe(正確なリスト) / block-level rescue(`OUTPUT_HIJACK_RE`+splitMode実routine) / 行レベルbanding / canonical-only tier(marginpar/todonotes) / broken-TeX freeze semantics(治癒検証つき)。「CTAN資産の何がどの局所性を壊すか」の実証分類はLode §4の3行の観察を体系化したものに相当
7. **page-context不動点**: `\pagegoal−\pagetotal`依存の分割環境(mdframed/breakable tcolorbox)を0.25bp量子のoffsetで非同期不動点に収束させる — 論文はこの問題の存在すら言及していない
8. **CJK**: luatexja/jsclasses・禁則・JFMグルー・CJK bigram検証・~70ページ日本語ストレス文書。この領域の先行研究は事実上空白

---

## 7. Q3: 新しい論文を書けるか

**書ける。** 以下、設計案。

### 7.1 論文のテーゼ(案)

> 段落局所性は1msの本文編集を与える(Lode 2026)。しかし**使える**リアルタイムLaTeXエディタにはさらに3つが要る: (a) 大域効果(改ページ・float・脚注・番号・参照・目次)の**有界レイテンシでの増分収束**、(b) 表示が本物のLuaLaTeX出力と一致することの**機械検証と検証失敗時の段階的劣化**、(c) 正本コンパイル自体の増分化。TDOMは無改造LuaTeXの上でこの3つを実装し、0.1bp/0.02bpの審判とランダム編集fuzzで「増分≡新規起動」を継続的に検証している。

Lodeが「fast path + eventual convergence」なら、こちらは **「verified incremental typesetting」**。役割が直交するので、潰し合いではなく積み上げになる。

### 7.2 貢献主張(候補、3–4個に絞る)

1. fork-checkpointed **unmodified** LuaTeX(Cシム1個)と、ブロック粒度の文脈保存増分モデル
2. 自己検証収束(stateVec/galleyHash/verdict/有界フォアグラウンド)と、その正しさを固定化する**参照審判群**(0.1bp layout referee / 0.02bp node-stream referee / fuzz定義方程式)
3. 表示整合性ゲートと段階的劣化タキソノミー(never-wrong-pixels)
4. (紙幅があれば)shipping chain = ページ境界checkpointによる増分正本

### 7.3 既に手元にある証拠

- farm 298/298(CIゲート済)、fuzz「EQUATION HOLDS」、50テスト(有界性・決定性・凍結・shipping同一性)
- corpus 13文書(数式・float・脚注・参照・rescue環境・includepdf・**期待opaque**・enlarge・marginpar・日本語混植)
- 実装の定量的ディテール(本mdの§2)と、コメントに記録された実測エピソード(2分→msの改善、OOM事例、fuzz seedで見つかったバグ群) — 「見つけて塞いだ穴」の記録は論文のcredibilityになる

### 7.4 足りない証拠(論文化前にやる実験リスト)

| 実験 | 器具 | 出すもの |
| --- | --- | --- |
| 打鍵レイテンシ分布 | `bench-typing.mjs`(CIで) | 3箇所×p50/p95/max、typeset内訳。目標p95≤100msの合否 |
| 文書規模スケーリング | `gen-long-doc.mjs`で10/100/300pp級を生成 | 編集レイテンシ vs ページ数(Lode Table 4と同形式で並べる) |
| time-to-verified | canonical/ship SSEのタイムスタンプ | 編集→「✓ exact」までの整合性ウィンドウ分布。shipping chain有無の比較 |
| メモリ | ps/RSS計測 | checkpoint数×文書規模のメモリ曲線(誠実なコスト報告) |
| (強く推奨)実文書分類 | safety gate + farm | arXivサンプル等でstructured/rescue/opaqueの割合 — 「実世界のLaTeXの何%がライブになるか」は最強のテーブルになる |
| (任意)対Typst/texlode | 公開ベンチレポの方法論 | 同一シナリオ比較。texlodeは10月公開予定なので入手可能になってから |

注意: AGENTS.mdの規則によりベンチはCIで走らせる(ローカル禁止)。

### 7.5 骨子案(TUGboat想定、6–10p)

1. Introduction — コンパイル待ち問題、ワープロパターン、Lode(2026)の段落局所性の実証を引き、その先の3課題を提示
2. Background — TeXのバッチモデル、LuaTeXの拡張点、TeXpresso/Typst/texlode(docs/01 §1.11がほぼそのまま使える)
3. Architecture — 4層、fork checkpoint(Cシム)、daemon収穫契約(バイト同一MVL)、JSページビルダー
4. Incremental convergence — stateVec/verdict/有界フォアグラウンド/deferred chain/ラベル・toc不動点
5. Fidelity — gate 3値、行banding、exact chunk 3経路、検証と降格、劣化タキソノミー
6. Shipping chain — 増分正本(短くてもよい、phase 1と明記)
7. Verification methodology — 4審判スタック(この節が本論文の独自性の核。「主張ではなく審判」)
8. Evaluation — §7.4の数値
9. Limitations — §7.8を正直に
10. Conclusion

### 7.6 投稿先

- **第一候補: TUGboat**。Lode論文・TeXpresso論文と同じ場で、読者層がそのまま利害関係者。システム論文として自然。日本語圏ならTeXユーザの集い/TUG年次も接続可
- **学術寄りに育てるなら: ACM DocEng**(Document Engineering)。「verified incremental typesetting」はDocEngのど真ん中。fuzz+referee方法論を前面に出す構成に組み替える
- 2段構え(TUGboatでシステム記述 → DocEngで検証方法論を深掘り)が現実的

### 7.7 Lode論文の引き方

- 競合ではなく**前提の実証**として引く: 「per-paragraph line breaking is ~1ms(Lode 2026)— 本システムはこの局所性を文脈保存つきで利用し、さらに大域効果と検証を扱う」
- texlode(2026年10月公開予定)とtdom-engineは同時代の独立実装であることを明記(fair attribution。TUGboat草稿段階なので、公刊誌面が出たらそちらを引用)
- Typst比較はLodeの数値を再利用しつつ、自前でも1点measure(方法論の借用を明記)

### 7.8 論文に正直に書くべき限界

microtype未対応(§5.1をやるまで) / twocolumn・custom output routineはopaque / 脚注分割なし / hyperrefでshipping無効 / fork依存(Windows外) / メモリコスト(数値で) / 検証のテキスト性(幾何審判はオフラインfarm側) / luatexja深系譜の壁。 — この「限界を列挙できる精度」自体が、劣化タキソノミーという貢献の裏面なので、隠すより武器にする。

---

## 8. 推奨アクション(優先順)

1. **microtypeの事実確認**: corpus追加+farm(CI)で乖離を測る → 対応 or 検出ゲート(§5.1)
2. **CIにbench+スケーリング計測を追加**し、JSONを残す(§5.2、§7.4)
3. **time-to-verified計測**を入れる(編集→✓ exactのウィンドウ。shipping chainの存在意義を数値化)
4. arXiv系サンプルでの**safety gate分類調査**(structured比率の表)
5. TUGboat骨子(§7.5)で書き始める。§2/§3/§5/§7の材料はdocs/00–11とこのmdでほぼ足りる
6. (執筆と並行して)ユーザー既存ロードマップの ②twocolumn があれば最大の限界が1つ消えるが、**論文はtwocolumn未対応のままでも成立する**(劣化タキソノミーの側で語れる)

---

### 付記: 一言でいうと

Lode論文は「**1段落なら1msで組める**」ことを示した4ページの綺麗な計測+製品予告。TDOMは「**文書全体を、正しさを機械検証しながら、増分で組み続ける**」ためのエンジンで、論文が「今後の課題」にすら挙げていない領域(検証・劣化制御・増分正本・CJK)まで実装が進んでいる。関係は「延長」ではなく「同じ観察から出発した、より深い別解」。そして新論文の空き地は明確に残っている — 埋めるべきは実測値だけ。

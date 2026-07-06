# 第10章 編集ホットパスの不変量 — checkpoint fungibility と有界 foreground

この章は 2026-07 の第3次改修を説明します。対象は**編集1回あたりの計算量**です。
第8章（canonical）・第9章（fidelity gate）が「何を表示してよいか」を決めるのに
対し、この章は「打鍵から表示更新までに**何を計算してよいか**」を決めます。

## 10.1 何が問題だったか（実測）

改修前の構造は、編集のたびに次を行っていました。

1. 編集点より後ろの **checkpoint を全て破棄**（engine-v3 の update 冒頭）。
2. foreground で「最寄りの生存 checkpoint → 編集ブロック」を**直列 replay**。
3. 背景で「checkpoint が無い境界」を文書末尾まで直列再組版。ただし checkpoint
   は grid 間引き（maxCheckpoints=64）なので、**実質毎編集で文書の大半を再組版**。

その帰結（70ページ・285ブロックの和文ストレス文書での実測）:

- 編集コスト = 最寄り生存 checkpoint からの**距離**。中盤編集 267ms、
  直後の末尾編集 **6.4 秒**（背景再構築が追いつく前に距離を foreground で払う）。
- `stateVec` を変える編集（`\section` 挿入等）は収束 walk が止まらず
  **foreground が O(文書)**。
- 打鍵のたびに背景 walk が再起動し、アイドルでも CPU を焼き続ける。

## 10.2 3つの不変量

**I1 — 有界 foreground.** 1編集の foreground 組版は「編集されたブロック＋
検証ブロック1個」を上限とする。それより広い伝播はすべて非同期・
プリエンプティブ（編集が来たら即中断・後で再開）・stale-first
（古いが正しい galley を表示し続ける。第9章の原則と同じ）。

**I2 — checkpoint fungibility.** checkpoint（fork プロセス）の有効性を
「**揮発状態はジョブ開始時の注入で正規化できる**」前提で定義し直す。
揮発状態 = counters / `\prevdepth` / `\if@nobreak` / `\lastskip` / label 値。
label は従来から全ジョブで注入済み、`\lastskip` は primer で注入済み、
counters+pd+nobreak は rescue 継続（`#stateJobBody`）で実証済みの機構を
prelude に合流させる。**注入は lineage が編集をまたいで古い（vstale）
checkpoint を使うときだけ**行う。自然な親から資材が続く通常打鍵は
従来どおり無注入＝バイト同一。

これにより編集は接尾辞 checkpoint を**殺さない**（index を再キーするだけ）。
接尾辞が無効になるのは次の3つだけ:

- (a) preamble 変化 → 全再起動（従来どおり）。
- (b) 本文ブロックでのマクロ定義類（`\def`/`\newcommand`/`\let`/
  `\newenvironment` …）の編集 → 保守経路。
- (c) **検証ブロックの galley 不一致** → 追跡していない状態（フォント切替の
  漏れ等）が下流に流れた証拠 → 保守経路。

保守経路 = 従来の「接尾辞破棄＋直列再構築」だが、I1 により foreground には
乗せず、非同期・プリエンプティブに実行する。

**I3 — アイドル最小性.** 編集が来ない限り背景仕事ゼロ。伝播キューは
編集後 300ms のアイドルで開始し、次の編集で即中断。

canonical も同じ原理に従う（**従量制の権威**）。structured モードでは
canonical の成果物が消費されるのは「ユーザーが手を止めて見る瞬間」と
「書き出す瞬間」だけなので、再コンパイルは自らのコストに比例した
クールダウン（既定: 前回コンパイル時間 × 2、上限 30 秒）で間引く。
これにより canonical の CPU 占有率は文書サイズに関わらず約 1/3 で頭打ちに
なる（改修前は、コンパイル中に編集が来ると**終了直後にデバウンス無しで
次を開始**していたため、執筆中は 7 秒級コンパイルが切れ目なく連続した）。
opaque モードだけは「コンパイル＝表示」なので従来どおり即時
（pressure `display`）。

## 10.3 stateVec 差分の分類と伝播

編集ブロックの exit `stateVec` が変わった場合:

- **counter 成分のみの差分**（`\section` 挿入など）: 下流を JS で伝播する。
  counter を**書く**ブロック（exit が entry と異なる）と counter を**読む**
  ブロック（見出し正規表現・`\the<counter>`・`\arabic` 等）だけを
  非同期に再組版（vstale checkpoint ＋注入）。それ以外のブロックは
  galley 不変・stateVec を差分シフトするだけで正しい。
  純粋読者（本文中の `\thesection` 等）は正規表現が拾い、漏れは
  canonical と衛生スイープが受ける。
- **pd/nobreak/ls の差分**: 隣接ブロックにしか効かない局所状態。検証ブロック
  の再組版が吸収し、その exit が収束すれば伝播は終わり（従来と同じ）。
- **それ以外（検証 galley 不一致を含む）**: 保守経路。

## 10.4 メモリ・プロセス方針

- grid 間引き（maxCheckpoints）は従来どおり。
- **editHold**: 現在の編集 locus の checkpoint は間引きから保護し、連続打鍵を
  常に「fork 1回＋1ブロック組版」にする（直近2 locus まで）。
- renderHold は従来どおり（第9章）。

## 10.5 galley 同一性の安定化（前提バグ2件の根治）

チェーン温存は「同じ出力 ⇒ 同じ galleyHash」が成り立って初めて意味を持つが、
改修前はこれが**二重に破れていた**。どちらも「1文字編集で無関係なページが
大量に dirty になり canonical が剥がれる」の直接原因である。

1. **フォント id が lineage の産物だった。** daemon の font id は fork 系譜
   内の割り当て順で決まり、別の系譜では同じフォントに別の id（最悪、別の
   フォントに同じ id）が付く。さらに font メタは系譜ごとに一度しか報告され
   なかった。→ daemon は **galley が使う全 id のメタを毎回完全報告**し、
   orchestrator は採択時に id を安定キー `fnv1a(file|name|size)` へ書き換える
   （`#normalizeGalleyFonts`）。
2. **JSON のキー順が Lua のハッシュシードの産物だった。** `jenc` が `pairs()`
   順で emit していたため、同じ値でもプロセスが違えばバイト列が変わり、
   `JSON.stringify` ベースの全ハッシュ（galleyHash・ページ display list）が
   揺れた。→ `jenc` を**キーソート**で決定論化。

この2つの根治により「増分 = ゼロから」がハッシュ レベルで成立し、
（a) replay がページ identity を汚さない、（b) reconcile の再利用が正しく
効く、（c) 越エンジン・越セッションで同一文書が同一 identity を持つ。

## 10.6 gate の精度は「正規表現」ではなく「粒度」で上げる

opaque への降格を減らす正しい方向は、静的判定の精緻化ではない（TeX は
静的解析できない——見逃しはそのまま嘘の表示になる）。方向は3つ:

1. **粒度**: 文書単位の降格を、ブロック単位の隔離に下げる。`\includepdf`
   はこの改修で document-gate から block-rescue（isolated 実ページ ship →
   per-page chunk）へ移った。`\marginpar/\marginnote` は galley 箱の外に
   描くためチャンクでは切れる——canonical-only ブロック tier が入るまで
   文書降格のまま（follow-up）。twocolumn / shipout hook / eso-pic 系の
   全ページ装飾は本質的に文書規模なので据え置き。
2. **実証**: 静的 gate は粗い門番に留め、最終精度は検証（canonical 照合・
   検証ブロック・fidelity 降格）が担う。gate を大胆にできるのは検証網が
   受け止めるから。
3. **自己修復**: 一過性の boot 失敗（システム負荷・teardown 競合）で
   opaque に張り付かない。失敗した preamble につき1回だけ、20 秒後に
   structured boot を自動再プローブする（`#scheduleStructuredReprobe`）。
   本当に起動不能な preamble は再試行ストームなしで opaque に留まる。

付随修正: isolated rescue と常駐 root にも canonical と同じ
`TEXINPUTS=docDir//` を与えた（文書相対アセットの解決が3経路で一致）。

## 10.7 正しさの担保

- 定義式「**任意の編集列で 増分結果 = ゼロから開いた結果**」をプロパティ
  テスト化（tests/hot-path.test.js）。prose 編集・`\section` 挿入・定義編集・
  ブロック数が変わる編集（再キー検証）で、収束後の全ブロック
  galleyHash/stateVec とページ display list が新規エンジンと一致すること。
- 検証ブロックは従来と同じ「未追跡漏れの番人」。判定の使い途が
  「walk を続けるか」から「接尾辞を信用してよいか」に変わっただけ。
- canonical が最終権威であることは不変（第8章）。

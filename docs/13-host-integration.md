# 13. ホスト統合層（host/）

`host/` は、**別のアプリがこのエンジンを自分のプレビューとして動かすため**の層である。エンジン本体（`server.js` と `engine/`）には手を入れず、その外側でプロセスの生死・編集ストリーム・埋め込み表示だけを扱う。

`web/` の開発 UI は「エンジン単体を人が触るための薄いクライアント」であり、この層は「エンジンをアプリに埋め込むための配線」である。両者は独立していて、どちらか一方だけを使ってもよい。

## 13.1 何を解くのか

ホストアプリ側から見ると、エンジンは次の三つの現実を持つ。

1. **別プロセスである。** 常駐 lualatex を fork するため、ホストのプロセス内では動かせない。誰かが起動・監視・終了を持たなければならない。
2. **編集は差分で渡す。** ホストのエディタはバッファ全体を持っているが、エンジンが速いのは「変更範囲が小さいとき」である。打鍵ごとに全文を投げるとチェックポイント再利用が効かない。
3. **表示はエンジン側のクライアントが持っている。** ページの描画・canonical 差し替え・exact chunk の合成は `web/app.js` の仕事で、ホストがそれを再実装する理由はない。`?embed=1` はそのためにある。
4. **差し替えの瞬間が難しい。** ナビゲート直後・文書リセット直後の iframe は表示するものを持たない。1 フレーム早く見せれば空白か前の文書が見える。静的表示から live への切り替えは、そのまま実装すると必ず閃く。

`host/` はこの四つにモジュールを当てる。

| ファイル | 実行場所 | 役割 |
| --- | --- | --- |
| [`host/engine-dir.js`](../host/engine-dir.js) | Node | エンジン checkout の解決順序（env → checkout → vendored → 自リポジトリ） |
| [`host/engine-host.js`](../host/engine-host.js) | Node | ポート確保・spawn・readiness 待ち・状態・停止 |
| [`host/document-session.js`](../host/document-session.js) | Node | 最小レンジ編集・overlay 差分・再同期・`/warm` |
| [`host/http-json.js`](../host/http-json.js) | Node | `node:http` だけの JSON クライアント |
| [`host/index.js`](../host/index.js) | Node | 上記を束ねた `createLivePreviewHost()` |
| [`host/live-driver.js`](../host/live-driver.js) | ブラウザ / Node | 打鍵 → push のデバウンス、単発キュー、世代管理、健全性監視 |
| [`host/embed-client.js`](../host/embed-client.js) | ブラウザ | `?embed=1` iframe との postMessage 往復 |
| [`host/live-surface.js`](../host/live-surface.js) | ブラウザ | ページ領域を live に差し替える状態機械。二フレーム reveal バリアと文書リセット握手 |
| [`host/live-toolbar-state.js`](../host/live-toolbar-state.js) | 純関数 | ライブ中のツールバー数値 |
| [`host/live-status.js`](../host/live-status.js) | 純関数 | エンジン status → 一意なビューア状態 |
| [`host/live-surface.css`](../host/live-surface.css) | 参照 CSS | 重なり順の規約 |

`host/live-driver.js` はタイマーを注入でき、`host/live-surface.js` は iframe・ホストウィンドウ・`requestAnimationFrame` をすべて注入できる。したがって DOM なしで実行でき、テストは Node で走る。

## 13.2 最小の使い方

```js
import { createLivePreviewHost } from './host/index.js';

const host = createLivePreviewHost({ workDir: '/abs/path/to/scratch' });
await host.start();                              // spawn して /status が返るまで待つ
await host.push({ source, path: '/abs/main.tex' }); // 打鍵のたびに全文を渡す
host.getStatus().url;                            // → http://127.0.0.1:4646
host.stop();                                     // SIGTERM。常駐 TeX ツリーごと回収される
```

`push` に渡すのは常に**現在のバッファ全文**である。差分計算は `DocumentSession` 側が持つ（[13.4](#134-編集ストリーム)）。

## 13.3 エンジンの解決とプロセス

`resolveEngineDir()` の順序は次の通りで、**開発 checkout が vendored コピーより優先される**。ホストアプリに同梱したコピーを使うのは、checkout が存在しないときだけである。

1. `TDOM_ENGINE_DIR`（env）または `engineDir`（明示指定）
2. `~/Developer/tdom-engine` → `~/tdom-engine` → `~/Desktop/tdom-engine`
3. `vendoredDir`（ホストが同梱したコピー）
4. このリポジトリ自身（`host/` の一つ上）

候補ディレクトリを列挙できないサンドボックス化されたホストは `fileAccess` を差し替える。`probeIfAllowed` が `null` を返した候補は「見ていない」であって「無かった」ではなく、その場合 `resolveEngineDir()` は `needsAccess` に権限キーを載せて返す。ホストは「エンジンが見つからない」ではなく権限要求を出せる。

`EngineHost` が spawn 時に固定する環境変数は、いずれも**ホストと同居するために必要**な値である。

- `TDOM_MAX_CHECKPOINTS`（既定 `8`）: checkpoint 1 個が常駐 lualatex 1 個（100–300MB）。エンジン既定の 64 は専有マシン向けで、エディタや LSP と同居するホストでは踏めない。
- `TDOM_SAMPLE`: boot 用に `samples/` に実在する小さいファイルを選ぶ（`pickBootSample()`）。既定の stress-test 文書は起動に数分かかる。実文書は起動直後の `POST /open` で入れ替わる。
- `TDOM_WORKDIR`: 絶対パスの作業ディレクトリ。vendored な（書き込めない）checkout の中にスクラッチを作らせない。
- `TDOM_SHIP` / `TDOM_SHIP_PRIVATE_PDF` / `TDOM_CANONICAL_ANCHOR`（既定すべて `1`）: いずれも打鍵経路の外で動き、対応できない preamble では通常の canonical コンパイルに fail close する。
- `PATH`: `binDirs` に渡されたホストの TeX bin ディレクトリを先頭に置き、続けて `/opt/homebrew/bin` `/usr/local/bin` `/usr/bin` `/bin` を足す。poppler（`pdftocairo` / `pdftotext` / `pdfinfo`）と fork shim をビルドする `cc` は TeX ツリーの外にあり、GUI から起動されたアプリは PATH をほとんど継承しない。
- `TDOM_PDFJS_PATH` / `TDOM_HOST_WEB_ROOT`: ホストが既に持っている pdf.js やアセットを再利用させる。エンジンを単体で依存ゼロに保ったまま、同じものを二重に入れずに済む。

ポートは 4646 起点で空きを探す。エンジンの開発既定は 4633 で、checkout で `npm start` している開発者と埋め込みエンジンが同じポートを取り合わないようにしている。

Electron ホストは `execPath: process.execPath` と `extraEnv: { ELECTRON_RUN_AS_NODE: '1' }` を渡す。ユーザーのマシンに Node があることを前提にしない。

## 13.4 編集ストリーム

`DocumentSession` は「エンジンが最後に受理したソース」を保持し、次の push との共通 prefix / suffix を削って `POST /edit` に渡す（`diffEdit`）。文書の同一性が変わったとき—`fresh` 指定・ファイルパスの変更・セッションキーの変更・エンジン再起動—だけ `POST /open` になる。

プロジェクト（`workspaceRoot` + `rootFile`）を渡した場合:

- 組版対象は常に **root 文書**である。子ファイルのタブに切り替えただけで root が差し替わることはない。
- 未保存の子バッファは **overlay** として渡り、変わったものだけが差分として送られる。閉じられた（または保存された）バッファは `removeOverlays` で外れる。
- root が未変更で mtime も同じなら、ディスクを読み直さず保持中のソースを使う。無意味な全文 diff を避ける。
- `workspaceRoot` の外へ出るパスは拒否される。

`POST /edit` が失敗したときは、その場で `POST /open` を投げて再同期する。ホストとエンジンのソース認識がずれた状態で差分を重ねると、以後の編集がすべて壊れるためである。

`focus({ offset })` は `POST /warm` を叩き、カーソル位置周辺の常駐チェーンを投機的に温める。文書が開かれる前は意味がないので `ok: false` を返す。

## 13.5 ライブドライバ

`createLiveDriver()` は、打鍵とタブ切り替えの速さが LuaLaTeX より速いことから来る問題だけを扱う。任意の瞬間に「ユーザーがもう離れた文書の push」が飛んでいる可能性があるため、間違いうるものすべてに版を振る。

| 版 | いつ上がるか | 何を無効化するか |
| --- | --- | --- |
| `lifecycleVersion` | プレビュー停止、エンジン再起動 | それ以前に発行した全 push |
| `pushVersion` | snapshot を1つ enqueue するたび | 直前までの結果（最新のみ採用） |
| `generation` | 表示面を採り直させたいとき | ビューア側の冪等判定（URL が同じでも再適用させる） |

- **デバウンスは 80ms**。エンジンは打鍵を 20–60ms で組むので、体感遅延を支配するのはデバウンス側である。300ms にすると 50ms のパイプラインが 0.5 秒に感じられる。
- **キューは単発・最新勝ち**。組版中の打鍵は「保留中の1件」を置き換える。すでに古い文書状態の FIFO を積まない。
- **プロジェクト切り替えは、新しい push より先に旧表示を降ろす**。前プロジェクトの `/open` が完了して iframe を一瞬蘇らせるのを防ぐ。
- **古い失敗はエラーにしない**。停止後・新しい編集後・プロジェクト変更後に届いた reject は、保留中の snapshot を捨てず、エラー面も出さない。
- **状態はポーリングで取る**（`refresh()`）。ホストはエディタの model を差し替えたりプロジェクトを切り替えたりを単一のイベントでは表現できない。実際の session key とバッファが真実で、一致していれば push は no-op になる。
- **健全性監視**（`checkHealth()`）でエンジンの死を検出したら、世代を上げてから再起動する。OS が新プロセスに同じポートを配ってもビューアが取り違えない。

IME 変換中は snapshot に `deferred: true` を立てる。ドライバは push せず自分を再スケジュールする（変換中のバッファは一時的なもので、変換キーごとの組版は無駄になる）。

## 13.6 埋め込み表示

`?embed=1` のとき、`web/app.js` は topbar・エディタ・インスペクタを隠してページだけを描く。ホストは自分のビューアのページ領域だけを iframe に差し替え、ツールバーは自前のものを使う。`?theme=light|dark` と `?bg=%23rrggbb` はホストの配色に合わせるためにある。

`createEmbedClient()` はその postMessage 往復を包む。

- ホスト → frame: `{ source: 'tdom-host', activationId, action, ... }` — `zoom-in` / `zoom-out` / `zoom-fit` / `goto-page` / `page-prev` / `page-next` / `goto-sync` / `search` / `reset-ack`
- frame → ホスト: `{ source: 'tdom-embed', activationId, ... }` — 400ms 間隔のスナップショット（`ready` / `pageCount` / `zoom` / `page` / `status` / `search`）に加え、`reset-pending`（文書リセット開始）・`source`（クリック位置のソース逆引き）・`edit`（プレビュー直接編集）

`activationId` は URL でホストが渡す。前の活性化から残った iframe が、すでに別の文書やエンジンへ移ったビューアを操作できないようにするためである。

## 13.7 ライブ面の差し替え（live-surface.js）

`createLiveSurface()` は、ホストのビューアが**静的 PDF を表示したまま**ページ領域だけを live に差し替えるための状態機械である。ここが一番壊しやすい。ナビゲート直後の iframe も、リセットのために文書 DOM を捨てた直後の iframe も、**表示するものを持っていない**。1 フレーム早く見せれば、空白か前の文書が見える。

### 二フレーム reveal バリア

1. **iframe は常に描画し続ける。** 不透明な静的カバーの下に置くだけで、`visibility: hidden` にはしない。Chromium は隠れた cross-origin iframe のラスタライズを省くことがあり、可視化した瞬間に空の backing store を 1 フレーム露出させる。活性化で変えるのは**重なり順だけ**である。
2. 子が特定の `documentEpoch` について `ready: true` を宣言する。これは**子自身の paint についての主張**であって、コンポジタについての主張ではない。
3. ホストはそこから**アニメーションフレームを 2 回**待つ。1 回目は ready な子がカバーの下で描くため。2 回目は重なり順の変更だけを含むため、どの commit にも古い／空の backing store が入り得ない。
4. 文書リセットは同じバリアを逆向きに走らせる。ホストが静的カバーを戻し、**新しい重なり順を確定させてから**（`getComputedStyle` によるスタイル解決の強制）`reset-ack` を返す。先に返すと、子が古い DOM を捨てた瞬間に何も無い面が見える。

フェーズは iframe の `data-live-phase` に書かれ、`onPhase` でも通知される。`off` → `activation-pending` → `staging` → `active`、リセット時は `active` → `reset-pending` → `staging` → `active`。重なり順の規約は [`host/live-surface.css`](../host/live-surface.css) にある。ホスト側の静的面を pending 中に iframe より上へ置くのはホストの責任である。

### 間違いうるものすべてに版を振る

| 版 | 何を守るか |
| --- | --- |
| `activationId` | 前の活性化から残った frame が現在のビューアを操作できない |
| `generation` | 同じエンジン URL でも「別の面」として採り直させる |
| `documentEpoch` | リセット待ちの epoch 以外の `ready` は無視。古い epoch へ戻らない |
| reveal token | 予約済みバリアを無効化する。同じ epoch の再スナップショットは**バリアを引き延ばさず**最新ペイロードだけ差し替える |

`source`（クリック逆引き）と `edit`（プレビュー直接編集）は、採用済み epoch と一致するときだけホストへ渡る。

### 静的文書のフリーズ

live が面を持っている間、ホストは静的文書を読み込み直してはならない。iframe の下からカバーを引き抜くことになり、このモジュール全体が防いでいる閃きが起きる。`deferStatic(request)` に預けると、live が降りて 1 フレーム経ってから最新の 1 件だけが `onStaticRestore` で返る。

> 元実装（TeX64 の pdf-viewer）では、live off → on が同一フレーム内で起きると保留中の静的文書が捨てられていた（復帰分岐が到達不能だった）。ここでは保留リクエストをフィールドに残し、次に live が降りたときに渡すよう直してある。

### ステータス

`resolveLiveStatus()` はエンジンの status スナップショット（`up` / `busy` / `mode` / `canonical.inFlight` / `canonical.error` + `errorRev`）から、ビューアの 1 行に出せる状態をひとつだけ決める。順序が意味そのものである。`canonical.inFlight`（実 LuaLaTeX 経路）は汎用 busy より優先し、現ソースより古い revision のエラーは既に打ち消されたものとして扱う。`key` はホストが自前の文言へ写すメッセージ ID で、`message` があるときはエンジンの生テキストをそのまま出す。

ツールバーの数値は `normalizeLiveToolbarSnapshot()` が持つ。子は部分スナップショット（zoom だけ、page だけ）を送るので単純代入にはできず、ページ送りは子の次の 400ms スナップショットを待たずに**クリックした瞬間**に動く必要がある。

## 13.8 テスト

エンジンを起動しない。`tests/fixtures/fake-engine/server.js` が `/status` `/open` `/edit` `/warm` `/doc` だけを持つスタンドインで、ホストが実際に送ったレンジと overlay をそのまま検査できる。

```
npm run test:host
```

`live-surface.js` のテストは iframe・ホストウィンドウ・`requestAnimationFrame` をすべて差し替え、**アニメーションフレームを 1 回ずつ手で進める**。バリアの両側（ready だけでは何も変わらない / 1 フレーム目でもまだ変わらない / 2 フレーム目で初めて切り替わる）が決定的に観測できる。実ピクセルの検証はブラウザが要るのでここにはない。TeX も lualatex も要らないので、`AGENTS.md` のマシン安全ルール（エンジンを起動するテストはローカルで走らせない）に触れない。

## 13.9 Electron の例

[`integrations/electron/`](../integrations/electron/) に main プロセスの IPC 配線と preload ブリッジがある。エンジンの依存ではなく、参照用の実例である。Electron main は CommonJS、このパッケージは ESM なので、host 層は動的 import で読み込む（IPC ハンドラはもともと非同期なので実害はない）。

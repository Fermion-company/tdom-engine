# 13. ホスト統合層（host/）

`host/` は、**別のアプリがこのエンジンを自分のプレビューとして動かすため**の層である。エンジン本体（`server.js` と `engine/`）には手を入れず、その外側でプロセスの生死・編集ストリーム・埋め込み表示だけを扱う。

`web/` の開発 UI は「エンジン単体を人が触るための薄いクライアント」であり、この層は「エンジンをアプリに埋め込むための配線」である。両者は独立していて、どちらか一方だけを使ってもよい。

## 13.1 何を解くのか

ホストアプリ側から見ると、エンジンは次の三つの現実を持つ。

1. **別プロセスである。** 常駐 lualatex を fork するため、ホストのプロセス内では動かせない。誰かが起動・監視・終了を持たなければならない。
2. **編集は差分で渡す。** ホストのエディタはバッファ全体を持っているが、エンジンが速いのは「変更範囲が小さいとき」である。打鍵ごとに全文を投げるとチェックポイント再利用が効かない。
3. **表示はエンジン側のクライアントが持っている。** ページの描画・canonical 差し替え・exact chunk の合成は `web/app.js` の仕事で、ホストがそれを再実装する理由はない。`?embed=1` はそのためにある。

`host/` はこの三つにそれぞれ一つのモジュールを当てる。

| ファイル | 実行場所 | 役割 |
| --- | --- | --- |
| [`host/engine-dir.js`](../host/engine-dir.js) | Node | エンジン checkout の解決順序（env → checkout → vendored → 自リポジトリ） |
| [`host/engine-host.js`](../host/engine-host.js) | Node | ポート確保・spawn・readiness 待ち・状態・停止 |
| [`host/document-session.js`](../host/document-session.js) | Node | 最小レンジ編集・overlay 差分・再同期・`/warm` |
| [`host/http-json.js`](../host/http-json.js) | Node | `node:http` だけの JSON クライアント |
| [`host/index.js`](../host/index.js) | Node | 上記を束ねた `createLivePreviewHost()` |
| [`host/live-driver.js`](../host/live-driver.js) | ブラウザ / Node | 打鍵 → push のデバウンス、単発キュー、世代管理、健全性監視 |
| [`host/embed-client.js`](../host/embed-client.js) | ブラウザ | `?embed=1` iframe との postMessage 往復 |

`host/live-driver.js` はタイマーを注入できるので DOM なしで実行でき、テストは Node で走る。`host/embed-client.js` だけが `postMessage` / `addEventListener` を必要とする。

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

`activationId` は URL でホストが渡す。前の活性化から残った iframe が、すでに別の文書やエンジンへ移ったビューアを操作できないようにするためである。`reset-pending` を受けたホストは、新しい重なり順を確定させてから `reset-ack` を返す。先に返すと、子が古い文書 DOM を捨てた瞬間に何も描かれていない面が見える。

## 13.7 テスト

エンジンを起動しない。`tests/fixtures/fake-engine/server.js` が `/status` `/open` `/edit` `/warm` `/doc` だけを持つスタンドインで、ホストが実際に送ったレンジと overlay をそのまま検査できる。

```
node --test tests/host-engine-dir.test.js tests/host-engine-host.test.js \
  tests/host-document-session.test.js tests/host-live-driver.test.js \
  tests/host-embed-client.test.js
```

`npm run test:host` が同じものを走らせる。TeX も lualatex も要らないので、`AGENTS.md` のマシン安全ルール（エンジンを起動するテストはローカルで走らせない）に触れない。

## 13.8 Electron の例

[`integrations/electron/`](../integrations/electron/) に main プロセスの IPC 配線と preload ブリッジがある。エンジンの依存ではなく、参照用の実例である。Electron main は CommonJS、このパッケージは ESM なので、host 層は動的 import で読み込む（IPC ハンドラはもともと非同期なので実害はない）。

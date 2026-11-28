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

- `TDOM_MAX_CHECKPOINTS`（既定は搭載メモリで決める: 12 GB 未満 `8`、12 GB 以上 `12`、24 GB 以上 `24`、48 GB 以上 `48`）: 常駐 checkpoint 数の**上限**。初回は `min(上限, block 数 + 1)`、canonical の実ページ数を得た後は `min(上限, block 数 + 1, page 数 + 1)` になる。小文書は root と1ページあたり最大1本、316ページ（約640 block）は上限まで持つ。休眠 fork の実コストは「fork以降に活動中の process が書き換えたページ」で、boot walk は fork 後にヒープのほぼ全体を書き換えるため316ページでは1個100〜200MBに育つ（macOS実測: 上限32で常駐32〜40個・合計7〜10GB、16GB機がswap 7GB）。以前の固定8は316ページで80 blockおきになり、カーソルを置いてから最初の打鍵が組版できるまで最大30sのwarmを要した。それでも間に合わない打鍵は `TDOM_COLD_PREFIX_MS`（エンジン既定1500）でhot pathから切り離され、残りはchain passが続けて`update`を後からbroadcastする（docs/10 §10.4a）。
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
- `removeOverlays` の時点でディスクが overlay と同じバイト列なら（保存）、エンジンは overlay ファイルを入力として残す（`savedOverlays`）。実効入力は変わらないので srcRev・anchor epoch・canonical の input epoch を進めず、その `/edit` は直前の report を返す。overlay が被さっているファイルへのディスク書込み（自動保存の fs.watch 通知を含む）も入力変化として扱わない。保存済み overlay と異なるバイト列がディスクに書かれたときだけ overlay を外し、通常の除去として refresh する。
- `\input` / `\include` で読んだファイルの fs.watch 通知は、ディスクのバイト列がエンジンの最後に読んだ内容と同じで、かつその内容を canonical に伝え済みなら捨てる（`include-cache.js`）。touch や、Spotlight・iCloud Drive・Dropbox などによる同じ内容の書き戻しは、srcRev も canonical の input epoch も進めない。捨てた数は `/status` の `unchangedInputEvents`。316ページの文書で `/open` 直後に33章すべてへ通知が届いたとき、以前は空の update が33回続き、最初の canonical が落ち着くまで305 sかかった。「伝え済み」の内容（`announcedText`）は、そのパスで最初に読んだ内容と、外部変更の refresh が canonical を無効化する直前のディスク内容である。cold resume や structured re-probe が新しいバイト列を読み直しても `announcedText` は変わらないので、その通知は捨てずに refresh する。refresh が待ち行列にある間に先行の refresh が同じバイト列を読んで伝え済みにした場合も、server はその refresh を行わない。画像や listing のように include として読んでいないファイルは、従来どおり通知ごとに refresh する。
- fs.watch はパスではなく inode を追う（macOS は kqueue、Linux は inotify）。vim や同期クライアントのように、一時ファイルを書いて rename で被せる保存をすると、古い watch は消えた inode に残り、以後は通知しない。`watchInclude`（`include-expander.js`）は `rename` 通知か、パスの inode（dev:ino）が変わった通知を受けると、その watch を閉じ、パスが今指すファイルに張り直す。通知そのものは 120 ms のデバウンス後に届ける。保存の途中でパスが一時的に無いときは、届ける直前にもう一度張り直す。それでも無ければ（削除）パスを `watchers` から外し、通知だけを届ける。refresh はその削除を読み、ファイルが戻った後にそれを読んだ最初の展開が watch を作り直す。同じバイト列の保存（上の項目で通知を捨てる場合）でも、張り直しはその判定より前に済んでいる。`watchers` の値はパスごとに一つの handle で、張り直しても変わらない。`close()`（`/open`・`setDocumentContext`・エンジン終了）は今の watch を閉じ、以後の張り直しも止める。server.js が保存済み overlay のディスク側に張る watch も同じ関数を使う。
- 子ファイル anchor の直前入力の検証は、ディスクが直前に読んだ内容と同じか、この編集の要求内容と同じで mtime が打鍵時刻（`clientEditAtEpochMs`）以降の場合だけ通す（編集がエンジンへ届く前に自動保存が同じ内容を書いた場合）。
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

- ホスト → frame: `{ source: 'tdom-host', activationId, action, ... }` — `zoom-in` / `zoom-out` / `zoom-fit` / `goto-page` / `page-prev` / `page-next` / `goto-sync`（任意の `viewportToken` を付けると、そのページへスクロールした後のスナップショットが同じ token を返す。`liveRevision` が frame の適用済み epoch・revision と一致すれば、その位置へ一度だけ動き、`sourceFile`・`sourceLine` からの精緻化はしない。一致しない Jump は位置を先に追わず、現在の紙面の答えで一度だけ動く。既に表示域の中ほどにある行・1 行未満の補正では動かない）/ `handoff-done`（token 付きの受け渡しをホストが表示し終えた。それまで frame は読み手の位置を保たない）/ `paper-width`（`{ fitPx, paperPx? }`：ホストの静的 PDF がページ幅に合わせて描く紙の幅と、いま描いている紙の幅。frame はその幅を zoom 1 とし、`paperPx` の幅で描く。読み手の操作ではないので Jump や受け渡しを取り消さない。ホストは frame を表示する前と隠れて追従している間の `goto-sync` の直前、ペインの幅が変わったときに送る。以前は frame の zoom 1 が min(92%, 640px) で、ホストの幅と食い違い、切り替えのたびに紙の幅が変わっていた）/ `search` / `reset-ack`。token 付きの `goto-sync` が `sourceFile`・`sourceLine`・`sourceFraction` を持てば、その行が resident のインクにあるページ（再ページ割りで移った先）へ行き、そこで token を受理する（無ければ従来どおりページと y）。スナップショットの `viewportCenter` は、中央の行が分かれば `source: { file, line, fraction }` を持つ（resident のインクから。exact 画素はスクロールが止まって 400 ms 後に SyncTeX で）
- プレビュー直接編集（紙面上のカーソルと入力面）と、編集した数式を組版が追いつくまで紙面に MathLive で重ねる表示のスイッチは `web/app.js` の `directEditingOn()` の 1 か所（テスト専用の `globalThis.__tdomDirectEditing`）。既定は origin/dev（504adab）のとおり有効で、止めるかどうかはオーナーが決める。止めている間はクリック・キー・貼り付け・選択の編集用リスナーを登録せず、MathLive も読み込まないので `edit` は届かない。Cmd/Ctrl+クリックの `source` と選択・右クリックの `place` は従来どおり
- frame → ホスト: `{ source: 'tdom-embed', activationId, ... }` — 400ms 間隔のスナップショット（`ready` / `presentationPending` / `pageCount` / `pageCountAuthoritative`（常駐側のページ数が実出力とまだ違うあいだ false。ホストは確定していない数を出さず「/ —」などにする）/ `zoom` / `page` / `srcRev`（適用済みの source revision）/ `viewportToken`（最後にスクロールした `goto-sync` の token）/ `painted`（表示域のシートすべてに紙面がある。resident の描画か、decode 済みの canonical・Build・last-good の画像。空の shell は紙面ではない。外側の紙の Build シートも、表示域にあればその画像の decode で数える。表示域に Build シートしかなければ live の 1 ページ目で代えない。`ready`・`presentationPending` も同じシートで決める。ホストは false の紙面を見せない）/ `tokenSheetShown`（最後に受理した viewport の `goto-sync` が名指ししたシートそのものが表示域の中央にある。端だけ残って中央が隣のシートのときは false。スクロールが紙の上端・下端で止まっていて中央に置けない点なら、そのシートがその端の側にあればよい。frame は token 付きの `goto-sync` を、そのシートがあるときだけ受理する。再構築中でまだないページを近い番号のページで受理しない。ホストはこれがあれば上端のページ番号の許容幅ではなくこれで位置を確かめる）/ `tokenPointShown`（さらに、そのシートの受理した点（`y`）が表示域の中央から表示域の高さの 1/8 以内にある。スクロールが紙の上端・下端で止まっていて中央に置けない点なら、その端の側にあればよい。シートだけでは、同じシートの上で中央が y=300 から y=500 へずれても受理されていた。点は受理のときに一度だけ、そのシートの紙の高さへ切り詰め、スクロールと確認に同じ値を使う（Build で y=770 だった点は、高さ 500 の live のシートでは 500。以前はスクロールだけ 500 に止まり、確認は 770 のまま通らなかった）。ホストはこれがあれば `tokenSheetShown` よりこれで確かめ、外れていれば同じ点へ送り直す。ホストは、名指しした位置と違うページへ送るとき（短い紙面へ縮めた位置、止まった後の近いページ）は、そのページだけの token（`<token>@<page>`）で送る。ページ 10 を求めて 5 で受理され、紙面が 10 まで伸びた後に、その受理を 10 の受理と取り違えない。進みの無いまま 8 s たつと、文書リセットなら一度だけ読み込み直し、それでも止まれば（最初の編集の受け渡しでは読み込み直さずに）点を手放し、frame が持つ最も近いページで、紙面が見せられる状態になり次第カバーを外す。カバーが残り続けることはない）/ `livePageCount`（live の章のページ数。外側の紙の Build シートは数えない。ホストは、名指しした live のページ（`livePage`）が完成した章にもう無いと分かったら、章の最後のページへ新しい token で渡し直す）/ `chapter`（外側の紙のとき、Build の章のシート `{ from, to }` を `goto-sync` の番号付けで。静的な Build のビューアから取った位置は `page` しか持たないので、ホストはこの範囲にある `page` を live のページ `page - from + 1` として解き、上と同じく渡し直す）/ `pageCountSettled`（ページ数がそれ自身では変わらない：canonical の権威があるか、canonical が失敗しているあいだ配置の済んだ常駐側の数。文書で最初の canonical が失敗した場合も含む。`pageCountAuthoritative` が false でも、ホストは無くなったページの渡し直しにこれを使う。Build の後は最初の編集がなった source revision（`expectedSrcRev`）の紙面の数だけを使い、それより前の revision の数で読み手の位置を縮めない。縮めた位置は元の位置から毎回解き直し、元の位置そのものは置き換えないので、章がまた長くなれば元のシートへ戻る）/ `syncPage`・`syncPageCount`（上端のシートと枚数を `goto-sync` の番号付けで。外側の紙では Build のシートが Build の番号のまま、live の章のページ n は before + n。章が伸び縮みすると `page`・`pageCount`（並んでいる順の番号、ツールバーと `goto-page` が使う）と違う）/ `viewportCenter`（表示域の中央の紙面上の点 `{ page, livePage?, y, paperPx }`。`page` は `goto-sync` の番号付け（外側の紙を含む。章が伸びて live のページが後ろの Build シートと同じ番号になる場合は `livePage` に frame 自身のページ番号を添え、`goto-sync` はその組を live のページとして扱う）、`y` は `goto-sync` と同じ上端基準の紙面単位、`paperPx` はその紙面の描画幅。ページの間なら近い方。文書リセットでホストが静的カバーをこの点・この幅で出し、新しい紙面をここへ戻す）/ `status` / `search`）に加え、`reset-pending`（文書リセット開始）・`source`（クリック位置のソース逆引き）・`edit`（プレビュー直接編集）

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
| reveal token | 予約済みバリアを無効化する。同じ epoch の再スナップショットは**バリアを引き延ばさず**最新ペイロードだけ差し替える。読者の位置へ渡す handoff は重なり順を変えるまで持ち続け、その間のスナップショットが位置（`tokenSheetShown`）か紙面を失えば予約を取り消す。重なり順を変えた時点の `viewportCenter` を読者の位置として残す（その直後のリセットにも位置がある） |

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

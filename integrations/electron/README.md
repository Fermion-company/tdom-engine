# Electron 統合の例

`host/` を Electron アプリに繋ぐ最小の配線。**エンジンの依存ではなく参照実装**である。

Electron main は CommonJS、このパッケージは ESM なので host 層は動的 import で読む。IPC ハンドラはもともと非同期なので、一度の await 以上のコストはない。

## main プロセス

```js
const { createElectronLivePreviewHost, registerTdomHostHandlers } =
  require('tdom-engine/integrations/electron/tdom-ipc.cjs');

let host = null;
const getHost = async () => (host ??= await createElectronLivePreviewHost({
  workDir: path.join(app.getPath('userData'), 'tdom-work'),
  binDirs: myTexBinDirs(),          // lualatex / poppler / cc のある場所
  vendoredDir: path.join(process.resourcesPath, 'tdom-engine'),
}));

registerTdomHostHandlers({ ipcMain, getHost, channelPrefix: 'myapp:tdom' });
app.on('will-quit', () => host?.stop());
```

`createElectronLivePreviewHost` は `execPath: process.execPath` と `ELECTRON_RUN_AS_NODE=1` を設定する。ユーザーのマシンに Node があることを前提にしない。

## preload

```js
const { exposeTdomBridge } = require('tdom-engine/integrations/electron/tdom-preload.cjs');
exposeTdomBridge('tdom', 'myapp:tdom');
```

## renderer

公開されたブリッジの形は `host/live-driver.js` がそのまま受け取れる。

```js
import { createLiveDriver } from 'tdom-engine/host/live-driver.js';
import { createEmbedClient, embedUrl } from 'tdom-engine/host/embed-client.js';

const driver = createLiveDriver({
  bridge: window.tdom,
  getSnapshot: ({ clientEditAtEpochMs }) => currentEditorSnapshot(clientEditAtEpochMs),
  getCursorOffset: () => editor.getOffsetAtPosition(editor.getPosition()),
  onLive: (url, generation) => viewer.setLivePreview(url, generation),
  onError: (message) => viewer.showError(message),
});
editor.onDidChangeModelContent(() => driver.notifyInput());
editor.onDidChangeCursorPosition(() => driver.notifyCursor());
driver.setActive(true);
```

## ビューア

ページ描画部分の差し替えは `createLiveSurface()` に任せる。activationId の発行、`?embed=1` の URL 組み立て、二フレーム reveal バリア、文書リセット握手、ツールバー数値、ステータス解決までを持つので、ホストは自分の chrome を更新するだけでよい。

```js
import { createLiveSurface } from 'tdom-engine/host/live-surface.js';

const surface = createLiveSurface({
  frame: document.getElementById('live-frame'),
  getTheme: () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'),
  getBackground: () => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  onPhase: (phase) => document.body.classList.toggle('is-live', phase === 'active'),
  onToolbar: ({ page, pageCount, zoom }) => renderToolbar(page, pageCount, zoom),
  onStatus: (view) => setStatus(view.message ?? translate(view.key), view.tone),
  onSource: (location) => bridge.postMessage({ type: 'live-source', payload: location }),
  onStaticRestore: ({ url, path }) => loadStaticPdf(url, path),
});

// driver からの onLive をそのまま渡す
onLive: (url, generation) => surface.setLive(url ? { url, generation } : null),

// 静的 PDF の読み込みは live に預ける（下からカバーを引き抜かない）
const requestStaticDocument = (url, path) => {
  if (surface.deferStatic({ url, path })) return;
  loadStaticPdf(url, path);
};
```

CSS は [`host/live-surface.css`](../../host/live-surface.css) をコピーする。ホスト側の静的ページ領域を pending 中に iframe より上へ置くのはホストの責任である。ツールバーのボタンは capture フェーズで `surface.isLive()` を見て `surface.zoomIn()` / `surface.stepPage(±1)` / `surface.gotoPage(n)` / `surface.search(q)` に振り分ければ、ライブ中は自前のレンダラにイベントが届かない。

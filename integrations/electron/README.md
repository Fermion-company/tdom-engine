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

ビューア側は、ライブ URL を受け取ったらページ描画部分だけを `embedUrl(url, { activationId, theme, bg })` の iframe に差し替え、ツールバーは `createEmbedClient()` 越しに操作する。ライブを降ろせば元の静的 PDF 表示に戻る。`activationId` は活性化ごとに新しくし、`generation` が上がったら iframe を採り直す。

# host/ — ホストアプリ統合層

別のアプリ（エディタ）がこのエンジンを自分のリアルタイムプレビューとして動かすための層。エンジン本体には手を入れず、外側でプロセスの生死・編集ストリーム・埋め込み表示だけを扱う。

```js
import { createLivePreviewHost } from './host/index.js';

const host = createLivePreviewHost({ workDir: '/abs/scratch' });
await host.start();
await host.push({ source, path: '/abs/main.tex' });
host.getStatus().url;   // → この URL の /?embed=1 を iframe に出す
host.stop();
```

| ファイル | 実行場所 | 役割 |
| --- | --- | --- |
| `engine-dir.js` | Node | checkout の解決順序 |
| `engine-host.js` | Node | spawn・readiness・停止 |
| `document-session.js` | Node | 最小レンジ編集・overlay・再同期 |
| `http-json.js` | Node | JSON クライアント |
| `index.js` | Node | `createLivePreviewHost()` |
| `live-driver.js` | ブラウザ / Node | デバウンス・単発キュー・世代管理・健全性監視 |
| `embed-client.js` | ブラウザ | `?embed=1` iframe との postMessage |

設計と不変条件は [docs/13-host-integration.md](../docs/13-host-integration.md)。Electron の実例は [integrations/electron/](../integrations/electron/)。テストは `npm run test:host`（エンジンを起動しない）。

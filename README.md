# 麻雀収支ツール

GitHub Pagesで動作するPWAです。v5.3.0では、現在配信中の雀魂Web版をWorkerが解析し、現行WebSocketゲートウェイの`Lobby.fetchGameRecord`から牌譜Protobufを取得します。牌譜内容のデコードは次バージョンで実装予定です。

デプロイ済みWorker：`https://mahjong-paipu-proxy.mahjong-paihu.workers.dev`

## v5.3.0：認証Secretの安全な登録手順

認証情報はCloudflare Worker Secretだけへ保存します。必要なSecret名は`MAJSOUL_OAUTH2_CREDENTIALS`です。値は、現在の雀魂Web版が現行ゲートウェイの`.lq.Lobby.oauth2Login`へ送る「アカウント種別」と「OAuthアクセストークン」をまとめたJSONです。パスワード、Cookie、メールアドレスは保存しません。

1. Chromeで雀魂Web版へログインします。
2. `Option + Command + I`でDevToolsを開き、「Sources」→「Snippets」→「New snippet」を選びます。
3. [worker/tools/capture-majsoul-oauth.js](worker/tools/capture-majsoul-oauth.js)の内容を貼り付け、`Command + Enter`で実行します。この補助コードは外部送信せず、認証JSONを端末内のクリップボードへコピーするだけです。
4. DevToolsの「Network」で通信を一度`Offline`、続けて`Online`へ戻し、雀魂を再接続させます。「認証Secretを…コピーしました」と出れば取得完了です。コピー内容をGitHub、README、チャット、スクリーンショットへ貼らないでください。
5. macOSの「ターミナル」を開き、Workerへ移動します。

   ```bash
   cd /Users/ari.yu0107/Documents/mahjong-tools-v2/worker
   ```

6. Secret登録コマンドを実行します。

   ```bash
   npx wrangler secret put MAJSOUL_OAUTH2_CREDENTIALS
   ```

   `Enter a secret value:`と表示された場所へ、手順4でコピーされた値を直接貼り付けてEnterを押します。画面に文字が表示されなくても正常です。
7. Workerを再デプロイします。

   ```bash
   npm run deploy
   ```

8. ブラウザで`https://mahjong-paipu-proxy.mahjong-paihu.workers.dev/health`を開き、`secretConfigured`が`true`であることを確認します。Secretの値・長さ・先頭文字・ハッシュは返しません。
9. GitHub Pagesの雀魂タブでWorker URLを保存し、「接続テスト」を押します。
10. 自分が閲覧できる実際の雀魂共有URLを入力し、認証状態が`PAIPU_FETCH_SUCCEEDED`になることを確認します。取得データはProtobuf/Base64として返り、内容デコードは次バージョンです。
11. 雀魂からログアウトした後、期限切れ、端末無効化、`AUTH_FAILED`表示時は、手順1〜7を繰り返してSecretを更新します。OAuthアクセストークンの有効期限は雀魂側が管理し、ログアウトやセッション失効で利用できなくなる場合があります。
12. Secretを削除する場合は次を実行します。

   ```bash
   cd /Users/ari.yu0107/Documents/mahjong-tools-v2/worker
   npx wrangler secret delete MAJSOUL_OAUTH2_CREDENTIALS
   ```

認証情報は第三者へ送信・共有しないでください。GitHub、チャット、診断JSON、Consoleログへ貼らず、`wrangler secret put`の非表示入力へだけ貼り付けます。

## ゆうひさん向け：Cloudflare Workerのデプロイ手順

### ① Cloudflareへログイン

1. [Cloudflare Dashboard](https://dash.cloudflare.com/)を開きます。
2. 無料アカウントを作成するか、既存アカウントでログインします。

<!-- スクリーンショット撮影箇所①：Cloudflare Dashboardへログインした直後の画面 -->

### ② Workerを作成する準備

1. Node.js 20以降をインストールします。`node -v`でバージョンが表示されれば準備済みです。
2. ターミナルを開き、このプロジェクトの`worker`フォルダーへ移動します。
3. Worker用ツールをインストールします。

```bash
cd worker
npm install
```

Worker名、実行ファイル、許可Originは[worker/wrangler.jsonc](worker/wrangler.jsonc)へ設定済みです。利用者が外部URLを指定する機能はありません。

### ③ Workerをデプロイ

1. 初回だけCloudflare CLIへログインします。

   ```bash
   npx wrangler login
   ```

2. ブラウザに表示されるCloudflareの確認画面で許可します。
3. デプロイします。

   ```bash
   npm run deploy
   ```

<!-- スクリーンショット撮影箇所②：ターミナルに「Deployed」とworkers.dev URLが表示された画面 -->

### ④ Worker URLを取得

デプロイ完了時に表示される次の形式のURLをコピーします。

```text
https://mahjong-paipu-proxy.<Cloudflareのサブドメイン>.workers.dev
```

末尾の`/health`や`/api/paipu`はコピーするURLへ含めません。

### ⑤ GitHub Pagesへ設定

1. 麻雀収支ツールの「雀魂」タブを開きます。
2. 「詳細設定・復元用」を開きます。
3. 「取得Provider」で「ProxyProvider（Worker）」を選びます。
4. 「WorkerベースURL」へ手順④のURLを貼り付けます。
5. 「Worker設定を保存」を押します。状態が「未接続」になります。

<!-- スクリーンショット撮影箇所③：Worker URLを入力して「未接続」と表示された設定画面 -->

### ⑥ Health Check

1. 「接続テスト」を押します。
2. 表示が「未接続 → 接続中 → 成功」と変わることを確認します。
3. 次のHealth情報を確認します。
   - Service: `mahjong-paipu-proxy`
   - Version: `5.3.0`
   - Response Time: 通信時間（ms）
4. Worker URLへ`/health`を付けてブラウザで開くと、次のJSONも確認できます。

```json
{"ok":true,"service":"mahjong-paipu-proxy","version":"5.3.0"}
```

<!-- スクリーンショット撮影箇所④：緑色の「成功」とService・Version・Response Timeが表示された画面 -->

## API

- `GET /health`: Worker稼働確認（HTTP 200）
- `GET /api/paipu?id={完全な牌譜ID}`: 現行HTML・loader.js・routesを解析し、選択したゲートウェイの牌譜RPCへ通信して統一形式のJSONを返す
- `OPTIONS`: GitHub Pages向けCORSプリフライト（HTTP 204）

Cloudflare Workersの無料枠を優先し、KV・D1・有料サービスは使用していません。許可Originを変更する場合は`worker/wrangler.jsonc`の`ALLOWED_ORIGIN`を変更して再デプロイしてください。

成功レスポンスには`sourceUrl`、`finalUrl`、`accessedApi`、`httpStatus`、`contentType`、`payloadType`、`size`、`durationMs`、`redirect`、`analysis`、`payload`が含まれます。Protobufの`payload`はBase64です。利用者が任意の外部URLを取得させることはできません。

## v5.3.0の通信根拠

2026年7月19日に、現在の公式ページと実通信を確認しました。

- 公式HTMLが読み込むloader: `Build/jp-WebGL-release-4.0.11(12).loader.js`
- Build Version: `4.0.11`
- Unity Version: `2022.3.62f2c1`
- 公式クライアントのroutes通信: `GET https://jpgs.mahjongsoul.com/api/clientgate/routes?platform=Web&version=4.0.11&lang=jp`
- routes応答で選択された現行通信先: `wss://jpgs.mahjongsoul.com:443/gateway`
- 公式クライアントの実ログ: `WS_Create(wss://jpgs.mahjongsoul.com:443/gateway, "")`
- 牌譜取得RPC: `.lq.Lobby.fetchGameRecord`

Workerは旧`game_record` HTTP APIへ依存しません。毎回HTMLとloader.jsを取得し、Build Versionをroutesへ渡して利用可能なゲートウェイを選びます。現行Unity版は従来の単一`app.json`ではなくclient bundle settingsとwarehouse settingsを利用するため、その構成も診断情報へ明記します。

## 次バージョンの実装入口

牌譜Protobufの内容デコードは[worker/src/index.js](worker/src/index.js)のRPC取得後へ追加します。API、CORS、タイムアウト、エラーフォーマットはそのまま利用できます。

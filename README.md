# 麻雀収支ツール

GitHub Pagesで動作するPWAです。v5.1.0では雀魂牌譜の通信経路としてCloudflare WorkersのProxyProviderを正式採用しています。牌譜本体の取得はv5.2.0で実装予定です。

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
   - Version: `5.1.0`
   - Response Time: 通信時間（ms）
4. Worker URLへ`/health`を付けてブラウザで開くと、次のJSONも確認できます。

```json
{"ok":true,"service":"mahjong-paipu-proxy","version":"5.1.0"}
```

<!-- スクリーンショット撮影箇所④：緑色の「成功」とService・Version・Response Timeが表示された画面 -->

## API

- `GET /health`: Worker稼働確認（HTTP 200）
- `GET /api/paipu?id={完全な牌譜ID}`: v5.1.0では構造化JSONとHTTP 501を返す
- `OPTIONS`: GitHub Pages向けCORSプリフライト（HTTP 204）

Cloudflare Workersの無料枠を優先し、KV・D1・有料サービスは使用していません。許可Originを変更する場合は`worker/wrangler.jsonc`の`ALLOWED_ORIGIN`を変更して再デプロイしてください。

## v5.2.0の実装入口

牌譜取得先への通信とProtobuf解析は[worker/src/index.js](worker/src/index.js)の`fetchMajsoulPaipu()`へ追加します。API、CORS、タイムアウト、エラーフォーマットはそのまま利用できます。

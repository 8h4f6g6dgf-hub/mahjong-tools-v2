# 麻雀収支ツール

GitHub Pagesで動作するPWAです。v5.0.0から雀魂牌譜の取得経路を、ブラウザ直接通信からCloudflare Workers中継APIへ移行しました。

## ゆうひさんが行うCloudflare Workerのデプロイ手順

1. [Cloudflare](https://dash.cloudflare.com/)で無料アカウントを作成し、ログインします。
2. パソコンへNode.js 20以降をインストールします。すでに`node -v`でバージョンが表示される場合は不要です。
3. ターミナルでこのプロジェクトの`worker`フォルダーへ移動します。

   ```bash
   cd worker
   ```

4. Worker用ツールをインストールします。

   ```bash
   npm install
   ```

5. Cloudflareへログインします。ブラウザが開いたら内容を確認して許可します。

   ```bash
   npx wrangler login
   ```

6. Workerをデプロイします。

   ```bash
   npm run deploy
   ```

7. 表示された`https://mahjong-paipu-proxy.<サブドメイン>.workers.dev`をブラウザで開き、末尾へ`/health`を付けます。次のJSONが表示されれば成功です。

   ```json
   {"ok":true,"service":"mahjong-paipu-proxy","version":"5.0.0"}
   ```

8. 麻雀収支ツールの「雀魂」タブを開き、「詳細設定・復元用」を展開します。
9. 「取得Provider」で`ProxyProvider（Worker）`を選び、手順7のURLを「WorkerベースURL」へ入力します。`/health`は入力しません。
10. 「Worker設定を保存」を押し、続いて「接続テスト」を押します。「Worker接続成功」と表示されれば設定完了です。

Cloudflare Workersの無料枠で動かせるよう、KV・D1・有料サービスは使用していません。v5.0.0の`/api/paipu`は接続基盤のみで、正常にWorkerへ到達するとHTTP 501と構造化JSONを返します。牌譜本体の取得とProtobufデコードは次バージョンで追加します。

## API

- `GET /health`: Worker稼働確認
- `GET /api/paipu?id={完全な牌譜ID}`: 牌譜取得（v5.0.0では501）
- `OPTIONS`: GitHub Pages向けCORSプリフライト

許可Originを変更する場合は[worker/wrangler.jsonc](worker/wrangler.jsonc)の`ALLOWED_ORIGIN`を変更して再デプロイしてください。Workerは利用者指定URLを受け取らず、牌譜IDだけを検証して処理します。

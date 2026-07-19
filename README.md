# 麻雀収支ツール

GitHub Pagesで動作するPWAです。v5.3.4では、現在の雀魂Web版で確認した牌譜RPCごとの応答Envelope、Payload有無、実際の失敗段階を安全に診断します。牌譜内容の完全デコードは次バージョンで実装予定です。

デプロイ済みWorker：`https://mahjong-paipu-proxy.mahjong-paihu.workers.dev`

## v5.3.4：認証Secretの安全な登録手順

認証情報はCloudflare Worker Secretだけへ保存します。必要なSecretは`MAJSOUL_OAUTH2_CREDENTIALS`の1個です。現在の雀魂Web版で確認した`requestConnection → prepareLogin → heartbeat`のうち、Workerの再接続に必要な値だけを1つのJSONとして保存します。パスワード、Cookie、Account ID、端末IDは保存しません。

1. 必要なSecret名は`MAJSOUL_OAUTH2_CREDENTIALS`です。
2. 保存する値は、接続種別、現行クライアント識別文字列、ログイン種別、`prepareLogin`へ渡す不透明な認証値です。実際の値は表示・共有しません。
3. JSONの必須フィールドは`flowVersion`（文字列）、`connectionType`（整数）、`clientVersionString`（文字列）、`providerType`（整数）、`prepareLoginToken`（文字列）です。
4. Chromeで雀魂Web版へログインし、`Option + Command + I`でDevToolsを開きます。
5. 「Network」→「Socket」を選び、記録を消してからページを再読み込みします。ログイン完了後、一覧の`gateway`を右クリックして「Copy」→「Copy all listed as HAR (sanitized)」を選びます。コピー内容を画面へ貼り付けないでください。
6. 保存禁止の情報は、パスワード、Cookie、Authorization Header、Account ID、端末ID、生のWebSocket payloadです。GitHub、チャット、診断JSON、スクリーンショットへ貼らないでください。
7. macOSの「ターミナル」を開き、次のコマンドをそのまま実行します。クリップボードのHARは端末内で解析され、認証値を表示せずSecretへ直接登録されます。

   ```bash
   cd /Users/ari.yu0107/Documents/mahjong-tools-v2
   pbpaste | node worker/tools/register-secret-from-har.mjs
   ```

8. `https://mahjong-paipu-proxy.mahjong-paihu.workers.dev/health`を開き、`secretConfigured`と`secretSchemaValid`がともに`true`であることを確認します。`wrangler secret put`は新しいWorkerバージョンを作るため、Secretだけの更新なら追加デプロイは不要です。
9. Secretを更新するときは、現在の雀魂Web版へログインし直して手順4〜7を再実行します。
10. Secretを削除する場合は次を実行します。

   ```bash
   cd /Users/ari.yu0107/Documents/mahjong-tools-v2/worker
   npx wrangler secret delete MAJSOUL_OAUTH2_CREDENTIALS
   ```

11. 有効期限は雀魂側のセッション管理に従い、固定日時は取得できません。ログアウト、別端末でのログイン、セッション失効、Web版の認証方式変更後は手順4〜7で更新します。
12. 認証情報そのものはGitHub、チャット、診断JSON、Console、READMEへ絶対に貼らないでください。確認を依頼するときは`authState`、`safeErrorCode`、`nextAction`だけを共有してください。

認証情報は第三者へ送信・共有しないでください。GitHub、チャット、診断JSON、Consoleログへ貼らず、`wrangler secret put`の非表示入力へだけ貼り付けます。

### Secret仕様（v5.3.4継続）

- Secret名: `MAJSOUL_OAUTH2_CREDENTIALS`
- 値の種類: 現行WebSocketの`.lq.Route.requestConnection`と`.lq.Lobby.prepareLogin`から端末内で抽出する再接続用JSON
- JSON必須フィールド: `flowVersion`（文字列）、`connectionType`（整数）、`clientVersionString`（文字列）、`providerType`（整数）、`prepareLoginToken`（空でない文字列）
- 必要なSecret数: 1個。このJSON以外にCookie、パスワード、Account ID、端末IDは保存しない
- 有効期限: 雀魂側のOAuthセッション管理に従うため固定日時は取得できない。ログアウト、セッション失効、認証方式変更で無効になる場合がある
- 再取得条件: `SECRET_FORMAT_INVALID`、`OAUTH_REJECTED`、`SESSION_NOT_ESTABLISHED`が表示されたとき、またはログアウト・別端末ログイン後
- 登録後の再デプロイ: `wrangler secret put`がSecretを含む新しいWorkerバージョンを作成するため、通常は追加の`npm run deploy`不要。アプリコードも変更した場合だけ再デプロイする

WorkerはSecret値、その一部、文字数、ハッシュ、Cookie、Account ID、生のRPC payloadをレスポンス・診断JSON・通常ログへ出しません。

### OAuth段階診断

v5.3.4では認証段階に加えて、値を含まない`rpcTimeline`、各RPCの送受信状態、応答コード、Envelope型、Payload有無・サイズ、実際の失敗RPCを保存します。Session確立後のエラーは`OAUTH_REJECTED`へ丸めず、`FETCH_GAME_RECORD_FAILED`、`READ_GAME_RECORD_FAILED`、`GAME_RECORD_DETAIL_FAILED`などへ分類します。

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
   - Version: `5.3.4`
   - Response Time: 通信時間（ms）
4. Worker URLへ`/health`を付けてブラウザで開くと、次のJSONも確認できます。

```json
{"ok":true,"service":"mahjong-paipu-proxy","version":"5.3.4"}
```

<!-- スクリーンショット撮影箇所④：緑色の「成功」とService・Version・Response Timeが表示された画面 -->

## API

- `GET /health`: Worker稼働確認（HTTP 200）
- `GET /api/paipu?id={完全な牌譜ID}`: 現行HTML・loader.js・routesを解析し、選択したゲートウェイの牌譜RPCへ通信して統一形式のJSONを返す
- `OPTIONS`: GitHub Pages向けCORSプリフライト（HTTP 204）

Cloudflare Workersの無料枠を優先し、KV・D1・有料サービスは使用していません。許可Originを変更する場合は`worker/wrangler.jsonc`の`ALLOWED_ORIGIN`を変更して再デプロイしてください。

成功レスポンスには`sourceUrl`、`finalUrl`、`accessedApi`、`httpStatus`、`contentType`、`payloadType`、`size`、`durationMs`、`redirect`、`analysis`、`payload`が含まれます。Protobufの`payload`はBase64です。利用者が任意の外部URLを取得させることはできません。

## v5.3.4の通信根拠

2026年7月19日に、現在の公式ページと実通信を確認しました。

- 公式HTMLが読み込むloader: `Build/jp-WebGL-release-4.0.11(12).loader.js`
- Build Version: `4.0.11`
- Unity Version: `2022.3.62f2c1`
- 公式クライアントのroutes通信: `GET https://jpgs.mahjongsoul.com/api/clientgate/routes?platform=Web&version=4.0.11&lang=jp`
- routes応答で選択された現行通信先: `wss://jpgs.mahjongsoul.com:443/gateway`
- 公式クライアントの実ログ: `WS_Create(wss://jpgs.mahjongsoul.com:443/gateway, "")`
- 現行Chromeのsanitized HARで確認したRPC順序: `.lq.Route.requestConnection` → `.lq.Lobby.prepareLogin` → `.lq.Route.heartbeat`
- `requestConnection`の送信形状: field 2（varint）、field 3（length-delimited）、field 4（varint・現在時刻）
- `prepareLogin`の送信形状: field 1（length-delimited・非表示）、field 2（varint）
- 牌譜取得RPC: `.lq.Lobby.fetchGameRecord`

Workerは旧`game_record` HTTP APIや旧`oauth2Login`フローへ依存しません。`MAJSOUL_151`の公式な記号定義は現在配信中の定義から確認できなかったため、トークン期限切れとは断定していません。実通信で`oauth2Login`が使われていない事実に基づき、診断上は`MAJSOUL_151_LEGACY_FLOW_REJECTED`として区別します。毎回HTMLとloader.jsを取得し、Build Versionをroutesへ渡して利用可能なゲートウェイを選びます。

### 共有URLから牌譜取得までのRPCシーケンス

```text
共有URL
  → .lq.Route.requestConnection
  → .lq.Lobby.prepareLogin
  → .lq.Lobby.fetchGameRecord
  → .lq.Lobby.readGameRecord
  → .lq.Lobby.fetchGameRecordsDetailV2
  → 牌譜画面
```

- `requestConnection`: 現行WebクライアントとGatewayの接続条件を送信
- `prepareLogin`: Worker Secret内の不透明な認証値でセッションを確立
- `fetchGameRecord`: 共有ページが保持する完全牌譜IDと、`requestConnection`で使用した同じクライアント識別文字列を送信
- `readGameRecord`: `fetchGameRecord`と同じクライアント識別文字列をfield 2へ送信
- `fetchGameRecordsDetailV2`: `fetchGameRecord`と同じ完全牌譜IDをfield 1へ送信

現在のsanitized HARでは、`fetchGameRecord`より前に牌譜IDを別IDへ変換するRPCはありませんでした。`fetchGameRecord`と`fetchGameRecordsDetailV2`のfield 1が同一値、`fetchGameRecord`と`readGameRecord`のfield 2が同一値であることを、値を表示せず照合しています。通知取得やheartbeatは牌譜ID解決に関与しないため、Workerの牌譜取得シーケンスには含めません。

### v5.3.4で解析する応答とエラー分類

- `fetchGameRecord`: 現行HARでは応答のlength-delimited field 3・4を確認済みです。Workerはfield 4の牌譜候補を既存処理と同じ方法で抽出し、Base64へ変換して内部レスポンスへ保持します。
- `readGameRecord`: 現行HARでは応答受信を確認済みです。WorkerはRPC Code、Envelope、Message型、Payload有無・サイズを個別に記録します。後続RPCが失敗しても、ここで検出したPayloadは破棄しません。
- `fetchGameRecordsDetailV2`: 現行HARでは応答のlength-delimited field 2を確認済みです。Workerは詳細応答を実送信して同じメタ情報を記録します。
- Payload全文はWorkerの成功レスポンス内で内部処理へ渡しますが、GitHub Pagesの通常診断JSONでは`[INTERNAL_PAYLOAD_OMITTED]`へ置換します。
- 1004を含む公式な意味が未確認のRPC Codeは意味を断定せず、`MAJSOUL_<code>`と実際のRPC名だけを表示します。
- Session確立前の失敗は`AUTH_FAILED`、確立後は発生RPCに応じて`FETCH_GAME_RECORD_FAILED`、`READ_GAME_RECORD_FAILED`、`GAME_RECORD_DETAIL_FAILED`へ分類します。

現在解析済みなのはLiqiレスポンスEnvelope、Protobuf field番号・wire type、ネスト候補、gzipシグネチャ、Payload位置とサイズまでです。メッセージ定義を使った牌譜内容の完全デコード、対局結果への変換、自動精算反映は未解析・未実装です。

## 次バージョンの実装入口

牌譜Protobufの完全デコードは[worker/src/index.js](worker/src/index.js)の`inspectRpcFrame`で分離したPayloadへ追加します。API、CORS、タイムアウト、段階別エラーフォーマットはそのまま利用できます。

# 麻雀収支ツール

GitHub Pagesで動作するPWAです。v5.4.0では、HARからProfile、Secret、Worker requestへ至る変換工程を監査し、保持情報と欠落情報を安全に診断します。

## v5.4.0：Profile生成監査

診断の`profileCompleteness`は、RPC名、Envelope、field/wire順、入力Role、接続関係、Session Timeline、安全なBinaryメタデータ、生HAR Binary証跡の保持状況を重み付きで示します。構造が100%一致していても、生HAR request byteを保存していない場合は`profileCanReproduceOriginalBinary=false`です。

- `comparisonLevel=worker-vs-profile`はWorker生成requestとProfile再構築結果の比較です。生HARとの比較を意味しません。
- `rawHarCompared=false`は、既存Secretに生HAR Binaryが保存されていないためです。セキュリティ上、生の認証通信を新たに保存しません。
- `profileLossDetected`と`lossItems`は、HAR→Parse→Message→Profile→Secret→Workerの各段階で証明不能になった情報を列挙します。
- `profileCanGenerateWorkerRequest=true`は実行に必要な入力が揃っている意味で、元Binaryと同一だと証明した意味ではありません。
- `secretCompleteness=runtime-complete-proof-incomplete`はWorker実行に必要な値は揃う一方、Raw Binary比較証跡が不足する状態です。

既存HARの再登録は要求しません。現在の`current-har-v2`ではRaw Binary、byte offset、request/response metadata、Unknown/Reserved/Extension不存在の証跡がProfileへ保存されていないため、v5.4.0はこれを欠落として正直に表示します。値、Token、Cookie、牌譜ID、生Payloadは診断へ出力しません。

デプロイ済みWorker：`https://mahjong-paipu-proxy.mahjong-paihu.workers.dev`

## v5.4.0：認証SecretとHAR意味情報の安全な登録手順

認証情報はCloudflare Worker Secretだけへ保存します。認証値は`MAJSOUL_OAUTH2_CREDENTIALS`、接続済みHARから更新する値を含まないfetch構造は`MAJSOUL_FETCH_GAME_RECORD_PROFILE`へ分離できます。現在の雀魂Web版で確認した`requestConnection → prepareLogin → heartbeat`のうち、Workerの再接続に必要な値だけを保存します。パスワード、Cookie、Account ID、端末IDは保存しません。

1. 必要なSecret名は`MAJSOUL_OAUTH2_CREDENTIALS`です。
2. 保存する値は、接続種別、現行クライアント識別文字列、ログイン種別、`prepareLogin`へ渡す不透明な認証値です。実際の値は表示・共有しません。
3. 認証JSONの必須フィールドは`flowVersion`、`connectionType`、`routeContextString`、`providerType`、`prepareLoginToken`です。fetch用Secretには`fetchClientContext`と値を出さない由来メタデータを保存します。
4. Chromeで雀魂Web版へログインし、`Option + Command + I`でDevToolsを開きます。
5. 実際に表示できる雀魂共有URLを開き、「Network」→「All」を選び、記録を消してからページを再読み込みします。牌譜画面の表示後、通信一覧を右クリックして「Copy」→「Copy all listed as HAR (sanitized)」を選びます。共有ページのDocumentと`gateway`の両方が必要です。コピー内容を画面へ貼り付けないでください。
6. 保存禁止の情報は、パスワード、Cookie、Authorization Header、Account ID、端末ID、生のWebSocket payloadです。GitHub、チャット、診断JSON、スクリーンショットへ貼らないでください。
7. macOSの「ターミナル」を開き、次のコマンドをそのまま実行します。クリップボードのHARは端末内で解析され、認証値を表示せずSecretへ直接登録されます。

   ```bash
   cd /Users/ari.yu0107/Documents/mahjong-tools-v2
   pbpaste | node worker/tools/register-secret-from-har.mjs
   ```

8. コマンドが「fetchGameRecordの構造と意味検証済みclient context」と表示したことを確認します。続けて`https://mahjong-paipu-proxy.mahjong-paihu.workers.dev/health`を開き、`secretConfigured`と`secretSchemaValid`がともに`true`であることを確認します。Secretだけの更新なら追加デプロイは不要です。

共有URLの再読込でロビーへ戻り、認証RPCと牌譜RPCを同じHARへ保存できない場合は、既存の認証Secretを変更せずfetch構造とclient contextだけを登録します。牌譜表示中のNetwork一覧からsanitized HARをコピーし、`worker`ディレクトリで次を実行します。

```bash
npm run register-fetch-profile
```

成功時は`fetchGameRecordの構造と意味検証済みclient contextを安全に登録しました`と表示されます。
9. Secretを更新するときは、現在の雀魂Web版へログインし直して手順4〜7を再実行します。
10. Secretを削除する場合は次を実行します。

   ```bash
   cd /Users/ari.yu0107/Documents/mahjong-tools-v2/worker
   npx wrangler secret delete MAJSOUL_OAUTH2_CREDENTIALS
   ```

11. 有効期限は雀魂側のセッション管理に従い、固定日時は取得できません。ログアウト、別端末でのログイン、セッション失効、Web版の認証方式変更後は手順4〜7で更新します。
12. 認証情報そのものはGitHub、チャット、診断JSON、Console、READMEへ絶対に貼らないでください。確認を依頼するときは`authState`、`safeErrorCode`、`nextAction`だけを共有してください。

認証情報は第三者へ送信・共有しないでください。GitHub、チャット、診断JSON、Consoleログへ貼らず、`wrangler secret put`の非表示入力へだけ貼り付けます。

### Secret仕様（v5.4.0）

- Secret名: `MAJSOUL_OAUTH2_CREDENTIALS`
- 値の種類: 現行WebSocketの`.lq.Route.requestConnection`と`.lq.Lobby.prepareLogin`から端末内で抽出する再接続用JSON
- 認証JSON必須フィールド: `flowVersion`、`connectionType`、`routeContextString`、`providerType`、`prepareLoginToken`
- `fetchGameRecordProfile`: RPC名、Envelope/request構造、field出所、route IDではないfield 2 contextをWorker Secretとして保存する。牌譜ID、Payload、生リクエストは保存しない
- 必要なSecret数: 1個。このJSON以外にCookie、パスワード、Account ID、端末IDは保存しない
- 有効期限: 雀魂側のOAuthセッション管理に従うため固定日時は取得できない。ログアウト、セッション失効、認証方式変更で無効になる場合がある
- 再取得条件: `SECRET_FORMAT_INVALID`、`OAUTH_REJECTED`、`SESSION_NOT_ESTABLISHED`が表示されたとき、またはログアウト・別端末ログイン後
- 登録後の再デプロイ: `wrangler secret put`がSecretを含む新しいWorkerバージョンを作成するため、通常は追加の`npm run deploy`不要。アプリコードも変更した場合だけ再デプロイする

WorkerはSecret値、その一部、文字数、ハッシュ、Cookie、Account ID、生のRPC payloadをレスポンス・診断JSON・通常ログへ出しません。

### OAuth段階診断

v5.4.0では既存の4スコアを構造一致として扱い、`requestSemanticMatched`、`connectionContextMatched`、`requestIdSequenceMatched`、field 1/2の出所確認を別に判定します。値、差分、Payloadは診断へ保存しません。構造が100%でも意味が未確認ならWorkerは`fetchGameRecord`を送信しません。

### 構造一致と意味的一致

- 構造一致: RPC名、Envelope、field番号、wire type、field順がHARと同じかを示す
- 意味的一致: field 1が完全牌譜ID、field 2が現行`fetchGameRecord`のclient contextに由来し、route IDではないことを示す
- `jp-2`は`requestConnection` field 3内のroute contextに含まれるroute IDであり、fetch field 2へ流用しない
- Workerは1本のWebSocket上でrequest ID 1、2、3を採番し、各response IDを対応付けてから次RPCへ進む
- 1004が継続した場合は、構造、client context、field出所、request ID、connection、upstream responseのうち残る1カテゴリだけを`remainingMismatchCategory`へ返す

HAR抽出はRPC名、send方向、Liqi Envelope、field番号、同一WebSocket entryを組み合わせて行います。routes APIの値や別connectionの値を認証・牌譜RPCへ混在させません。

### v5.4.0の静的検証と実行時検証

- 静的検証は共通モジュール`worker/src/shared/fetch-profile-schema.js`を登録ツールとWorkerの両方が使用します。
- v5.3.6で登録済みの`current-har-v2`プロファイルは後方互換としてそのまま利用できます。HAR再取得は不要です。
- HARのconnection indexは過去のブラウザ内識別子なので、Workerが作る新しいconnection IDとは比較しません。
- 実行前のconnection状態は`pending-runtime-validation`です。同じWebSocketオブジェクト上で`requestConnection → prepareLogin`の応答を確認後に`matched`または`mismatched`へ確定します。
- HAR再登録が必要なのは`PROFILE_SCHEMA_MISMATCH`または`PROFILE_VERSION_MISMATCH`の場合だけです。個別条件が成功している場合は再登録を求めません。
- 残差カテゴリはprofile/version、field 1/2、route混入、client context、Message、Envelope、field構造、request ID、connection関係、prepareLogin前提、runtime validationのいずれか1つを返します。
- v5.3.6で全条件がtrueでも停止した原因は、総合条件が初期値`requestSemanticMatched=false`自身を参照していたためです。v5.4.0では個別条件だけから再計算します。

### v5.4.0のSession Timeline

- 登録ツールは同一WebSocket内の`prepareLogin response → fetchGameRecord request`を時系列で抽出します。
- 保存対象はRPC名、方向、request ID、イベント種別、経過時間、Payload有無・サイズだけです。Payload本体、Token、Cookie、Account情報は保存しません。
- `current-har-session-v1`にはHAR待機時間、heartbeatの有無、中間RPC、server push/notify、request ID差分、同一接続条件を保存します。
- HAR由来待機時間には小さなbufferを加え、0〜3000msの安全な範囲へ制限します。無制限リトライや複数WebSocket同時接続は行いません。
- 既存`current-har-v2`にSession Timelineがない場合もSecretは有効です。その場合は`prepareLogin`応答受信をSession Ready条件とする`legacy-response-trigger`を使用し、HAR再登録を必須にしません。
- HARでheartbeatまたは中間RPCを確認しても、安全な入力値を復元できない場合は推測送信せず、`HEARTBEAT_FAILED`または`INTERMEDIATE_RPC_FAILED`で停止します。
- 必須server eventがある場合は検証済み待機範囲内で受信を待ち、未受信なら`REQUIRED_SERVER_EVENT_NOT_RECEIVED`を返します。
- 1004が再発した場合は`SESSION_TIMING`と断定せず、Session条件一致後なら`FETCH_GAME_RECORD_SESSION_REJECTED`として上流応答を分離します。

### v5.4.0のfetchGameRecord Binary比較

- 比較段階は、入力値の役割、encode前field object、Protobuf encode後Payload、Liqi request Envelope、送信requestの順です。
- `payloadByteMatch`はrequest body、`protobufBinaryMatch`はRPC Envelopeを含むProtobuf部分、`encodeMatch`は再構築した参照requestとのbyte一致を示します。
- `protobufObjectMatch`はfield番号・wire type・field順の一致です。値やbyte列そのものは診断へ返しません。
- `unknownFieldCount`はWorker requestに既知のfield 1/2以外が存在した件数です。差分表示はfield番号、wire type、最初の差分offset、長さだけに限定します。
- 既存`current-har-v2`には生HAR byteを保存していないため、再登録を要求せずHAR由来Profileから参照requestを独立再構築します。この場合`binaryComparisonSource`は`profile-reconstructed-current-har-v2`、`harBinaryCompared`は`false`です。
- 今後登録されるProfileは安全な`binaryProfile`（長さ、field順、Unknown Field件数のみ）を保存できます。Payload、牌譜ID、Token、Cookieは保存しません。
- `sessionTimelineProfileValid=false`の場合、`sessionTimingMatched`は誤解を避けるため`unknown`（診断JSONでは`null`）です。
- `fetchGameRecord`が失敗した場合はそこで停止し、`readGameRecord`と`fetchGameRecordsDetailV2`を送信しません。Code 0かつPayload取得後だけ後続RPCへ進みます。

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
   - Version: `5.4.0`
   - Response Time: 通信時間（ms）
4. Worker URLへ`/health`を付けてブラウザで開くと、次のJSONも確認できます。

```json
{"ok":true,"service":"mahjong-paipu-proxy","version":"5.4.0"}
```

<!-- スクリーンショット撮影箇所④：緑色の「成功」とService・Version・Response Timeが表示された画面 -->

## API

- `GET /health`: Worker稼働確認（HTTP 200）
- `GET /api/paipu?id={完全な牌譜ID}`: 現行HTML・loader.js・routesを解析し、選択したゲートウェイの牌譜RPCへ通信して統一形式のJSONを返す
- `OPTIONS`: GitHub Pages向けCORSプリフライト（HTTP 204）

Cloudflare Workersの無料枠を優先し、KV・D1・有料サービスは使用していません。許可Originを変更する場合は`worker/wrangler.jsonc`の`ALLOWED_ORIGIN`を変更して再デプロイしてください。

成功レスポンスには`sourceUrl`、`finalUrl`、`accessedApi`、`httpStatus`、`contentType`、`payloadType`、`size`、`durationMs`、`redirect`、`analysis`、`payload`が含まれます。Protobufの`payload`はBase64です。利用者が任意の外部URLを取得させることはできません。

## v5.4.0の通信根拠

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

### v5.4.0で維持する応答解析とエラー分類

- `fetchGameRecord`: 現行HARでは応答のlength-delimited field 3・4を確認済みです。Workerはfield 4の牌譜候補を既存処理と同じ方法で抽出し、Base64へ変換して内部レスポンスへ保持します。
- `readGameRecord`: 現行HARでは応答受信を確認済みです。WorkerはRPC Code、Envelope、Message型、Payload有無・サイズを個別に記録します。後続RPCが失敗しても、ここで検出したPayloadは破棄しません。
- `fetchGameRecordsDetailV2`: 現行HARでは応答のlength-delimited field 2を確認済みです。Workerは詳細応答を実送信して同じメタ情報を記録します。
- Payload全文はWorkerの成功レスポンス内で内部処理へ渡しますが、GitHub Pagesの通常診断JSONでは`[INTERNAL_PAYLOAD_OMITTED]`へ置換します。
- 1004を含む公式な意味が未確認のRPC Codeは意味を断定せず、`MAJSOUL_<code>`と実際のRPC名だけを表示します。
- Session確立前の失敗は`AUTH_FAILED`、確立後は発生RPCに応じて`FETCH_GAME_RECORD_FAILED`、`READ_GAME_RECORD_FAILED`、`GAME_RECORD_DETAIL_FAILED`へ分類します。

現在解析済みなのはLiqiレスポンスEnvelope、Protobuf field番号・wire type、ネスト候補、gzipシグネチャ、Payload位置とサイズまでです。メッセージ定義を使った牌譜内容の完全デコード、対局結果への変換、自動精算反映は未解析・未実装です。

### fetchGameRecordのHAR比較方法

`register-secret-from-har.mjs`は、現在のHAR内の共有URL、`requestConnection`、`prepareLogin`、`fetchGameRecord`を端末内だけで照合します。次の条件をすべて確認できた場合だけ、安全な構造プロファイルをSecretへ登録します。

- Message一致率: RPC名が`.lq.Lobby.fetchGameRecord`と一致
- Envelope一致率: Liqi request Envelopeのfield番号・wire type・順序が一致
- Field一致率: request bodyのfield番号・wire type・順序に加え、fieldの値が共有URLの完全IDまたは`requestConnection`と同じclientVersion由来であることを確認
- Request一致率: 上記3スコアの平均。すべて100%の場合だけ`requestFullyMatched`と`fetchGameRecordRequestValidated`がtrueになる

現在コードへ組み込まれている比較対象は、HARで確認したMessage、Envelope、body field構造、完全牌譜IDとclientVersionの値の出所です。個々の認証値や牌譜IDそのものは保存しません。

まだ一致を確認できていないものは、v5.4.0公開後に取得する新しい共有ページHARと実際のWorker送信結果です。旧Secretには`fetchGameRecordProfile`がないため、手順4〜8を一度実施するまで`secretSchemaValid`はfalseになります。

`fetchGameRecord`がRPCエラーを返した場合は、その時点で処理を停止します。成功前に`readGameRecord`や`fetchGameRecordsDetailV2`を送信しません。1004の意味は断定せず、発生RPC、RPC Code、HAR比較済みかだけを表示します。

## 次バージョンの実装入口

牌譜Protobufの完全デコードは[worker/src/index.js](worker/src/index.js)の`inspectRpcFrame`で分離したPayloadへ追加します。API、CORS、タイムアウト、段階別エラーフォーマットはそのまま利用できます。

## リポジトリ概要（短く）
このサービスはLINE Messaging API用のWebhookサーバー（Express）です。主要処理は `app.js` に集約されており、イベント受信 -> 同期処理 -> 200 応答が基本の流れです。

## 重要なファイル
- `app.js` — 全ロジック（ルーティング、署名検証、dedupe、tap-guard、rate-limit、reply/push のリトライ）
- `package.json` — 実行スクリプト: `npm start` (= `node app.js`)、依存は `axios`, `express`, `ioredis`, `pino`, `prom-client` 等
- `huku/` — 画像アセット（`rabbitImages` に使われる）
- `README.md` — デプロイのヒント（Render 用の注記）

## アーキテクチャ＆データフロー（要点）
- Webhook受信 (`POST /webhook`) -> `validateSignature()` で署名検証 -> イベント配列を per-key ロックで順次処理 (`lockPerKeyAndRun`)。
- 重複検知は Redis を優先、未設定時はプロセス内キャッシュ（`seenMem`）を使用（関数: `isDuplicate`）。
- 連打防止は tap-guard（Redis の `tap:` キー、または `tapMem`）を使う（関数: `tapGuardAccept`）。
- 返信はまず reply API を試行し、4xx が返ると push へフォールバック（関数: `replyWithRetryOrPush`）。リトライ/バックオフ実装あり。

## 環境変数（動作に直接影響する）
- `LINE_ACCESS_TOKEN` (必須): API 呼び出し用
- `LINE_CHANNEL_SECRET` (推奨): 署名検証に使用
- `STRICT_SIGNATURE` (true/false): 署名失敗で403にするか（`false`なら200で無視）
- `REDIS_URL` (任意): 有効化すると Redis ベースの dedupe/tapGuard/admins を使う
- `ADMIN_USER_IDS`, `ADMIN_REG_TOKEN`：管理者登録周り
- `METRICS_USER`, `METRICS_PASS`：`/metrics` の Basic 認証（任意）
- 調整用: `TAP_DEBOUNCE_MS`, `DEDUPE_TTL_MS`, `RATE_CAP`, `RATE_REFILL`, `AXIOS_TIMEOUT_MS`, `PORT`

## プロジェクト固有の慣習・パターン
- コードはシングルファイル実装中心（`app.js`）で、機能は小さな関数群に分けられている。変更時は相互作用（特に dedupe / tap / rate / perKeyQueue）を意識する。
- Quick Reply は空配列を送らない（`withQuickReply` と `stripEmptyQuickReply` の組合せ）。AI がメッセージを生成する際は、空の quickReply を含めないこと。
- 最大 reply メッセージ数は5（`sanitizeMessages` の上限）。これを超えないようにまとめる。
- 管理者コマンドはプレーンテキストの正規表現ルーティング(`routes` 配列)で処理される。例: `admin:register <token>`、`admin:unregister`、`admin:stats`。

## テスト・ローカル実行の手順（発見可能な最小手順）
1. 依存インストール:
```powershell
npm install
```
2. 環境変数をセットして起動（最低 `LINE_ACCESS_TOKEN` をセット）:
```powershell
$env:LINE_ACCESS_TOKEN = '***token***'; npm start
```
3. Webhook の動作確認は ngrok 等で外部公開してLINE側に設定するか、署名検証を無効化（`STRICT_SIGNATURE=false`）して `curl` で `POST /webhook` を投げる。

署名ありでローカルテストする場合は、`validateSignature` がリクエストの raw body を HMAC-SHA256 で検証するので、正しい `x-line-signature` を付与すること。

例（署名無視モードでの簡易テスト）:
```powershell
curl -X POST http://localhost:3000/webhook -H "Content-Type: application/json" -d '{"events": [{"type":"message","replyToken":"token","message":{"type":"text","id":"1","text":"test"},"source":{"type":"user","userId":"U123"}}]}'
```

## デバッグ時の注意点・よくある落とし穴
- Redis の有無で挙動が変わる（プロセス内キャッシュは単一プロセスのみ）。ローカルで Redis を使わない場合、複数インスタンスでの正しい dedupe/tap 動作は保証されない。
- 署名検証は raw body に依存するため、ミドルウェアで body を加工すると検証に失敗する（`express.json({ verify: rawBodySaver })` のパターンに倣う）。
- reply が 4xx を返すと push フォールバックする動作があるので、テストで2重送信や期待外の push を生まないよう注意。

## 変更時の小さなチェックリスト
- `app.js` を編集したら、`/health` と `/metrics` を手動で叩いて基本的な健全性を確認する。
- Quick Reply を生成する場合は `stripEmptyQuickReply` の振る舞いを壊していないか確認する。
- Redis を追加・削除する場合は `isDuplicate`, `tapGuardAccept` の両方を確認する。

---
フィードバックください: 追加してほしい実行手順や秘密情報の扱い（例: サンプル .env）などがあれば追記します。

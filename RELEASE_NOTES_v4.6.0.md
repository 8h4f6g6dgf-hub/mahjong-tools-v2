# 麻雀収支ツール v4.6.0 リリースノート

リリース日: 2026-07-17

## 変更内容

- Content-Typeとレスポンス本文の両方でHTMLを検出し、HTMLを牌譜データとして扱わないよう修正しました。
- HTMLと取得可能なJavaScriptから、script、inline script、fetch、axios、XMLHttpRequest、HTTP(S)、WebSocketの通信情報を抽出する基盤を追加しました。
- API候補とWebSocket候補を抽出し、通信方式を「HTMLのみ」「REST API」「WebSocket」「不明」に分類する診断を追加しました。
- 診断画面とコピー可能な技術ログに、HTML解析、API候補、WebSocket候補、通信方式を追加しました。
- 将来の牌譜デコードに備え、取得データを `PROTOBUF`、`UNKNOWN`、`JSON`、`HTML` に分類する基盤を追加しました。Protobufデコード自体は次バージョン以降の対象です。
- アプリ、manifest、Service Workerのバージョンをv4.6.0へ更新しました。

## 互換性

- GitHub PagesおよびPWAの構成を維持しています。
- 既存のMトーナメント、四麻、五等、三麻、雀魂タブ、JSON読込、履歴、グラフ、チップ、精算機能の仕様とUIは変更していません。
- アイコンファイルと `mtournament.json` は更新していません。

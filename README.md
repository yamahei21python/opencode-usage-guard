# opencode-usage-guard

OpenAI 無料枠（sol 250k/day, terra 2.5M/day）超過時に opencode の LLM リクエストを自動ブロックするプラグイン。

Cline, ChatGPT Desktop 等の他ツール消費も API で検知し、クロスツールでガード。

## 特徴

- **自動分類**: model 名のキーワード（sol, luna, mini, nano）で sol/terra を判定
- **独立枠**: sol と terra は完全分離して管理
- **クロスツール検知**: OpenAI Usage API で Cline/ChatGPT 分も計上
- **自己ガード**: subagent も per-Instance で自動ブロック
- **フェイルクローズ**: API 不通時もブロック（課金回避）
- **SQLite + JSON fallback**: 並行安全・耐障害
- **環境適応**: env 無くても ~/.zshrc からキー取得

## セットアップ

### 1. Admin Key 発行

OpenAI Dashboard → API Keys → 「Create new secret key」→ **Read only** で発行。

### 2. 環境変数設定

```bash
# ~/.zshrc に追加
export OPENAI_ADMIN_KEY='sk-admin-...'
chmod 600 ~/.zshrc
```

### 3. プラグイン配置

```bash
# opencode のツールディレクトリにコピー
cp tools/*.ts ~/.config/opencode/tools/
```

### 4. opencode.json にプラグイン登録

```json
{
  "plugin": [
    "./tools/openai-usage-guard.ts",
    "./tools/openai-usage-status.ts"
  ]
}
```

### 5. ガード閾値の調整（オプション）

`openai-usage-shared.ts` の冒頭で変更:

```typescript
export const SOL_LIMIT = 175_000;   // sol 枠（公式250kの70%）
export const TERRA_LIMIT = 2_000_000; // terra 枠（公式2.5Mの80%）
```

## 仕組み

```
OpenAI Usage API ──┐
                   ▼
         getEffectiveUsage()
         (max(ローカル, API))
                   │
                   ▼
            classify() ── sol/terra 自動分類
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
  chat.params            tool.execute.before
  (LLM リクエスト前)      (task spawn 前)
```

### classify() の分類ロジック

model 文字列の `/` 右側を小文字化し、キーワード一致:

| キーワード | group | 例 |
|---|---|---|
| `sol` (完全一致) | sol | gpt-5.6-sol |
| `luna` | terra | gpt-5.6-luna |
| `mini` | terra | gpt-5.4-mini |
| `nano` | terra | gpt-5.4-nano |
| ヒット無し | null | big-pickle, glm-5.1 |

### agentGroup() のサブエージェント解決

`tool.execute.before` で task 呼び出しをブロックする際、サブエージェントの model を data-driven で解決:

1. `opencode.json` の `agent.<name>.model`
2. `agent/<name>.md` フロントマターの `model:`
3. `agents/<name>.json` の `"model"`

## 状態確認

```bash
# ステータス表示（ローカル + API 真値）
rtk opencode run -m openai/gpt-5.6-luna "usage"
```

## リセット

毎日 **09:00 JST (UTC 00:00)** に自動リセット。手動リセット不要。

## 注意事項

- **API キーは公開しないこと**。Read only で発行し、chmod 600 で保護。
- SQLite ファイル（`.opencode/usage_guard.sqlite`）は `.gitignore` に含めること。
- このプラグインは **OpenAI の無料枠超過を防ぐもの**。有料プランでの課金制限は保証しない。

## ライセンス

MIT

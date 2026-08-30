import fs from "fs";
import os from "os";
import path from "path";
import { addUsage as addUsageAtomic, classify, getEffectiveUsage, limitFor, recordSessionUsage } from "./openai-usage-shared";

type ModelObject = {
  providerID?: unknown;
  provider_id?: unknown;
  modelID?: unknown;
  model_id?: unknown;
  id?: unknown;
};

type TokenInfo = {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown };
};

type MessageInfo = {
  role?: unknown;
  id?: unknown;
  providerID?: unknown;
  provider_id?: unknown;
  modelID?: unknown;
  model_id?: unknown;
  tokens?: unknown;
};

type ChatParams = { model?: unknown };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// subagent_type から sol/terra を判定。
// 設定済エージェントは opencode.json の agent.<name>.model から、built-in は既定マップから。
// subagent_type から sol/terra を判定。実 model 定義をデータ駆動で解決（ハードコード廃止）。
function agentGroup(sub: string): "sol" | "terra" | null {
  const cfgDir = path.join(os.homedir(), ".config", "opencode");
  // 1) opencode.json の agent.<name>.model
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cfgDir, "opencode.json"), "utf8"));
    const agentCfg = isRecord(cfg) && isRecord(cfg.agent) ? cfg.agent : {};
    const m = isRecord(agentCfg[sub]) ? agentCfg[sub].model : undefined;
    if (typeof m === "string") return classify(m);
  } catch {
    // 無視
  }
  // 2) agent/<name>.md フロントマター model:
  try {
    const md = fs.readFileSync(path.join(cfgDir, "agent", `${sub}.md`), "utf8");
    const fm = md.match(/^---\s*\n[\s\S]*?\n---/);
    const line = fm?.[1].split("\n").find((l) => l.trimStart().startsWith("model:"));
    if (line) {
      const m = line.split(":", 2)[1].trim();
      if (m) return classify(m);
    }
  } catch {
    // 無視
  }
  // 3) agents/<name>.json "model"
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cfgDir, "agents", `${sub}.json`), "utf8"));
    if (isRecord(j) && typeof j.model === "string") return classify(j.model);
  } catch {
    // 無視
  }
  return null; // 非OpenAI or 不明はガード対象外
}

// v1.18+ では model がオブジェクトで渡る場合あり
function normalizeModel(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";

  const model = raw as ModelObject;
  const provider = asString(model.providerID ?? model.provider_id);
  const modelId = asString(model.modelID ?? model.model_id ?? model.id);
  return `${provider}/${modelId}`;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function messageInfo(event: unknown): MessageInfo | undefined {
  if (!isRecord(event) || !isRecord(event.properties) || !isRecord(event.properties.info)) return;
  return event.properties.info as MessageInfo;
}

async function checkLimit(model: string): Promise<{ allowed: boolean; message: string }> {
  const group = classify(model);
  if (!group) return { allowed: true, message: "" };

  const usage = await getEffectiveUsage();
  const current = group === "sol" ? usage.sol_tokens : usage.terra_tokens;
  const limit = limitFor(group);
  const percentage = ((current / limit) * 100).toFixed(1);

  // API 不通で真値確認不可 → 過小評価リスク → フェイルクローズ（課金回避）
  if (usage.apiUnavailable) {
    return {
      allowed: false,
      message: [
        `[USAGE GUARD] ${model} をブロック（課金回避）`,
        `  OpenAI Usage API 取得不可（ネットワーク/キー要確認）`,
        `  ローカル計測: ${current.toLocaleString()} / ${limit.toLocaleString()} tokens (${percentage}%)`,
      ].join("\n"),
    };
  }

  if (current >= limit) {
    return {
      allowed: false,
      message: [
        `[USAGE GUARD] ${model} がガード閾値 ${limit.toLocaleString()} tokens に到達`,
        `  現在: ${current.toLocaleString()} / ${limit.toLocaleString()} tokens (${percentage}%)`,
        `  リセット: 毎日 09:00 JST`,
      ].join("\n"),
    };
  }

  if (current >= limit * 0.6) {
    console.log(
      `[Usage Guard WARNING] ${model}: ${current.toLocaleString()} / ${limit.toLocaleString()} (${percentage}%)`
    );
  }

  return { allowed: true, message: "" };
}

// SQLite の UPDATE ... + ? による原子的加算
async function recordUsage(model: string, tokens: number): Promise<void> {
  const group = classify(model);
  if (!group || tokens <= 0) return;

  const totals = await addUsageAtomic(group, tokens);
  const limit = limitFor(group);
  const current = group === "sol" ? totals.sol : totals.terra;
  const percentage = ((current / limit) * 100).toFixed(1);
  console.log(
    `[Usage Guard] ${model}: +${tokens.toLocaleString()} → ${current.toLocaleString()} / ${limit.toLocaleString()} (${percentage}%)`
  );
}

// ストリーミング更新の重複排除
const seenTokens = new Map<string, number>();

export default async () => ({
  // chat.message は user のみ。リクエスト前ガードは chat.params で実施
  "chat.params": async (input: ChatParams) => {
    const model = normalizeModel(input.model);
    if (!classify(model)) return;

    const { allowed, message } = await checkLimit(model);
    if (!allowed) throw new Error(message);
  },

  // assistant 使用量は bus event の message.updated から取得
  event: async (input: { event?: unknown }) => {
    const event = input.event;
    if (!isRecord(event)) return;
    if (event.type !== "message.updated") return;

    const info = messageInfo(event);
    if (info?.role !== "assistant") return;

    const model = normalizeModel({
      providerID: info.providerID ?? info.provider_id,
      modelID: info.modelID ?? info.model_id,
    });
    if (!classify(model)) return;

    const tokens: TokenInfo = isRecord(info.tokens) ? info.tokens : {};
    const total =
      tokenCount(tokens.input) +
      tokenCount(tokens.output) +
      tokenCount(tokens.reasoning) +
      tokenCount(tokens.cache?.read);
    const messageId = asString(info.id);
    if (!messageId) return;

    const previous = seenTokens.get(messageId) ?? 0;
    const delta = total - previous;
    if (delta <= 0) return;

    // await 前に記録。並行イベントの二重加算防止
    seenTokens.set(messageId, total);
    try {
      await recordUsage(model, delta);
    } catch (error) {
      console.error("[Usage Guard] usage record failed:", error);
    }

    // セッション別記録（会話ごとの消費量追跡）
    try {
      const props = isRecord(event.properties) ? event.properties : {};
      const sessionId =
        asString(props.sessionID) ||
        asString(props.session_id) ||
        asString(props.conversationID) ||
        asString(props.conversation_id) ||
        asString((props as Record<string, unknown>).session) ||
        messageId; // フォールバック: message ID を session 代用
      await recordSessionUsage(classify(model)!, model, delta, sessionId);
    } catch (error) {
      console.error("[Usage Guard] session record failed:", error);
    }
  },

  // サブエージェント呼び出し自体をブロック（chat.params が効かない経路の穴を塞ぐ）
  "tool.execute.before": async (input: { tool?: unknown; args?: unknown }) => {
    const tool = asString(input.tool);
    if (tool !== "task") return;
    const args = isRecord(input.args) ? input.args : {};
    const sub = asString(args.subagent_type) || asString(args.agent) || asString(args.name);
    if (!sub) return;
    const group = agentGroup(sub);
    if (!group) return; // 非OpenAIサブエージェントは対象外

    const usage = await getEffectiveUsage();
    if (usage.apiUnavailable) {
      throw new Error(`[USAGE GUARD] task(${sub}) ブロック: OpenAI Usage API 取得不可（課金回避）`);
    }
    const current = group === "sol" ? usage.sol_tokens : usage.terra_tokens;
    if (current >= limitFor(group)) {
      throw new Error(
        `[USAGE GUARD] task(${sub}) ブロック: ${group} ${current.toLocaleString()} / ${limitFor(group).toLocaleString()} (課金回避)`
      );
    }
  },
});

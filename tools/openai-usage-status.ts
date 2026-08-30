import { tool } from "@opencode-ai/plugin";
import { getEffectiveUsage, getSessionBreakdown, SOL_LIMIT, TERRA_LIMIT } from "./openai-usage-shared";

export default () =>
  tool({
    description:
      "OpenAI API 無料枠の使用量照会。Sol/Terra/Luna の今日の消費トークン数と残量、セッション別内訳を返す。",
    args: {},
    async execute() {
      const usage = await getEffectiveUsage();
      const solRemaining = Math.max(0, SOL_LIMIT - usage.sol_tokens);
      const terraRemaining = Math.max(0, TERRA_LIMIT - usage.terra_tokens);
      const solPct = percentage(usage.sol_tokens, SOL_LIMIT);
      const terraPct = percentage(usage.terra_tokens, TERRA_LIMIT);

      const lines = [
        `═══ OpenAI Free Tier Usage (${usage.last_reset_date}) ═══`,
        ``,
        `■ Sol (${SOL_LIMIT.toLocaleString()}/日)`,
        `  使用: ${usage.sol_tokens.toLocaleString()} / ${SOL_LIMIT.toLocaleString()} tokens (${solPct}%)`,
        `  残量: ${solRemaining.toLocaleString()} tokens`,
        ``,
        `■ Terra/Luna/Mini/Nano (${TERRA_LIMIT.toLocaleString()}/日)`,
        `  使用: ${usage.terra_tokens.toLocaleString()} / ${TERRA_LIMIT.toLocaleString()} tokens (${terraPct}%)`,
        `  残量: ${terraRemaining.toLocaleString()} tokens`,
        ``,
        `リセット: 毎日 09:00 JST`,
      ];

      if (usage.sol_tokens >= SOL_LIMIT * 0.6)
        lines.push(`⚠ Sol: 60%超過 - 残量少`);
      if (usage.terra_tokens >= TERRA_LIMIT * 0.6)
        lines.push(`⚠ Terra/Luna: 60%超過 - 残量少`);

      // セッション別内訳
      const sessions = await getSessionBreakdown();
      if (sessions.length > 0) {
        lines.push(``, `── セッション別内訳 ──`);
        for (const s of sessions.slice(0, 10)) {
          const total = s.sol + s.terra;
          const group = s.terra > 0 ? "terra" : "sol";
          const pct = percentage(total, group === "sol" ? SOL_LIMIT : TERRA_LIMIT);
          const shortId = s.session_id.length > 12 ? s.session_id.slice(0, 12) + "…" : s.session_id;
          lines.push(
            `  ${shortId} [${s.model}] ${group}: ${total.toLocaleString()} tokens (${pct}%)`
          );
        }
      }

      return lines.join("\n");
    },
  });

function percentage(used: number, limit: number): string {
  return ((used / limit) * 100).toFixed(1);
}

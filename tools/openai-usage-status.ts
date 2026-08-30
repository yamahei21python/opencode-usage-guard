import { tool } from "@opencode-ai/plugin";
import { getEffectiveUsage, SOL_LIMIT, TERRA_LIMIT } from "./openai-usage-shared";

export default () =>
  tool({
    description:
      "OpenAI API 無料枠の使用量照会。Sol/Terra/Luna の今日の消費トークン数と残量を返す。",
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

      return lines.join("\n");
    },
  });

function percentage(used: number, limit: number): string {
  return ((used / limit) * 100).toFixed(1);
}

import fs from "fs";
import os from "os";
import path from "path";

export const SOL_LIMIT = 175_000;
export const TERRA_LIMIT = 2_000_000;

const DB_PATH = path.join(os.homedir(), ".opencode", "usage_guard.sqlite");
const JSON_PATH = path.join(os.homedir(), ".opencode", "today_usage.json");

type SqliteDatabase = {
  run(sql: string, params?: readonly unknown[]): unknown;
  query<T>(sql: string): { get(...params: readonly unknown[]): T | null };
};

type UsageTotals = { sol: number; terra: number };

let databasePromise: Promise<SqliteDatabase | null> | null = null;

// SQLite 優先、失敗時は JSON フォールバック（ガードが死なないように）
async function getDatabase(): Promise<SqliteDatabase | null> {
  databasePromise ??= (async () => {
    try {
      const { Database } = await import("bun:sqlite");
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      const database = new Database(DB_PATH, { create: true }) as SqliteDatabase;
      database.run("PRAGMA journal_mode = WAL");
      database.run("PRAGMA busy_timeout = 5000");
      database.run("PRAGMA synchronous = NORMAL");
      database.run(
        "CREATE TABLE IF NOT EXISTS usage (date TEXT PRIMARY KEY, sol INTEGER NOT NULL DEFAULT 0, terra INTEGER NOT NULL DEFAULT 0)"
      );
      return database;
    } catch (error) {
      console.error("[Usage Guard] SQLite init failed, fallback JSON:", error);
      return null;
    }
  })();
  return databasePromise;
}

export interface UsageData {
  last_reset_date: string;
  sol_tokens: number;
  terra_tokens: number;
}

/** UTC 00:00 = JST 09:00 リセット（OpenAI 公式と一致） */
export function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

async function ensureRow(date: string): Promise<void> {
  const d = await getDatabase();
  if (!d) return;
  d.run("INSERT OR IGNORE INTO usage (date, sol, terra) VALUES (?, 0, 0)", [date]);
}

export async function loadUsage(): Promise<UsageData> {
  const today = todayStr();
  const d = await getDatabase();
  if (d) {
    try {
      await ensureRow(today);
      const row = d.query<UsageTotals>("SELECT sol, terra FROM usage WHERE date = ?").get(today);
      if (row) {
        return {
          last_reset_date: today,
          sol_tokens: finiteTokenCount(row.sol),
          terra_tokens: finiteTokenCount(row.terra),
        };
      }
    } catch (error) {
      console.error("[Usage Guard] SQLite read failed, fallback JSON:", error);
    }
    return loadUsageJson();
  }
  return loadUsageJson();
}

function loadUsageJson(): UsageData {
  const today = todayStr();
  const init: UsageData = { last_reset_date: today, sol_tokens: 0, terra_tokens: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    if (
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      raw.last_reset_date === today
    ) {
      return {
        last_reset_date: today,
        sol_tokens: Number(raw.sol_tokens) || 0,
        terra_tokens: Number(raw.terra_tokens) || 0,
      };
    }
  } catch {
    // 初回起動・破損ファイルは未使用として扱う
  }
  return init;
}

export async function saveUsage(data: UsageData): Promise<void> {
  const d = await getDatabase();
  if (d) {
    try {
      await ensureRow(data.last_reset_date);
      d.run("UPDATE usage SET sol = ?, terra = ? WHERE date = ?", [
        data.sol_tokens,
        data.terra_tokens,
        data.last_reset_date,
      ]);
    } catch (error) {
      console.error("[Usage Guard] SQLite save failed:", error);
    }
    return;
  }
  try {
    fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
    fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("[Usage Guard] save failed:", e);
  }
}

/** 原子的加算（並行セッションでもロストしない） */
export async function addUsage(
  group: "sol" | "terra",
  amount: number
): Promise<{ sol: number; terra: number }> {
  const date = todayStr();
  const increment = finiteTokenCount(amount);
  if (increment <= 0) return loadUsageJsonTotals();
  const d = await getDatabase();
  if (d) {
    const col = group === "sol" ? "sol" : "terra";
    try {
      await ensureRow(date);
      d.run(`UPDATE usage SET ${col} = ${col} + ? WHERE date = ?`, [increment, date]);
    } catch (error) {
      console.error("[Usage Guard] SQLite increment failed:", error);
      return loadUsageJsonTotals();
    }
    const row = d.query<UsageTotals>("SELECT sol, terra FROM usage WHERE date = ?").get(date);
    if (!row) return { sol: 0, terra: 0 };
    return { sol: finiteTokenCount(row.sol), terra: finiteTokenCount(row.terra) };
  }
  // JSON フォールバック（read-modify-write、競合の可能性あり）
  const u = loadUsageJson();
  if (group === "sol") u.sol_tokens += increment;
  else u.terra_tokens += increment;
  await saveUsage(u);
  return { sol: u.sol_tokens, terra: u.terra_tokens };
}

function finiteTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function loadUsageJsonTotals(): UsageTotals {
  const usage = loadUsageJson();
  return { sol: usage.sol_tokens, terra: usage.terra_tokens };
}

// ── OpenAI 実使用量 API（クロスツール検知・真値補正）──
let usageCache: { fetchedAt: number; data: UsageTotals } | null = null;
const USAGE_TTL_MS = 5 * 60 * 1000;

function openaiAdminKey(): string | undefined {
  const processEnv = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const bunEnv = (globalThis as {
    Bun?: { env?: Record<string, string | undefined> };
  }).Bun?.env;
  const key = processEnv?.OPENAI_ADMIN_KEY ?? bunEnv?.OPENAI_ADMIN_KEY;
  if (key?.trim()) return key.trim();
  // フォールバック: opencode が env 無しで起動された場合でも ~/.zshrc から取得
  // （クロスツール検知は API 要キーのため、欠落すると Cline/ChatGPT 分を看過する）
  try {
    const zshrc = fs.readFileSync(path.join(os.homedir(), ".zshrc"), "utf8");
    const m = zshrc.match(/OPENAI_ADMIN_KEY=['"]([^'"]+)['"]/);
    if (m?.[1]) return m[1];
  } catch {
    // 無視
  }
  return undefined;
}

export async function fetchOpenAIUsage(): Promise<UsageTotals | null> {
  const now = Date.now();
  if (usageCache && now - usageCache.fetchedAt < USAGE_TTL_MS) return usageCache.data;

  const key = openaiAdminKey();
  if (!key) return null;

  try {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const startSec = Math.floor(start.getTime() / 1000);
    const endSec = Math.floor(now / 1000);

    const params = new URLSearchParams({
      start_time: String(startSec),
      end_time: String(endSec),
      bucket_width: "1d",
      group_by: "model",
    });
    const url = `https://api.openai.com/v1/organization/usage/completions?${params}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    if (!res.ok) {
      console.error(`[Usage Guard] OpenAI usage API ${res.status}`);
      return null;
    }
    const json: unknown = await res.json();
    const buckets = isRecord(json) && Array.isArray(json.data) ? json.data : [];
    let sol = 0;
    let terra = 0;
    for (const b of buckets) {
      if (!isRecord(b)) continue;
      // 前日バケツ（境界 artifact）を除外し、本日 UTC 分のみ集計
      if (typeof b.start_time === "number" && b.start_time < startSec) continue;
      const results = Array.isArray(b.results)
        ? b.results
        : Array.isArray(b.result)
          ? b.result
          : [];
      for (const r of results) {
        if (!isRecord(r)) continue;
        const m = typeof r.model === "string" ? r.model : "";
        const g = classify(m);
        if (!g) continue;
        const tokens = finiteTokenCount(r.input_tokens) + finiteTokenCount(r.output_tokens);
        if (g === "sol") sol += tokens;
        else terra += tokens;
      }
    }
    usageCache = { fetchedAt: now, data: { sol, terra } };
    return { sol, terra };
  } catch (e) {
    console.error("[Usage Guard] OpenAI usage API failed:", e);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ローカル計測と API 真値の最大値（即時性＋網羅性のハイブリッド）
export async function getEffectiveUsage(): Promise<UsageData & { apiUnavailable: boolean }> {
  const local = await loadUsage();
  let sol = local.sol_tokens;
  let terra = local.terra_tokens;
  // キーなしの場合はローカルのみ（apiUnavailable は false のまま = 従来の動作）
  const key = openaiAdminKey();
  let apiUnavailable = false;
  if (key) {
    const api = await fetchOpenAIUsage();
    if (api) {
      sol = Math.max(sol, api.sol);
      terra = Math.max(terra, api.terra);
      if (api.sol > local.sol_tokens || api.terra > local.terra_tokens) {
        console.log(
          `[Usage Guard] API真値反映 sol=${api.sol} terra=${api.terra} (Cline等他ツール分含む)`
        );
      }
    } else {
      apiUnavailable = true; // キーはあるが API 取得失敗 → 真値確認不可
    }
  }
  return { last_reset_date: local.last_reset_date, sol_tokens: sol, terra_tokens: terra, apiUnavailable };
}

export type ModelGroup = "sol" | "terra" | null;

export function classify(modelId: string): ModelGroup {
  const id = modelId.trim().toLowerCase();
  const bare = id.split("/").pop() ?? "";
  if (bare === "gpt-5.6-sol") return "sol";
  if (
    bare.includes("terra") ||
    bare.includes("luna") ||
    bare.includes("mini") ||
    bare.includes("nano")
  )
    return "terra";
  return null;
}

export function limitFor(group: "sol" | "terra"): number {
  return group === "sol" ? SOL_LIMIT : TERRA_LIMIT;
}

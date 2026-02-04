import type { FeishuConfig, FeishuProbeResult } from "./types.js";
import { createFeishuClient } from "./client.js";
import { resolveFeishuCredentials } from "./accounts.js";

const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_CACHE_KEY_NO_CREDS = "__missing_credentials__";

type ProbeCacheEntry = {
  expiresAt: number;
  result: FeishuProbeResult;
};

const probeCache = new Map<string, ProbeCacheEntry>();
const probeInFlight = new Map<string, Promise<FeishuProbeResult>>();

function getProbeCacheKey(cfg?: FeishuConfig): string {
  const creds = resolveFeishuCredentials(cfg);
  if (!creds) return PROBE_CACHE_KEY_NO_CREDS;
  return `${creds.domain}:${creds.appId}`;
}

export async function probeFeishu(cfg?: FeishuConfig): Promise<FeishuProbeResult> {
  const cacheKey = getProbeCacheKey(cfg);
  const now = Date.now();
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const inFlight = probeInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const requestPromise = (async (): Promise<FeishuProbeResult> => {
    const creds = resolveFeishuCredentials(cfg);
    if (!creds) {
      return {
        ok: false,
        error: "missing credentials (appId, appSecret)",
      };
    }

    try {
      const client = createFeishuClient(cfg!);
      // Use im.chat.list as a simple connectivity test
      // The bot info API path varies by SDK version
      const response = await (client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
        data: {},
      });

      if (response.code !== 0) {
        return {
          ok: false,
          appId: creds.appId,
          error: `API error: ${response.msg || `code ${response.code}`}`,
        };
      }

      const bot = response.bot || response.data?.bot;
      return {
        ok: true,
        appId: creds.appId,
        botName: bot?.bot_name,
        botOpenId: bot?.open_id,
      };
    } catch (err) {
      return {
        ok: false,
        appId: creds.appId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();

  probeInFlight.set(cacheKey, requestPromise);

  try {
    const result = await requestPromise;
    probeCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
    });
    return result;
  } finally {
    probeInFlight.delete(cacheKey);
  }
}

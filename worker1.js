/**
 * Microsoft ISO & Tools Bot
 * Cloudflare Worker (Webhook) + KV cache + Deno Deploy proxy fallback
 *
 * Secrets (wrangler secret put ...):
 *   BOT_TOKEN      — Telegram bot token
 *   PROXY_SECRET   — shared secret with Deno proxy
 *
 * wrangler.toml [vars]:
 *   DENO_PROXY_URL = "https://your-project.deno.dev"
 *
 * KV binding = "CACHE" in wrangler.toml
 *
 * SESSION LOGIC (Fido 1.70 exact):
 *   $SessionId = @($null) * 2  → отдельный sessionId для каждого editionId
 *   whitelist → ovdf → getskuinformation  (с SessionVariable "Session" — куки)
 *   GetProductDownloadLinksBySku использует ТОТ ЖЕ sessionId[$Entry.SessionIndex]
 *   SessionIds одноразовые — НИКОГДА не кешируются в KV
 */

/**
 * @typedef {{ BOT_TOKEN: string; CACHE: KVNamespace; DENO_PROXY_URL?: string; PROXY_SECRET?: string }} Env
 * @typedef {{ callback_query?: TgCQ; message?: TgMsg }} TgUpdate
 * @typedef {{ chat: { id: number }; message_id: number; text?: string }} TgMsg
 * @typedef {{ id: string; data?: string; message?: TgMsg; from: { id: number } }} TgCQ
 * @typedef {{ display: string; name: string; skuData: { sessionIndex: number; skuId: string }[]; sessionIds: string[]; cookies: string[][] }} LangItem
 * @typedef {{ arch: string; url: string }} LinkItem
 */

import { OFFICE_VERSIONS, STANDALONE_APPS } from "./linkoffice.js";

// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════

const TTL_LANGS        = 6 * 3600;   // 6 часов — список языков (без sessionIds)
const TTL_LINKS        = 24 * 3600;  // 24 часа — ссылки на ISO
const TIMEOUT_MS       = 15_000;     // таймаут прямого запроса к MS
const PROXY_TIMEOUT_MS = 20_000;     // таймаут через Deno прокси
const DEFAULT_TIMEOUT  = 30_000;     // как $DefaultTimeout = 30 в Fido
const LOCALE           = "en-US";    // $QueryLocale в Fido
const ORG_ID           = "y6jn8c31";
const PROFILE_ID       = "606624d44113";
const INST_ID          = "560dc9f3-1aa5-4a2f-b63c-9e18f8d0e175";

// Browser headers — для preVisit
const BH = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "DNT":             "1",
};

// AJAX headers — для API запросов Microsoft
const AH = {
  "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":            "application/json, text/plain, */*",
  "Accept-Language":   "en-US,en;q=0.9",
  "X-Requested-With":  "XMLHttpRequest",
};

const POPULAR_LANGS = [
  "Russian", "English", "German", "French", "Spanish",
  "Italian", "Portuguese Brazil", "Ukrainian", "Polish",
  "Chinese Simplified", "Chinese Traditional", "Japanese", "Korean",
];

// ═══════════════════════════════════════════
// WINDOWS VERSIONS — из Fido 1.70
// ═══════════════════════════════════════════

const WIN_VERSIONS = [
  {
    name:    "Windows 11",
    dl_page: "https://www.microsoft.com/software-download/windows11",
    releases: [
      {
        label: "25H2 v2 (Build 26200.8037 — 2026.03)",
        editions: [
          // Fido: @("Windows 11 Home/Pro/Edu", @(3321, 3324))
          // два id → два sessionId → x64 и ARM64
          { name: "Windows 11 Home/Pro/Edu", ids: [3321, 3324] },
          { name: "Windows 11 Home China",   ids: [3322, 3325] },
          { name: "Windows 11 Pro China",    ids: [3323, 3326] },
        ],
      },
    ],
  },
  {
    name:    "Windows 10",
    dl_page: "https://www.microsoft.com/software-download/windows10ISO",
    releases: [
      {
        label: "22H2 v1 (Build 19045.2965 — 2023.05)",
        editions: [
          // Fido: @("Windows 10 Home/Pro/Edu", 2618) — один id
          { name: "Windows 10 Home/Pro/Edu", ids: [2618] },
          { name: "Windows 10 Home China",   ids: [2378] },
        ],
      },
    ],
  },
];

// ═══════════════════════════════════════════
// WINDOWS SERVER
// ═══════════════════════════════════════════

const SERVER_VERSIONS = [
  { name: "Windows Server 2025", linkId: "2313280", langs: [
    { code: "en-us", name: "English",            clcid: "0x409", country: "US" },
    { code: "ru-ru", name: "Russian",            clcid: "0x419", country: "RU" },
    { code: "de-de", name: "German",             clcid: "0x407", country: "DE" },
    { code: "fr-fr", name: "French",             clcid: "0x40c", country: "FR" },
    { code: "es-es", name: "Spanish",            clcid: "0xc0a", country: "ES" },
    { code: "zh-cn", name: "Chinese Simplified", clcid: "0x804", country: "CN" },
    { code: "ja-jp", name: "Japanese",           clcid: "0x411", country: "JP" },
    { code: "ko-kr", name: "Korean",             clcid: "0x412", country: "KR" },
  ]},
  { name: "Windows Server 2022", linkId: "2195280", langs: [
    { code: "en-us", name: "English",            clcid: "0x409", country: "US" },
    { code: "ru-ru", name: "Russian",            clcid: "0x419", country: "RU" },
    { code: "de-de", name: "German",             clcid: "0x407", country: "DE" },
    { code: "fr-fr", name: "French",             clcid: "0x40c", country: "FR" },
    { code: "es-es", name: "Spanish",            clcid: "0xc0a", country: "ES" },
    { code: "zh-cn", name: "Chinese Simplified", clcid: "0x804", country: "CN" },
    { code: "ja-jp", name: "Japanese",           clcid: "0x411", country: "JP" },
    { code: "ko-kr", name: "Korean",             clcid: "0x412", country: "KR" },
  ]},
  { name: "Windows Server 2019", linkId: "2237606", langs: [
    { code: "en-us", name: "English",            clcid: "0x409", country: "US" },
    { code: "ru-ru", name: "Russian",            clcid: "0x419", country: "RU" },
    { code: "de-de", name: "German",             clcid: "0x407", country: "DE" },
    { code: "fr-fr", name: "French",             clcid: "0x40c", country: "FR" },
    { code: "es-es", name: "Spanish",            clcid: "0xc0a", country: "ES" },
    { code: "zh-cn", name: "Chinese Simplified", clcid: "0x804", country: "CN" },
    { code: "ja-jp", name: "Japanese",           clcid: "0x411", country: "JP" },
    { code: "ko-kr", name: "Korean",             clcid: "0x412", country: "KR" },
  ]},
];

// ═══════════════════════════════════════════
// STATIC ITEMS
// ═══════════════════════════════════════════

const STATIC = {
  mct: {
    label: "🛠 Media Creation Tool",
    items: [
      { name: "MCT — Windows 11 25H2", url: "https://download.microsoft.com/download/4e211187-7e51-429a-a93f-5bf9a77ad77e/MediaCreationTool.exe" },
      { name: "MCT — Windows 11 24H2", url: "https://software-static.download.prss.microsoft.com/dbazure/888969d5-f34g-4e03-ac9d-1f9786c66749/mediacreationtool.exe" },
      { name: "MCT — Windows 11 23H2", url: "https://download.microsoft.com/download/e/c/d/ecd532eb-bed0-465a-9b7a-330066bec3ce/MediaCreationTool_Win11_23H2.exe" },
      { name: "MCT — Windows 11 22H2", url: "https://software-static.download.prss.microsoft.com/dbazure/988969d5-f34g-4e03-ac9d-1f9786c66749/mediacreationtool.exe" },
      { name: "MCT — Windows 11 21H2", url: "https://software-download.microsoft.com/download/pr/888969d5-f34g-4e03-ac9d-1f9786c69161/MediaCreationToolW11.exe" },
      { name: "MCT — Windows 10 22H2", url: "https://download.microsoft.com/download/9/e/a/9eac306f-d134-4609-9c58-35d1638c2363/MediaCreationTool_22H2.exe" },
      { name: "MCT — Windows 10 21H2", url: "https://download.microsoft.com/download/b/0/5/b053c6bc-fc07-4785-a66a-63c5aeb715a9/MediaCreationTool21H2.exe" },
      { name: "MCT — Windows 10 21H1", url: "https://download.microsoft.com/download/d/5/2/d528a4e0-03f3-452d-a98e-3e479226d166/MediaCreationTool21H1.exe" },
      { name: "MCT — Windows 10 20H2", url: "https://download.microsoft.com/download/4/c/c/4cc6c15c-75a5-4d1b-a3fe-140a5e09c9ff/MediaCreationTool20H2.exe" },
      { name: "MCT — Windows 10 2004", url: "https://software-download.microsoft.com/download/pr/8d71966f-05fd-4d64-900b-f49135257fa5/MediaCreationTool2004.exe" },
      { name: "MCT — Windows 10 1909", url: "https://download.microsoft.com/download/c/0/b/c0b2b254-54f1-42de-bfe5-82effe499ee0/MediaCreationTool1909.exe" },
      { name: "MCT — Windows 10 1903", url: "https://download.microsoft.com/download/9/8/8/9886d5ac-8d7c-4570-a3af-e887ce89cf65/MediaCreationTool1903.exe" },
    ],
  },
  office_apps: {
    label: "📄 Word / Excel (standalone, RU)",
    items: [
      { name: "Word 2021",  url: "https://officecdn.microsoft.com/db/492350f6-3a01-4f97-b9c0-c7c6ddf67d60/media/ru-RU/Word2021Retail.img" },
      { name: "Word 2019",  url: "https://officecdn.microsoft.com/db/492350F6-3A01-4F97-B9C0-C7C6DDF67D60/media/ru-RU/Word2019Retail.img" },
      { name: "Word 2013",  url: "https://officecdn.microsoft.com/pr/39168D7E-077B-48E7-872C-B232C3E72675/media/ru-RU/WordRetail.img" },
      { name: "Excel 2021", url: "https://officecdn.microsoft.com/db/492350f6-3a01-4f97-b9c0-c7c6ddf67d60/media/ru-RU/Excel2021Retail.img" },
      { name: "Excel 2019", url: "https://officecdn.microsoft.com/db/492350F6-3A01-4F97-B9C0-C7C6DDF67D60/media/ru-RU/Excel2019Retail.img" },
      { name: "Excel 2013", url: "https://officecdn.microsoft.com/pr/39168D7E-077B-48E7-872C-B232C3E72675/media/ru-RU/ExcelRetail.img" },
    ],
  },
  admin: {
    label: "🔧 Windows Admin Center",
    items: [
      { name: "Windows Admin Center (latest)", url: "https://aka.ms/WACDownload" },
      { name: "Windows Admin Center 2311",     url: "https://download.microsoft.com/download/1/0/5/1059800B-F375-451C-B37A-FB820EE6CEDE/WindowsAdminCenter2311.msi" },
      { name: "Windows Admin Center 2306",     url: "https://download.microsoft.com/download/1/0/5/1059800B-F375-451C-B37A-FB820EE6CEDE/WindowsAdminCenter2306.msi" },
    ],
  },
};

// ═══════════════════════════════════════════
// KV CACHE
// ═══════════════════════════════════════════

async function kvGet(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const { data, created_at, ttl } = parsed;
    if (!created_at || !ttl) return null;
    if (Math.floor(Date.now() / 1000) - created_at > ttl) {
      kv.delete(key);
      return null;
    }
    return { data, created_at };
  } catch { return null; }
}

async function kvSet(kv, key, data, ttl) {
  const created_at = Math.floor(Date.now() / 1000);
  await kv.put(key, JSON.stringify({ data, created_at, ttl }), { expirationTtl: ttl });
}

async function saveUrlKV(kv, chatId, url) {
  await kv.put(`url:${chatId}`, JSON.stringify({ url }), { expirationTtl: TTL_LINKS });
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function expiryText(createdAt) {
  const rem = Math.floor(createdAt + TTL_LINKS - Date.now() / 1000);
  if (rem <= 0) return "⏰ Link expired";
  const h = Math.floor(rem / 3600), m = Math.floor((rem % 3600) / 60);
  return h > 0 ? `⏳ Expires in ${h}h ${m}m` : `⏳ Expires in ${m}m`;
}

function is715(text) {
  return typeof text === "string" && text.includes("715-123130");
}

function isErr715(err) {
  // Fido: if ($r.Errors[0].Type -eq 9)
  return (
    Number(err["Type"]) === 9 ||
    String(err["Value"] || "").includes("715-123130") ||
    String(err["Key"]   || "").includes("Sentinel")
  );
}

function parseResp(body) {
  if (is715(body)) throw new Error("BLOCKED_715");
  try {
    const p = JSON.parse(body);
    if (typeof p === "object" && p !== null) return p;
  } catch { /* */ }
  throw new Error(`Unexpected response: ${body.slice(0, 200)}`);
}

function errMsg(e, vi) {
  const dp  = WIN_VERSIONS[vi]?.dl_page || "";
  const ref = dp ? `\n\n🌐 <a href="${dp}">Download manually</a>` : "";
  if (e.includes("BLOCKED_715"))
    return `⛔ <b>Microsoft blocked this IP (715-123130)</b>\n\nWait 1–2 hours and try again.${ref}`;
  if (e.includes("EMPTY"))
    return `⚠️ <b>Microsoft returned empty response.</b>\nTry again in a minute.${ref}`;
  if (e.includes("TIMEOUT") || e.includes("MS_TIMEOUT"))
    return `⏱ <b>Microsoft API timeout.</b>\nTry again in a minute.${ref}`;
  return `❌ <b>Error:</b>\n<code>${e.slice(0, 300)}</code>${ref}`;
}

// ═══════════════════════════════════════════
// DENO PROXY
// ═══════════════════════════════════════════

async function fetchViaProxy(env, url, headers) {
  if (!env.DENO_PROXY_URL || !env.PROXY_SECRET) throw new Error("Proxy not configured");
  console.log("[PROXY] →", url);
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const resp = await fetch(env.DENO_PROXY_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-proxy-secret": env.PROXY_SECRET },
      body:    JSON.stringify({ url, headers }),
      signal:  controller.signal,
    });
    if (!resp.ok) throw new Error(`Proxy HTTP ${resp.status}`);
    const text = await resp.text();
    console.log("[PROXY] ← len", text.length);
    return text;
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Универсальный fetch: прямой запрос → при ошибке/715/таймауте → прокси.
 * cookies — массив строк Set-Cookie из предыдущих ответов (имитация SessionVariable).
 */
async function msFetch(env, url, reqHeaders, cookies) {
  const hdrs = { ...reqHeaders };
  if (cookies && cookies.length > 0) {
    hdrs["Cookie"] = cookies.join("; ");
  }

  let text = null;
  let respCookies = [];

  // 1. Прямой запрос
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers: hdrs, signal: controller.signal });
      text = await resp.text();
      const setCookie = resp.headers.get("set-cookie");
      if (setCookie) respCookies = setCookie.split(",").map(c => c.split(";")[0].trim());
    } finally {
      clearTimeout(tid);
    }
  } catch (e) {
    console.warn("[MS] direct failed:", String(e));
    text = null;
  }

  // Диагностика
  console.log("[msFetch] url:", url.slice(0, 80));
  console.log("[msFetch] text===null:", text === null, "| is715:", is715(text));
  console.log("[msFetch] DENO_PROXY_URL:", env.DENO_PROXY_URL || "NOT SET");

  // 2. Нужен прокси?
  if (text === null || is715(text)) {
    if (!env.DENO_PROXY_URL) {
      console.warn("[msFetch] proxy not configured, throwing");
      if (text === null) throw new Error("MS_TIMEOUT");
      throw new Error("BLOCKED_715");
    }
    console.log("[msFetch] → going to proxy");
    text = await fetchViaProxy(env, url, hdrs);
    console.log("[msFetch] proxy response is715:", is715(text));
    respCookies = [];
  }

  // 3. Прокси тоже вернул 715?
  if (is715(text)) {
    console.warn("[msFetch] 715 even after proxy");
    throw new Error("BLOCKED_715");
  }

  return { text, cookies: respCookies };
}

// ═══════════════════════════════════════════
// MICROSOFT SESSION — точная логика Fido 1.70
// ═══════════════════════════════════════════

/**
 * Fido: preVisit dl_page перед сессией
 */
async function preVisit(dlPage, env) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10_000);
    await fetch(dlPage, { headers: BH, signal: controller.signal });
  } catch { /* ignore */ }
}

/**
 * Fido шаг 1: whitelist sessionId через vlscppe.microsoft.com/tags
 * Таймаут 5 сек — не критичный шаг, не должен висеть.
 */
async function doWhitelist(sid, env, prevCookies) {
  const url = "https://vlscppe.microsoft.com/tags?org_id=" + ORG_ID + "&session_id=" + sid;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5_000);
    try {
      const resp = await fetch(url, {
        headers:  { ...BH, ...(prevCookies?.length ? { Cookie: prevCookies.join("; ") } : {}) },
        redirect: "manual",
        signal:   controller.signal,
      });
      const setCookie = resp.headers.get("set-cookie");
      if (setCookie) return setCookie.split(",").map(c => c.split(";")[0].trim());
    } finally {
      clearTimeout(tid);
    }
  } catch (e) {
    console.warn("[whitelist] failed:", String(e));
  }
  return prevCookies || [];
}

/**
 * Fido шаг 2: ov-df.microsoft.com
 * Таймаут 5 сек на каждый запрос — не критичный шаг, не должен висеть.
 */
async function doOvdf(sid, env, cookies) {
  try {
    // 2a: получить mdt.js
    const mdtUrl = "https://ov-df.microsoft.com/mdt.js?instanceId=" + INST_ID + "&PageId=si&session_id=" + sid;

    const ctrl1 = new AbortController();
    const tid1  = setTimeout(() => ctrl1.abort(), 5_000);
    let txt;
    try {
      const resp = await fetch(mdtUrl, {
        headers: { ...BH, ...(cookies?.length ? { Cookie: cookies.join("; ") } : {}) },
        signal:  ctrl1.signal,
      });
      txt = await resp.text();
    } finally {
      clearTimeout(tid1);
    }

    // Fido: if ($r -match '[?&]w=([A-F0-9]+)')
    const mW = txt.match(/[?&]w=([A-F0-9]+)/i);
    // Fido: if ($r -match 'rticks\=\"\+?(\d+)')
    const mR = txt.match(/rticks\s*=\s*"\+?(\d+)/);

    if (!mW || !mR) {
      console.warn("[ovdf] could not extract w/rticks, continuing anyway");
      return cookies;
    }

    // 2b: отправить reply
    const replyUrl = "https://ov-df.microsoft.com/?session_id=" + sid
      + "&CustomerId=" + INST_ID
      + "&PageId=si&w=" + mW[1]
      + "&mdt=" + Date.now()
      + "&rticks=" + mR[1];

    const ctrl2 = new AbortController();
    const tid2  = setTimeout(() => ctrl2.abort(), 5_000);
    try {
      await fetch(replyUrl, {
        headers: { ...BH, ...(cookies?.length ? { Cookie: cookies.join("; ") } : {}) },
        signal:  ctrl2.signal,
      });
    } finally {
      clearTimeout(tid2);
    }

  } catch (e) {
    console.warn("[ovdf] failed:", String(e));
  }

  // Всегда возвращаем исходные куки — ovdf не критичен
  return cookies;
}

// ═══════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════

async function fetchLanguages(vi, editionIds, env) {
  const referer        = WIN_VERSIONS[vi].dl_page;
  const langs          = {};
  const sessionIds     = new Array(editionIds.length).fill(null);
  const sessionCookies = new Array(editionIds.length).fill([]);

  await preVisit(referer, env);

  for (let si = 0; si < editionIds.length; si++) {
    sessionIds[si]     = crypto.randomUUID();
    sessionCookies[si] = await doWhitelist(sessionIds[si], env, []);
    sessionCookies[si] = await doOvdf(sessionIds[si], env, sessionCookies[si]);

    const url = "https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition"
      + "?profile=" + PROFILE_ID
      + "&productEditionId=" + editionIds[si]
      + "&SKU=undefined&friendlyFileName=undefined"
      + "&Locale=" + LOCALE
      + "&sessionID=" + sessionIds[si];

    let data;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000));

      const msResult = await msFetch(env, url, { ...AH, Referer: referer }, sessionCookies[si]);
      const text = msResult.text;

      console.log("[fetchLanguages] editionId=" + editionIds[si] + " attempt=" + attempt + " response(200):", text.slice(0, 200));

      if (msResult.cookies.length) sessionCookies[si] = msResult.cookies;

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        console.warn("[fetchLanguages] JSON parse error:", String(e), "body:", text.slice(0, 100));
        if (attempt === 0) continue;
        throw new Error("Unexpected response: " + text.slice(0, 200));
      }

      data = parsed;

      if (data.Errors && data.Errors.length > 0) {
        console.warn("[fetchLanguages] Errors:", JSON.stringify(data.Errors[0]));
        if (isErr715(data.Errors[0])) throw new Error("BLOCKED_715");
        if (attempt === 0) continue;
        throw new Error(String(data.Errors[0].Value || "API error"));
      }

      if (!data.Skus || !data.Skus.length) {
        console.warn("[fetchLanguages] empty Skus");
        if (attempt === 0) continue;
        throw new Error("EMPTY_LANGUAGES");
      }

      console.log("[fetchLanguages] got " + data.Skus.length + " SKUs for editionId=" + editionIds[si]);
      break;
    }

    for (const sku of (data.Skus || [])) {
      const lg = String(sku.Language);
      if (!langs[lg]) langs[lg] = { display: String(sku.LocalizedLanguage), skuData: [] };
      langs[lg].skuData.push({ sessionIndex: si, skuId: String(sku.Id) });
    }
  }

  if (!Object.keys(langs).length) throw new Error("EMPTY_LANGUAGES");

  return Object.entries(langs).map(([name, v]) => ({
    name,
    display:         v.display,
    skuData:         v.skuData,
    sessionIds,
    sessionCookies,
  }));
}

async function getLanguageList(kv, vi, editionIds, env) {
  const ck     = "langlist:" + vi + ":" + editionIds.join(",");
  const cached = await kvGet(kv, ck);
  if (cached) return cached.data;

  const langs = await fetchLanguages(vi, editionIds, env);
  const list  = langs.map(l => ({ name: l.name, display: l.display }));
  await kvSet(kv, ck, list, TTL_LANGS);
  return list;
}

/**
 * Создаёт новую сессию полностью через Deno прокси и получает ссылку.
 * Используется когда CF IP заблокирован Sentinel.
 * Новый sessionId создаётся и используется целиком с одного IP (Deno).
 */
async function getDownloadLinkViaProxy(env, skuId, editionId, referer) {
  const newSid = crypto.randomUUID();
  console.log("[proxySession] new sid=" + newSid.slice(0, 8) + "... skuId=" + skuId);

  // whitelist через прокси
  try {
    await fetchViaProxy(env, "https://vlscppe.microsoft.com/tags?org_id=" + ORG_ID + "&session_id=" + newSid, { ...BH });
    console.log("[proxySession] whitelist ok");
  } catch (e) { console.warn("[proxySession] whitelist failed:", String(e)); }

  // ovdf через прокси
  try {
    const mdtText = await fetchViaProxy(env, "https://ov-df.microsoft.com/mdt.js?instanceId=" + INST_ID + "&PageId=si&session_id=" + newSid, { ...BH });
    const mW = mdtText.match(/[?&]w=([A-F0-9]+)/i);
    const mR = mdtText.match(/rticks\s*=\s*"\+?(\d+)/);
    if (mW && mR) {
      await fetchViaProxy(env, "https://ov-df.microsoft.com/?session_id=" + newSid + "&CustomerId=" + INST_ID + "&PageId=si&w=" + mW[1] + "&mdt=" + Date.now() + "&rticks=" + mR[1], { ...BH });
      console.log("[proxySession] ovdf ok");
    }
  } catch (e) { console.warn("[proxySession] ovdf failed:", String(e)); }

  // getskuinformation через прокси — получаем свежий SKU для этого editionId
  let freshSkuId = skuId;
  try {
    const skuUrl = "https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition"
      + "?profile=" + PROFILE_ID
      + "&productEditionId=" + editionId
      + "&SKU=undefined&friendlyFileName=undefined"
      + "&Locale=" + LOCALE
      + "&sessionID=" + newSid;
    const skuText = await fetchViaProxy(env, skuUrl, { ...AH, Referer: referer });
    console.log("[proxySession] getsku response(150):", skuText.slice(0, 150));
    const skuData = JSON.parse(skuText);
    if (skuData.Skus && skuData.Skus.length > 0) {
      const found = skuData.Skus.find(s => String(s.Id) === String(skuId));
      if (found) {
        freshSkuId = String(found.Id);
        console.log("[proxySession] found matching sku:", freshSkuId);
      } else {
        console.warn("[proxySession] original skuId not found, using first:", skuData.Skus[0].Id);
        freshSkuId = String(skuData.Skus[0].Id);
      }
    }
  } catch (e) { console.warn("[proxySession] getsku failed, using original skuId:", String(e)); }

  // Задержка перед GetLinks — критично для обхода rate limit Sentinel
  await new Promise(r => setTimeout(r, 4000 + Math.random() * 2000));

  // GetProductDownloadLinksBySku через прокси с новым sessionId и свежим SKU
  const dlUrl = "https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku"
    + "?profile=" + PROFILE_ID
    + "&productEditionId=undefined&SKU=" + freshSkuId
    + "&friendlyFileName=undefined&Locale=" + LOCALE
    + "&sessionID=" + newSid;

  const proxyText = await fetchViaProxy(env, dlUrl, { ...AH, Referer: referer });
  console.log("[proxySession] GetLinks response(200):", proxyText.slice(0, 200));

  const data = JSON.parse(proxyText);
  if (data.Errors && data.Errors.length > 0) {
    console.warn("[proxySession] errored:", JSON.stringify(data.Errors[0]));
    throw new Error("BLOCKED_715");
  }

  return data.ProductDownloadOptions || [];
}

async function getDownloadLinks(kv, vi, ri, editionIds, langName, env) {
  const ck     = "links:" + vi + ":" + ri + ":" + langName;
  const cached = await kvGet(kv, ck);
  if (cached) {
    console.log("[getDownloadLinks] cache hit for", langName);
    return cached.data;
  }

  const referer = WIN_VERSIONS[vi].dl_page;
  const archMap = { 0: "x86", 1: "x64", 2: "ARM64" };
  const links   = [];

  console.log("[getDownloadLinks] starting fresh session for lang:", langName);

  const langs = await fetchLanguages(vi, editionIds, env);
  const lang  = langs.find(l => l.name === langName);

  if (!lang) {
    console.warn("[getDownloadLinks] lang not found:", langName, "available:", langs.map(l => l.name).join(", "));
    throw new Error("Language not found: " + langName);
  }

  console.log("[getDownloadLinks] found lang, skuData count:", lang.skuData.length);

  for (const entry of lang.skuData) {
    // Если x64 уже получен — пропускаем ARM64 чтобы не тратить rate limit
    if (links.find(l => l.arch === "x64") && entry.sessionIndex === 1) {
      console.log("[getDownloadLinks] x64 already got, skipping ARM64");
      continue;
    }

    // Задержка между SKU запросами — снижает rate limit
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

    const sid     = lang.sessionIds[entry.sessionIndex];
    const cookies = lang.sessionCookies[entry.sessionIndex];

    if (!sid) {
      console.warn("[getDownloadLinks] no sessionId for index", entry.sessionIndex);
      throw new Error("No sessionId for index " + entry.sessionIndex);
    }

    const url = "https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku"
      + "?profile=" + PROFILE_ID
      + "&productEditionId=undefined&SKU=" + entry.skuId
      + "&friendlyFileName=undefined&Locale=" + LOCALE
      + "&sessionID=" + sid;

    console.log("[getDownloadLinks] GetLinks skuId=" + entry.skuId + " sessionIndex=" + entry.sessionIndex);

    const msResult = await msFetch(env, url, { ...AH, Referer: referer }, cookies);
    const text = msResult.text;

    console.log("[getDownloadLinks] response(200):", text.slice(0, 200));

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.warn("[getDownloadLinks] JSON parse error:", String(e));
      throw new Error("Unexpected response: " + text.slice(0, 200));
    }

    if (data.Errors && data.Errors.length > 0) {
      console.warn("[getDownloadLinks] Errors:", JSON.stringify(data.Errors[0]));

      if (isErr715(data.Errors[0])) {
        if (!env.DENO_PROXY_URL) throw new Error("BLOCKED_715");

        console.log("[getDownloadLinks] Sentinel → new full session via proxy for skuId=" + entry.skuId);
        try {
          const editionId = editionIds[entry.sessionIndex];
          const opts = await getDownloadLinkViaProxy(env, entry.skuId, editionId, referer);
          console.log("[getDownloadLinks] proxy session options:", opts.length);
          for (const opt of opts) {
            const arch = archMap[Number(opt.DownloadType)] || "?";
            if (!links.find(l => l.arch === arch)) links.push({ arch, url: String(opt.Uri) });
          }
          continue;
        } catch (pe) {
          console.warn("[getDownloadLinks] proxy session failed:", String(pe));
          throw new Error("BLOCKED_715");
        }
      }

      throw new Error(String(data.Errors[0].Value || "unknown"));
    }

    const opts = data.ProductDownloadOptions || [];
    console.log("[getDownloadLinks] options count:", opts.length);

    for (const opt of opts) {
      const arch = archMap[Number(opt.DownloadType)] || "?";
      if (!links.find(l => l.arch === arch)) links.push({ arch, url: String(opt.Uri) });
    }
  }

  if (!links.length) throw new Error("EMPTY_LINKS");

  const order = ["x64", "x86", "ARM64"];
  links.sort((a, b) => order.indexOf(a.arch) - order.indexOf(b.arch));

  console.log("[getDownloadLinks] done, links:", links.map(l => l.arch).join(", "));

  const result = { links, created_at: Math.floor(Date.now() / 1000) };
  await kvSet(kv, ck, result, TTL_LINKS);
  return result;
}

// ═══════════════════════════════════════════
// TELEGRAM API
// ═══════════════════════════════════════════

async function tg(token, method, body) {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const edit = (token, chatId, msgId, text, kb) =>
  tg(token, "editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
const send = (token, chatId, text, kb) =>
  tg(token, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
const ack = (token, id, text, alert = false) =>
  tg(token, "answerCallbackQuery", { callback_query_id: id, text, show_alert: alert });

// ═══════════════════════════════════════════
// KEYBOARDS
// ═══════════════════════════════════════════

const b  = (t, d) => ({ text: t, callback_data: d });
const ub = (t, u) => ({ text: t, url: u });
const mk = rows   => ({ inline_keyboard: rows });
const BM = [[b("🏠 Main menu", "main")]];

const FLAGS = {
  "ar-sa": "🇸🇦", "bg-bg": "🇧🇬", "zh-cn": "🇨🇳", "zh-tw": "🇹🇼",
  "hr-hr": "🇭🇷", "cs-cz": "🇨🇿", "da-dk": "🇩🇰", "nl-nl": "🇳🇱",
  "en-us": "🇺🇸", "et-ee": "🇪🇪", "fi-fi": "🇫🇮", "fr-fr": "🇫🇷",
  "de-de": "🇩🇪", "el-gr": "🇬🇷", "he-il": "🇮🇱", "hi-in": "🇮🇳",
  "hu-hu": "🇭🇺", "id-id": "🇮🇩", "it-it": "🇮🇹", "ja-jp": "🇯🇵",
  "kk-kz": "🇰🇿", "ko-kr": "🇰🇷", "lv-lv": "🇱🇻", "lt-lt": "🇱🇹",
  "ms-my": "🇲🇾", "nb-no": "🇳🇴", "pl-pl": "🇵🇱", "pt-br": "🇧🇷",
  "pt-pt": "🇵🇹", "ro-ro": "🇷🇴", "ru-ru": "🇷🇺", "sr-latn-rs": "🇷🇸",
  "sk-sk": "🇸🇰", "sl-si": "🇸🇮", "es-es": "🇪🇸", "sv-se": "🇸🇪",
  "th-th": "🇹🇭", "tr-tr": "🇹🇷", "uk-ua": "🇺🇦", "vi-vn": "🇻🇳",
  "Arabic": "🇸🇦", "Bulgarian": "🇧🇬", "Chinese Simplified": "🇨🇳",
  "Chinese Traditional": "🇹🇼", "Chinese (Simplified)": "🇨🇳", "Chinese (Traditional)": "🇹🇼",
  "Croatian": "🇭🇷", "Czech": "🇨🇿", "Danish": "🇩🇰", "Dutch": "🇳🇱",
  "English": "🇺🇸", "English International": "🇬🇧", "Estonian": "🇪🇪",
  "Finnish": "🇫🇮", "French": "🇫🇷", "French Canadian": "🇨🇦",
  "German": "🇩🇪", "Greek": "🇬🇷", "Hebrew": "🇮🇱", "Hindi": "🇮🇳",
  "Hungarian": "🇭🇺", "Indonesian": "🇮🇩", "Italian": "🇮🇹",
  "Japanese": "🇯🇵", "Kazakh": "🇰🇿", "Korean": "🇰🇷",
  "Latvian": "🇱🇻", "Lithuanian": "🇱🇹", "Malay": "🇲🇾",
  "Norwegian": "🇳🇴", "Polish": "🇵🇱", "Portuguese": "🇧🇷",
  "Portuguese Brazil": "🇧🇷", "Portuguese Portugal": "🇵🇹",
  "Romanian": "🇷🇴", "Russian": "🇷🇺", "Serbian": "🇷🇸",
  "Slovak": "🇸🇰", "Slovenian": "🇸🇮", "Spanish": "🇪🇸",
  "Swedish": "🇸🇪", "Thai": "🇹🇭", "Turkish": "🇹🇷",
  "Ukrainian": "🇺🇦", "Vietnamese": "🇻🇳",
};
const fl = key => FLAGS[key] ? FLAGS[key] + " " : "";

const mainKb = () => mk([
  [b("💿 Windows 10 / 11 ISO",        "sec:fido")],
  [b("🖥 Windows Server (Eval)",      "sec:server")],
  [b("💼 Microsoft Office",           "sec:office")],
  [b("📄 Word / Excel / Office Apps", "sec:office_apps")],
  [b("🛠 Media Creation Tool",        "sec:mct")],
  [b("🔧 Windows Admin Center",       "sec:admin")],
  [b("💸 Donate",                     "donate")],
]);

const staticKb = sec => mk([
  ...STATIC[sec].items.map((item, i) => [b(item.name, `si:${sec}:${i}`)]),
  ...BM,
]);

const serverVersionsKb = () => mk([
  ...SERVER_VERSIONS.map((v, i) => [b(`🖥 ${v.name}`, `sver:${i}`)]),
  ...BM,
]);

const serverLangsKb = vi => {
  const rows  = [];
  const langs = SERVER_VERSIONS[vi].langs;
  for (let i = 0; i < langs.length; i += 2) {
    const row = [b(fl(langs[i].code) + langs[i].name, `slang:${vi}:${i}`)];
    if (langs[i + 1]) row.push(b(fl(langs[i + 1].code) + langs[i + 1].name, `slang:${vi}:${i + 1}`));
    rows.push(row);
  }
  rows.push([b("⬅️ Back", "sec:server")], ...BM);
  return mk(rows);
};

const officeVersionsKb = () => mk([
  ...OFFICE_VERSIONS.map((v, i) => [b(v.label, `offver2:${i}`)]),
  ...BM,
]);
const officeEditionsKb = vi => mk([
  ...OFFICE_VERSIONS[vi].editions.map((e, i) => [b(e.name, `offed2:${vi}:${i}`)]),
  [b("⬅️ Back", "sec:office")], ...BM,
]);
const officeLangsKb = (vi, ei, langs) => {
  const popular = langs.filter(l => POPULAR_LANGS.includes(l.name));
  const others  = langs.filter(l => !POPULAR_LANGS.includes(l.name));
  const rows    = [];
  for (let i = 0; i < popular.length; i += 2) {
    const li0 = langs.indexOf(popular[i]);
    const li1 = popular[i + 1] ? langs.indexOf(popular[i + 1]) : -1;
    const row = [b(fl(popular[i].code) + popular[i].name, `offlang:${vi}:${ei}:${li0}`)];
    if (li1 >= 0) row.push(b(fl(popular[i + 1].code) + popular[i + 1].name, `offlang:${vi}:${ei}:${li1}`));
    rows.push(row);
  }
  if (others.length > 0) rows.push([b(`🌐 All languages (+${others.length})`, `offalllang:${vi}:${ei}`)]);
  rows.push([b("⬅️ Back", `offver2:${vi}`)], ...BM);
  return mk(rows);
};
const officeAllLangsKb = (vi, ei, langs) => {
  const others = langs.filter(l => !POPULAR_LANGS.includes(l.name));
  const rows   = [];
  for (let i = 0; i < others.length; i += 2) {
    const li0 = langs.indexOf(others[i]);
    const li1 = others[i + 1] ? langs.indexOf(others[i + 1]) : -1;
    const row = [b(fl(others[i].code) + others[i].name, `offlang:${vi}:${ei}:${li0}`)];
    if (li1 >= 0) row.push(b(fl(others[i + 1].code) + others[i + 1].name, `offlang:${vi}:${ei}:${li1}`));
    rows.push(row);
  }
  rows.push([b("⬅️ Back to popular", `offlangback:${vi}:${ei}`)], ...BM);
  return mk(rows);
};
const officeTypeKb = (vi, ei, li, hasOffline) => {
  const rows = [[b("🌐 Online x64 (small installer)", `offtype:${vi}:${ei}:${li}:online`)]];
  if (hasOffline) rows.push([b("📦 Offline x64 (.img ~3GB)", `offtype:${vi}:${ei}:${li}:offline`)]);
  rows.push([b("⬅️ Back", `offed2:${vi}:${ei}`)], ...BM);
  return mk(rows);
};

const standaloneAppsKb = () => mk([
  ...STANDALONE_APPS.map((app, ai) => [b(app.label, `saapp:${ai}`)]),
  ...BM,
]);
const standaloneVersionsKb = ai => mk([
  ...STANDALONE_APPS[ai].versions.map((v, vi) => [b(v.name, `saver:${ai}:${vi}`)]),
  [b("⬅️ Back", "sec:office_apps")], ...BM,
]);
const standaloneLangsKb = (ai, vi) => {
  const langs   = STANDALONE_APPS[ai].versions[vi].langs;
  const popular = langs.filter(l => POPULAR_LANGS.includes(l.name));
  const others  = langs.filter(l => !POPULAR_LANGS.includes(l.name));
  const rows    = [];
  for (let i = 0; i < popular.length; i += 2) {
    const li0 = langs.indexOf(popular[i]);
    const li1 = popular[i + 1] ? langs.indexOf(popular[i + 1]) : -1;
    const row = [b(fl(popular[i].code) + popular[i].name, `salang:${ai}:${vi}:${li0}`)];
    if (li1 >= 0) row.push(b(fl(popular[i + 1].code) + popular[i + 1].name, `salang:${ai}:${vi}:${li1}`));
    rows.push(row);
  }
  if (others.length > 0) rows.push([b(`🌐 All languages (+${others.length})`, `saalllang:${ai}:${vi}`)]);
  rows.push([b("⬅️ Back", `saver:${ai}:${vi}`)], ...BM);
  return mk(rows);
};
const standaloneAllLangsKb = (ai, vi) => {
  const langs  = STANDALONE_APPS[ai].versions[vi].langs;
  const others = langs.filter(l => !POPULAR_LANGS.includes(l.name));
  const rows   = [];
  for (let i = 0; i < others.length; i += 2) {
    const li0 = langs.indexOf(others[i]);
    const li1 = others[i + 1] ? langs.indexOf(others[i + 1]) : -1;
    const row = [b(fl(others[i].code) + others[i].name, `salang:${ai}:${vi}:${li0}`)];
    if (li1 >= 0) row.push(b(fl(others[i + 1].code) + others[i + 1].name, `salang:${ai}:${vi}:${li1}`));
    rows.push(row);
  }
  rows.push([b("⬅️ Back to popular", `saver:${ai}:${vi}`)], ...BM);
  return mk(rows);
};
const standaloneTypeKb = (ai, vi, li) => mk([
  [b("🌐 Online x64 (small installer)", `satype:${ai}:${vi}:${li}:online`)],
  [b("📦 Offline x64 (.img ~3GB)",      `satype:${ai}:${vi}:${li}:offline`)],
  [b("⬅️ Back", `saver:${ai}:${vi}`)], ...BM,
]);

const staticResultKb = url => mk([
  [ub("⬇️ Download", url)], [b("📋 Show link", "show_url")], [b("💸 Donate", "donate")], ...BM,
]);
const versionKb = () => mk([
  ...WIN_VERSIONS.map((v, i) => [b(`🖥 ${v.name}`, `ver:${i}`)]), ...BM,
]);
const releaseKb = vi => mk([
  ...WIN_VERSIONS[vi].releases.map((r, i) => [b(r.label, `rel:${vi}:${i}`)]),
  [b("⬅️ Back", "sec:fido")], ...BM,
]);
const editionKb = (vi, ri) => mk([
  ...WIN_VERSIONS[vi].releases[ri].editions.map((e, i) => [b(e.name, `ed:${vi}:${ri}:${i}`)]),
  [b("⬅️ Back", `rel:${vi}:0`)], ...BM,
]);

const langKb = (vi, ri, ei, langList) => {
  const popular = langList.filter(l => POPULAR_LANGS.includes(l.display));
  const others  = langList.filter(l => !POPULAR_LANGS.includes(l.display));
  const rows    = [];
  for (let i = 0; i < popular.length; i += 2) {
    const li0 = langList.indexOf(popular[i]);
    const li1 = popular[i + 1] ? langList.indexOf(popular[i + 1]) : -1;
    const row = [b(fl(popular[i].display) + popular[i].display, `lang:${vi}:${ri}:${ei}:${li0}`)];
    if (li1 >= 0) row.push(b(fl(popular[i + 1].display) + popular[i + 1].display, `lang:${vi}:${ri}:${ei}:${li1}`));
    rows.push(row);
  }
  if (others.length > 0) rows.push([b(`🌐 All languages (+${others.length})`, `alllang:${vi}:${ri}:${ei}`)]);
  rows.push([b("⬅️ Back", `ed:${vi}:${ri}:0`)], ...BM);
  return mk(rows);
};
const allLangKb = (vi, ri, ei, langList) => {
  const others = langList.filter(l => !POPULAR_LANGS.includes(l.display));
  const rows   = [];
  for (let i = 0; i < others.length; i += 2) {
    const li0 = langList.indexOf(others[i]);
    const li1 = others[i + 1] ? langList.indexOf(others[i + 1]) : -1;
    const row = [b(fl(others[i].display) + others[i].display, `lang:${vi}:${ri}:${ei}:${li0}`)];
    if (li1 >= 0) row.push(b(fl(others[i + 1].display) + others[i + 1].display, `lang:${vi}:${ri}:${ei}:${li1}`));
    rows.push(row);
  }
  rows.push([b("⬅️ Back to popular", `showlang:${vi}:${ri}:${ei}`)], ...BM);
  return mk(rows);
};
const archKb = (vi, ri, ei, li, links, createdAt) => {
  const em = { x64: "💿", x86: "📀", ARM64: "🔷" };
  return mk([
    ...links.map((l, i) => [b(`${em[l.arch] || "💾"} ${l.arch}`, `arch:${vi}:${ri}:${ei}:${li}:${i}:${createdAt}`)]),
    [b("⬅️ Back", `showlang:${vi}:${ri}:${ei}`)], ...BM,
  ]);
};
const resultKb = (url, vi, ri, ei, li) => mk([
  [ub("⬇️ Download ISO", url)],
  [b("📋 Show link", "show_url")],
  [b("⬅️ Back", `showlang:${vi}:${ri}:${ei}`)],
  [b("💸 Donate", "donate")],
  [b("🔄 Another image", "sec:fido")],
  ...BM,
]);
const blockedKb = (dlPage, vi, ri, ei) => mk([
  [ub("🌐 Download manually", dlPage)],
  [b("🔄 Try again", `ed:${vi}:${ri}:${ei}`)],
  ...BM,
]);
const donateKb = () => mk([...BM]);

// ═══════════════════════════════════════════
// TEXTS
// ═══════════════════════════════════════════

const WELCOME = `🗂 <b>Microsoft ISO &amp; Tools Bot by KeicH2O</b>

Official downloads directly from Microsoft servers.

💿 <b>Windows 10 / 11</b> — 40 languages · x64 / x86 / ARM64
🖥 <b>Windows Server 2019–2025</b> — 8 languages · official ISO
💼 <b>Office 365 / 2013–2024</b> — 40 languages · Online + Offline
📄 <b>Word / Excel / PowerPoint...</b> — 40 languages · standalone
🛠 <b>Media Creation Tool</b> — all versions
🔧 <b>Windows Admin Center</b>

Choose a section:`;

const DONATE_TEXT = `💸 <b>Support the project</b>

<b>TON:</b>
<code>UQARgaMSvODHBT9YNnf1m6gLL-Lmat64KV0IBTWOOXwiNkDp</code>

<b>TRC20 USDT:</b>
<code>TDZEdxy9zFxHAE4bvsZeL8Ytbyw922kd3Y</code>

<b>ERC20 (USDT/ETH):</b>
<code>0xA42145FACc44E0b31Df2569B85846a7fA8DEed55</code>

<b>BTC:</b>
<code>bc1qteffasa377wy5r9hx7cwu3saf7lp077hyp2wxj</code>`;

// ═══════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════

async function handleUpdate(update, env, ctx) {
  const token = env.BOT_TOKEN;
  const kv    = env.CACHE;

  if (update.message) {
    const chatId = update.message.chat.id;
    const text   = update.message.text || "";
    if (text.startsWith("/start") || text.startsWith("/help")) {
      await send(token, chatId, WELCOME, mainKb());
    } else {
      await send(token, chatId, "Send /start for the main menu.");
    }
    return;
  }

  if (!update.callback_query) return;
  const cq     = update.callback_query;
  const data   = cq.data || "";
  const chatId = cq.message.chat.id;
  const msgId  = cq.message.message_id;

  if (data === "main") { await edit(token, chatId, msgId, WELCOME, mainKb()); await ack(token, cq.id); return; }
  if (data === "donate") { await edit(token, chatId, msgId, DONATE_TEXT, donateKb()); await ack(token, cq.id); return; }

  if (data === "show_url") {
    const raw = await kv.get(`url:${chatId}`);
    if (raw) {
      let url;
      try { url = JSON.parse(raw).url; } catch { url = raw; }
      await send(token, chatId, `🔗 <b>Full link:</b>\n<code>${url}</code>`);
    }
    await ack(token, cq.id);
    return;
  }

  if (data.startsWith("sec:")) {
    const sec = data.split(":")[1];
    if      (sec === "fido")        await edit(token, chatId, msgId, "🖥 <b>Select Windows version:</b>", versionKb());
    else if (sec === "office")      await edit(token, chatId, msgId, "💼 <b>Microsoft Office</b>\n\nSelect version:", officeVersionsKb());
    else if (sec === "server")      await edit(token, chatId, msgId, "🖥 <b>Windows Server</b>\n\nSelect version:", serverVersionsKb());
    else if (sec === "office_apps") await edit(token, chatId, msgId, "📄 <b>Word / Excel / Office Apps</b>\n\nSelect app:", standaloneAppsKb());
    else if (STATIC[sec])           await edit(token, chatId, msgId, `<b>${STATIC[sec].label}</b>\n\nSelect product:`, staticKb(sec));
    await ack(token, cq.id);
    return;
  }

  if (data.startsWith("sver:")) {
    const vi = parseInt(data.split(":")[1]);
    await edit(token, chatId, msgId, `🖥 <b>${SERVER_VERSIONS[vi].name}</b>\n\nSelect language:`, serverLangsKb(vi));
    await ack(token, cq.id);
    return;
  }

  if (data.startsWith("slang:")) {
    const [, vis, lis] = data.split(":");
    const vi = parseInt(vis), li = parseInt(lis);
    const sv   = SERVER_VERSIONS[vi];
    const lang = sv.langs[li];
    const url  = `https://go.microsoft.com/fwlink/p/?LinkID=${sv.linkId}&clcid=${lang.clcid}&culture=${lang.code}&country=${lang.country}`;
    await saveUrlKV(kv, chatId, url);
    await edit(token, chatId, msgId,
      `✅ <b>${sv.name}</b>\n🌐 ${lang.name}\n\n💿 .iso — burn to USB with Rufus or Ventoy\n\n⬇️ <a href="${url}">Click to download</a>\n\n<i>Permanent Microsoft link — no expiry</i>`,
      mk([[ub("⬇️ Download", url)], [b("📋 Show link", "show_url")], [b("🌐 Other language", `sver:${vi}`)], [b("💸 Donate", "donate")], ...BM]));
    await ack(token, cq.id, "✅ Link ready!");
    return;
  }

  if (data.startsWith("si:")) {
    const [, sec, idxS] = data.split(":");
    const item = STATIC[sec]?.items[parseInt(idxS)];
    if (!item) { await ack(token, cq.id, "Not found"); return; }
    const ext  = (item.url.split(".").pop() || "").toUpperCase();
    const note = { IMG: "📦 .img — mount via ODT or open with 7-Zip", ISO: "💿 .iso — burn to USB with Rufus or Ventoy", EXE: "🔧 .exe — run to install", MSI: "🔧 .msi — run to install" };
    await saveUrlKV(kv, chatId, item.url);
    await edit(token, chatId, msgId, `✅ <b>${item.name}</b>\n\n${note[ext] || "📎 Microsoft file"}\n\n<i>Permanent link — no expiry</i>`, staticResultKb(item.url));
    await ack(token, cq.id, "✅ Link ready!");
    return;
  }

  if (data.startsWith("offver2:")) {
    const vi = parseInt(data.split(":")[1]);
    await edit(token, chatId, msgId, `💼 <b>${OFFICE_VERSIONS[vi].label}</b>\n\nSelect edition:`, officeEditionsKb(vi));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("offed2:")) {
    const [, vis, eis] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis);
    const ed = OFFICE_VERSIONS[vi].editions[ei];
    await edit(token, chatId, msgId, `💼 <b>${OFFICE_VERSIONS[vi].label}</b>\n📦 <b>${ed.name}</b>\n\nSelect language:`, officeLangsKb(vi, ei, ed.langs));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("offlangback:")) {
    const [, vis, eis] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis);
    const ed = OFFICE_VERSIONS[vi].editions[ei];
    await edit(token, chatId, msgId, `💼 <b>${OFFICE_VERSIONS[vi].label}</b>\n📦 <b>${ed.name}</b>\n\nSelect language:`, officeLangsKb(vi, ei, ed.langs));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("offalllang:")) {
    const [, vis, eis] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis);
    const ed = OFFICE_VERSIONS[vi].editions[ei];
    await edit(token, chatId, msgId, `💼 <b>${OFFICE_VERSIONS[vi].label}</b>\n📦 <b>${ed.name}</b>\n\n🌐 All languages:`, officeAllLangsKb(vi, ei, ed.langs));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("offlang:")) {
    const [, vis, eis, lis] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis), li = parseInt(lis);
    const ed = OFFICE_VERSIONS[vi].editions[ei];
    const lang = ed.langs[li];
    await edit(token, chatId, msgId, `💼 <b>${OFFICE_VERSIONS[vi].label}</b>\n📦 <b>${ed.name}</b>\n🌐 <b>${lang.name}</b>\n\nSelect download type:`, officeTypeKb(vi, ei, li, "offline" in lang));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("offtype:")) {
    const [, vis, eis, lis, type] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis), li = parseInt(lis);
    const ed   = OFFICE_VERSIONS[vi].editions[ei];
    const lang = ed.langs[li];
    const url  = type === "offline" && "offline" in lang ? lang.offline : lang.online;
    await saveUrlKV(kv, chatId, url);
    await edit(token, chatId, msgId,
      `✅ <b>${OFFICE_VERSIONS[vi].label}</b>\n📦 ${ed.name}\n🌐 ${lang.name} · ${type === "offline" ? "📦 Offline x64" : "🌐 Online x64"}\n\n`
      + (type === "offline" ? `📦 .img — mount via ODT or open with 7-Zip` : `🌐 Small installer — downloads during installation`)
      + `\n\n⬇️ <a href="${url}">Click to download</a>\n\n<i>Permanent link — no expiry</i>`,
      mk([[ub("⬇️ Download", url)], [b("📋 Show link", "show_url")], [b("💸 Donate", "donate")], [b("🌐 Other language", `offed2:${vi}:${ei}`)], [b("📦 Other edition", `offver2:${vi}`)], ...BM]));
    await ack(token, cq.id, "✅ Link ready!"); return;
  }

  if (data.startsWith("ver:")) {
    const vi = parseInt(data.split(":")[1]);
    await edit(token, chatId, msgId, `📅 <b>${WIN_VERSIONS[vi].name}</b> — select release:`, releaseKb(vi));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("rel:")) {
    const [, vs, rs] = data.split(":");
    const vi = parseInt(vs), ri = parseInt(rs);
    await edit(token, chatId, msgId, `📦 <b>${WIN_VERSIONS[vi].releases[ri].label}</b> — select edition:`, editionKb(vi, ri));
    await ack(token, cq.id); return;
  }

  // ── ed: — загружаем список языков
  if (data.startsWith("ed:")) {
    const [, vs, rs, es] = data.split(":");
    const vi = parseInt(vs), ri = parseInt(rs), ei = parseInt(es);
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];
    await edit(token, chatId, msgId, `🌐 <b>${edition.name}</b>\n⏳ Loading languages…`);
    await ack(token, cq.id);
    try {
      const langList = await getLanguageList(kv, vi, edition.ids, env);
      await edit(token, chatId, msgId,
        `🌐 <b>${edition.name}</b> — select language:\n\n<i>Popular languages below · "All languages" for the full list</i>`,
        langKb(vi, ri, ei, langList));
    } catch (e) {
      await edit(token, chatId, msgId, errMsg(String(e), vi), blockedKb(WIN_VERSIONS[vi].dl_page, vi, ri, ei));
    }
    return;
  }

  // ── showlang: — назад к языкам
  if (data.startsWith("showlang:")) {
    const [, vs, rs, es] = data.split(":");
    const vi = parseInt(vs), ri = parseInt(rs), ei = parseInt(es);
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];
    await ack(token, cq.id);
    try {
      const langList = await getLanguageList(kv, vi, edition.ids, env);
      await edit(token, chatId, msgId, `🌐 <b>${edition.name}</b> — select language:`, langKb(vi, ri, ei, langList));
    } catch (e) {
      await edit(token, chatId, msgId, errMsg(String(e), vi), blockedKb(WIN_VERSIONS[vi].dl_page, vi, ri, ei));
    }
    return;
  }

  // ── alllang: — все языки
  if (data.startsWith("alllang:")) {
    const [, vs, rs, es] = data.split(":");
    const vi = parseInt(vs), ri = parseInt(rs), ei = parseInt(es);
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];
    await ack(token, cq.id);
    try {
      const langList = await getLanguageList(kv, vi, edition.ids, env);
      await edit(token, chatId, msgId, "🌐 <b>All languages</b> — select:", allLangKb(vi, ri, ei, langList));
    } catch (e) {
      await edit(token, chatId, msgId, errMsg(String(e), vi), blockedKb(WIN_VERSIONS[vi].dl_page, vi, ri, ei));
    }
    return;
  }

  // ── lang: — КЛЮЧЕВОЙ момент — полная сессия как в Fido
  // whitelist → ovdf → getskuinformation → GetProductDownloadLinksBySku
  // всё с одним sessionId[$sessionIndex] и SessionVariable (куки)
  if (data.startsWith("lang:")) {
    const parts = data.split(":");
    const vi = parseInt(parts[1]), ri = parseInt(parts[2]);
    const ei = parseInt(parts[3]), li = parseInt(parts[4]);
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];
    await ack(token, cq.id);

    // Получаем имя языка из кеша
    let langList;
    try {
      langList = await getLanguageList(kv, vi, edition.ids, env);
    } catch (e) {
      await edit(token, chatId, msgId, errMsg(String(e), vi), blockedKb(WIN_VERSIONS[vi].dl_page, vi, ri, ei));
      return;
    }

    const langItem = langList[li];
    if (!langItem) { await edit(token, chatId, msgId, "❌ Language not found", mk(BM)); return; }

    await edit(token, chatId, msgId, `⏳ <b>${langItem.display}</b>\nFetching download links…`);

    try {
      // Полная сессия Fido: whitelist → ovdf → getskuinformation → GetProductDownloadLinksBySku
      const result = await getDownloadLinks(kv, vi, ri, edition.ids, langItem.name, env);
      await edit(token, chatId, msgId,
        `🏗 <b>${langItem.display}</b> — select architecture:`,
        archKb(vi, ri, ei, li, result.links, result.created_at));
    } catch (e) {
      await edit(token, chatId, msgId, errMsg(String(e), vi), blockedKb(WIN_VERSIONS[vi].dl_page, vi, ri, ei));
    }
    return;
  }

  // ── arch: — финальная ссылка
  if (data.startsWith("arch:")) {
    const parts   = data.split(":");
    const vi      = parseInt(parts[1]), ri = parseInt(parts[2]);
    const ei      = parseInt(parts[3]), li = parseInt(parts[4]);
    const archIdx = parseInt(parts[5]), ca = parseInt(parts[6]) || 0;
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];

    const listCached = await kvGet(kv, `langlist:${vi}:${edition.ids.join(",")}`);
    if (!listCached) {
      await edit(token, chatId, msgId, "⚠️ Cache expired. Please start over.", mk([[b("🔄 Start over", `ed:${vi}:${ri}:${ei}`)]]));
      await ack(token, cq.id); return;
    }
    const langItem = listCached.data[li];
    if (!langItem) { await ack(token, cq.id, "Language not found"); return; }

    const linkCached = await kvGet(kv, `links:${vi}:${ri}:${langItem.name}`);
    if (!linkCached) {
      await edit(token, chatId, msgId, "⚠️ Links expired. Please select language again.",
        mk([[b("🔄 Select again", `showlang:${vi}:${ri}:${ei}`)]]));
      await ack(token, cq.id); return;
    }

    const { links, created_at } = linkCached.data;
    const link = links[archIdx];
    if (!link) { await ack(token, cq.id, "Architecture not found"); return; }

    await saveUrlKV(kv, chatId, link.url);
    await edit(token, chatId, msgId,
      `✅ <b>Link ready!</b>\n\n`
      + `🖥 ${WIN_VERSIONS[vi].name} · ${WIN_VERSIONS[vi].releases[ri].label}\n`
      + `📦 ${edition.name}\n`
      + `🌐 ${langItem.display} · 🏗 ${link.arch}\n\n`
      + `⬇️ <a href="${link.url}">Click to download</a>\n\n`
      + `<i>⚠️ ${expiryText(ca || created_at)}</i>`,
      resultKb(link.url, vi, ri, ei, li));
    await ack(token, cq.id, "✅ Link ready!");
    return;
  }

  if (data.startsWith("saapp:")) {
    const ai = parseInt(data.split(":")[1]);
    await edit(token, chatId, msgId, `📄 <b>${STANDALONE_APPS[ai].label}</b>\n\nSelect version:`, standaloneVersionsKb(ai));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("saver:")) {
    const [, ais, vis] = data.split(":");
    const ai = parseInt(ais), vi = parseInt(vis);
    await edit(token, chatId, msgId, `📄 <b>${STANDALONE_APPS[ai].versions[vi].name}</b>\n\nSelect language:`, standaloneLangsKb(ai, vi));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("saalllang:")) {
    const [, ais, vis] = data.split(":");
    const ai = parseInt(ais), vi = parseInt(vis);
    await edit(token, chatId, msgId, `📄 <b>${STANDALONE_APPS[ai].versions[vi].name}</b>\n\n🌐 All languages:`, standaloneAllLangsKb(ai, vi));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("salang:")) {
    const [, ais, vis, lis] = data.split(":");
    const ai = parseInt(ais), vi = parseInt(vis), li = parseInt(lis);
    const ver  = STANDALONE_APPS[ai].versions[vi];
    const lang = ver.langs[li];
    await edit(token, chatId, msgId, `📄 <b>${ver.name}</b>\n🌐 <b>${fl(lang.code)}${lang.name}</b>\n\nSelect download type:`, standaloneTypeKb(ai, vi, li));
    await ack(token, cq.id); return;
  }
  if (data.startsWith("satype:")) {
    const [, ais, vis, lis, type] = data.split(":");
    const ai = parseInt(ais), vi = parseInt(vis), li = parseInt(lis);
    const ver  = STANDALONE_APPS[ai].versions[vi];
    const lang = ver.langs[li];
    const url  = type === "offline" ? lang.offline : lang.online;
    await saveUrlKV(kv, chatId, url);
    await edit(token, chatId, msgId,
      `✅ <b>${ver.name}</b>\n🌐 ${fl(lang.code)}${lang.name} · ${type === "offline" ? "📦 Offline x64 (.img)" : "🌐 Online x64"}\n\n`
      + (type === "offline" ? `📦 .img — mount via ODT or open with 7-Zip` : `🌐 Small installer — downloads during installation`)
      + `\n\n⬇️ <a href="${url}">Click to download</a>\n\n<i>Permanent link — no expiry</i>`,
      mk([[ub("⬇️ Download", url)], [b("📋 Show link", "show_url")], [b("💸 Donate", "donate")], [b("🌐 Other language", `saver:${ai}:${vi}`)], [b("📄 Other app", "sec:office_apps")], ...BM]));
    await ack(token, cq.id, "✅ Link ready!"); return;
  }

  await ack(token, cq.id);
}

// ═══════════════════════════════════════════
// WORKER ENTRY POINT
// ═══════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ────────────────────────────────────────
    // 0. WEB: HTML‑страница по /
    // ────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(renderHtmlPage(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // ────────────────────────────────────────
    // 1. HEALTHCHECK
    // ────────────────────────────────────────
    if (url.pathname === "/health") {
      return new Response("OK");
    }

    // ────────────────────────────────────────
    // 2. TELEGRAM WEBHOOK SETUP
    // ────────────────────────────────────────
    if (url.pathname === "/setWebhook") {
      const r = await fetch(
        "https://api.telegram.org/bot" +
          env.BOT_TOKEN +
          "/setWebhook?url=" +
          url.origin +
          "/webhook",
      );
      const t = await r.text();
      return new Response(t, {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ────────────────────────────────────────
    // 3. ТЕСТ ПРОКСИ
    // ────────────────────────────────────────
    if (url.pathname === "/testProxy") {
      try {
        const result = await fetchViaProxy(
          env,
          "https://www.microsoft.com/software-download/windows11",
          BH,
        );
        return new Response("Proxy OK, len=" + result.length);
      } catch (e) {
        return new Response("Proxy FAILED: " + String(e), { status: 500 });
      }
    }

    // ────────────────────────────────────────
    // 4. ТЕСТ ПРЯМОГО ДОСТУПА К MS API
    // ────────────────────────────────────────
    if (url.pathname === "/testMS") {
      const sid = crypto.randomUUID();
      const testUrl =
        "https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition" +
        "?profile=" +
        PROFILE_ID +
        "&productEditionId=2618&SKU=undefined&friendlyFileName=undefined" +
        "&Locale=en-US&sessionID=" +
        sid;
      const ref = "https://www.microsoft.com/software-download/windows10ISO";
      try {
        let cookies = await doWhitelist(sid, env, []);
        cookies = await doOvdf(sid, env, cookies);
        const msResult = await msFetch(env, testUrl, { ...AH, Referer: ref }, cookies);
        const directText = msResult.text;
        const proxyText = await fetchViaProxy(env, testUrl, { ...AH, Referer: ref });
        const out =
          "DIRECT: " + directText.slice(0, 300) + "\n\nPROXY: " + proxyText.slice(0, 300);
        return new Response(out, {
          headers: { "Content-Type": "text/plain" },
        });
      } catch (e) {
        return new Response("Error: " + String(e), { status: 500 });
      }
    }

    // ────────────────────────────────────────
    // 5. ПОЛНЫЙ ТЕСТ СЕССИИ ДЛЯ WIN10
    // ────────────────────────────────────────
    if (url.pathname === "/testFull") {
      const sid = crypto.randomUUID();
      const log = [];
      try {
        log.push("1. preVisit...");
        await preVisit(
          "https://www.microsoft.com/software-download/windows10ISO",
          env,
        );
        log.push("   OK");

        log.push("2. whitelist...");
        const c1 = await doWhitelist(sid, env, []);
        log.push("   cookies: " + JSON.stringify(c1));

        log.push("3. ovdf...");
        const c2 = await doOvdf(sid, env, c1);
        log.push("   cookies: " + JSON.stringify(c2));

        const apiUrl =
          "https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition" +
          "?profile=" +
          PROFILE_ID +
          "&productEditionId=2618&SKU=undefined&friendlyFileName=undefined" +
          "&Locale=en-US&sessionID=" +
          sid;
        const ref = "https://www.microsoft.com/software-download/windows10ISO";

        log.push("4. getskuinformation direct...");
        const msResult = await msFetch(env, apiUrl, { ...AH, Referer: ref }, c2);
        log.push("   response(150): " + msResult.text.slice(0, 150));
        log.push("   is715: " + is715(msResult.text));

        log.push("5. DENO_PROXY_URL = " + (env.DENO_PROXY_URL || "NOT SET"));
        log.push("   PROXY_SECRET set: " + (env.PROXY_SECRET ? "YES" : "NO"));

        log.push("6. fetchViaProxy...");
        const proxyResult = await fetchViaProxy(env, apiUrl, {
          ...AH,
          Referer: ref,
        });
        log.push("   response(150): " + proxyResult.slice(0, 150));
        log.push("   is715: " + is715(proxyResult));
      } catch (e) {
        log.push("ERROR: " + String(e));
      }
      return new Response(log.join("\n"), {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // ────────────────────────────────────────
    // 6. ПОЛНЫЙ ТЕСТ СЕССИИ ДЛЯ WIN11
    // ────────────────────────────────────────
    if (url.pathname === "/testWin11") {
      const log = [];
      try {
        const editionIds = [3321, 3324];
        log.push(
          "Testing Windows 11 session with editionIds: " +
            JSON.stringify(editionIds),
        );

        for (let si = 0; si < editionIds.length; si++) {
          const sid = crypto.randomUUID();
          log.push(
            "\n--- editionId=" +
              editionIds[si] +
              " sid=" +
              sid.slice(0, 8) +
              "...",
          );

          const c1 = await doWhitelist(sid, env, []);
          log.push("  whitelist cookies: " + c1.length);

          const c2 = await doOvdf(sid, env, c1);
          log.push("  ovdf cookies: " + c2.length);

          const apiUrl =
            "https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition" +
            "?profile=" +
            PROFILE_ID +
            "&productEditionId=" +
            editionIds[si] +
            "&SKU=undefined&friendlyFileName=undefined&Locale=en-US&sessionID=" +
            sid;

          const msResult = await msFetch(
            env,
            apiUrl,
            {
              ...AH,
              Referer:
                "https://www.microsoft.com/software-download/windows11",
            },
            c2,
          );
          log.push(
            "  getsku response(200): " + msResult.text.slice(0, 200),
          );
          log.push("  is715: " + is715(msResult.text));

          try {
            const data = JSON.parse(msResult.text);
            if (data.Errors && data.Errors.length > 0) {
              log.push("  ERRORS: " + JSON.stringify(data.Errors[0]));
            } else if (data.Skus && data.Skus.length > 0) {
              const sku = data.Skus[0];
              log.push(
                "  First SKU: id=" + sku.Id + " lang=" + sku.Language,
              );

              const dlUrl =
                "https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku" +
                "?profile=" +
                PROFILE_ID +
                "&productEditionId=undefined&SKU=" +
                sku.Id +
                "&friendlyFileName=undefined&Locale=en-US&sessionID=" +
                sid;

              const dlResult = await msFetch(
                env,
                dlUrl,
                {
                  ...AH,
                  Referer:
                    "https://www.microsoft.com/software-download/windows11",
                },
                msResult.cookies,
              );
              log.push(
                "  GetLinks response(200): " +
                  dlResult.text.slice(0, 200),
              );

              try {
                const dlData = JSON.parse(dlResult.text);
                if (dlData.Errors && dlData.Errors.length > 0) {
                  log.push(
                    "  LINKS ERRORS: " +
                      JSON.stringify(dlData.Errors[0]),
                  );
                } else if (dlData.ProductDownloadOptions) {
                  log.push(
                    "  LINKS OK: " +
                      dlData.ProductDownloadOptions.length +
                      " options",
                  );
                }
              } catch (pe) {
                log.push("  LINKS PARSE ERROR: " + String(pe));
              }
            }
          } catch (pe) {
            log.push("  PARSE ERROR: " + String(pe));
          }
        }
      } catch (e) {
        log.push("ERROR: " + String(e));
      }
      return new Response(log.join("\n"), {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // ────────────────────────────────────────
    // 7. ОЧИСТКА KV‑КЭША
    // ────────────────────────────────────────
    if (url.pathname === "/clearCache") {
      const list = await env.CACHE.list();
      for (const key of list.keys) {
        await env.CACHE.delete(key.name);
      }
      return new Response("Deleted " + list.keys.length + " keys");
    }

    // ────────────────────────────────────────
    // 8. TELEGRAM WEBHOOK
    // ────────────────────────────────────────
    if (url.pathname === "/webhook" && request.method === "POST") {
      let update;
      try {
        update = await request.json();
      } catch (e) {
        console.error("[webhook] JSON parse failed:", String(e));
        return new Response("OK");
      }
      console.log(
        "[webhook] received update_id:",
        update?.update_id,
        "has_callback:",
        !!update?.callback_query,
        "has_message:",
        !!update?.message,
      );
      ctx.waitUntil(
        handleUpdate(update, env, ctx).catch((e) =>
          console.error("[handleUpdate] uncaught:", String(e)),
        ),
      );
      return new Response("OK");
    }

    // ────────────────────────────────────────
    // 9. WEB API: список языков
    // ────────────────────────────────────────
    if (url.pathname === "/api/langs") {
      const kv = env.CACHE;

      const vi = parseInt(url.searchParams.get("vi") || "0", 10);
      const ri = parseInt(url.searchParams.get("ri") || "0", 10);
      const ei = parseInt(url.searchParams.get("ei") || "0", 10);

      try {
        const win = WIN_VERSIONS[vi];
        if (!win) throw new Error("Unknown Windows version index: " + vi);

        const rel = win.releases[ri];
        if (!rel) throw new Error("Unknown release index: " + ri);

        const ed = rel.editions[ei];
        if (!ed) throw new Error("Unknown edition index: " + ei);

        const editionIds = ed.ids;

        const langs = await fetchLanguages(vi, editionIds, env);

        return new Response(JSON.stringify({ langs }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message || String(e) }),
          {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }
    }

    // ────────────────────────────────────────
    // 10. WEB API: ISO‑ссылки
    // ────────────────────────────────────────
    if (url.pathname === "/api/iso") {
      const kv = env.CACHE;

      const vi = parseInt(url.searchParams.get("vi") || "0", 10);
      const ri = parseInt(url.searchParams.get("ri") || "0", 10);
      const ei = parseInt(url.searchParams.get("ei") || "0", 10);

      const langName = url.searchParams.get("lang") || "English";

      try {
        const win = WIN_VERSIONS[vi];
        if (!win) throw new Error("Unknown Windows version index: " + vi);

        const rel = win.releases[ri];
        if (!rel) throw new Error("Unknown release index: " + ri);

        const ed = rel.editions[ei];
        if (!ed) throw new Error("Unknown edition index: " + ei);

        const editionIds = ed.ids;

        const result = await getDownloadLinks(
          kv,
          vi,
          ri,
          editionIds,
          langName,
          env,
        );

        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message || String(e) }),
          {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }
    }

    // ────────────────────────────────────────
    // 11. 404 ДЛЯ НЕИЗВЕСТНЫХ ПУТЕЙ
    // ────────────────────────────────────────
    return new Response("Not Found", { status: 404 });
  },
};

// ────────────────────────────────────────────
// HTML‑страница для корневого пути /
// ────────────────────────────────────────────
function renderHtmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Microsoft ISO Downloader – webwordisowin</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 900px;
      margin: 40px auto;
      padding: 0 16px;
      line-height: 1.5;
    }
    label {
      display: block;
      margin: 8px 0;
    }
    select, button {
      padding: 4px 8px;
      margin-top: 4px;
    }
    #results a {
      display: block;
      margin: 4px 0;
      word-break: break-all;
    }
    .note {
      font-size: 0.9em;
      color: #555;
    }
  </style>
</head>
<body>
  <h1>Microsoft ISO Downloader (webwordisowin)</h1>

  <p>
    Это веб-интерфейс к Telegram-боту
    <a href="https://t.me/WinOfficeISO_bot" target="_blank">WinOfficeISO_bot</a>,
    который помогает скачивать официальные ISO Windows и Office с серверов Microsoft.
  </p>

  <p class="note">
    Языки и ссылки берутся через тот же backend (fetchLanguages + getDownloadLinks).
  </p>

  <label>
    Language:
    <select id="lang"></select>
  </label>

  <button id="loadBtn">Get ISO links</button>

  <h2>Results</h2>
  <div id="results"></div>

  <script>
    const btn = document.getElementById('loadBtn');
    const results = document.getElementById('results');
    const langSelect = document.getElementById('lang');

    const vi = 0;
    const ri = 0;
    const ei = 0;

    (async () => {
      try {
        const resp = await fetch(
          '/api/langs?vi=' + vi +
          '&ri=' + ri +
          '&ei=' + ei
        );
        const data = await resp.json();
        if (!resp.ok) {
          console.error('Cannot load langs:', data.error);
          langSelect.innerHTML =
            '<option value="English">English (fallback)</option>';
          return;
        }

        if (!data || !Array.isArray(data.langs) || data.langs.length === 0) {
          langSelect.innerHTML =
            '<option value="English">English (fallback)</option>';
          return;
        }

        langSelect.innerHTML = '';
        data.langs.forEach(l => {
          const opt = document.createElement('option');
          opt.value = l.name;
          opt.textContent = l.name;
          langSelect.appendChild(opt);
        });
      } catch (e) {
        console.error('Error loading langs:', e);
        langSelect.innerHTML =
          '<option value="English">English (fallback)</option>';
      }
    })();

    btn.addEventListener('click', async () => {
      results.textContent = 'Loading...';

      const lang = langSelect.value;

      try {
        const resp = await fetch(
          '/api/iso?vi=' + vi +
          '&ri=' + ri +
          '&ei=' + ei +
          '&lang=' + encodeURIComponent(lang)
        );

        const data = await resp.json();
        results.innerHTML = '';

        if (!resp.ok) {
          results.textContent = data.error || ('HTTP error ' + resp.status);
          return;
        }

        if (!data || !Array.isArray(data.links) || data.links.length === 0) {
          results.textContent = 'No links returned.';
          return;
        }

        if (data.created_at) {
          const p = document.createElement('p');
          p.textContent =
            'Links generated at: ' +
            new Date(data.created_at * 1000).toLocaleString();
          results.appendChild(p);
        }

        data.links.forEach(link => {
          const a = document.createElement('a');
          a.href = link.url;
          a.textContent =
            (link.arch ? (link.arch + ' — ') : '') + link.url;
          a.target = '_blank';
          results.appendChild(a);
        });
      } catch (e) {
        results.textContent = 'Error: ' + e.message;
      }
    });
  </script>
</body>
</html>`;
}

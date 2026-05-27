/**
 * Microsoft ISO & Tools Web Interface
 * Cloudflare Worker + KV cache + Deno Deploy proxy fallback
 */

import { OFFICE_VERSIONS, STANDALONE_APPS } from "./linkoffice.js";

// ═══════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════

const TTL_LANGS        = 6 * 3600;
const TTL_LINKS        = 24 * 3600;
const TIMEOUT_MS       = 15_000;
const PROXY_TIMEOUT_MS = 20_000;
const LOCALE           = "en-US";
const ORG_ID           = "y6jn8c31";
const PROFILE_ID       = "606624d44113";
const INST_ID          = "560dc9f3-1aa5-4a2f-b63c-9e18f8d0e175";

const BH = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "DNT":             "1",
};

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

const WIN_VERSIONS = [
  {
    name:    "Windows 11",
    dl_page: "https://www.microsoft.com/software-download/windows11",
    releases: [
      {
        label: "25H2 v2 (Build 26200.8037 — 2026.03)",
        editions: [
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
          { name: "Windows 10 Home/Pro/Edu", ids: [2618] },
          { name: "Windows 10 Home China",   ids: [2378] },
        ],
      },
    ],
  },
];

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
  "Arabic": "🇺🇸", "Bulgarian": "🇧🇬", "Chinese Simplified": "🇨🇳",
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

const WELCOME = `🗂 <b>Microsoft ISO &amp; Tools by KeicH2O</b><br><br>Official downloads directly from Microsoft servers.<br><br>💿 <b>Windows 10 / 11</b> — 40 languages · x64 / x86 / ARM64<br>🖥 <b>Windows Server 2019–2025</b> — 8 languages · official ISO<br>💼 <b>Office 365 / 2013–2024</b> — 40 languages · Online + Offline<br>📄 <b>Word / Excel / PowerPoint...</b> — 40 languages · standalone<br>🛠 <b>Media Creation Tool</b> — all versions<br>🔧 <b>Windows Admin Center</b><br><br>Choose a section:`;

const DONATE_TEXT = `💸 <b>Support the project</b><br><br><b>TON:</b><br><code>UQARgaMSvODHBT9YNnf1m6gLL-Lmat64KV0IBTWOOXwiNkDp</code><br><br><b>TRC20 USDT:</b><br><code>TDZEdxy9zFxHAE4bvsZeL8Ytbyw922kd3Y</code><br><br><b>ERC20 (USDT/ETH):</b><br><code>0xA42145FACc44E0b31Df2569B85846a7fA8DEed55</code><br><br><b>BTC:</b><br><code>bc1qteffasa377wy5r9hx7cwu3saf7lp077hyp2wxj</code>`;

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

// ═══════════════════════════════════════════
// MS API & SESSION LOGIC
// ═══════════════════════════════════════════

function is715(text) { return typeof text === "string" && text.includes("715-123130"); }
function isErr715(err) {
  return Number(err["Type"]) === 9 || String(err["Value"] || "").includes("715-123130") || String(err["Key"] || "").includes("Sentinel");
}

function expiryText(createdAt) {
  const rem = Math.floor(createdAt + TTL_LINKS - Date.now() / 1000);
  if (rem <= 0) return "⏰ Link expired";
  const h = Math.floor(rem / 3600), m = Math.floor((rem % 3600) / 60);
  return h > 0 ? `⏳ Expires in ${h}h ${m}m` : `⏳ Expires in ${m}m`;
}

function errMsg(e, vi) {
  const dp  = WIN_VERSIONS[vi]?.dl_page || "";
  const ref = dp ? `<br><br>🌐 <a href="${dp}" target="_blank">Download manually</a>` : "";
  if (e.includes("BLOCKED_715")) return `⛔ <b>Microsoft blocked this IP (715-123130)</b><br><br>Wait 1–2 hours and try again.${ref}`;
  if (e.includes("EMPTY")) return `⚠️ <b>Microsoft returned empty response.</b><br>Try again in a minute.${ref}`;
  if (e.includes("TIMEOUT") || e.includes("MS_TIMEOUT")) return `⏱ <b>Microsoft API timeout.</b><br>Try again in a minute.${ref}`;
  return `❌ <b>Error:</b><br><code>${e.slice(0, 300)}</code>${ref}`;
}

async function fetchViaProxy(env, url, headers) {
  if (!env.DENO_PROXY_URL || !env.PROXY_SECRET) throw new Error("Proxy not configured");
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
    return await resp.text();
  } finally { clearTimeout(tid); }
}

async function msFetch(env, url, reqHeaders, cookies) {
  const hdrs = { ...reqHeaders };
  if (cookies?.length) hdrs["Cookie"] = cookies.join("; ");
  let text = null; let respCookies = [];
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers: hdrs, signal: controller.signal });
      text = await resp.text();
      const setCookie = resp.headers.get("set-cookie");
      if (setCookie) respCookies = setCookie.split(",").map(c => c.split(";")[0].trim());
    } finally { clearTimeout(tid); }
  } catch { text = null; }
  if (text === null || is715(text)) {
    if (!env.DENO_PROXY_URL) {
      if (text === null) throw new Error("MS_TIMEOUT");
      throw new Error("BLOCKED_715");
    }
    text = await fetchViaProxy(env, url, hdrs);
    respCookies = [];
  }
  if (is715(text)) throw new Error("BLOCKED_715");
  return { text, cookies: respCookies };
}

async function preVisit(dlPage) {
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10_000);
    await fetch(dlPage, { headers: BH, signal: controller.signal });
  } catch {}
}

async function doWhitelist(sid, env, prevCookies) {
  const url = "https://vlscppe.microsoft.com/tags?org_id=" + ORG_ID + "&session_id=" + sid;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5_000);
    try {
      const resp = await fetch(url, {
        headers:  { ...BH, ...(prevCookies?.length ? { Cookie: prevCookies.join("; ") } : {}) },
        redirect: "manual", signal: controller.signal,
      });
      const setCookie = resp.headers.get("set-cookie");
      if (setCookie) return setCookie.split(",").map(c => c.split(";")[0].trim());
    } finally { clearTimeout(tid); }
  } catch {}
  return prevCookies || [];
}

async function doOvdf(sid, env, cookies) {
  try {
    const mdtUrl = "https://ov-df.microsoft.com/mdt.js?instanceId=" + INST_ID + "&PageId=si&session_id=" + sid;
    const resp = await fetch(mdtUrl, { headers: { ...BH, ...(cookies?.length ? { Cookie: cookies.join("; ") } : {}) } });
    const txt = await resp.text();
    const mW = txt.match(/[?&]w=([A-F0-9]+)/i);
    const mR = txt.match(/rticks\s*=\s*"\+?(\d+)/);
    if (mW && mR) {
      const replyUrl = `https://ov-df.microsoft.com/?session_id=${sid}&CustomerId=${INST_ID}&PageId=si&w=${mW[1]}&mdt=${Date.now()}&rticks=${mR[1]}`;
      await fetch(replyUrl, { headers: { ...BH, ...(cookies?.length ? { Cookie: cookies.join("; ") } : {}) } });
    }
  } catch {}
  return cookies;
}

async function fetchLanguages(vi, editionIds, env) {
  const referer = WIN_VERSIONS[vi].dl_page;
  const langs = {};
  const sessionIds = new Array(editionIds.length).fill(null);
  const sessionCookies = new Array(editionIds.length).fill([]);
  await preVisit(referer);
  for (let si = 0; si < editionIds.length; si++) {
    sessionIds[si] = crypto.randomUUID();
    sessionCookies[si] = await doWhitelist(sessionIds[si], env, []);
    sessionCookies[si] = await doOvdf(sessionIds[si], env, sessionCookies[si]);
    const url = `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition?profile=${PROFILE_ID}&productEditionId=${editionIds[si]}&SKU=undefined&friendlyFileName=undefined&Locale=${LOCALE}&sessionID=${sessionIds[si]}`;
    let data;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
      const msResult = await msFetch(env, url, { ...AH, Referer: referer }, sessionCookies[si]);
      if (msResult.cookies.length) sessionCookies[si] = msResult.cookies;
      try { data = JSON.parse(msResult.text); } catch { if (attempt === 0) continue; throw new Error("Unexpected response"); }
      if (data.Errors?.length) {
        if (isErr715(data.Errors[0])) throw new Error("BLOCKED_715");
        if (attempt === 0) continue;
        throw new Error(String(data.Errors[0].Value || "API error"));
      }
      if (!data.Skus?.length) { if (attempt === 0) continue; throw new Error("EMPTY_LANGUAGES"); }
      break;
    }
    for (const sku of (data.Skus || [])) {
      const lg = String(sku.Language);
      if (!langs[lg]) langs[lg] = { display: String(sku.LocalizedLanguage), skuData: [] };
      langs[lg].skuData.push({ sessionIndex: si, skuId: String(sku.Id) });
    }
  }
  return Object.entries(langs).map(([name, v]) => ({ name, display: v.display, skuData: v.skuData, sessionIds, sessionCookies }));
}

async function getLanguageList(kv, vi, editionIds, env) {
  const ck = `langlist:${vi}:${editionIds.join(",")}`;
  const cached = await kvGet(kv, ck);
  if (cached) return cached.data;
  const langs = await fetchLanguages(vi, editionIds, env);
  const list = langs.map(l => ({ name: l.name, display: l.display }));
  await kvSet(kv, ck, list, TTL_LANGS);
  return list;
}

async function getDownloadLinkViaProxy(env, skuId, editionId, referer) {
  const newSid = crypto.randomUUID();
  try { await fetchViaProxy(env, `https://vlscppe.microsoft.com/tags?org_id=${ORG_ID}&session_id=${newSid}`, { ...BH }); } catch {}
  try {
    const mdtText = await fetchViaProxy(env, `https://ov-df.microsoft.com/mdt.js?instanceId=${INST_ID}&PageId=si&session_id=${newSid}`, { ...BH });
    const mW = mdtText.match(/[?&]w=([A-F0-9]+)/i);
    const mR = mdtText.match(/rticks\s*=\s*"\+?(\d+)/);
    if (mW && mR) await fetchViaProxy(env, `https://ov-df.microsoft.com/?session_id=${newSid}&CustomerId=${INST_ID}&PageId=si&w=${mW[1]}&mdt=${Date.now()}&rticks=${mR[1]}`, { ...BH });
  } catch {}
  let freshSkuId = skuId;
  try {
    const skuUrl = `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition?profile=${PROFILE_ID}&productEditionId=${editionId}&SKU=undefined&friendlyFileName=undefined&Locale=${LOCALE}&sessionID=${newSid}`;
    const skuData = JSON.parse(await fetchViaProxy(env, skuUrl, { ...AH, Referer: referer }));
    if (skuData.Skus?.length) {
      const found = skuData.Skus.find(s => String(s.Id) === String(skuId));
      freshSkuId = found ? String(found.Id) : String(skuData.Skus[0].Id);
    }
  } catch {}
  await new Promise(r => setTimeout(r, 4000 + Math.random() * 2000));
  const dlUrl = `https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku?profile=${PROFILE_ID}&productEditionId=undefined&SKU=${freshSkuId}&friendlyFileName=undefined&Locale=${LOCALE}&sessionID=${newSid}`;
  const data = JSON.parse(await fetchViaProxy(env, dlUrl, { ...AH, Referer: referer }));
  if (data.Errors?.length) throw new Error("BLOCKED_715");
  return data.ProductDownloadOptions || [];
}

async function getDownloadLinks(kv, vi, ri, editionIds, langName, env) {
  const ck = `links:${vi}:${ri}:${langName}`;
  const cached = await kvGet(kv, ck);
  if (cached) return cached.data;
  const referer = WIN_VERSIONS[vi].dl_page;
  const archMap = { 0: "x86", 1: "x64", 2: "ARM64" };
  const links = [];
  const langs = await fetchLanguages(vi, editionIds, env);
  const lang = langs.find(l => l.name === langName);
  if (!lang) throw new Error("Language not found");
  for (const entry of lang.skuData) {
    if (links.find(l => l.arch === "x64") && entry.sessionIndex === 1) continue;
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    const sid = lang.sessionIds[entry.sessionIndex];
    const cookies = lang.sessionCookies[entry.sessionIndex];
    const url = `https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku?profile=${PROFILE_ID}&productEditionId=undefined&SKU=${entry.skuId}&friendlyFileName=undefined&Locale=${LOCALE}&sessionID=${sid}`;
    const msResult = await msFetch(env, url, { ...AH, Referer: referer }, cookies);
    let data;
    try { data = JSON.parse(msResult.text); } catch { throw new Error("Unexpected response"); }
    if (data.Errors?.length) {
      if (isErr715(data.Errors[0]) && env.DENO_PROXY_URL) {
        const opts = await getDownloadLinkViaProxy(env, entry.skuId, editionIds[entry.sessionIndex], referer);
        for (const opt of opts) {
          const arch = archMap[Number(opt.DownloadType)] || "?";
          if (!links.find(l => l.arch === arch)) links.push({ arch, url: String(opt.Uri) });
        }
        continue;
      }
      throw new Error(String(data.Errors[0].Value || "unknown"));
    }
    for (const opt of (data.ProductDownloadOptions || [])) {
      const arch = archMap[Number(opt.DownloadType)] || "?";
      if (!links.find(l => l.arch === arch)) links.push({ arch, url: String(opt.Uri) });
    }
  }
  const order = ["x64", "x86", "ARM64"];
  links.sort((a, b) => order.indexOf(a.arch) - order.indexOf(b.arch));
  const result = { links, created_at: Math.floor(Date.now() / 1000) };
  await kvSet(kv, ck, result, TTL_LINKS);
  return result;
}

// ═══════════════════════════════════════════
// WEB ACTION HANDLER
// ═══════════════════════════════════════════

const BACK = { label: "⬅️ Back", action: "main" };

async function handleAction(data, env) {
  const kv = env.CACHE;
  if (!data || data === "main") {
    return {
      title: "🏠 Main Menu", text: WELCOME,
      items: [
        { label: "💿 Windows 10 / 11 ISO", action: "sec:fido" },
        { label: "🖥 Windows Server (Eval)", action: "sec:server" },
        { label: "💼 Microsoft Office", action: "sec:office" },
        { label: "📄 Word / Excel / Office Apps", action: "sec:office_apps" },
        { label: "🛠 Media Creation Tool", action: "sec:mct" },
        { label: "🔧 Windows Admin Center", action: "sec:admin" },
        { label: "💸 Donate", action: "donate" }
      ]
    };
  }

  if (data === "donate") {
    return { title: "💸 Donate", text: DONATE_TEXT, items: [BACK] };
  }

  if (data.startsWith("sec:")) {
    const sec = data.split(":")[1];
    if (sec === "fido") {
      return { title: "🖥 Windows ISO", text: "Select Windows version:", items: [...WIN_VERSIONS.map((v, i) => ({ label: `🖥 ${v.name}`, action: `ver:${i}` })), BACK] };
    }
    if (sec === "office") {
      return { title: "💼 Microsoft Office", text: "Select version:", items: [...OFFICE_VERSIONS.map((v, i) => ({ label: v.label, action: `offver2:${i}` })), BACK] };
    }
    if (sec === "server") {
      return { title: "🖥 Windows Server", text: "Select version:", items: [...SERVER_VERSIONS.map((v, i) => ({ label: `🖥 ${v.name}`, action: `sver:${i}` })), BACK] };
    }
    if (sec === "office_apps") {
      return { title: "📄 Office Apps", text: "Select app:", items: [...STANDALONE_APPS.map((app, i) => ({ label: app.label, action: `saapp:${i}` })), BACK] };
    }
    if (STATIC[sec]) {
      return { title: STATIC[sec].label, text: "Select product:", items: [...STATIC[sec].items.map((item, i) => ({ label: item.name, action: `si:${sec}:${i}` })), BACK] };
    }
  }

  if (data.startsWith("sver:")) {
    const vi = parseInt(data.split(":")[1]);
    const sv = SERVER_VERSIONS[vi];
    return { title: sv.name, text: "Select language:", items: [...sv.langs.map((l, i) => ({ label: fl(l.code) + l.name, action: `slang:${vi}:${i}` })), { label: "⬅️ Back", action: "sec:server" }, BACK] };
  }

  if (data.startsWith("slang:")) {
    const [, vis, lis] = data.split(":");
    const vi = parseInt(vis), li = parseInt(lis);
    const sv = SERVER_VERSIONS[vi], lang = sv.langs[li];
    const url = `https://go.microsoft.com/fwlink/p/?LinkID=${sv.linkId}&clcid=${lang.clcid}&culture=${lang.code}&country=${lang.country}`;
    return { title: "✅ Ready", text: `✅ <b>${sv.name}</b><br>🌐 ${lang.name}<br><br>💿 .iso — burn to USB with Rufus or Ventoy<br><br><i>Permanent Microsoft link — no expiry</i>`, items: [{ label: "⬇️ Download", url }, { label: "🌐 Other language", action: `sver:${vi}` }, { label: "💸 Donate", action: "donate" }, BACK] };
  }

  if (data.startsWith("si:")) {
    const [, sec, idxS] = data.split(":");
    const item = STATIC[sec]?.items[parseInt(idxS)];
    if (!item) return { title: "Error", text: "Product not found", items: [BACK] };
    const ext = (item.url.split(".").pop() || "").toUpperCase();
    const notes = { IMG: "📦 .img — mount via ODT or open with 7-Zip", ISO: "💿 .iso — burn to USB with Rufus or Ventoy", EXE: "🔧 .exe — run to install", MSI: "🔧 .msi — run to install" };
    return { title: "✅ Ready", text: `✅ <b>${item.name}</b><br><br>${notes[ext] || "📎 Microsoft file"}<br><br><i>Permanent link — no expiry</i>`, items: [{ label: "⬇️ Download", url: item.url }, { label: "💸 Donate", action: "donate" }, BACK] };
  }

  if (data.startsWith("offver2:")) {
    const vi = parseInt(data.split(":")[1]);
    const v = OFFICE_VERSIONS[vi];
    return { title: v.label, text: "Select edition:", items: [...v.editions.map((e, i) => ({ label: e.name, action: `offed2:${vi}:${i}` })), { label: "⬅️ Back", action: "sec:office" }, BACK] };
  }
  if (data.startsWith("offed2:")) {
    const [, vis, eis] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis);
    const ed = OFFICE_VERSIONS[vi].editions[ei];
    const popular = ed.langs.filter(l => POPULAR_LANGS.includes(l.name));
    const items = popular.map(l => ({ label: fl(l.code) + l.name, action: `offlang:${vi}:${ei}:${ed.langs.indexOf(l)}` }));
    if (ed.langs.length > popular.length) items.push({ label: `🌐 All languages (+${ed.langs.length - popular.length})`, action: `offalllang:${vi}:${ei}` });
    items.push({ label: "⬅️ Back", action: `offver2:${vi}` }, BACK);
    return { title: ed.name, text: "Select language:", items };
  }
  if (data.startsWith("offalllang:")) {
    const [, vis, eis] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis);
    const ed = OFFICE_VERSIONS[vi].editions[ei];
    const others = ed.langs.filter(l => !POPULAR_LANGS.includes(l.name));
    return { title: "All languages", text: "Select language:", items: [...others.map(l => ({ label: fl(l.code) + l.name, action: `offlang:${vi}:${ei}:${ed.langs.indexOf(l)}` })), { label: "⬅️ Back to popular", action: `offed2:${vi}:${ei}` }, BACK] };
  }
  if (data.startsWith("offlang:")) {
    const [, vis, eis, lis] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis), li = parseInt(lis);
    const ed = OFFICE_VERSIONS[vi].editions[ei], lang = ed.langs[li];
    const items = [{ label: "🌐 Online x64", action: `offtype:${vi}:${ei}:${li}:online` }];
    if (lang.offline) items.push({ label: "📦 Offline x64 (~3GB)", action: `offtype:${vi}:${ei}:${li}:offline` });
    items.push({ label: "⬅️ Back", action: `offed2:${vi}:${ei}` }, BACK);
    return { title: lang.name, text: "Select download type:", items };
  }
  if (data.startsWith("offtype:")) {
    const [, vis, eis, lis, type] = data.split(":");
    const vi = parseInt(vis), ei = parseInt(eis), li = parseInt(lis);
    const ed = OFFICE_VERSIONS[vi].editions[ei], lang = ed.langs[li];
    const url = type === "offline" ? lang.offline : lang.online;
    return { title: "✅ Ready", text: `✅ <b>${OFFICE_VERSIONS[vi].label}</b><br>📦 ${ed.name}<br>🌐 ${lang.name} · ${type === "offline" ? "📦 Offline x64" : "🌐 Online x64"}<br><br>${type === "offline" ? "📦 .img — mount via ODT or open with 7-Zip" : "🌐 Small installer — downloads during installation"}<br><br><i>Permanent link — no expiry</i>`, items: [{ label: "⬇️ Download", url }, { label: "💸 Donate", action: "donate" }, { label: "🌐 Other language", action: `offed2:${vi}:${ei}` }, BACK] };
  }

  if (data.startsWith("ver:")) {
    const vi = parseInt(data.split(":")[1]);
    return { title: WIN_VERSIONS[vi].name, text: "Select release:", items: [...WIN_VERSIONS[vi].releases.map((r, i) => ({ label: r.label, action: `rel:${vi}:${i}` })), { label: "⬅️ Back", action: "sec:fido" }, BACK] };
  }
  if (data.startsWith("rel:")) {
    const [, vs, rs] = data.split(":");
    const vi = parseInt(vs), ri = parseInt(rs);
    return { title: WIN_VERSIONS[vi].releases[ri].label, text: "Select edition:", items: [...WIN_VERSIONS[vi].releases[ri].editions.map((e, i) => ({ label: e.name, action: `ed:${vi}:${ri}:${i}` })), { label: "⬅️ Back", action: `ver:${vi}` }, BACK] };
  }
  if (data.startsWith("ed:")) {
    const [, vs, rs, es] = data.split(":");
    const vi = parseInt(vs), ri = parseInt(rs), ei = parseInt(es);
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];
    try {
      const langList = await getLanguageList(kv, vi, edition.ids, env);
      const popular = langList.filter(l => POPULAR_LANGS.includes(l.display));
      const items = popular.map(l => ({ label: fl(l.display) + l.display, action: `lang:${vi}:${ri}:${ei}:${langList.indexOf(l)}` }));
      if (langList.length > popular.length) items.push({ label: `🌐 All languages (+${langList.length - popular.length})`, action: `alllang:${vi}:${ri}:${ei}` });
      items.push({ label: "⬅️ Back", action: `rel:${vi}:${ri}` }, BACK);
      return { title: edition.name, text: "Select language:", items };
    } catch (e) { return { title: "Error", text: errMsg(String(e), vi), items: [{ label: "🔄 Try again", action: `ed:${vi}:${ri}:${ei}` }, BACK] }; }
  }
  if (data.startsWith("alllang:")) {
    const [, vs, rs, es] = data.split(":");
    const vi = parseInt(vs), ri = parseInt(rs), ei = parseInt(es);
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];
    const langList = await getLanguageList(kv, vi, edition.ids, env);
    const others = langList.filter(l => !POPULAR_LANGS.includes(l.display));
    return { title: "All languages", text: "Select language:", items: [...others.map(l => ({ label: fl(l.display) + l.display, action: `lang:${vi}:${ri}:${ei}:${langList.indexOf(l)}` })), { label: "⬅️ Back to popular", action: `ed:${vi}:${ri}:${ei}` }, BACK] };
  }
  if (data.startsWith("lang:")) {
    const [, vis, ris, eis, lis] = data.split(":");
    const vi = parseInt(vis), ri = parseInt(ris), ei = parseInt(eis), li = parseInt(lis);
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];
    try {
      const langList = await getLanguageList(kv, vi, edition.ids, env);
      const langItem = langList[li];
      const result = await getDownloadLinks(kv, vi, ri, edition.ids, langItem.name, env);
      const em = { x64: "💿", x86: "📀", ARM64: "🔷" };
      return { title: langItem.display, text: "Select architecture:", items: [...result.links.map((l, i) => ({ label: `${em[l.arch] || "💾"} ${l.arch}`, action: `arch:${vi}:${ri}:${ei}:${li}:${i}:${result.created_at}` })), { label: "⬅️ Back", action: `ed:${vi}:${ri}:${ei}` }, BACK] };
    } catch (e) { return { title: "Error", text: errMsg(String(e), vi), items: [{ label: "🔄 Try again", action: `lang:${vi}:${ri}:${ei}:${li}` }, BACK] }; }
  }
  if (data.startsWith("arch:")) {
    const [, vis, ris, eis, lis, aiS, caS] = data.split(":");
    const vi = parseInt(vis), ri = parseInt(ris), ei = parseInt(eis), li = parseInt(lis), archIdx = parseInt(aiS), ca = parseInt(caS);
    const edition = WIN_VERSIONS[vi].releases[ri].editions[ei];
    const langList = await getLanguageList(kv, vi, edition.ids, env);
    const langItem = langList[li];
    const linksCached = await kvGet(kv, `links:${vi}:${ri}:${langItem.name}`);
    if (!linksCached) return { title: "Expired", text: "Links expired. Please start over.", items: [{ label: "🔄 Start over", action: `ed:${vi}:${ri}:${ei}` }, BACK] };
    const link = linksCached.data.links[archIdx];
    return { title: "✅ Ready", text: `✅ <b>Link ready!</b><br><br>🖥 ${WIN_VERSIONS[vi].name} · ${WIN_VERSIONS[vi].releases[ri].label}<br>📦 ${edition.name}<br>🌐 ${langItem.display} · 🏗 ${link.arch}<br><br><i>⚠️ ${expiryText(ca || linksCached.data.created_at)}</i>`, items: [{ label: "⬇️ Download", url: link.url }, { label: "💸 Donate", action: "donate" }, { label: "🔄 Another image", action: "sec:fido" }, BACK] };
  }

  if (data.startsWith("saapp:")) {
    const ai = parseInt(data.split(":")[1]);
    const app = STANDALONE_APPS[ai];
    return { title: app.label, text: "Select version:", items: [...app.versions.map((v, i) => ({ label: v.name, action: `saver:${ai}:${i}` })), { label: "⬅️ Back", action: "sec:office_apps" }, BACK] };
  }
  if (data.startsWith("saver:")) {
    const [, ais, vis] = data.split(":");
    const ai = parseInt(ais), vi = parseInt(vis);
    const ver = STANDALONE_APPS[ai].versions[vi];
    const popular = ver.langs.filter(l => POPULAR_LANGS.includes(l.name));
    const items = popular.map(l => ({ label: fl(l.code) + l.name, action: `salang:${ai}:${vi}:${ver.langs.indexOf(l)}` }));
    if (ver.langs.length > popular.length) items.push({ label: `🌐 All languages (+${ver.langs.length - popular.length})`, action: `saalllang:${ai}:${vi}` });
    items.push({ label: "⬅️ Back", action: `saapp:${ai}` }, BACK);
    return { title: ver.name, text: "Select language:", items };
  }
  if (data.startsWith("saalllang:")) {
    const [, ais, vis] = data.split(":");
    const ai = parseInt(ais), vi = parseInt(vis);
    const ver = STANDALONE_APPS[ai].versions[vi];
    const others = ver.langs.filter(l => !POPULAR_LANGS.includes(l.name));
    return { title: "All languages", text: "Select language:", items: [...others.map(l => ({ label: fl(l.code) + l.name, action: `salang:${ai}:${vi}:${ver.langs.indexOf(l)}` })), { label: "⬅️ Back to popular", action: `saver:${ai}:${vi}` }, BACK] };
  }
  if (data.startsWith("salang:")) {
    const [, ais, vis, lis] = data.split(":");
    const ai = parseInt(ais), vi = parseInt(vis), li = parseInt(lis);
    const ver = STANDALONE_APPS[ai].versions[vi], lang = ver.langs[li];
    return { title: lang.name, text: "Select download type:", items: [{ label: "🌐 Online x64", action: `satype:${ai}:${vi}:${li}:online` }, { label: "📦 Offline x64 (.img)", action: `satype:${ai}:${vi}:${li}:offline` }, { label: "⬅️ Back", action: `saver:${ai}:${vi}` }, BACK] };
  }
  if (data.startsWith("satype:")) {
    const [, ais, vis, lis, type] = data.split(":");
    const ai = parseInt(ais), vi = parseInt(vis), li = parseInt(lis);
    const ver = STANDALONE_APPS[ai].versions[vi], lang = ver.langs[li];
    const url = type === "offline" ? lang.offline : lang.online;
    return { title: "✅ Ready", text: `✅ <b>${ver.name}</b><br>🌐 ${fl(lang.code)}${lang.name} · ${type === "offline" ? "📦 Offline x64 (.img)" : "🌐 Online x64"}<br><br>${type === "offline" ? "📦 .img — mount via ODT or open with 7-Zip" : "🌐 Small installer — downloads during installation"}<br><br><i>Permanent link — no expiry</i>`, items: [{ label: "⬇️ Download", url }, { label: "💸 Donate", action: "donate" }, { label: "📄 Other app", action: "sec:office_apps" }, BACK] };
  }

  return { title: "Unknown", text: "Action not recognized", items: [BACK] };
}

// ═══════════════════════════════════════════
// WORKER ENTRY POINT
// ═══════════════════════════════════════════

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Microsoft ISO & Tools</title>
  <style>
    :root {
      --bg: #1c1c1e;
      --card-bg: #2c2c2e;
      --accent: #0a84ff;
      --success: #30d158;
      --text: #ffffff;
      --text-muted: #8e8e93;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      margin: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      width: 100%;
      max-width: 600px;
      padding: 20px;
      box-sizing: border-box;
    }
    header {
      text-align: center;
      margin-bottom: 30px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 10px;
    }
    .card {
      background-color: var(--card-bg);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      line-height: 1.6;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .btn-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    @media (min-width: 480px) {
      .btn-grid {
        grid-template-columns: 1fr 1fr;
      }
      .btn-grid .full-width {
        grid-column: span 2;
      }
    }
    button {
      background-color: var(--accent);
      color: white;
      border: none;
      border-radius: 10px;
      padding: 16px;
      font-size: 15px;
      cursor: pointer;
      transition: all 0.2s;
      text-align: left;
      font-weight: 500;
    }
    button:hover {
      background-color: #007aff;
      transform: translateY(-1px);
    }
    button:active {
      transform: translateY(0);
    }
    button:disabled {
      background-color: #3a3a3c;
      cursor: not-allowed;
      opacity: 0.6;
    }
    a.btn {
      display: block;
      background-color: var(--success);
      color: white;
      text-decoration: none;
      border-radius: 10px;
      padding: 16px;
      font-size: 16px;
      text-align: center;
      font-weight: bold;
      grid-column: span 2;
    }
    a.btn:hover {
      background-color: #28cd41;
    }
    code {
      background: #3a3a3c;
      padding: 3px 6px;
      border-radius: 4px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 13px;
      word-break: break-all;
      color: #ffb454;
    }
    .loading-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 100;
      backdrop-filter: blur(2px);
    }
    body.loading .loading-overlay {
      display: flex;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid rgba(255,255,255,0.1);
      border-left-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    #status-text {
      margin-left: 15px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="loading-overlay">
    <div class="spinner"></div>
    <div id="status-text">Processing...</div>
  </div>
  <div class="container">
    <header><h1 id="title">Loading...</h1></header>
    <div id="content" class="card">Please wait...</div>
    <div id="buttons" class="btn-grid"></div>
  </div>
  <script>
    const titleEl = document.getElementById('title');
    const contentEl = document.getElementById('content');
    const buttonsEl = document.getElementById('buttons');

    async function navigate(action) {
      document.body.classList.add('loading');
      try {
        const resp = await fetch('/api?data=' + encodeURIComponent(action));
        if (!resp.ok) {
           const err = await resp.json();
           render(err);
           return;
        }
        const data = await resp.json();
        render(data);
      } catch (e) {
        contentEl.innerHTML = "❌ Connection error. Please check your internet or try again later.";
      } finally {
        document.body.classList.remove('loading');
      }
    }

    function render(data) {
      titleEl.innerText = data.title || "Message";
      contentEl.innerHTML = data.text || "";
      buttonsEl.innerHTML = "";
      
      if (data.items) {
        data.items.forEach((item, index) => {
          if (item.url) {
            const a = document.createElement('a');
            a.href = item.url;
            a.className = "btn";
            a.target = "_blank";
            a.innerText = item.label;
            buttonsEl.appendChild(a);
          } else {
            const b = document.createElement('button');
            b.innerText = item.label;
            b.onclick = () => navigate(item.action);
            // Make "Back" and "Main Menu" buttons full width if they are alone or at the end
            if (item.label.includes('Back') || item.label.includes('Main menu')) {
               b.classList.add('full-width');
            }
            buttonsEl.appendChild(b);
          }
        });
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Initial load
    navigate('main');
  </script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("OK");
    if (url.pathname === "/testProxy") {
      try { return new Response("Proxy OK, len=" + (await fetchViaProxy(env, "https://www.microsoft.com/software-download/windows11", BH)).length); }
      catch (e) { return new Response("Proxy FAILED: " + String(e), { status: 500 }); }
    }
    if (url.pathname === "/clearCache") {
      const list = await env.CACHE.list();
      for (const key of list.keys) await env.CACHE.delete(key.name);
      return new Response("Deleted " + list.keys.length + " keys");
    }

    if (url.pathname === "/api") {
      try {
        const action = url.searchParams.get("data");
        const result = await handleAction(action, env);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ title: "Error", text: String(e), items: [BACK] }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
};

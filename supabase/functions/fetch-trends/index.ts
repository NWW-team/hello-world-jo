// fetch-trends — haalt publieke Google Trends RSS-feeds op en slaat ze op in Supabase.
// Deploy: supabase functions deploy fetch-trends

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { parse } from "https://deno.land/x/xml@2.1.3/mod.ts";

const DEFAULT_GEOS = ["NG", "VE"];
const FETCH_TIMEOUT_MS = 15_000;
const DELAY_BETWEEN_FEEDS_MS = 400;

const TRANSLATE_TARGET_LANG = "nl";
const TRANSLATE_TIMEOUT_MS = 8_000;
const TRANSLATE_CONCURRENCY = 4;
const TRANSLATE_DELAY_BETWEEN_CHUNKS_MS = 150;

const FEED_URLS = [
  (geo: string) => `https://trends.google.com/trending/rss?geo=${geo}`,
  (geo: string) => `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`,
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

type TrendRow = {
  country_code: string;
  keyword: string;
  keyword_nl: string | null;
  search_volume: number;
  traffic_label: string | null;
  news_title: string | null;
  news_title_nl: string | null;
  news_snippet: string | null;
  news_url: string | null;
  news_source: string | null;
  picture_url: string | null;
  trend_link: string | null;
  pub_date: string;
};

type FeedResult = {
  geo: string;
  ok: boolean;
  items?: number;
  stored?: number;
  source?: string;
  error?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node).trim();
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const key of ["#text", "#cdata", "$text", "$"]) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number") return String(value).trim();
    }
  }
  return "";
}

// RSS-namespaces verschillen per feedversie (ht:approx_traffic vs approx_traffic).
function fieldOf(node: Record<string, unknown> | undefined, name: string): unknown {
  if (!node) return undefined;
  if (name in node) return node[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(node)) {
    const normalised = key.replace(/^[@#$]/, "").split(":").pop()?.toLowerCase();
    if (normalised === wanted) return node[key];
  }
  return undefined;
}

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function cleanText(raw: string): string | null {
  const stripped = decodeEntities(raw).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > 0 ? stripped : null;
}

function cleanUrl(raw: string): string | null {
  const value = decodeEntities(raw).trim();
  return /^https?:\/\//i.test(value) ? value : null;
}

// "20,000+" -> 20000, "2.5K+" -> 2500, "1M+" -> 1000000
function parseApproxTraffic(raw: string): { volume: number; label: string | null } {
  const label = raw.trim();
  if (!label) return { volume: 0, label: null };

  let value = label.replace(/\+/g, "").replace(/\s/g, "");
  const suffix = value.match(/([kmb])$/i)?.[1].toLowerCase() ?? "";
  if (suffix) value = value.slice(0, -1);

  value = /^\d{1,3}([.,]\d{3})+$/.test(value) ? value.replace(/[.,]/g, "") : value.replace(/,/g, "");

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return { volume: 0, label };

  const factor = suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : 1;
  return { volume: Math.round(parsed * factor), label };
}

// Zonder geldige pubDate valt de sleutel terug op vandaag, zodat upserts stabiel blijven.
function parsePubDate(raw: string): string {
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
}

function normaliseGeo(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["nl"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// -------------------------------------------------------------------- vertaling
//
// Vertaalt keyword/nieuwstitel naar het Nederlands zodat het dashboard geen
// Russische, Spaanse, ... brontekst hoeft te tonen. Best-effort: een mislukte of
// overgeslagen vertaling laat het _nl-veld gewoon leeg (de UI valt dan terug op
// de brontekst) en breekt de ingest van trends nooit.
//
// Standaard wordt het gratis, key-loze Google Translate-endpoint gebruikt (geen
// setup nodig, geen SLA). Zet de edge function secret DEEPL_API_KEY om in plaats
// daarvan de officiële DeepL-API te gebruiken (betrouwbaarder, hogere volumes).

async function translateText(text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const deeplKey = Deno.env.get("DEEPL_API_KEY");
    return deeplKey ? await translateWithDeepL(trimmed, deeplKey) : await translateWithGoogleFree(trimmed);
  } catch {
    return null;
  }
}

async function translateWithDeepL(text: string, apiKey: string): Promise<string | null> {
  const response = await fetch("https://api-free.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      "Authorization": `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ text, target_lang: TRANSLATE_TARGET_LANG.toUpperCase() }),
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const body = await response.json();
  const translated = body?.translations?.[0]?.text;
  return typeof translated === "string" && translated.trim() ? translated.trim() : null;
}

async function translateWithGoogleFree(text: string): Promise<string | null> {
  const url = `https://translate.googleapis.com/translate_a/single`
    + `?client=gtx&sl=auto&tl=${TRANSLATE_TARGET_LANG}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS) });
  if (!response.ok) return null;

  const body = await response.json();
  const segments = Array.isArray(body?.[0]) ? body[0] : [];
  const translated = segments
    .map((segment: unknown) => (Array.isArray(segment) ? String(segment[0] ?? "") : ""))
    .join("")
    .trim();
  return translated || null;
}

// Vertaalt een lijst teksten met beperkte gelijktijdigheid, zodat het endpoint niet
// in één klap wordt platgebeld bij landen met veel trending keywords tegelijk.
async function translateBatch(texts: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(texts.map((text) => text.trim()).filter((text) => text.length > 0))];
  const results = new Map<string, string>();

  for (let i = 0; i < unique.length; i += TRANSLATE_CONCURRENCY) {
    const chunk = unique.slice(i, i + TRANSLATE_CONCURRENCY);
    const translations = await Promise.all(chunk.map((text) => translateText(text)));
    chunk.forEach((text, index) => {
      const translated = translations[index];
      if (translated) results.set(text, translated);
    });
    if (i + TRANSLATE_CONCURRENCY < unique.length) await sleep(TRANSLATE_DELAY_BETWEEN_CHUNKS_MS);
  }

  return results;
}

// Keywords die voor dit land al eerder vertaald zijn, worden hergebruikt in
// plaats van opnieuw naar de vertaalservice te sturen (een trending keyword
// duikt vaak dagen achter elkaar opnieuw op).
async function fetchKeywordTranslationCache(
  supabase: SupabaseClient,
  geo: string,
  keywords: string[],
): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  if (keywords.length === 0) return cache;

  const { data, error } = await supabase
    .from("trends")
    .select("keyword, keyword_nl")
    .eq("country_code", geo)
    .in("keyword", [...new Set(keywords)])
    .not("keyword_nl", "is", null);

  if (error) return cache; // cache is best-effort; ingest mag hier nooit op stuklopen
  for (const row of data ?? []) {
    if (row.keyword_nl) cache.set(row.keyword, row.keyword_nl);
  }
  return cache;
}

// Vult keyword_nl/news_title_nl op de rijen in-place. Titels verschillen doorgaans
// per artikel en worden dus altijd opnieuw vertaald; keywords worden hergebruikt
// waar mogelijk (zie fetchKeywordTranslationCache).
async function attachTranslations(supabase: SupabaseClient, geo: string, rows: TrendRow[]): Promise<void> {
  const keywordCache = await fetchKeywordTranslationCache(supabase, geo, rows.map((row) => row.keyword));
  const keywordsToTranslate = rows.map((row) => row.keyword).filter((keyword) => !keywordCache.has(keyword));
  const titlesToTranslate = rows
    .map((row) => row.news_title)
    .filter((title): title is string => Boolean(title));

  const [translatedKeywords, translatedTitles] = await Promise.all([
    translateBatch(keywordsToTranslate),
    translateBatch(titlesToTranslate),
  ]);

  for (const row of rows) {
    row.keyword_nl = keywordCache.get(row.keyword) ?? translatedKeywords.get(row.keyword) ?? null;
    row.news_title_nl = row.news_title ? translatedTitles.get(row.news_title) ?? null : null;
  }
}

async function fetchFeed(geo: string): Promise<{ xml: string; source: string }> {
  let lastError = "";

  for (const buildUrl of FEED_URLS) {
    const url = buildUrl(geo);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; BZ-EarlyWarning/1.0)",
          "Accept": "application/rss+xml, application/xml, text/xml",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        lastError = `${url} gaf HTTP ${response.status}`;
        continue;
      }

      const xml = await response.text();
      if (!xml.includes("<item")) {
        lastError = `${url} bevatte geen RSS-items`;
        continue;
      }

      return { xml, source: url };
    } catch (error) {
      lastError = `${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  throw new Error(lastError || `Geen feed beschikbaar voor ${geo}`);
}

function extractItems(xml: string): Record<string, unknown>[] {
  const document = parse(xml) as Record<string, unknown>;
  const rss = fieldOf(document, "rss") as Record<string, unknown> | undefined;
  const channel = fieldOf(rss, "channel") as Record<string, unknown> | undefined;
  return toArray(fieldOf(channel, "item")) as Record<string, unknown>[];
}

function toRow(geo: string, item: Record<string, unknown>): TrendRow | null {
  const keyword = cleanText(textOf(fieldOf(item, "title")));
  if (!keyword) return null;

  const traffic = parseApproxTraffic(textOf(fieldOf(item, "approx_traffic")));
  const news = toArray(fieldOf(item, "news_item"))[0] as Record<string, unknown> | undefined;

  return {
    country_code: geo,
    keyword,
    keyword_nl: null,
    search_volume: traffic.volume,
    traffic_label: traffic.label,
    news_title: news ? cleanText(textOf(fieldOf(news, "news_item_title"))) : null,
    news_title_nl: null,
    news_snippet: news ? cleanText(textOf(fieldOf(news, "news_item_snippet"))) : null,
    news_url: news ? cleanUrl(textOf(fieldOf(news, "news_item_url"))) : null,
    news_source: news ? cleanText(textOf(fieldOf(news, "news_item_source"))) : null,
    picture_url: cleanUrl(textOf(fieldOf(item, "picture"))),
    trend_link: cleanUrl(textOf(fieldOf(item, "link"))),
    pub_date: parsePubDate(textOf(fieldOf(item, "pubDate"))),
  };
}

async function resolveGeos(req: Request, supabase: SupabaseClient): Promise<string[]> {
  const requested: unknown[] = [];

  const queryGeo = new URL(req.url).searchParams.get("geo");
  if (queryGeo) requested.push(...queryGeo.split(","));

  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    if (body && Array.isArray(body.countries)) requested.push(...body.countries);
  }

  const explicit = requested.map(normaliseGeo).filter((code): code is string => code !== null);
  if (explicit.length > 0) return [...new Set(explicit)];

  const { data } = await supabase
    .from("monitored_countries")
    .select("code")
    .eq("enabled", true)
    .order("code");

  const fromDatabase = (data ?? [])
    .map((row) => normaliseGeo(row.code))
    .filter((code): code is string => code !== null);

  return fromDatabase.length > 0 ? fromDatabase : DEFAULT_GEOS;
}

async function ensureCountry(supabase: SupabaseClient, geo: string): Promise<void> {
  const { error } = await supabase
    .from("monitored_countries")
    .upsert({ code: geo, name: countryName(geo) }, { onConflict: "code", ignoreDuplicates: true });
  if (error) throw new Error(`Land ${geo} kon niet worden vastgelegd: ${error.message}`);
}

// De anon-sleutel is zelf een geldig JWT, dus een ingelogde gebruiker is vereist.
// De service role blijft toegestaan: dat is de route die pg_cron gebruikt.
async function callerIsAllowed(req: Request, supabaseUrl: string, serviceRoleKey: string): Promise<boolean> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (token === serviceRoleKey) return true;

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!anonKey) return false;

  const scoped = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await scoped.auth.getUser();
  return !error && Boolean(data.user);
}

async function ingestCountry(supabase: SupabaseClient, geo: string): Promise<FeedResult> {
  const { xml, source } = await fetchFeed(geo);
  const items = extractItems(xml);
  const rows = items
    .map((item) => toRow(geo, item))
    .filter((row): row is TrendRow => row !== null);

  await ensureCountry(supabase, geo);

  // Nederlandse trends hoeven niet vertaald te worden.
  if (rows.length > 0 && geo !== "NL") {
    await attachTranslations(supabase, geo, rows);
  }

  if (rows.length > 0) {
    const { error } = await supabase
      .from("trends")
      .upsert(rows, { onConflict: "country_code,keyword,pub_date" });
    if (error) throw new Error(`Opslaan mislukt: ${error.message}`);
  }

  return { geo, ok: true, items: items.length, stored: rows.length, source };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const jsonResponse = (body: unknown, status: number) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "SUPABASE_URL of SUPABASE_SERVICE_ROLE_KEY ontbreekt" }, 500);
  }

  if (!await callerIsAllowed(req, supabaseUrl, serviceRoleKey)) {
    return jsonResponse({ error: "Niet geautoriseerd" }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const geos = await resolveGeos(req, supabase);
  const results: FeedResult[] = [];

  for (const [index, geo] of geos.entries()) {
    try {
      results.push(await ingestCountry(supabase, geo));
    } catch (error) {
      results.push({ geo, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    if (index < geos.length - 1) await sleep(DELAY_BETWEEN_FEEDS_MS);
  }

  const succeeded = results.filter((result) => result.ok);
  const stored = succeeded.reduce((total, result) => total + (result.stored ?? 0), 0);

  return jsonResponse(
    {
      run_at: new Date().toISOString(),
      countries_requested: geos.length,
      countries_succeeded: succeeded.length,
      trends_stored: stored,
      results,
    },
    succeeded.length === 0 ? 502 : 200,
  );
});

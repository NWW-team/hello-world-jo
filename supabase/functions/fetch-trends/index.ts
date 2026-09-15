// fetch-trends — haalt publieke Google Trends RSS-feeds op en slaat ze op in Supabase.
// Deploy: supabase functions deploy fetch-trends

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { parse } from "https://deno.land/x/xml@2.1.3/mod.ts";

const DEFAULT_GEOS = ["NG", "VE"];
const FETCH_TIMEOUT_MS = 15_000;
const DELAY_BETWEEN_FEEDS_MS = 400;

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
  search_volume: number;
  traffic_label: string | null;
  news_title: string | null;
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
    search_volume: traffic.volume,
    traffic_label: traffic.label,
    news_title: news ? cleanText(textOf(fieldOf(news, "news_item_title"))) : null,
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

async function ingestCountry(supabase: SupabaseClient, geo: string): Promise<FeedResult> {
  const { xml, source } = await fetchFeed(geo);
  const items = extractItems(xml);
  const rows = items
    .map((item) => toRow(geo, item))
    .filter((row): row is TrendRow => row !== null);

  await ensureCountry(supabase, geo);

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

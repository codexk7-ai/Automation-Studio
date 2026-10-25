import { toText } from "@automation-studio/core";
import type { AppContext } from "../context.ts";
import { StepError } from "../errors.ts";
import { safeRequest } from "../security/ssrf.ts";
import { apiCall } from "./http.ts";
import type { IntegrationModule, LoadedCredential, NodeImplementation, StepContext } from "./types.ts";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const YT = "https://www.googleapis.com/youtube/v3";

/** Auth for Google APIs: OAuth bearer token, or API key for public read-only YouTube data. */
function googleAuth(cred: LoadedCredential | undefined, needsOAuth: boolean): { headers: Record<string, string>; query: Record<string, string> } {
  if (!cred) throw new StepError("config", "Connect a Google account first.");
  if (cred.data.access_token) return { headers: { authorization: `Bearer ${toText(cred.data.access_token)}` }, query: {} };
  if (needsOAuth) throw new StepError("config", "This action needs a Google account connected with OAuth (an API key only allows public read-only data).");
  if (cred.data.apiKey) return { headers: {}, query: { key: toText(cred.data.apiKey) } };
  throw new StepError("config", "The Google connection has neither OAuth tokens nor an API key.");
}

async function google<T>(ctx: StepContext, method: string, url: string, opts: { needsOAuth?: boolean; query?: Record<string, unknown>; json?: unknown } = {}): Promise<T> {
  const auth = googleAuth(ctx.credential, opts.needsOAuth ?? true);
  const res = await apiCall<T>(ctx.app, { method, url, headers: auth.headers, query: { ...(opts.query ?? {}), ...auth.query }, json: opts.json, signal: ctx.signal, provider: "Google" });
  return res.data;
}

function sheetRange(sheet: unknown, range = ""): string {
  const name = toText(sheet) || "Sheet1";
  return encodeURIComponent(`'${name.replace(/'/g, "''")}'${range ? `!${range}` : ""}`);
}

function spreadsheetId(v: unknown): string {
  const s = toText(v).trim();
  const fromUrl = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(s)?.[1];
  const id = fromUrl ?? s;
  if (!/^[a-zA-Z0-9-_]{10,100}$/.test(id)) throw new StepError("config", "Spreadsheet ID (or URL) is invalid.");
  return id;
}

// ---------------------------------------------------------------------------
// Sheets

const appendRow: NodeImplementation = {
  type: "sheets.append_row",
  integration: "google",
  kind: "action",
  name: "Google Sheets: add row",
  description: "Append a row; values are matched to the sheet's header row by column name.",
  credentialType: "google",
  credentialRequired: true,
  sideEffects: "external",
  fields: [
    { key: "spreadsheetId", label: "Spreadsheet ID or URL", type: "string", required: true },
    { key: "sheet", label: "Sheet (tab) name", type: "string", default: "Sheet1" },
    { key: "values", label: "Values by column header", type: "keyvalue", required: true, default: { Name: "{{ trigger.body.name }}", Email: "{{ trigger.body.email }}" } },
    {
      key: "valueInputOption",
      label: "Value handling",
      type: "select",
      default: "RAW",
      options: [
        { value: "RAW", label: "Store exactly as given (safe)" },
        { value: "USER_ENTERED", label: "Parse like typed input (formulas, dates)" },
      ],
    },
  ],
  sampleOutput: { updatedRange: "Sheet1!A5:C5", updatedRows: 1, _mock: false },
  mode: "live",
  async execute(ctx) {
    const id = spreadsheetId(ctx.config.spreadsheetId);
    const header = await google<{ values?: string[][] }>(ctx, "GET", `${SHEETS}/${id}/values/${sheetRange(ctx.config.sheet, "1:1")}`);
    const headers = header.values?.[0] ?? [];
    if (!headers.length) throw new StepError("config", "The sheet has no header row (row 1).");
    const values = (ctx.config.values as Record<string, unknown>) ?? {};
    const known = new Map(headers.map((h, i) => [h.trim().toLowerCase(), i]));
    const unknown = Object.keys(values).filter((k) => !known.has(k.trim().toLowerCase()));
    if (unknown.length) throw new StepError("config", `Columns not found in the header row: ${unknown.join(", ")}`);
    const row: string[] = headers.map(() => "");
    for (const [k, v] of Object.entries(values)) row[known.get(k.trim().toLowerCase())!] = toText(v);
    const res = await google<{ updates?: { updatedRange?: string; updatedRows?: number } }>(ctx, "POST", `${SHEETS}/${id}/values/${sheetRange(ctx.config.sheet, "A1")}:append`, {
      query: { valueInputOption: ctx.config.valueInputOption === "USER_ENTERED" ? "USER_ENTERED" : "RAW", insertDataOption: "INSERT_ROWS" },
      json: { values: [row] },
    });
    return { output: { updatedRange: res.updates?.updatedRange, updatedRows: res.updates?.updatedRows ?? 1 } };
  },
  async mock(ctx) {
    return { output: { updatedRange: `${toText(ctx.config.sheet) || "Sheet1"}!A2:Z2`, updatedRows: 1, values: ctx.config.values, _mock: true } };
  },
};

const readRows: NodeImplementation = {
  type: "sheets.read_rows",
  integration: "google",
  kind: "action",
  name: "Google Sheets: read rows",
  description: "Read rows as objects keyed by the header row.",
  credentialType: "google",
  credentialRequired: true,
  fields: [
    { key: "spreadsheetId", label: "Spreadsheet ID or URL", type: "string", required: true },
    { key: "sheet", label: "Sheet (tab) name", type: "string", default: "Sheet1" },
    { key: "maxRows", label: "Maximum rows", type: "number", default: 500, min: 1, max: 10000 },
  ],
  sampleOutput: { count: 1, rows: [{ Name: "Ada", Email: "ada@example.com" }] },
  mode: "live",
  testable: true,
  async execute(ctx) {
    const id = spreadsheetId(ctx.config.spreadsheetId);
    const max = Math.min(10000, Number(ctx.config.maxRows) || 500);
    const res = await google<{ values?: string[][] }>(ctx, "GET", `${SHEETS}/${id}/values/${sheetRange(ctx.config.sheet, `A1:ZZ${max + 1}`)}`);
    const [headers = [], ...rest] = res.values ?? [];
    const rows = rest.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
    return { output: { count: rows.length, headers, rows } };
  },
  async mock() {
    return { output: { count: 2, headers: ["Name", "Email"], rows: [{ Name: "Ada Lovelace", Email: "ada@example.com" }, { Name: "Alan Turing", Email: "alan@example.com" }], _mock: true } };
  },
};

// ---------------------------------------------------------------------------
// YouTube Data API v3 (quota: 10,000 units/day by default; list calls ≈1 unit, updates ≈50 units)

interface YtVideo {
  id: string;
  snippet?: Record<string, unknown>;
  statistics?: Record<string, unknown>;
  contentDetails?: Record<string, unknown>;
}

function videoId(v: unknown): string {
  const s = toText(v).trim();
  const id = /(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/.exec(s)?.[1] ?? s;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new StepError("config", "Video ID (or URL) is invalid.");
  return id;
}

async function uploadsPlaylist(ctx: { app: AppContext; credential?: LoadedCredential; signal: AbortSignal }, channelId: string): Promise<string> {
  const auth = googleAuth(ctx.credential, false);
  const query: Record<string, unknown> = { part: "contentDetails", ...auth.query };
  if (channelId === "mine") query.mine = "true";
  else query.id = channelId;
  const res = await apiCall<{ items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(ctx.app, { url: `${YT}/channels`, headers: auth.headers, query, signal: ctx.signal, provider: "YouTube" });
  const id = res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!id) throw new StepError("config", "Channel not found (use a channel ID like UC…, or 'mine' with OAuth).");
  return id;
}

async function latestUploads(ctx: { app: AppContext; credential?: LoadedCredential; signal: AbortSignal }, channelId: string, max: number) {
  const playlistId = await uploadsPlaylist(ctx, channelId);
  const auth = googleAuth(ctx.credential, false);
  const res = await apiCall<{ items?: Array<{ snippet?: Record<string, unknown>; contentDetails?: { videoId?: string; videoPublishedAt?: string } }> }>(ctx.app, {
    url: `${YT}/playlistItems`,
    headers: auth.headers,
    query: { part: "snippet,contentDetails", playlistId, maxResults: Math.min(50, max), ...auth.query },
    signal: ctx.signal,
    provider: "YouTube",
  });
  return (res.data.items ?? []).map((i) => ({
    videoId: i.contentDetails?.videoId,
    title: i.snippet?.title,
    description: i.snippet?.description,
    publishedAt: i.contentDetails?.videoPublishedAt ?? i.snippet?.publishedAt,
    url: `https://www.youtube.com/watch?v=${i.contentDetails?.videoId}`,
  }));
}

const getVideo: NodeImplementation = {
  type: "youtube.get_video",
  integration: "google",
  kind: "action",
  name: "YouTube: get video details",
  description: "Title, description, tags, statistics and duration of a video (API key or OAuth).",
  credentialType: "google",
  credentialRequired: true,
  fields: [{ key: "videoId", label: "Video ID or URL", type: "string", required: true }],
  sampleOutput: { id: "dQw4w9WgXcQ", title: "Video title", description: "…", tags: [], viewCount: 100, durationIso: "PT3M33S" },
  mode: "live",
  testable: true,
  async execute(ctx) {
    const id = videoId(ctx.config.videoId);
    const res = await google<{ items?: YtVideo[] }>(ctx, "GET", `${YT}/videos`, { needsOAuth: false, query: { part: "snippet,statistics,contentDetails", id } });
    const v = res.items?.[0];
    if (!v) throw new StepError("permanent", "Video not found or not accessible.");
    return {
      output: {
        id: v.id,
        title: v.snippet?.title,
        description: v.snippet?.description,
        tags: v.snippet?.tags ?? [],
        channelId: v.snippet?.channelId,
        channelTitle: v.snippet?.channelTitle,
        publishedAt: v.snippet?.publishedAt,
        categoryId: v.snippet?.categoryId,
        viewCount: Number(v.statistics?.viewCount ?? 0),
        likeCount: Number(v.statistics?.likeCount ?? 0),
        commentCount: Number(v.statistics?.commentCount ?? 0),
        durationIso: v.contentDetails?.duration,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      },
    };
  },
  async mock(ctx) {
    return { output: { id: toText(ctx.config.videoId).slice(-11), title: "Sample video (mock)", description: "Mock description for testing.", tags: ["automation"], viewCount: 1234, _mock: true } };
  },
};

const listVideos: NodeImplementation = {
  type: "youtube.list_channel_videos",
  integration: "google",
  kind: "action",
  name: "YouTube: list channel uploads",
  description: "Latest uploads of a channel (uses the uploads playlist: ~1 quota unit per call instead of 100 for search).",
  credentialType: "google",
  credentialRequired: true,
  fields: [
    { key: "channelId", label: "Channel ID (UC…) or 'mine'", type: "string", required: true },
    { key: "maxResults", label: "Max videos", type: "number", default: 10, min: 1, max: 50 },
  ],
  sampleOutput: { count: 1, videos: [{ videoId: "abc123def45", title: "Title", publishedAt: "2026-01-01T00:00:00Z" }] },
  mode: "live",
  testable: true,
  async execute(ctx) {
    const videos = await latestUploads(ctx, toText(ctx.config.channelId), Number(ctx.config.maxResults) || 10);
    return { output: { count: videos.length, videos } };
  },
  async mock() {
    return { output: { count: 1, videos: [{ videoId: "mockVideo01", title: "Mock upload", publishedAt: new Date().toISOString(), url: "https://www.youtube.com/watch?v=mockVideo01" }], _mock: true } };
  },
};

const updateVideo: NodeImplementation = {
  type: "youtube.update_video",
  integration: "google",
  kind: "action",
  name: "YouTube: update title/description/tags",
  description: "Update metadata of a video you own (OAuth, ~50 quota units). Leave a field empty to keep the current value.",
  credentialType: "google",
  credentialRequired: true,
  sideEffects: "external",
  fields: [
    { key: "videoId", label: "Video ID or URL", type: "string", required: true },
    { key: "title", label: "New title", type: "string", description: "Max 100 characters." },
    { key: "description", label: "New description", type: "text", description: "Max 5000 bytes." },
    { key: "tags", label: "Tags", type: "string_list" },
  ],
  sampleOutput: { id: "abc123def45", title: "New title", updated: true },
  mode: "live",
  async execute(ctx) {
    const id = videoId(ctx.config.videoId);
    const current = await google<{ items?: YtVideo[] }>(ctx, "GET", `${YT}/videos`, { query: { part: "snippet", id } });
    const snippet = current.items?.[0]?.snippet;
    if (!snippet) throw new StepError("permanent", "Video not found, or the connected account does not own it.");
    const title = toText(ctx.config.title) || toText(snippet.title);
    if (title.length > 100) throw new StepError("config", "YouTube titles are limited to 100 characters.");
    const description = ctx.config.description ? toText(ctx.config.description) : toText(snippet.description);
    if (Buffer.byteLength(description) > 5000) throw new StepError("config", "YouTube descriptions are limited to 5000 bytes.");
    const tags = Array.isArray(ctx.config.tags) && ctx.config.tags.length ? (ctx.config.tags as unknown[]).map(toText) : (snippet.tags as string[] | undefined);
    const res = await google<YtVideo>(ctx, "PUT", `${YT}/videos`, { query: { part: "snippet" }, json: { id, snippet: { title, description, tags, categoryId: snippet.categoryId, defaultLanguage: snippet.defaultLanguage } } });
    return { output: { id: res.id, title: res.snippet?.title, updated: true } };
  },
  async mock(ctx) {
    return { output: { id: toText(ctx.config.videoId), title: toText(ctx.config.title), updated: false, _mock: true } };
  },
};

const captions: NodeImplementation = {
  type: "youtube.get_captions",
  integration: "google",
  kind: "action",
  name: "YouTube: download captions (own videos)",
  description: "Download a caption track as plain text. The API only allows this for videos the connected account can edit.",
  credentialType: "google",
  credentialRequired: true,
  fields: [
    { key: "videoId", label: "Video ID or URL", type: "string", required: true },
    { key: "language", label: "Preferred language", type: "string", default: "en" },
  ],
  sampleOutput: { language: "en", text: "Transcript text…", trackId: "abc" },
  mode: "live",
  async execute(ctx) {
    const id = videoId(ctx.config.videoId);
    const list = await google<{ items?: Array<{ id: string; snippet?: { language?: string; trackKind?: string } }> }>(ctx, "GET", `${YT}/captions`, { query: { part: "snippet", videoId: id } });
    const tracks = list.items ?? [];
    if (!tracks.length) throw new StepError("permanent", "No caption tracks available for this video.");
    const lang = toText(ctx.config.language).toLowerCase();
    const track = tracks.find((t) => t.snippet?.language?.toLowerCase() === lang && t.snippet?.trackKind !== "asr") ?? tracks.find((t) => t.snippet?.language?.toLowerCase() === lang) ?? tracks[0]!;
    const auth = googleAuth(ctx.credential, true);
    const res = await safeRequest(ctx.app.fetch, `${YT}/captions/${encodeURIComponent(track.id)}?tfmt=srt`, { headers: auth.headers, signal: ctx.signal, maxBytes: 5_000_000 });
    if (res.status === 403) throw new StepError("auth", "YouTube only allows caption downloads for videos the connected account can edit.");
    if (res.status >= 400) throw new StepError(res.status >= 500 ? "transient" : "permanent", `YouTube captions: HTTP ${res.status}`);
    const text = res.body
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l))
      .join(" ");
    return { output: { language: track.snippet?.language, trackId: track.id, text } };
  },
  async mock() {
    return { output: { language: "en", trackId: "mock", text: "This is a mock transcript used for testing summarization workflows.", _mock: true } };
  },
};

const newVideoTrigger: NodeImplementation = {
  type: "trigger.youtube_new_video",
  integration: "google",
  kind: "trigger",
  name: "YouTube: new video on channel",
  description: "Polls a channel's uploads and starts one execution per new video.",
  credentialType: "google",
  credentialRequired: true,
  fields: [
    { key: "channelId", label: "Channel ID (UC…) or 'mine'", type: "string", required: true, allowExpressions: false },
    { key: "pollMinutes", label: "Check every (minutes)", type: "number", default: 30, min: 5, max: 1440, allowExpressions: false },
  ],
  sampleOutput: { videoId: "abc123def45", title: "New upload", description: "…", publishedAt: "2026-01-01T00:00:00Z", url: "https://www.youtube.com/watch?v=abc123def45" },
  mode: "live",
  execute: async (ctx) => ({ output: ctx.scope.trigger }),
  async poll(ctx) {
    const videos = await latestUploads(ctx, toText(ctx.config.channelId), 15);
    const seen = new Set((ctx.state.seen as string[]) ?? []);
    const first = !ctx.state.initialized;
    const items = videos.filter((v) => v.videoId && !seen.has(v.videoId)).map((v) => ({ data: v, dedupeKey: v.videoId! }));
    for (const v of videos) if (v.videoId) seen.add(v.videoId);
    return { items: first ? [] : items.reverse(), state: { initialized: true, seen: [...seen].slice(-500) } };
  },
};

export async function refreshGoogleToken(data: Record<string, unknown>, app: AppContext): Promise<Record<string, unknown> | null> {
  if (!data.refresh_token) return null;
  if (!app.config.google) throw new StepError("config", "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not configured on the server.");
  const res = await safeRequest(app.fetch, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: toText(data.refresh_token), client_id: app.config.google.clientId, client_secret: app.config.google.clientSecret }).toString(),
  });
  const body = JSON.parse(res.body.toString("utf8") || "{}");
  if (res.status >= 400) throw new StepError("auth", `Google token refresh failed: ${toText(body.error_description ?? body.error)}. Reconnect the account.`);
  return { ...data, access_token: body.access_token, expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000, scope: body.scope ?? data.scope };
}

export const googleIntegration: IntegrationModule = {
  definition: {
    id: "google",
    name: "Google (Sheets & YouTube)",
    description: "Google Sheets rows and YouTube Data API v3 through official OAuth 2.0 or an API key.",
    category: "Productivity",
    version: "1.0.0",
    icon: "sheet",
    credentialTypes: ["google"],
    docsUrl: "https://developers.google.com/youtube/v3",
    prerequisites: [
      "A Google Cloud project with the Sheets API and/or YouTube Data API v3 enabled.",
      "For OAuth: an OAuth client (Web application) with redirect URI <PUBLIC_URL>/api/oauth/google/callback; set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server.",
      "Unverified OAuth apps are limited to test users; sensitive scopes may require Google verification.",
      "YouTube quota: 10,000 units/day by default; uploads/updates cost more units. Higher quota requires an audit.",
    ],
    availability: "live+mock",
    scopes: GOOGLE_SCOPES,
    rateLimits: "Sheets: 60 read & 60 write requests/minute/user by default. YouTube: daily unit quota.",
  },
  nodes: [appendRow, readRows, getVideo, listVideos, updateVideo, captions, newVideoTrigger],
  credentialTypes: [
    {
      id: "google",
      name: "Google account",
      description: "Connect with OAuth (Sheets, YouTube management) or paste an API key (public YouTube data only).",
      fields: [{ key: "apiKey", label: "API key (public YouTube data only)", type: "string", sensitive: true }],
      oauth2: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: GOOGLE_SCOPES,
        extraParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
      },
      refresh: refreshGoogleToken,
      describe: (d) => ({ authMode: d.access_token ? "oauth" : "api_key", account: d.email ?? undefined }),
      async test(data, app) {
        const cred = { id: "test", name: "test", type: "google", data };
        const auth = googleAuth(cred, false);
        if (data.access_token) {
          await apiCall(app, { url: "https://www.googleapis.com/oauth2/v3/userinfo", headers: auth.headers, provider: "Google" });
          return { ok: true, message: "OAuth token is valid." };
        }
        await apiCall(app, { url: `${YT}/videos`, query: { part: "id", id: "dQw4w9WgXcQ", ...auth.query }, provider: "YouTube" });
        return { ok: true, message: "API key accepted by the YouTube Data API." };
      },
    },
  ],
};

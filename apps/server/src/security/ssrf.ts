import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";

/**
 * Outbound network policy for every user-configurable URL (HTTP actions,
 * webhooks callbacks, MCP servers, AI base URLs, polling triggers).
 *
 * - Only http/https.
 * - Every resolved IP is checked *at connect time* through a custom DNS
 *   lookup, so DNS rebinding between validation and connection is not
 *   possible: the socket connects only to the address we validated.
 * - Loopback, private, link-local (incl. cloud metadata 169.254.169.254),
 *   CGNAT, multicast, reserved and IPv6 ULA ranges are refused.
 * - Redirects are followed manually and every hop is revalidated.
 * - `host:port` pairs in the allowlist (e.g. a local Ollama) are exempt.
 */
export class OutboundPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundPolicyError";
  }
}

export interface NetworkPolicy {
  allowlist: string[];
  /** Development escape hatch; never enable in production. */
  allowPrivate?: boolean;
}

const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata", "metadata.azure.internal", "instance-data"]);

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === "unicast";
}

function hostKey(url: URL): string {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.replace(/^\[|\]$/g, "").toLowerCase()}:${port}`;
}

export function isAllowlisted(url: URL, policy: NetworkPolicy): boolean {
  return policy.allowlist.includes(hostKey(url));
}

/** Synchronous checks that do not need DNS. */
export function assertUrlAllowed(raw: string, policy: NetworkPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundPolicyError(`Invalid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new OutboundPolicyError(`Only http and https URLs are allowed (got ${url.protocol}).`);
  if (url.username || url.password) throw new OutboundPolicyError("Credentials embedded in URLs are not allowed; use a connection instead.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isAllowlisted(url, policy) || policy.allowPrivate) return url;
  if (METADATA_HOSTNAMES.has(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new OutboundPolicyError(`Requests to ${host} are blocked by the outbound network policy.`);
  }
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new OutboundPolicyError(`Requests to private or reserved address ${host} are blocked.`);
  return url;
}

function guardedLookup(url: URL, policy: NetworkPolicy): LookupFunction {
  const exempt = isAllowlisted(url, policy) || policy.allowPrivate === true;
  return ((hostname: string, options: { all?: boolean; family?: number }, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { all: true, family: options?.family as 0 | 4 | 6 | undefined }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as LookupAddress[];
      const allowed = exempt ? list : list.filter((a) => isPublicAddress(a.address));
      if (allowed.length === 0) {
        return callback(new OutboundPolicyError(`${hostname} resolves to a private or reserved address; blocked by the outbound network policy.`), "", 0);
      }
      if (options?.all) return callback(null, allowed);
      return callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  }) as unknown as LookupFunction;
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string> | Headers | [string, string][];
  body?: string | Uint8Array | null;
  signal?: AbortSignal | null;
  timeoutMs?: number;
  maxRedirects?: number;
  followRedirects?: boolean;
}

function headersToRecord(h: SafeFetchInit["headers"]): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h };
}

/**
 * fetch-compatible client enforcing the outbound policy. The response body
 * streams (works for SSE). Use `safeRequest` for buffered, size-capped reads.
 */
export function createSafeFetch(policy: NetworkPolicy) {
  return async function safeFetch(input: string | URL | Request, init: SafeFetchInit & Omit<RequestInit, "body" | "headers" | "signal"> = {}): Promise<Response> {
    const startUrl = input instanceof Request ? input.url : String(input);
    let method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let headers = headersToRecord(init.headers as SafeFetchInit["headers"]);
    let body: string | Uint8Array | null | undefined = init.body as string | Uint8Array | null | undefined;
    if (input instanceof Request && body === undefined && method !== "GET" && method !== "HEAD") body = new Uint8Array(await input.arrayBuffer());
    const maxRedirects = init.followRedirects === false ? 0 : (init.maxRedirects ?? 5);
    const timeoutMs = init.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new OutboundPolicyError(`Request timed out after ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onAbort, { once: true });

    let url = assertUrlAllowed(startUrl, policy);
    try {
      for (let hop = 0; ; hop++) {
        const res = await requestOnce(url, method, headers, body, controller.signal, policy);
        const location = res.headers.location;
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && location && hop < maxRedirects) {
          res.resume();
          const next = assertUrlAllowed(new URL(location, url).toString(), policy);
          if (next.origin !== url.origin) {
            // Never forward credentials to a different origin.
            headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization|x-api-key)$/i.test(k)));
          }
          if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
          }
          url = next;
          continue;
        }
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => responseHeaders.append(k, x));
          else if (v !== undefined) responseHeaders.set(k, String(v));
        }
        const status = res.statusCode ?? 0;
        const nullBody = method === "HEAD" || status === 204 || status === 304;
        res.on("end", () => clearTimeout(timer));
        res.on("error", () => clearTimeout(timer));
        if (nullBody) {
          res.resume();
          clearTimeout(timer);
        }
        const response = new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
          status: status < 200 || status > 599 ? 502 : status,
          statusText: res.statusMessage,
          headers: responseHeaders,
        });
        Object.defineProperty(response, "url", { value: url.toString() });
        return response;
      }
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw err;
    } finally {
      init.signal?.removeEventListener("abort", onAbort);
    }
  };
}

function requestOnce(url: URL, method: string, headers: Record<string, string>, body: string | Uint8Array | null | undefined, signal: AbortSignal, policy: NetworkPolicy): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method,
        headers: { "user-agent": "AutomationStudio/0.1", ...headers },
        lookup: guardedLookup(url, policy),
        signal,
      },
      resolve,
    );
    req.on("error", reject);
    if (body !== undefined && body !== null && method !== "GET" && method !== "HEAD") req.write(body);
    req.end();
  });
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
  truncated: boolean;
}

/** Buffered request with a response size cap. */
export async function safeRequest(
  fetcher: ReturnType<typeof createSafeFetch>,
  url: string,
  init: SafeFetchInit & { maxBytes?: number } = {},
): Promise<SafeResponse> {
  const res = await fetcher(url, init);
  const maxBytes = init.maxBytes ?? 5 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.concat(chunks), url: res.url, truncated };
}

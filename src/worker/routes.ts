import { appendDomain } from "../shared/constants";
import type { Env } from "./env";
import { json, err } from "./http";
import {
  handleCreateIdentity,
  handleListIdentities,
  handleGetIdentity,
  handleDeleteIdentity,
} from "./identities";
import { handleListMessages, handleGetMessage, handleOtp } from "./messages";

declare const NPCMAIL_VERSION: string;

async function handleHealth(env: Env): Promise<Response> {
  const ident = await env.DB.prepare(`SELECT COUNT(*) AS n FROM identities`).first<{ n: number }>();
  const msgs = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages`).first<{ n: number }>();
  return json({
    ok: true,
    service: "npcmail",
    version: typeof NPCMAIL_VERSION !== "undefined" ? NPCMAIL_VERSION : "dev",
    domain: env.DOMAIN,
    identities: ident?.n ?? 0,
    messages: msgs?.n ?? 0,
  });
}

export async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  if (path === "/v1/health" && method === "GET") return handleHealth(env);
  if (path === "/v1/identities" && method === "POST") return handleCreateIdentity(req, env);
  if (path === "/v1/identities" && method === "GET") return handleListIdentities(url, env);

  const identMatch = path.match(/^\/v1\/identities\/([^/]+)(?:\/(messages|otp))?$/);
  if (identMatch) {
    let address: string;
    try {
      address = appendDomain(decodeURIComponent(identMatch[1]!), env.DOMAIN);
    } catch {
      return err("malformed percent-encoding in address", 400);
    }
    const sub = identMatch[2];
    if (!sub && method === "GET") return handleGetIdentity(address, env);
    if (!sub && method === "DELETE") return handleDeleteIdentity(address, env);
    if (sub === "messages" && method === "GET") return handleListMessages(address, url, env);
    if (sub === "otp" && method === "GET") return handleOtp(address, url, env);
  }

  const msgMatch = path.match(/^\/v1\/messages\/([0-9a-f-]{36})$/);
  if (msgMatch && method === "GET") return handleGetMessage(msgMatch[1]!, env);

  return err(`no route: ${method} ${path}`, 404);
}

import type { Env } from "./env";
import { err, tokenMatches } from "./http";
import { handleEmail } from "./ingest";
import { route } from "./routes";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname === "/" && req.method === "GET") {
      return new Response("npcmail — throwaway email identities on your own domain\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!(await tokenMatches(token, env.API_TOKEN))) {
      return err("missing or invalid bearer token", 401);
    }

    try {
      return await route(req, env);
    } catch (e) {
      // Log the real error; don't reflect internals to the caller.
      console.error(`unhandled api error: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      return err("internal error", 500);
    }
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env);
  },
};

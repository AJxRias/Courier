import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Auth, type Principal } from "./auth.js";
import type { Gateway } from "./gateway.js";
import { ForbiddenError } from "./repo.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const username = z.string().regex(/^[a-z0-9_]{3,32}$/, "3-32 chars: a-z, 0-9, _");
const uuidParam = z.object({ id: z.string().uuid() });

/** REST API: login, conversations, history (scrollback), presence, ops endpoints. */
export function registerHttp(gw: Gateway): void {
  const app = gw.http;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues[0]?.message ?? "bad request" });
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    gw.log.error({ err }, "http error");
    return reply.code(500).send({ error: "internal error" });
  });

  const authed = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = Auth.bearer(req.headers.authorization);
    if (!token) return reply.code(401).send({ error: "missing bearer token" });
    try {
      req.principal = await gw.auth.verify(token);
    } catch {
      return reply.code(401).send({ error: "invalid token" });
    }
  };

  // --------------------------------------------------------------- ops

  app.get("/healthz", async () => ({ ok: true, node: gw.config.nodeId }));
  app.get("/readyz", async (_req, reply) => {
    if (gw.isDraining) return reply.code(503).send({ ready: false, draining: true });
    return { ready: true, connections: gw.connectionCount };
  });
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", gw.metrics.registry.contentType);
    return gw.metrics.registry.metrics();
  });

  // --------------------------------------------------------------- auth

  if (gw.config.allowDevLogin) {
    // Username-only login for demos and load tests. Swap for a real identity
    // provider (OIDC) in production; the rest of the system only sees JWTs.
    app.post("/api/auth/dev-login", async (req, reply) => {
      const body = z.object({ username: z.string().transform((s) => s.trim().toLowerCase()).pipe(username) }).parse(req.body);
      if (gw.demo?.isBotName(body.username) || (await gw.repo.isBotName(body.username))) {
        return reply.code(403).send({ error: "that name belongs to a demo bot; pick another" });
      }
      const user = await gw.repo.upsertUser(body.username);
      const token = await gw.auth.issue(user.id, user.username);
      // First sign-in gets a guide bot DM and a demo room, so nobody starts alone.
      if (user.created && gw.demo) await gw.demo.onboard(user.id).catch((err) => gw.log.warn({ err }, "onboarding failed"));
      return { token, user: { id: user.id, username: user.username }, expiresIn: gw.config.tokenTtlSec };
    });
  }

  app.post("/api/auth/refresh", { preHandler: authed }, async (req) => {
    // Short-lived tokens are re-issued while still valid. A production setup
    // would use a separate, revocable refresh token instead.
    const p = req.principal!;
    return { token: await gw.auth.issue(p.userId, p.username), expiresIn: gw.config.tokenTtlSec };
  });

  // Recreates the demo conversations for an existing user (idempotent).
  app.post("/api/demo/start", { preHandler: authed }, async (req, reply) => {
    if (!gw.demo) return reply.code(404).send({ error: "demo bots are not enabled on this server" });
    return gw.demo.onboard(req.principal!.userId);
  });

  app.get("/api/me", { preHandler: authed }, async (req) => ({
    id: req.principal!.userId,
    username: req.principal!.username,
  }));

  // --------------------------------------------------------------- users

  app.get("/api/users", { preHandler: authed }, async (req) => {
    const { q } = z.object({ q: z.string().max(32).default("") }).parse(req.query);
    return gw.repo.searchUsers(q.toLowerCase());
  });

  app.get("/api/presence", { preHandler: authed }, async (req) => {
    const { userIds } = z.object({ userIds: z.string().max(4000) }).parse(req.query);
    const ids = userIds.split(",").filter((s) => z.string().uuid().safeParse(s).success).slice(0, 100);
    return gw.presence.online(ids);
  });

  // --------------------------------------------------------------- conversations

  app.get("/api/conversations", { preHandler: authed }, async (req) => gw.repo.listConversations(req.principal!.userId));

  app.post("/api/conversations", { preHandler: authed }, async (req, reply) => {
    const body = z
      .object({
        members: z.array(username).min(1).max(256),
        title: z.string().trim().min(1).max(80).optional(),
      })
      .parse(req.body);
    const users = await gw.repo.findUsersByName(body.members);
    if (users.some((u) => u.isBot)) return reply.code(403).send({ error: "demo bots can't be added to conversations" });
    if (users.length !== new Set(body.members).size) {
      const found = new Set(users.map((u) => u.username));
      return reply.code(404).send({ error: `unknown users: ${body.members.filter((m) => !found.has(m)).join(", ")}` });
    }
    const conv = await gw.repo.createConversation(req.principal!.userId, users.map((u) => u.id), body.title ?? null);
    await gw.announceMembers(conv.id, conv.members);
    return reply.code(201).send(conv);
  });

  app.post("/api/conversations/:id/members", { preHandler: authed }, async (req, reply) => {
    const { id } = uuidParam.parse(req.params);
    const body = z.object({ username }).parse(req.body);
    const [user] = await gw.repo.findUsersByName([body.username]);
    if (!user) return reply.code(404).send({ error: "unknown user" });
    if (user.isBot) return reply.code(403).send({ error: "demo bots can't be added to conversations" });
    const added = await gw.repo.addMember(id, req.principal!.userId, user.id);
    if (added) await gw.announceMembers(id, [user.id]);
    return { added };
  });

  app.get("/api/conversations/:id/messages", { preHandler: authed }, async (req) => {
    const { id } = uuidParam.parse(req.params);
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    return gw.repo.messagesBefore(id, req.principal!.userId, q.before ?? null, q.limit);
  });

  // ------------------------------------------------------------ web app

  if (gw.config.staticDir) {
    const root = resolve(gw.config.staticDir);
    if (!existsSync(resolve(root, "index.html"))) {
      gw.log.warn({ root }, "STATIC_DIR has no index.html; not serving the web app");
      return;
    }
    void app.register(fastifyStatic, { root, index: ["index.html"] });
    // Single-page app: unknown non-API GETs get index.html.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0]!;
      // Paths that look like files (have an extension) are real 404s, not app routes.
      if (req.method === "GET" && !path.startsWith("/api/") && path !== "/ws" && !/\.[a-z0-9]+$/i.test(path)) {
        return reply.sendFile("index.html", root);
      }
      return reply.code(404).send({ error: "not found" });
    });
  }
}

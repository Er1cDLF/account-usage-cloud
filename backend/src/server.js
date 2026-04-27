import "dotenv/config";
import cors from "cors";
import crypto from "crypto";
import express from "express";
import http from "http";
import pg from "pg";
import { WebSocketServer } from "ws";

const { Pool } = pg;

const PORT = Number(process.env.PORT || 10000);
const INVITE_CODE = process.env.INVITE_CODE || "WAYTOAGI";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-me";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const HEARTBEAT_TIMEOUT_MS = 90_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set. API calls that touch the database will fail.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sockets = new Set();

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: false }));
app.use(express.json({ limit: "64kb" }));

function nowPlus(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function signToken(rawToken) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(rawToken).digest("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name };
}

function mapUsage(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    name: row.display_name,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
    reason: row.end_reason,
    durationMs: row.duration_ms,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    text: row.text,
    toSessionId: row.to_session_id,
    toName: row.to_name,
    system: row.system,
    createdAt: row.created_at,
  };
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result;
}

async function authUser(req) {
  const header = req.headers.authorization || "";
  const rawToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  return authUserFromToken(rawToken);
}

async function authUserFromToken(rawToken) {
  if (!rawToken) return null;
  const tokenHash = signToken(rawToken);
  const result = await query(
    `select u.id, u.username, u.display_name
     from auth_sessions s
     join app_users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0] || null;
}

function requireUser(handler) {
  return async (req, res, next) => {
    try {
      const user = await authUser(req);
      if (!user) {
        res.status(401).json({ error: "请先登录。" });
        return;
      }
      req.user = user;
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

async function createSession(userId) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  await query(
    `insert into auth_sessions (token_hash, user_id, expires_at)
     values ($1, $2, $3)`,
    [signToken(rawToken), userId, nowPlus(SESSION_TTL_MS)],
  );
  return rawToken;
}

async function expireStaleUsage() {
  const result = await query(
    `update usage_sessions
     set ended_at = now(),
         end_reason = 'heartbeat_timeout',
         duration_ms = greatest(0, floor(extract(epoch from (now() - started_at)) * 1000))::integer
     where ended_at is null
       and last_seen_at < now() - ($1::text)::interval
     returning *`,
    [`${HEARTBEAT_TIMEOUT_MS} milliseconds`],
  );

  for (const row of result.rows) {
    await query(
      `insert into chat_messages (name, text, system, created_at)
       values ('系统', $1, true, now())`,
      [`${row.display_name} 离线超时，系统已自动释放账号。`],
    );
  }
  if (result.rowCount) await broadcastState();
}

async function getState() {
  await expireStaleUsage();
  const [active, history, messages] = await Promise.all([
    query(`select * from usage_sessions where ended_at is null order by started_at desc limit 1`),
    query(`select * from usage_sessions where ended_at is not null order by started_at desc limit 200`),
    query(`select * from chat_messages order by created_at desc limit 200`),
  ]);
  return {
    active: mapUsage(active.rows[0]),
    history: history.rows.map(mapUsage),
    messages: messages.rows.map(mapMessage),
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    serverTime: new Date().toISOString(),
  };
}

async function broadcastState() {
  const payload = JSON.stringify({ type: "state", state: await getState() });
  for (const socket of sockets) {
    if (socket.readyState === 1) socket.send(payload);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "account-usage-cloud-api",
    health: "/health",
  });
});

app.get("/api/me", requireUser(async (req, res) => {
  res.json({ user: publicUser(req.user) });
}));

app.post("/api/register", async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase().slice(0, 32);
    const displayName = String(req.body.displayName || req.body.username || "").trim().slice(0, 32);
    const password = String(req.body.password || "");
    const inviteCode = String(req.body.inviteCode || "").trim();

    if (inviteCode !== INVITE_CODE) return res.status(403).json({ error: "邀请码不正确。" });
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return res.status(400).json({ error: "账号只能包含小写字母、数字、下划线，长度 3-32 位。" });
    if (displayName.length < 1) return res.status(400).json({ error: "请填写显示名称。" });
    if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位。" });

    const created = await query(
      `insert into app_users (username, display_name, password_hash)
       values ($1, $2, $3)
       returning id, username, display_name`,
      [username, displayName, hashPassword(password)],
    ).catch((error) => {
      if (error.code === "23505") error.publicMessage = "该账号已注册。";
      throw error;
    });
    const token = await createSession(created.rows[0].id);
    res.json({ token, user: publicUser(created.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const result = await query(`select * from app_users where username = $1`, [username]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "账号或密码不正确。" });
    }
    const token = await createSession(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", requireUser(async (req, res) => {
  const header = req.headers.authorization || "";
  const rawToken = header.startsWith("Bearer ") ? header.slice(7) : "";
  await query(`delete from auth_sessions where token_hash = $1`, [signToken(rawToken)]);
  res.json({ ok: true });
}));

app.get("/api/status", requireUser(async (_req, res) => {
  res.json(await getState());
}));

app.post("/api/start", requireUser(async (req, res) => {
  const existing = await query(`select * from usage_sessions where ended_at is null limit 1`);
  if (existing.rows[0]) {
    return res.status(409).json({ error: `当前账号正在被 ${existing.rows[0].display_name} 使用。`, active: mapUsage(existing.rows[0]) });
  }

  const started = await query(
    `insert into usage_sessions (user_id, username, display_name)
     values ($1, $2, $3)
     returning *`,
    [req.user.id, req.user.username, req.user.display_name],
  );
  await query(
    `insert into chat_messages (name, text, system)
     values ('系统', $1, true)`,
    [`${req.user.display_name} 开始使用账号。`],
  );
  await broadcastState();
  res.json({ sessionId: started.rows[0].id, active: mapUsage(started.rows[0]) });
}));

app.post("/api/heartbeat", requireUser(async (req, res) => {
  const result = await query(
    `update usage_sessions
     set last_seen_at = now()
     where id = $1 and user_id = $2 and ended_at is null
     returning *`,
    [req.body.sessionId, req.user.id],
  );
  if (!result.rows[0]) return res.status(409).json({ error: "当前会话已结束或被释放。" });
  await broadcastState();
  res.json({ ok: true, active: mapUsage(result.rows[0]) });
}));

app.post("/api/stop", requireUser(async (req, res) => {
  const result = await query(
    `update usage_sessions
     set ended_at = now(),
         end_reason = 'manual_stop',
         duration_ms = greatest(0, floor(extract(epoch from (now() - started_at)) * 1000))::integer
     where id = $1 and user_id = $2 and ended_at is null
     returning *`,
    [req.body.sessionId, req.user.id],
  );
  if (result.rows[0]) {
    await query(
      `insert into chat_messages (name, text, system)
       values ('系统', $1, true)`,
      [`${result.rows[0].display_name} 结束使用账号。`],
    );
  }
  await broadcastState();
  res.json({ ok: true, ...(await getState()) });
}));

app.post("/api/messages", requireUser(async (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: "请填写消息内容。" });
  const active = await query(`select * from usage_sessions where ended_at is null limit 1`);
  await query(
    `insert into chat_messages (user_id, name, text, to_session_id, to_name)
     values ($1, $2, $3, $4, $5)`,
    [req.user.id, req.user.display_name, text, active.rows[0]?.id || null, active.rows[0]?.display_name || null],
  );
  await broadcastState();
  res.json(await getState());
}));

wss.on("connection", async (socket, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const user = await authUserFromToken(url.searchParams.get("token"));
  if (!user) {
    socket.close(1008, "Unauthorized");
    return;
  }
  sockets.add(socket);
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });
  socket.on("close", () => sockets.delete(socket));
  socket.send(JSON.stringify({ type: "state", state: await getState() }));
});

setInterval(() => {
  for (const socket of sockets) {
    if (!socket.isAlive) {
      socket.terminate();
      sockets.delete(socket);
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

setInterval(() => {
  expireStaleUsage().catch((error) => console.error(error));
}, 30_000);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.publicMessage || "服务器错误。" });
});

server.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});

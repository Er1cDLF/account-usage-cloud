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
const PROFILE_PASSPHRASE = process.env.PROFILE_PASSPHRASE || "WoAiXueXi";
const HEARTBEAT_TIMEOUT_MS = 90_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_USER_COLOR = "#FFD93D";
const MEMBER_RULES = [
  { group: "组A", color: "#0A2463", names: ["eric"] },
  { group: "组A", color: "#059244", names: ["叶子"] },
  { group: "组A", color: "#AC5326", names: ["caesar"] },
  { group: "组A", color: "#F6E4D0", names: ["lens"] },
  { group: "组A", color: "#E85D75", names: ["litchi"] },
  { group: "组B", color: "#FBB9BA", names: ["wzh"] },
  { group: "组B", color: "#D4E5F4", names: ["不要洋葱cong", "cong"] },
  { group: "组B", color: "#926AAD", names: ["fentanyl"] },
  { group: "组B", color: "#A72061", names: ["maningbo"] },
  { group: "组B", color: "#C2E3D0", names: ["baekhyun"] },
];
const MEMBER_GROUPS = ["组A", "组B", "未分组"];

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

async function query(sql, params = []) {
  return pool.query(sql, params);
}

function nowPlus(ms) {
  return new Date(Date.now() + ms).toISOString();
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

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function memberRuleFor(username, displayName) {
  const candidates = [normalizeName(username), normalizeName(displayName)];
  return MEMBER_RULES.find((rule) => rule.names.some((name) => candidates.includes(normalizeName(name))));
}

function colorForUser(username, displayName) {
  return memberRuleFor(username, displayName)?.color || DEFAULT_USER_COLOR;
}

function groupForUser(username, displayName) {
  return memberRuleFor(username, displayName)?.group || "未分组";
}

function hasProfilePassphrase(req) {
  return String(req.body.passphrase || "") === PROFILE_PASSPHRASE;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    color: row.color || DEFAULT_USER_COLOR,
    group: row.member_group || groupForUser(row.username, row.display_name),
    createdAt: row.created_at,
  };
}

function mapAccount(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
  };
}

function mapUsage(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name || "学习账号",
    accountColor: row.account_color || "#64748b",
    userId: row.user_id,
    username: row.username,
    name: row.display_name,
    userColor: row.user_color || DEFAULT_USER_COLOR,
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
    accountId: row.account_id,
    accountName: row.account_name,
    accountColor: row.account_color,
    userId: row.user_id,
    userColor: row.user_color || DEFAULT_USER_COLOR,
    name: row.name,
    text: row.text,
    toSessionId: row.to_session_id,
    toName: row.to_name,
    system: row.system,
    createdAt: row.created_at,
  };
}

async function ensureDatabase() {
  await query(`create extension if not exists "pgcrypto"`);
  await query(`
    create table if not exists app_users (
      id uuid primary key default gen_random_uuid(),
      username text not null unique check (username ~ '^[a-z0-9_]{3,32}$'),
      display_name text not null check (char_length(display_name) between 1 and 32),
      password_hash text not null,
      created_at timestamptz not null default now()
    )
  `);
  await query(`
    create table if not exists auth_sessions (
      token_hash text primary key,
      user_id uuid not null references app_users(id) on delete cascade,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    )
  `);
  await query(`
    create table if not exists learning_accounts (
      id uuid primary key default gen_random_uuid(),
      name text not null unique,
      color text not null default '#64748b',
      sort_order integer not null default 0,
      created_at timestamptz not null default now()
    )
  `);
  await query(`
    create table if not exists usage_sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references app_users(id) on delete cascade,
      username text not null,
      display_name text not null,
      started_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      ended_at timestamptz,
      end_reason text,
      duration_ms integer
    )
  `);
  await query(`
    create table if not exists chat_messages (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references app_users(id) on delete set null,
      name text not null,
      text text not null check (char_length(text) between 1 and 500),
      to_session_id uuid references usage_sessions(id) on delete set null,
      to_name text,
      system boolean not null default false,
      created_at timestamptz not null default now()
    )
  `);
  await query(`alter table app_users add column if not exists color text`);
  await query(`alter table app_users add column if not exists member_group text`);
  await query(`alter table usage_sessions add column if not exists account_id uuid references learning_accounts(id) on delete set null`);
  await query(`alter table chat_messages add column if not exists account_id uuid references learning_accounts(id) on delete set null`);
  await query(`drop index if exists one_active_usage_session`);
  await query(`
    create unique index if not exists one_active_user_per_account
    on usage_sessions (user_id, account_id)
    where ended_at is null and account_id is not null
  `);
  await query(`
    insert into learning_accounts (name, color, sort_order)
    values ('学习账号 A', '#2563eb', 1), ('学习账号 B', '#16a34a', 2)
    on conflict (name) do nothing
  `);
  await query(`
    update app_users u
    set color = case
        when lower(u.username) = 'eric' or lower(u.display_name) = 'eric' then '#0A2463'
        when u.username = '叶子' or u.display_name = '叶子' then '#059244'
        when lower(u.username) = 'caesar' or lower(u.display_name) = 'caesar' then '#AC5326'
        when lower(u.username) = 'lens' or lower(u.display_name) = 'lens' then '#F6E4D0'
        when lower(u.username) = 'litchi' or lower(u.display_name) = 'litchi' then '#E85D75'
        when lower(u.username) = 'wzh' or lower(u.display_name) = 'wzh' then '#FBB9BA'
        when lower(u.username) in ('不要洋葱cong', 'cong') or lower(u.display_name) in ('不要洋葱cong', 'cong') then '#D4E5F4'
        when lower(u.username) = 'fentanyl' or lower(u.display_name) = 'fentanyl' then '#926AAD'
        when lower(u.username) = 'maningbo' or lower(u.display_name) = 'maningbo' then '#A72061'
        when lower(u.username) = 'baekhyun' or lower(u.display_name) = 'baekhyun' then '#C2E3D0'
        else '#FFD93D'
      end,
      member_group = case
        when lower(u.username) in ('eric', 'caesar', 'lens', 'litchi') or lower(u.display_name) in ('eric', 'caesar', 'lens', 'litchi') or u.username = '叶子' or u.display_name = '叶子' then '组A'
        when lower(u.username) in ('wzh', '不要洋葱cong', 'cong', 'fentanyl', 'maningbo', 'baekhyun') or lower(u.display_name) in ('wzh', '不要洋葱cong', 'cong', 'fentanyl', 'maningbo', 'baekhyun') then '组B'
        else '未分组'
      end
    where lower(u.username) in ('eric', 'caesar', 'lens', 'litchi', 'wzh', '不要洋葱cong', 'cong', 'fentanyl', 'maningbo', 'baekhyun')
       or lower(u.display_name) in ('eric', 'caesar', 'lens', 'litchi', 'wzh', '不要洋葱cong', 'cong', 'fentanyl', 'maningbo', 'baekhyun')
       or u.username = '叶子'
       or u.display_name = '叶子'
  `);
  await query(`
    update app_users
    set color = '${DEFAULT_USER_COLOR}',
        member_group = coalesce(member_group, '未分组')
    where not (
      lower(username) in ('eric', 'caesar', 'lens', 'litchi', 'wzh', '不要洋葱cong', 'cong', 'fentanyl', 'maningbo', 'baekhyun')
      or lower(display_name) in ('eric', 'caesar', 'lens', 'litchi', 'wzh', '不要洋葱cong', 'cong', 'fentanyl', 'maningbo', 'baekhyun')
      or username = '叶子'
      or display_name = '叶子'
    )
  `);
  await query(`
    update usage_sessions
    set account_id = (select id from learning_accounts order by sort_order limit 1)
    where account_id is null
  `);
}

async function authUserFromToken(rawToken) {
  if (!rawToken) return null;
  const result = await query(
    `select u.id, u.username, u.display_name, u.color, u.member_group, u.created_at
     from auth_sessions s
     join app_users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [signToken(rawToken)],
  );
  return result.rows[0] || null;
}

async function authUser(req) {
  const header = req.headers.authorization || "";
  return authUserFromToken(header.startsWith("Bearer ") ? header.slice(7) : "");
}

function requireUser(handler) {
  return async (req, res, next) => {
    try {
      const user = await authUser(req);
      if (!user) return res.status(401).json({ error: "请先登录。" });
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

const usageSelect = `
  select us.*,
         la.name as account_name,
         la.color as account_color,
         coalesce(u.color, '${DEFAULT_USER_COLOR}') as user_color
  from usage_sessions us
  left join learning_accounts la on la.id = us.account_id
  left join app_users u on u.id = us.user_id
`;

const messageSelect = `
  select cm.*,
         la.name as account_name,
         la.color as account_color,
         coalesce(u.color, '${DEFAULT_USER_COLOR}') as user_color
  from chat_messages cm
  left join learning_accounts la on la.id = cm.account_id
  left join app_users u on u.id = cm.user_id
`;

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
      `insert into chat_messages (account_id, name, text, system)
       values ($1, '系统', $2, true)`,
      [row.account_id, `${row.display_name} 离线超时，系统已自动结束记录。`],
    );
  }
  if (result.rowCount) await broadcastState();
}

async function getState() {
  await expireStaleUsage();
  const [accounts, active, history, messages, users] = await Promise.all([
    query(`select * from learning_accounts order by sort_order, name`),
    query(`${usageSelect} where us.ended_at is null order by us.started_at desc`),
    query(`${usageSelect} where us.ended_at is not null order by us.started_at desc limit 500`),
    query(`${messageSelect} order by cm.created_at desc limit 300`),
    query(`select id, username, display_name, color, member_group, created_at from app_users order by member_group asc, created_at asc`),
  ]);

  return {
    accounts: accounts.rows.map(mapAccount),
    active: active.rows.map(mapUsage),
    history: history.rows.map(mapUsage),
    messages: messages.rows.map(mapMessage),
    users: users.rows.map(publicUser),
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

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "account-usage-cloud-api", health: "/health" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
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
    if (!displayName) return res.status(400).json({ error: "请填写显示名称。" });
    if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位。" });

    const color = colorForUser(username, displayName);
    const group = groupForUser(username, displayName);
    const created = await query(
      `insert into app_users (username, display_name, password_hash, color, member_group)
       values ($1, $2, $3, $4, $5)
       returning id, username, display_name, color, member_group, created_at`,
      [username, displayName, hashPassword(password), color, group],
    ).catch((error) => {
      if (error.code === "23505") error.publicMessage = "该账号已注册。";
      throw error;
    });
    const token = await createSession(created.rows[0].id);
    await broadcastState().catch(() => {});
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

app.post("/api/profile/password", requireUser(async (req, res) => {
  if (!hasProfilePassphrase(req)) return res.status(403).json({ error: "静态口令不正确。" });
  const newPassword = String(req.body.newPassword || "");
  if (newPassword.length < 6) return res.status(400).json({ error: "新密码至少 6 位。" });
  await query(`update app_users set password_hash = $1 where id = $2`, [hashPassword(newPassword), req.user.id]);
  res.json({ ok: true });
}));

app.patch("/api/profile/group", requireUser(async (req, res) => {
  const group = String(req.body.group || "").trim();
  if (!MEMBER_GROUPS.includes(group)) return res.status(400).json({ error: "请选择有效分组。" });
  const result = await query(
    `update app_users
     set member_group = $1
     where id = $2
     returning id, username, display_name, color, member_group, created_at`,
    [group, req.user.id],
  );
  await broadcastState().catch(() => {});
  res.json({ user: publicUser(result.rows[0]), state: await getState() });
}));

app.delete("/api/profile", requireUser(async (req, res) => {
  const confirmText = String(req.body.confirmText || "").trim();
  if (confirmText !== "注销账号") return res.status(400).json({ error: "请输入“注销账号”确认。" });
  await query(
    `update usage_sessions
     set ended_at = now(),
         end_reason = 'account_deleted',
         duration_ms = greatest(0, floor(extract(epoch from (now() - started_at)) * 1000))::integer
     where user_id = $1 and ended_at is null`,
    [req.user.id],
  );
  await query(`delete from app_users where id = $1`, [req.user.id]);
  await broadcastState().catch(() => {});
  res.json({ ok: true });
}));

app.get("/api/status", requireUser(async (_req, res) => {
  res.json(await getState());
}));

app.post("/api/start", requireUser(async (req, res) => {
  const accountId = String(req.body.accountId || "");
  const account = await query(`select * from learning_accounts where id = $1`, [accountId]);
  if (!account.rows[0]) return res.status(400).json({ error: "请选择要使用的学习账号。" });

  const existing = await query(
    `${usageSelect} where us.account_id = $1 and us.user_id = $2 and us.ended_at is null limit 1`,
    [accountId, req.user.id],
  );
  if (existing.rows[0]) {
    return res.json({ sessionId: existing.rows[0].id, active: mapUsage(existing.rows[0]) });
  }

  const started = await query(
    `insert into usage_sessions (account_id, user_id, username, display_name)
     values ($1, $2, $3, $4)
     returning *`,
    [accountId, req.user.id, req.user.username, req.user.display_name],
  );
  await query(
    `insert into chat_messages (account_id, name, text, system)
     values ($1, '系统', $2, true)`,
    [accountId, `${req.user.display_name} 开始使用 ${account.rows[0].name}。`],
  );
  await broadcastState();
  res.json({ sessionId: started.rows[0].id, active: mapUsage({ ...started.rows[0], account_name: account.rows[0].name, account_color: account.rows[0].color, user_color: req.user.color }) });
}));

app.post("/api/heartbeat", requireUser(async (req, res) => {
  const sessionIds = Array.isArray(req.body.sessionIds) ? req.body.sessionIds : [req.body.sessionId].filter(Boolean);
  if (!sessionIds.length) return res.json({ ok: true });
  const result = await query(
    `update usage_sessions
     set last_seen_at = now()
     where id = any($1::uuid[]) and user_id = $2 and ended_at is null
     returning *`,
    [sessionIds, req.user.id],
  );
  res.json({ ok: true, count: result.rowCount });
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
    const account = await query(`select name from learning_accounts where id = $1`, [result.rows[0].account_id]);
    await query(
      `insert into chat_messages (account_id, name, text, system)
       values ($1, '系统', $2, true)`,
      [result.rows[0].account_id, `${result.rows[0].display_name} 结束使用 ${account.rows[0]?.name || "学习账号"}。`],
    );
  }
  await broadcastState();
  res.json({ ok: true, ...(await getState()) });
}));

app.post("/api/messages", requireUser(async (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 500);
  const accountId = req.body.accountId || null;
  if (!text) return res.status(400).json({ error: "请填写消息内容。" });

  let account = null;
  if (accountId) {
    const result = await query(`select * from learning_accounts where id = $1`, [accountId]);
    account = result.rows[0] || null;
  }
  await query(
    `insert into chat_messages (account_id, user_id, name, text, to_name)
     values ($1, $2, $3, $4, $5)`,
    [account?.id || null, req.user.id, req.user.display_name, text, account?.name || null],
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

ensureDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed", error);
    process.exit(1);
  });

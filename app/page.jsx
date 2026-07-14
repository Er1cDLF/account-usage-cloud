"use client";

import { useEffect, useMemo, useState } from "react";

const TOKEN_KEY = "sitesAccountUsageToken";
const USERNAME_KEY = "sitesAccountUsageUsername";
const SESSION_KEY = "sitesAccountUsageSessions";
const ACCOUNT_A_EMAIL = "Lifuduan2000@gmail.com";
const ACCOUNT_B_EMAIL = "hzy1026931135@gmail.com";

function readSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeSessions(value) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(value));
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function accountTitle(account) {
  if (account.name?.includes("A")) return `${account.name}（${ACCOUNT_A_EMAIL}）`;
  if (account.name?.includes("B")) return `${account.name}（${ACCOUNT_B_EMAIL}）`;
  return account.name;
}

export default function Page() {
  const [tab, setTab] = useState("overview");
  const [mode, setMode] = useState("login");
  const [user, setUser] = useState(null);
  const [state, setState] = useState(null);
  const [notice, setNotice] = useState("");
  const [login, setLogin] = useState({
    username: typeof localStorage === "undefined" ? "" : localStorage.getItem(USERNAME_KEY) || "",
    password: "",
  });
  const [register, setRegister] = useState({ username: "", displayName: "", password: "", inviteCode: "" });
  const [chatText, setChatText] = useState("");
  const [now, setNow] = useState(Date.now());

  const token = () => localStorage.getItem(TOKEN_KEY);

  async function api(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (token()) headers.authorization = `Bearer ${token()}`;
    const response = await fetch(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "请求失败，请稍后重试。");
    return payload;
  }

  async function refresh(options = {}) {
    if (!token()) return;
    const nextState = await api("/api/status");
    setState(nextState);
    if (!options.keepNotice) setNotice("");
  }

  async function boot() {
    if (!token()) return;
    try {
      const payload = await api("/api/me");
      setUser(payload.user);
      await refresh();
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
    }
  }

  useEffect(() => {
    boot();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const refreshTimer = setInterval(() => refresh({ keepNotice: true }).catch(() => {}), document.hidden ? 120000 : 30000);
    const heartbeatTimer = setInterval(() => {
      const sessionIds = Object.values(readSessions());
      if (!sessionIds.length) return;
      api("/api/heartbeat", { method: "POST", body: JSON.stringify({ sessionIds }) }).catch(() => {});
    }, 30000);
    return () => {
      clearInterval(refreshTimer);
      clearInterval(heartbeatTimer);
    };
  }, [user]);

  useEffect(() => {
    const stopOnUnload = () => {
      const sessionIds = Object.values(readSessions());
      if (!sessionIds.length || !token()) return;
      for (const sessionId of sessionIds) {
        fetch("/api/stop", {
          method: "POST",
          keepalive: true,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token()}`,
          },
          body: JSON.stringify({ sessionId }),
        });
      }
    };
    window.addEventListener("beforeunload", stopOnUnload);
    return () => window.removeEventListener("beforeunload", stopOnUnload);
  }, []);

  const accounts = state?.accounts || [];
  const active = state?.active || [];
  const history = state?.history || [];
  const messages = state?.messages || [];
  const users = state?.users || [];
  const sessions = useMemo(() => readSessions(), [state, user]);

  async function submitLogin(event) {
    event.preventDefault();
    setNotice("正在登录...");
    try {
      const payload = await api("/api/login", { method: "POST", body: JSON.stringify(login) });
      localStorage.setItem(TOKEN_KEY, payload.token);
      localStorage.setItem(USERNAME_KEY, payload.user.username);
      setUser(payload.user);
      await refresh();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function submitRegister(event) {
    event.preventDefault();
    const username = register.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      setNotice("账号只能包含小写字母、数字、下划线，长度 3-32 位。");
      return;
    }
    setNotice("正在注册...");
    try {
      const payload = await api("/api/register", {
        method: "POST",
        body: JSON.stringify({ ...register, username }),
      });
      localStorage.setItem(TOKEN_KEY, payload.token);
      localStorage.setItem(USERNAME_KEY, payload.user.username);
      setUser(payload.user);
      await refresh();
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function startUsage(accountId) {
    setNotice("正在开始记录...");
    try {
      const payload = await api("/api/start", { method: "POST", body: JSON.stringify({ accountId }) });
      const next = readSessions();
      next[accountId] = payload.sessionId;
      writeSessions(next);
      await refresh();
      setNotice("已开始记录。");
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function stopUsage(accountId) {
    const sessionId = readSessions()[accountId];
    if (!sessionId) return;
    setNotice("正在结束记录...");
    try {
      await api("/api/stop", { method: "POST", body: JSON.stringify({ sessionId }) });
      const next = readSessions();
      delete next[accountId];
      writeSessions(next);
      await refresh();
      setNotice("已结束记录。");
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    try {
      const nextState = await api("/api/messages", { method: "POST", body: JSON.stringify({ text }) });
      setState(nextState);
      setChatText("");
    } catch (error) {
      setNotice(error.message);
    }
  }

  function logout() {
    api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(SESSION_KEY);
    setUser(null);
    setState(null);
  }

  if (!user) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="eyebrow">学习共享空间</p>
          <h1>登录后使用</h1>
          <div className="switcher">
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">登录</button>
            <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")} type="button">注册</button>
          </div>
          {notice && <p className="notice">{notice}</p>}
          {mode === "login" ? (
            <form className="stack" onSubmit={submitLogin}>
              <input value={login.username} onChange={(event) => setLogin({ ...login, username: event.target.value })} placeholder="账号" autoComplete="username" />
              <input value={login.password} onChange={(event) => setLogin({ ...login, password: event.target.value })} placeholder="密码" type="password" autoComplete="current-password" />
              <button>登录</button>
            </form>
          ) : (
            <form className="stack" onSubmit={submitRegister}>
              <input value={register.username} onChange={(event) => setRegister({ ...register, username: event.target.value })} placeholder="账号：小写字母、数字、下划线" />
              <input value={register.displayName} onChange={(event) => setRegister({ ...register, displayName: event.target.value })} placeholder="显示名称" />
              <input value={register.password} onChange={(event) => setRegister({ ...register, password: event.target.value })} placeholder="密码，至少 6 位" type="password" />
              <input value={register.inviteCode} onChange={(event) => setRegister({ ...register, inviteCode: event.target.value })} placeholder="邀请码" />
              <button>注册并登录</button>
            </form>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="workspace">
      <header className="hero">
        <img src="/Logo.png" alt="学习共享空间" />
        <div>
          <p className="eyebrow">学习账号</p>
          <h1>学习共享空间</h1>
          <p className="hero-line">人以想象开路，AI以智慧相伴；让知识流动，让成长发生。</p>
        </div>
        <div className="user-area">
          <span className="user-pill" style={{ "--color": user.color }}>{user.displayName}</span>
          <button className="plain" onClick={logout}>退出登录</button>
        </div>
      </header>

      <nav className="tabs">
        {[
          ["overview", "账号总览"],
          ["chat", "聊天"],
          ["history", "历史记录"],
          ["members", "成员"],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
        ))}
        <a className="gpt-link" href="https://chatgpt.com/" target="_blank" rel="noreferrer">
          <img src="/ChatGPT-Logo.png" alt="" />
          启动GPT
        </a>
      </nav>

      {notice && <p className="notice">{notice}</p>}

      {tab === "overview" && (
        <section className="account-grid">
          {accounts.map((account) => {
            const people = active.filter((item) => item.accountId === account.id);
            const mine = Boolean(sessions[account.id]);
            return (
              <article className="account-card" key={account.id} style={{ "--accent": account.color }}>
                <div className="card-title">
                  <h2>{accountTitle(account)}</h2>
                  <span>{people.length} 人正在使用</span>
                </div>
                <div className="people">
                  {people.map((person) => (
                    <div className="person" key={person.id}>
                      <span style={{ background: person.userColor }} />
                      <strong>{person.name}</strong>
                      <em>{formatDuration(now - new Date(person.startedAt).getTime())}</em>
                    </div>
                  ))}
                  {!people.length && <p className="empty">当前空闲。</p>}
                </div>
                <button onClick={() => (mine ? stopUsage(account.id) : startUsage(account.id))}>
                  {mine ? "我结束使用" : "我开始使用"}
                </button>
              </article>
            );
          })}
        </section>
      )}

      {tab === "chat" && (
        <section className="panel">
          <form className="chat-form" onSubmit={sendMessage}>
            <input value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="输入消息" maxLength={500} />
            <button>发送</button>
          </form>
          <div className="chat-grid">
            <div>
              <h2>成员对话</h2>
              {messages.filter((item) => !item.system).slice(0, 80).map((item) => (
                <article className="message" key={item.id}>
                  <strong style={{ color: item.userColor }}>{item.name}</strong>
                  <span>{formatTime(item.createdAt)}</span>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
            <div>
              <h2>系统动态</h2>
              {messages.filter((item) => item.system).slice(0, 80).map((item) => (
                <article className="message system" key={item.id}>
                  <strong>{item.name}</strong>
                  <span>{formatTime(item.createdAt)}</span>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {tab === "history" && (
        <section className="history-grid">
          {accounts.map((account) => (
            <article className="panel" key={account.id}>
              <h2>{accountTitle(account)}</h2>
              {history.filter((item) => item.accountId === account.id).slice(0, 80).map((item) => (
                <div className="history-item" key={item.id}>
                  <span style={{ background: item.userColor }} />
                  <strong>{item.name}</strong>
                  <em>{formatTime(item.startedAt)} - {formatTime(item.endedAt)}</em>
                </div>
              ))}
            </article>
          ))}
        </section>
      )}

      {tab === "members" && (
        <section className="member-grid">
          {users.map((item) => (
            <article className="member" key={item.id}>
              <span style={{ background: item.color }} />
              <strong>{item.displayName}</strong>
              <em>{item.group || "未分组"} · {item.color}</em>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

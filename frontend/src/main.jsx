import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL || "https://account-usage-cloud.onrender.com";
const WS_URL = import.meta.env.VITE_WS_URL || "wss://account-usage-cloud.onrender.com/ws";
const AUTH_TOKEN_KEY = "cloudAccountUsageAuthToken";
const USAGE_SESSIONS_KEY = "cloudAccountUsageSessions";
const USERNAME_KEY = "cloudAccountUsageUsername";
const DEFAULT_TITLE = "学习共享空间";
const ACCOUNT_A_EMAIL = "Lifuduan2000@gmail.com";

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
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

function readSessionMap() {
  try {
    return JSON.parse(localStorage.getItem(USAGE_SESSIONS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeSessionMap(map) {
  localStorage.setItem(USAGE_SESSIONS_KEY, JSON.stringify(map));
}

function accountShortName(accountName) {
  if (accountName?.includes("A")) return "号A";
  if (accountName?.includes("B")) return "号B";
  return accountName || "账号";
}

function accountDisplayName(account) {
  if (account.name?.includes("A")) return `${account.name}（${ACCOUNT_A_EMAIL}）`;
  return account.name;
}

function App() {
  const [page, setPage] = useState("overview");
  const [authMode, setAuthMode] = useState("login");
  const [user, setUser] = useState(null);
  const [state, setState] = useState(null);
  const [authMessage, setAuthMessage] = useState("");
  const [message, setMessage] = useState("");
  const [login, setLogin] = useState({ username: localStorage.getItem(USERNAME_KEY) || "", password: "" });
  const [register, setRegister] = useState({ username: "", displayName: "", password: "", inviteCode: "" });
  const [chatText, setChatText] = useState("");
  const [calendarAccountId, setCalendarAccountId] = useState("all");
  const [tick, setTick] = useState(Date.now());
  const [authLoading, setAuthLoading] = useState(false);
  const [usageLoading, setUsageLoading] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const wsRef = useRef(null);
  const authNoticeRef = useRef(null);
  const knownMessageIdsRef = useRef(new Set());
  const userRef = useRef(null);

  const token = () => localStorage.getItem(AUTH_TOKEN_KEY);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    if (authMessage) authNoticeRef.current?.focus();
  }, [authMessage]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) {
        setUnreadCount(0);
        document.title = DEFAULT_TITLE;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) 有新消息 - ${DEFAULT_TITLE}` : DEFAULT_TITLE;
  }, [unreadCount]);

  async function api(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (token()) headers.authorization = `Bearer ${token()}`;

    let response;
    try {
      response = await fetch(`${API_URL}${path}`, { ...options, headers });
    } catch {
      throw new Error("无法连接服务器，请稍后重试。Render 免费服务刚唤醒时可能需要等待几十秒。");
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "请求失败，请稍后重试。");
    return payload;
  }

  function requestNotificationPermission() {
    if (!("Notification" in window)) {
      setMessage("当前浏览器不支持系统通知。");
      return;
    }
    if (Notification.permission === "default") Notification.requestPermission();
  }

  function notifyNewMessage(item) {
    if (!document.hidden) return;
    setUnreadCount((count) => count + 1);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("学习共享空间有新消息", {
        body: `${item.name}: ${item.text}`,
      });
    }
  }

  function receiveState(nextState, { silent = false } = {}) {
    const nextIds = new Set((nextState.messages || []).map((item) => item.id));
    const knownIds = knownMessageIdsRef.current;
    const currentUser = userRef.current;

    if (!silent && currentUser) {
      const freshMessages = (nextState.messages || [])
        .filter((item) => !knownIds.has(item.id))
        .filter((item) => !item.system && item.userId !== currentUser.id)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      for (const item of freshMessages) notifyNewMessage(item);
    }

    knownMessageIdsRef.current = nextIds;
    setState(nextState);

    const activeIds = new Set((nextState.active || []).filter((item) => item.userId === currentUser?.id).map((item) => item.id));
    const sessions = readSessionMap();
    let changed = false;
    for (const [accountId, sessionId] of Object.entries(sessions)) {
      if (!activeIds.has(sessionId)) {
        delete sessions[accountId];
        changed = true;
      }
    }
    if (changed) writeSessionMap(sessions);
  }

  async function refreshStatus(options = {}) {
    const nextState = await api("/api/status");
    receiveState(nextState, options);
  }

  function connectWebSocket() {
    wsRef.current?.close();
    const separator = WS_URL.includes("?") ? "&" : "?";
    const ws = new WebSocket(`${WS_URL}${separator}token=${encodeURIComponent(token())}`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "state") receiveState(payload.state);
    };
    ws.onclose = () => {
      if (token()) setTimeout(connectWebSocket, 2000);
    };
  }

  async function boot() {
    if (!token()) return;
    try {
      const payload = await api("/api/me");
      setUser(payload.user);
      userRef.current = payload.user;
      await refreshStatus({ silent: true });
      connectWebSocket();
    } catch {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      setUser(null);
    }
  }

  useEffect(() => {
    boot();
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    const refresh = setInterval(() => refreshStatus({ silent: true }).catch(() => {}), 10000);
    const heartbeat = setInterval(() => {
      const sessionIds = Object.values(readSessionMap());
      if (!sessionIds.length) return;
      api("/api/heartbeat", { method: "POST", body: JSON.stringify({ sessionIds }) }).catch((error) => {
        setMessage(error.message);
        refreshStatus({ silent: true }).catch(() => {});
      });
    }, 30_000);
    return () => {
      clearInterval(refresh);
      clearInterval(heartbeat);
    };
  }, [user]);

  useEffect(() => {
    const stopOnUnload = () => {
      const sessionIds = Object.values(readSessionMap());
      if (!sessionIds.length || !token()) return;
      for (const sessionId of sessionIds) {
        fetch(`${API_URL}/api/stop`, {
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
  const users = state?.users || [];
  const sessionMap = readSessionMap();

  const calendarEvents = useMemo(() => {
    const rows = [...(state?.history || [])];
    for (const item of active) rows.unshift({ ...item, endedAt: new Date().toISOString(), reason: "active" });
    return rows
      .filter((item) => calendarAccountId === "all" || item.accountId === calendarAccountId)
      .map((item) => ({
        id: item.id,
        title: `${accountShortName(item.accountName)}-${item.name}`,
        start: item.startedAt,
        end: item.reason === "active" ? new Date().toISOString() : item.endedAt,
        backgroundColor: item.userColor,
        borderColor: item.userColor,
      }));
  }, [state, active, tick, calendarAccountId]);

  async function submitLogin(event) {
    event.preventDefault();
    setAuthLoading(true);
    setAuthMessage("正在登录...");
    try {
      const payload = await api("/api/login", { method: "POST", body: JSON.stringify(login) });
      localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
      localStorage.setItem(USERNAME_KEY, payload.user.username);
      setUser(payload.user);
      userRef.current = payload.user;
      setAuthMessage("");
      requestNotificationPermission();
      await refreshStatus({ silent: true });
      connectWebSocket();
    } catch (error) {
      setAuthMessage(error.message);
    } finally {
      setAuthLoading(false);
    }
  }

  async function submitRegister(event) {
    event.preventDefault();
    const username = register.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      setAuthMessage("注册失败：账号只能包含小写字母、数字、下划线，长度 3-32 位。不能使用邮箱。");
      return;
    }
    setAuthLoading(true);
    setAuthMessage("正在注册...");
    try {
      const payload = await api("/api/register", { method: "POST", body: JSON.stringify({ ...register, username }) });
      localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
      localStorage.setItem(USERNAME_KEY, payload.user.username);
      setUser(payload.user);
      userRef.current = payload.user;
      setAuthMessage("");
      requestNotificationPermission();
      await refreshStatus({ silent: true });
      connectWebSocket();
    } catch (error) {
      setAuthMessage(`注册失败：${error.message}`);
    } finally {
      setAuthLoading(false);
    }
  }

  async function startUsage(accountId) {
    setUsageLoading(accountId);
    try {
      const payload = await api("/api/start", { method: "POST", body: JSON.stringify({ accountId }) });
      const sessions = readSessionMap();
      sessions[accountId] = payload.sessionId;
      writeSessionMap(sessions);
      setMessage("已开始记录。");
      await refreshStatus({ silent: true });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUsageLoading("");
    }
  }

  async function stopUsage(accountId) {
    const sessionId = readSessionMap()[accountId];
    if (!sessionId) return;
    setUsageLoading(accountId);
    try {
      await api("/api/stop", { method: "POST", body: JSON.stringify({ sessionId }) });
      const sessions = readSessionMap();
      delete sessions[accountId];
      writeSessionMap(sessions);
      setMessage("已结束记录。");
      await refreshStatus({ silent: true });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setUsageLoading("");
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    setChatLoading(true);
    try {
      const nextState = await api("/api/messages", { method: "POST", body: JSON.stringify({ text, accountId: null }) });
      receiveState(nextState, { silent: true });
      setChatText("");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setChatLoading(false);
    }
  }

  async function logout() {
    await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    wsRef.current?.close();
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(USAGE_SESSIONS_KEY);
    userRef.current = null;
    setUser(null);
    setState(null);
  }

  function accountActive(accountId) {
    return active.filter((item) => item.accountId === accountId);
  }

  function historyForAccount(accountId) {
    return (state?.history || []).filter((item) => item.accountId === accountId).slice(0, 80);
  }

  if (!user) {
    return (
      <main className="auth-view">
        <section className="auth-card">
          <p className="eyebrow">学习共享空间</p>
          <h1>登录后使用</h1>
          <div className="auth-tabs">
            <button className={authMode === "login" ? "active" : ""} onClick={() => setAuthMode("login")} type="button">登录</button>
            <button className={authMode === "register" ? "active" : ""} onClick={() => setAuthMode("register")} type="button">注册</button>
          </div>
          {authMessage && <p ref={authNoticeRef} className={`notice ${authMessage.includes("失败") || authMessage.includes("不") || authMessage.includes("无法") ? "error" : "info"}`} role="alert" tabIndex="-1">{authMessage}</p>}
          {authMode === "login" ? (
            <form className="stack" onSubmit={submitLogin}>
              <input value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} placeholder="账号" autoComplete="username" required />
              <input value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} placeholder="密码" type="password" autoComplete="current-password" required />
              <button disabled={authLoading}>{authLoading ? "登录中..." : "登录"}</button>
            </form>
          ) : (
            <form className="stack" onSubmit={submitRegister}>
              <input value={register.username} onChange={(e) => setRegister({ ...register, username: e.target.value })} placeholder="账号：小写字母、数字、下划线" required />
              <input value={register.displayName} onChange={(e) => setRegister({ ...register, displayName: e.target.value })} placeholder="显示名称" required />
              <input value={register.password} onChange={(e) => setRegister({ ...register, password: e.target.value })} placeholder="密码，至少 6 位" type="password" required />
              <input value={register.inviteCode} onChange={(e) => setRegister({ ...register, inviteCode: e.target.value })} placeholder="邀请码" required />
              <button disabled={authLoading}>{authLoading ? "注册中..." : "注册并登录"}</button>
            </form>
          )}
          <p className="hint">第一栏是登录账号，不是邮箱。只能用小写字母、数字、下划线。</p>
        </section>
      </main>
    );
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="brand">
          <img src="/Logo.png" alt="学习共享空间" />
          <div>
            <p className="brand-name">学习共享空间</p>
            <p className="brand-line">人以想象开路，AI以智慧相伴；让知识流动，让成长发生。</p>
          </div>
        </div>
        <div className="top-actions">
          <span className="user-chip" style={{ "--user-color": user.color }}>{user.displayName}</span>
          <button className="text-button" onClick={logout} type="button">退出登录</button>
        </div>
      </header>

      <nav className="page-tabs" aria-label="页面">
        {[
          ["overview", "账号总览"],
          ["calendar", "日历"],
          ["users", "成员"],
          ["chat", "聊天"],
          ["history", "历史记录"],
        ].map(([key, label]) => (
          <button className={page === key ? "active" : ""} key={key} onClick={() => setPage(key)} type="button">{label}</button>
        ))}
      </nav>

      {message && <p className="notice info">{message}</p>}

      {page === "overview" && (
        <section className="page-section">
          <div className="section-title">
            <h2>账号总览</h2>
            <p>两个学习账号可以同时被多人使用，每张卡片单独显示当前人数和具体名单。</p>
          </div>
          <div className="account-grid">
            {accounts.map((account) => {
              const people = accountActive(account.id);
              const mine = Boolean(sessionMap[account.id]);
              return (
                <article className="account-card" key={account.id} style={{ "--account-color": account.color }}>
                  <div className="account-card-head">
                    <div>
                      <h3>{accountDisplayName(account)}</h3>
                      <span>{people.length ? `使用中 · ${people.length} 人` : "空闲 · 0 人"}</span>
                    </div>
                    <i />
                  </div>
                  <div className="people-list">
                    {people.map((person) => (
                      <div className="person-row" key={person.id}>
                        <span className="color-dot" style={{ background: person.userColor }} />
                        <strong>{person.name}</strong>
                        <em>{formatDuration(tick - new Date(person.startedAt).getTime())}</em>
                      </div>
                    ))}
                    {!people.length && <p className="empty-text">当前没有人在使用这个账号。</p>}
                  </div>
                  <button onClick={() => mine ? stopUsage(account.id) : startUsage(account.id)} disabled={usageLoading === account.id} type="button">
                    {usageLoading === account.id ? "处理中..." : mine ? "我结束使用" : "我开始使用"}
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {page === "calendar" && (
        <section className="page-section">
          <div className="section-title">
            <h2>使用日历</h2>
            <p>每个人都有固定颜色，事件显示为“号A-人名”或“号B-人名”。</p>
          </div>
          <div className="filters">
            <button className={calendarAccountId === "all" ? "active" : ""} onClick={() => setCalendarAccountId("all")} type="button">全部账号</button>
            {accounts.map((account) => (
              <button className={calendarAccountId === account.id ? "active" : ""} onClick={() => setCalendarAccountId(account.id)} type="button" key={account.id}>{account.name}</button>
            ))}
          </div>
          <div className="panel calendar-panel">
            <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView="timeGridWeek"
              headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,timeGridDay" }}
              locale={zhCnLocale}
              height="auto"
              allDaySlot={false}
              displayEventTime={false}
              eventTimeFormat={false}
              events={calendarEvents}
              nowIndicator
            />
          </div>
        </section>
      )}

      {page === "users" && (
        <section className="page-section">
          <div className="section-title">
            <h2>成员</h2>
            <p>当前已注册 {users.length} 人。每个人的颜色会用于日历和在线名单。</p>
          </div>
          <div className="user-grid">
            {users.map((item) => (
              <article className="user-card" key={item.id}>
                <span className="user-color-block" style={{ background: item.color }} />
                <div>
                  <strong>{item.displayName}</strong>
                  <span>{item.username}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {page === "chat" && (
        <section className="page-section narrow">
          <div className="section-title">
            <h2>聊天</h2>
            <p>这里是唯一的公共聊天区，用来协调账号使用。</p>
          </div>
          {"Notification" in window && Notification.permission === "default" && <button className="notify-button" onClick={requestNotificationPermission} type="button">开启消息提醒</button>}
          <form className="chat-compose" onSubmit={sendMessage}>
            <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="输入消息" maxLength={500} />
            <button disabled={chatLoading}>{chatLoading ? "发送中..." : "发送"}</button>
          </form>
          <div className="chat-list relaxed">
            {(state?.messages || []).slice(0, 80).map((item) => (
              <article className={`chat-message ${item.system ? "system" : ""}`} key={item.id}>
                <div><strong style={{ color: item.userColor }}>{item.name}</strong><span>{formatTime(item.createdAt)}</span></div>
                <p>{item.text}</p>
              </article>
            ))}
            {!state?.messages?.length && <p className="empty-text">暂无聊天消息。</p>}
          </div>
        </section>
      )}

      {page === "history" && (
        <section className="page-section">
          <div className="section-title">
            <h2>历史记录</h2>
            <p>按学习账号分成两列，方便分别查看 A/B 两个账号的使用情况。</p>
          </div>
          <div className="history-columns">
            {accounts.map((account) => {
              const rows = historyForAccount(account.id);
              return (
                <section className="history-column" key={account.id}>
                  <h3>{accountDisplayName(account)}</h3>
                  <ol className="history-list relaxed">
                    {rows.map((item) => (
                      <li key={item.id}>
                        <span className="color-dot" style={{ background: item.userColor }} />
                        <div>
                          <strong>{item.name} · {formatDuration(item.durationMs || 0)}</strong>
                          <span>{formatTime(item.startedAt)} - {formatTime(item.endedAt)} · {item.reason === "heartbeat_timeout" ? "离线超时自动结束" : "手动结束"}</span>
                        </div>
                      </li>
                    ))}
                    {!rows.length && <li><div><strong>暂无记录</strong><span>结束使用后会显示在这里。</span></div></li>}
                  </ol>
                </section>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:10000";
const WS_URL = import.meta.env.VITE_WS_URL || API_URL.replace(/^http/, "ws") + "/ws";
const AUTH_TOKEN_KEY = "cloudAccountUsageAuthToken";
const USAGE_SESSION_KEY = "cloudAccountUsageSessionId";
const USERNAME_KEY = "cloudAccountUsageUsername";

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

function App() {
  const [authMode, setAuthMode] = useState("login");
  const [user, setUser] = useState(null);
  const [state, setState] = useState(null);
  const [authMessage, setAuthMessage] = useState("");
  const [message, setMessage] = useState("");
  const [login, setLogin] = useState({ username: localStorage.getItem(USERNAME_KEY) || "", password: "" });
  const [register, setRegister] = useState({ username: "", displayName: "", password: "", inviteCode: "" });
  const [chatText, setChatText] = useState("");
  const [tick, setTick] = useState(Date.now());
  const wsRef = useRef(null);

  const token = () => localStorage.getItem(AUTH_TOKEN_KEY);

  async function api(path, options = {}) {
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    if (token()) headers.authorization = `Bearer ${token()}`;
    const response = await fetch(`${API_URL}${path}`, { ...options, headers });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "请求失败");
    return payload;
  }

  async function refreshStatus() {
    const nextState = await api("/api/status");
    setState(nextState);
    const active = nextState.active;
    const ownSession = localStorage.getItem(USAGE_SESSION_KEY);
    if (ownSession && (!active || active.id !== ownSession)) {
      localStorage.removeItem(USAGE_SESSION_KEY);
    }
  }

  function connectWebSocket() {
    wsRef.current?.close();
    const separator = WS_URL.includes("?") ? "&" : "?";
    const ws = new WebSocket(`${WS_URL}${separator}token=${encodeURIComponent(token())}`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "state") setState(payload.state);
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
      await refreshStatus();
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
    const refresh = setInterval(() => refreshStatus().catch(() => {}), 10000);
    const heartbeat = setInterval(() => {
      const sessionId = localStorage.getItem(USAGE_SESSION_KEY);
      if (!sessionId) return;
      api("/api/heartbeat", { method: "POST", body: JSON.stringify({ sessionId }) })
        .then(refreshStatus)
        .catch((error) => {
          localStorage.removeItem(USAGE_SESSION_KEY);
          setMessage(error.message);
          refreshStatus().catch(() => {});
        });
    }, 30_000);
    return () => {
      clearInterval(refresh);
      clearInterval(heartbeat);
    };
  }, [user]);

  useEffect(() => {
    const stopOnUnload = () => {
      const sessionId = localStorage.getItem(USAGE_SESSION_KEY);
      if (!sessionId || !token()) return;
      fetch(`${API_URL}/api/stop`, {
        method: "POST",
        keepalive: true,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token()}`,
        },
        body: JSON.stringify({ sessionId }),
      });
    };
    window.addEventListener("beforeunload", stopOnUnload);
    return () => window.removeEventListener("beforeunload", stopOnUnload);
  }, []);

  const active = state?.active || null;
  const ownSession = localStorage.getItem(USAGE_SESSION_KEY);
  const isMine = active && active.id === ownSession;
  const elapsed = active ? formatDuration(tick - new Date(active.startedAt).getTime()) : "00:00:00";

  const events = useMemo(() => {
    const rows = [...(state?.history || [])];
    if (active) rows.unshift({ ...active, endedAt: new Date().toISOString(), reason: "active" });
    return rows.map((item) => ({
      id: item.id,
      title: `${item.name}${item.reason === "active" ? " 使用中" : ""}`,
      start: item.startedAt,
      end: item.reason === "active" ? new Date().toISOString() : item.endedAt,
      className: item.reason === "active" ? "event-active" : "event-finished",
    }));
  }, [state, active, tick]);

  async function submitLogin(event) {
    event.preventDefault();
    try {
      const payload = await api("/api/login", { method: "POST", body: JSON.stringify(login) });
      localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
      localStorage.setItem(USERNAME_KEY, payload.user.username);
      setUser(payload.user);
      setAuthMessage("");
      await refreshStatus();
      connectWebSocket();
    } catch (error) {
      setAuthMessage(error.message);
    }
  }

  async function submitRegister(event) {
    event.preventDefault();
    try {
      const payload = await api("/api/register", { method: "POST", body: JSON.stringify(register) });
      localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
      localStorage.setItem(USERNAME_KEY, payload.user.username);
      setUser(payload.user);
      setAuthMessage("");
      await refreshStatus();
      connectWebSocket();
    } catch (error) {
      setAuthMessage(error.message);
    }
  }

  async function startUsage() {
    try {
      const payload = await api("/api/start", { method: "POST", body: "{}" });
      localStorage.setItem(USAGE_SESSION_KEY, payload.sessionId);
      setMessage("已开始计时。");
      await refreshStatus();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function stopUsage() {
    const sessionId = localStorage.getItem(USAGE_SESSION_KEY);
    if (!sessionId) return;
    await api("/api/stop", { method: "POST", body: JSON.stringify({ sessionId }) });
    localStorage.removeItem(USAGE_SESSION_KEY);
    setMessage("已结束使用。");
    await refreshStatus();
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    const nextState = await api("/api/messages", { method: "POST", body: JSON.stringify({ text }) });
    setState(nextState);
    setChatText("");
  }

  async function logout() {
    await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    wsRef.current?.close();
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(USAGE_SESSION_KEY);
    setUser(null);
    setState(null);
  }

  if (!user) {
    return (
      <main className="auth-view">
        <section className="auth-card">
          <p className="eyebrow">学习账号</p>
          <h1>登录后使用</h1>
          <div className="auth-tabs">
            <button className={authMode === "login" ? "active" : ""} onClick={() => setAuthMode("login")}>登录</button>
            <button className={authMode === "register" ? "active" : ""} onClick={() => setAuthMode("register")}>注册</button>
          </div>
          {authMode === "login" ? (
            <form className="stack" onSubmit={submitLogin}>
              <input value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} placeholder="账号" autoComplete="username" required />
              <input value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} placeholder="密码" type="password" autoComplete="current-password" required />
              <button>登录</button>
            </form>
          ) : (
            <form className="stack" onSubmit={submitRegister}>
              <input value={register.username} onChange={(e) => setRegister({ ...register, username: e.target.value })} placeholder="账号：字母、数字、下划线" required />
              <input value={register.displayName} onChange={(e) => setRegister({ ...register, displayName: e.target.value })} placeholder="显示名称" required />
              <input value={register.password} onChange={(e) => setRegister({ ...register, password: e.target.value })} placeholder="密码，至少 6 位" type="password" required />
              <input value={register.inviteCode} onChange={(e) => setRegister({ ...register, inviteCode: e.target.value })} placeholder="邀请码" required />
              <button>注册并登录</button>
            </form>
          )}
          <p className="message">{authMessage}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="panel status-panel">
        <div className="status-head">
          <div>
            <p className="eyebrow">学习账号</p>
            <h1>在线使用状态</h1>
          </div>
          <span className={`badge ${active ? "busy" : "idle"}`}>{active ? "使用中" : "空闲"}</span>
        </div>
        <div className="user-bar">
          <span>{user.displayName}（{user.username}）</span>
          <button className="text-button" onClick={logout}>退出登录</button>
        </div>
        <div className={`active-card ${active ? "busy" : "idle"}`}>
          <p>当前状态</p>
          <strong>{active ? `${active.name} 正在使用` : "账号空闲，可以开始使用"}</strong>
          <span>{active ? (isMine ? "这是你的当前会话，保持网页打开会持续在线。" : "账号已被占用，可以在聊天区联系对方。") : "点击开始后，系统会自动计时。"}</span>
        </div>
        <div className="timer-grid">
          <div><span>已使用</span><strong>{elapsed}</strong></div>
          <div><span>最后在线</span><strong>{formatTime(active?.lastSeenAt)}</strong></div>
        </div>
        <button onClick={startUsage} disabled={Boolean(active)}>开始使用</button>
        <button className="secondary" onClick={stopUsage} disabled={!isMine}>结束使用</button>
        <p className="message">{message}</p>
      </section>

      <section className="panel calendar-panel">
        <div className="section-head">
          <h2>使用日历</h2>
          <button className="icon-button" onClick={() => refreshStatus().catch((error) => setMessage(error.message))}>刷新</button>
        </div>
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,timeGridDay" }}
          locale={zhCnLocale}
          height="auto"
          allDaySlot={false}
          events={events}
          nowIndicator
        />
      </section>

      <section className="panel chat-panel">
        <div className="section-head">
          <h2>聊天</h2>
          <span>{active ? `正在与 ${active.name} 对话` : "当前无人使用，可先留言"}</span>
        </div>
        <form className="input-row" onSubmit={sendMessage}>
          <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="给当前使用人留言" maxLength={500} />
          <button>发送</button>
        </form>
        <div className="chat-list">
          {(state?.messages || []).slice(0, 60).map((item) => (
            <article className={`chat-message ${item.system ? "system" : ""}`} key={item.id}>
              <div><strong>{item.name}</strong><span>{formatTime(item.createdAt)}{item.toName ? ` · 发给 ${item.toName}` : ""}</span></div>
              <p>{item.text}</p>
            </article>
          ))}
          {!state?.messages?.length && <p className="empty-text">暂无聊天消息。</p>}
        </div>
      </section>

      <section className="panel history-panel">
        <h2>最近使用记录</h2>
        <ol className="history-list">
          {(state?.history || []).slice(0, 20).map((item) => (
            <li key={item.id}>
              <strong>{item.name} 使用了 {formatDuration(item.durationMs || 0)}</strong>
              <span>{formatTime(item.startedAt)} - {formatTime(item.endedAt)} · {item.reason === "heartbeat_timeout" ? "离线超时自动结束" : "手动结束"}</span>
            </li>
          ))}
          {!state?.history?.length && <li><strong>暂无记录</strong><span>结束使用后会显示在这里。</span></li>}
        </ol>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);

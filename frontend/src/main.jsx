import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import "./styles.css";

const API_URL = "";
const AUTH_TOKEN_KEY = "cloudAccountUsageAuthToken";
const USAGE_SESSIONS_KEY = "cloudAccountUsageSessions";
const USERNAME_KEY = "cloudAccountUsageUsername";
const DEFAULT_TITLE = "学习共享空间";
const ACCOUNT_A_EMAIL = "Lifuduan2000@gmail.com";
const ACCOUNT_B_EMAIL = "hzy1026931135@gmail.com";

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
  if (account.name?.includes("B")) return `${account.name}（${ACCOUNT_B_EMAIL}）`;
  return account.name;
}

function groupedUsers(users) {
  const groups = ["组A", "组B", "未分组"];
  return groups.map((group) => ({
    group,
    users: users.filter((item) => (item.group || "未分组") === group),
  }));
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const GESTURE_POINTS = [
  { id: 1, col: 0, row: 0 }, { id: 2, col: 1, row: 0 }, { id: 3, col: 2, row: 0 },
  { id: 4, col: 0, row: 1 }, { id: 5, col: 1, row: 1 }, { id: 6, col: 2, row: 1 },
  { id: 7, col: 0, row: 2 }, { id: 8, col: 1, row: 2 }, { id: 9, col: 2, row: 2 },
];

function GesturePad({ onComplete, minPoints = 3 }) {
  const containerRef = useRef(null);
  const [path, setPath] = useState([]);
  const [dragPos, setDragPos] = useState(null);
  const pathRef = useRef([]);
  const draggingRef = useRef(false);

  const posOf = (p) => ({ x: p.col * 50, y: p.row * 50 });

  function getPointerPos(event) {
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    };
  }

  function hitTest(pos) {
    const threshold = 26;
    for (const p of GESTURE_POINTS) {
      const { x, y } = posOf(p);
      if (Math.hypot(pos.x - x, pos.y - y) < threshold) return p;
    }
    return null;
  }

  function setPathSafe(next) {
    pathRef.current = next;
    setPath(next);
  }

  function handleDown(event) {
    event.preventDefault();
    const pos = getPointerPos(event);
    const hit = hitTest(pos);
    if (!hit) return;
    draggingRef.current = true;
    setPathSafe([hit.id]);
    setDragPos(pos);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleMove(event) {
    if (!draggingRef.current) return;
    event.preventDefault();
    const pos = getPointerPos(event);
    setDragPos(pos);
    const hit = hitTest(pos);
    if (hit && !pathRef.current.includes(hit.id)) {
      setPathSafe([...pathRef.current, hit.id]);
    }
  }

  function handleUp() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragPos(null);
    const sequence = pathRef.current.join("");
    setPathSafe([]);
    if (sequence.length >= minPoints) onComplete(sequence);
  }

  const linePts = [...path].map((id) => posOf(GESTURE_POINTS.find((p) => p.id === id)));
  if (dragPos && path.length) linePts.push(dragPos);

  return (
    <div
      ref={containerRef}
      className="gesture-pad"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
    >
      <svg className="gesture-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        {linePts.length > 1 && (
          <polyline
            points={linePts.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      {GESTURE_POINTS.map((p) => (
        <span
          key={p.id}
          className={`gesture-dot${path.includes(p.id) ? " active" : ""}`}
          style={{ left: `${p.col * 50}%`, top: `${p.row * 50}%` }}
        >
          {p.id}
        </span>
      ))}
    </div>
  );
}

function GestureSetup() {
  const [sequence, setSequence] = useState("");
  const [hash, setHash] = useState("");
  const [copied, setCopied] = useState(false);

  async function handleComplete(seq) {
    setSequence(seq);
    setCopied(false);
    setHash(await sha256Hex(seq));
  }

  async function copyHash() {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="gesture-setup">
      <section className="panel gesture-setup-card">
        <h1>设置手势密码</h1>
        <p>在下方九宫格上画一个手势（至少连接 3 个点，按顺序），松开后下方会显示对应的 SHA-256 哈希。</p>
        <GesturePad onComplete={handleComplete} />
        {hash && (
          <div className="gesture-result">
            <p>手势序列：<strong>{sequence}</strong></p>
            <p>SHA-256 哈希（填到后端 .env 的 GESTURE_HASH）：</p>
            <code>{hash}</code>
            <button type="button" onClick={copyHash}>{copied ? "已复制" : "复制哈希"}</button>
          </div>
        )}
        <p className="hint">记住你的手势。之后在网页里画同样的手势即可查看验证码。此页面仅用于生成哈希，不保存任何内容。</p>
      </section>
    </main>
  );
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
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [passwordForm, setPasswordForm] = useState({ passphrase: "", newPassword: "" });
  const [groupChoice, setGroupChoice] = useState("未分组");
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [calendarAccountId, setCalendarAccountId] = useState("all");
  const [tick, setTick] = useState(Date.now());
  const [authLoading, setAuthLoading] = useState(false);
  const [usageLoading, setUsageLoading] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [otpModal, setOtpModal] = useState(null);
  const [otpPhase, setOtpPhase] = useState("gesture");
  const [otpResult, setOtpResult] = useState(null);
  const [otpCountdown, setOtpCountdown] = useState(0);
  const [otpError, setOtpError] = useState("");

  const authNoticeRef = useRef(null);
  const knownMessageIdsRef = useRef(new Set());
  const userRef = useRef(null);

  const token = () => localStorage.getItem(AUTH_TOKEN_KEY);

  useEffect(() => {
    userRef.current = user;
    if (user?.group) setGroupChoice(user.group);
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
      throw new Error("无法连接服务器，请稍后重试。");
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

  async function boot() {
    if (!token()) return;
    try {
      const payload = await api("/api/me");
      setUser(payload.user);
      userRef.current = payload.user;
      await refreshStatus({ silent: true });
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
    if (otpPhase !== "show" || !otpResult) return undefined;
    const timer = setInterval(() => {
      setOtpCountdown((count) => {
        if (count <= 1) {
          clearInterval(timer);
          setOtpPhase("expired");
          return 0;
        }
        return count - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [otpPhase, otpResult]);

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
  const recentMessages = (state?.messages || []).slice(0, 80);
  const systemMessages = recentMessages.filter((item) => item.system);
  const memberMessages = recentMessages.filter((item) => !item.system);
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

  function readOtpCache(key) {
    try {
      const raw = sessionStorage.getItem(`otp:${key}`);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const elapsed = (Date.now() - data.cachedAt) / 1000;
      if (elapsed >= 10) return null;
      const remaining = Math.max(0, Math.floor(data.remainingSeconds - elapsed));
      if (remaining <= 0) return null;
      return { otp: data.otp, remainingSeconds: remaining };
    } catch {
      return null;
    }
  }

  function writeOtpCache(key, otp, remainingSeconds) {
    try {
      sessionStorage.setItem(`otp:${key}`, JSON.stringify({ otp, remainingSeconds, cachedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  function accountKeyOf(account) {
    if (account.name?.includes("A")) return "A";
    if (account.name?.includes("B")) return "B";
    return "A";
  }

  function openOtp(account) {
    const key = accountKeyOf(account);
    const cache = readOtpCache(key);
    setOtpModal({ accountId: account.id, accountKey: key, label: account.name });
    if (cache) {
      setOtpResult({ otp: cache.otp, remainingSeconds: cache.remainingSeconds });
      setOtpCountdown(cache.remainingSeconds);
      setOtpPhase("show");
      setOtpError("");
    } else {
      setOtpResult(null);
      setOtpCountdown(0);
      setOtpPhase("gesture");
      setOtpError("");
    }
  }

  function closeOtp() {
    setOtpModal(null);
    setOtpPhase("gesture");
    setOtpResult(null);
    setOtpCountdown(0);
    setOtpError("");
  }

  async function handleGestureComplete(sequence) {
    const gestureHash = await sha256Hex(sequence);
    setOtpPhase("loading");
    setOtpError("");
    try {
      const payload = await api("/api/otp/get", {
        method: "POST",
        body: JSON.stringify({ gestureHash, account: otpModal.accountKey }),
      });
      setOtpResult({ otp: payload.otp, remainingSeconds: payload.remainingSeconds });
      setOtpCountdown(payload.remainingSeconds);
      setOtpPhase("show");
      writeOtpCache(otpModal.accountKey, payload.otp, payload.remainingSeconds);
    } catch (error) {
      setOtpError(error.message);
      setOtpPhase("gesture");
    }
  }

  function refreshOtp() {
    setOtpResult(null);
    setOtpCountdown(0);
    setOtpError("");
    setOtpPhase("gesture");
  }

  function clearLocalSession() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(USAGE_SESSIONS_KEY);
    userRef.current = null;
    setUser(null);
    setState(null);
  }

  async function logout() {
    await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    clearLocalSession();
  }

  async function changePassword(event) {
    event.preventDefault();
    setProfileMessage("正在修改密码...");
    try {
      await api("/api/profile/password", { method: "POST", body: JSON.stringify(passwordForm) });
      setPasswordForm({ passphrase: "", newPassword: "" });
      setProfileMessage("密码已修改。");
    } catch (error) {
      setProfileMessage(error.message);
    }
  }

  async function saveProfileGroup() {
    setProfileMessage("正在保存分组...");
    try {
      const payload = await api("/api/profile/group", { method: "PATCH", body: JSON.stringify({ group: groupChoice }) });
      setUser(payload.user);
      userRef.current = payload.user;
      receiveState(payload.state, { silent: true });
      setProfileMessage("默认分组已保存。");
    } catch (error) {
      setProfileMessage(error.message);
    }
  }

  async function deleteAccount() {
    setProfileMessage("正在注销账号...");
    try {
      await api("/api/profile", { method: "DELETE", body: JSON.stringify({ confirmText: deleteConfirm }) });
      clearLocalSession();
    } catch (error) {
      setProfileMessage(error.message);
    }
  }

  function accountActive(accountId) {
    return active.filter((item) => item.accountId === accountId);
  }

  function historyForAccount(accountId) {
    return (state?.history || []).filter((item) => item.accountId === accountId).slice(0, 80);
  }

  if (new URLSearchParams(window.location.search).has("setup-gesture")) {
    return <GestureSetup />;
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
          <div className="account-menu">
            <button className="user-chip menu-trigger" style={{ "--user-color": user.color }} onClick={() => setProfileMenuOpen((open) => !open)} type="button">
              {user.displayName}
            </button>
            {profileMenuOpen && (
              <section className="profile-menu" aria-label="个人资料菜单">
                <div className="profile-block">
                  <h3>查看账号密码</h3>
                  <p>账号：{user.username}</p>
                  <p>密码已加密保存，不能查看明文。输入静态口令 WoAiXueXi 后可修改密码。</p>
                  <form className="profile-form" onSubmit={changePassword}>
                    <input value={passwordForm.passphrase} onChange={(e) => setPasswordForm({ ...passwordForm, passphrase: e.target.value })} placeholder="静态口令" type="password" />
                    <input value={passwordForm.newPassword} onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} placeholder="新密码，至少 6 位" type="password" />
                    <button type="submit">修改密码</button>
                  </form>
                </div>
                <div className="profile-block">
                  <h3>默认分组</h3>
                  <select value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)}>
                    <option value="组A">组A</option>
                    <option value="组B">组B</option>
                    <option value="未分组">未分组</option>
                  </select>
                  <button type="button" onClick={saveProfileGroup}>保存分组</button>
                </div>
                <div className="profile-block danger-zone">
                  <h3>注销账号</h3>
                  <input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder="输入：注销账号" />
                  <button className="danger-button" type="button" onClick={deleteAccount}>注销账号</button>
                </div>
                {profileMessage && <p className={`notice ${profileMessage.includes("已") || profileMessage.includes("正在") ? "info" : "error"}`}>{profileMessage}</p>}
                <button className="logout-button" onClick={logout} type="button">退出登录</button>
              </section>
            )}
          </div>
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
          <div className="section-title overview-title">
            <h2>账号总览</h2>
            <a className="link-button gpt-link" href="https://chatgpt.com/" target="_blank" rel="noreferrer">
              <img src="/ChatGPT-Logo.png" alt="" />
              <span>启动GPT</span>
            </a>
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
                  <div className="account-card-actions">
                    <button className="otp-button" onClick={() => openOtp(account)} type="button">查看验证码</button>
                    <button onClick={() => mine ? stopUsage(account.id) : startUsage(account.id)} disabled={usageLoading === account.id} type="button">
                      {usageLoading === account.id ? "处理中..." : mine ? "我结束使用" : "我开始使用"}
                    </button>
                  </div>
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
            <p>当前已注册 {users.length} 人。成员按组展示，每个人的颜色会用于日历、在线名单和聊天。</p>
          </div>
          <div className="member-groups">
            {groupedUsers(users).map((group) => (
              <section className="member-group" key={group.group}>
                <h3>{group.group}</h3>
                <div className="user-grid">
                  {group.users.map((item) => (
                    <article className="user-card" key={item.id}>
                      <span className="user-color-block" style={{ background: item.color }} />
                      <div>
                        <strong>{item.displayName}</strong>
                        <span>{item.username} · {item.color}</span>
                      </div>
                    </article>
                  ))}
                  {!group.users.length && <p className="empty-text">暂无成员。</p>}
                </div>
              </section>
            ))}
          </div>
        </section>
      )}

      {page === "chat" && (
        <section className="page-section">
          <div className="section-title">
            <h2>聊天</h2>
            <p>系统动态和成员对话分开显示，真正聊天时更清爽。</p>
          </div>
          {"Notification" in window && Notification.permission === "default" && <button className="notify-button" onClick={requestNotificationPermission} type="button">开启消息提醒</button>}
          <form className="chat-compose" onSubmit={sendMessage}>
            <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="输入消息" maxLength={500} />
            <button disabled={chatLoading}>{chatLoading ? "发送中..." : "发送"}</button>
          </form>
          <div className="chat-columns">
            <section className="chat-column">
              <h3>成员聊天</h3>
              <div className="chat-list relaxed">
                {memberMessages.map((item) => (
                  <article className="chat-message" key={item.id}>
                    <div><strong style={{ color: item.userColor }}>{item.name}</strong><span>{formatTime(item.createdAt)}</span></div>
                    <p>{item.text}</p>
                  </article>
                ))}
                {!memberMessages.length && <p className="empty-text">暂无成员聊天。</p>}
              </div>
            </section>
            <section className="chat-column system-column">
              <h3>系统动态</h3>
              <div className="chat-list relaxed">
                {systemMessages.map((item) => (
                  <article className="chat-message system" key={item.id}>
                    <div><strong style={{ color: item.userColor }}>{item.name}</strong><span>{formatTime(item.createdAt)}</span></div>
                    <p>{item.text}</p>
                  </article>
                ))}
                {!systemMessages.length && <p className="empty-text">暂无系统动态。</p>}
              </div>
            </section>
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
      {otpModal && (
        <div className="otp-overlay" onClick={closeOtp}>
          <section className="otp-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <button className="otp-close" onClick={closeOtp} type="button" aria-label="关闭">×</button>
            <h3>{otpModal.label} · 登录验证码</h3>

            {otpPhase === "gesture" && (
              <div className="otp-gesture-step">
                <p>请画出你的手势密码。</p>
                <GesturePad onComplete={handleGestureComplete} />
                {otpError && <p className="notice error" role="alert">{otpError}</p>}
              </div>
            )}

            {otpPhase === "loading" && <p className="otp-loading">正在生成验证码…</p>}

            {otpPhase === "show" && otpResult && (
              <div className="otp-show">
                <p className="otp-digits">{otpResult.otp}</p>
                <div className="otp-progress">
                  <i style={{ width: `${Math.max(0, Math.min(100, (otpCountdown / 30) * 100))}%` }} />
                </div>
                <p className="otp-countdown">{otpCountdown > 0 ? `剩余 ${otpCountdown} 秒` : "已过期"}</p>
              </div>
            )}

            {otpPhase === "expired" && (
              <div className="otp-expired">
                <p className="otp-digits masked">******</p>
                <p>验证码已过期。</p>
                <button type="button" onClick={refreshOtp}>点击刷新</button>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);

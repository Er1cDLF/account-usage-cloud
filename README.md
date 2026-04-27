# 学习账号使用管理 Cloud 版

这个版本用于部署到：

- 前端：Vercel + React + FullCalendar
- 后端：Render Web Service + Node.js + WebSocket
- 数据库：Supabase PostgreSQL

功能包含注册登录、邀请码、免登录、在线占用提示、30 秒心跳、90 秒离线释放、聊天、使用日历和历史记录。

## 目录

```text
account-usage-cloud/
  backend/       Render 后端
  frontend/      Vercel 前端
  supabase/      数据库建表 SQL
  render.yaml    Render Blueprint
```

## 1. 创建 Supabase 数据库

1. 在 Supabase 创建项目。
2. 打开 SQL Editor。
3. 执行 `supabase/schema.sql`。

也可以在本地/Render shell 中执行：

```powershell
cd backend
copy .env.example .env
# 填好 DATABASE_URL 后
npm install
npm run migrate
```

`DATABASE_URL` 使用 Supabase 提供的 PostgreSQL 连接字符串。

## 2. 部署后端到 Render

Render 里创建 Web Service，Root Directory 选择：

```text
backend
```

Build Command：

```text
npm install
```

Start Command：

```text
npm start
```

环境变量：

```text
DATABASE_URL=你的 Supabase Postgres 连接串
INVITE_CODE=你的注册邀请码
SESSION_SECRET=一串很长的随机字符串
FRONTEND_ORIGIN=https://你的-vercel-域名.vercel.app
```

如果使用仓库根目录的 `render.yaml`，Render Blueprint 也可以直接识别。

## 3. 部署前端到 Vercel

Vercel 里导入 GitHub 仓库，Root Directory 选择：

```text
frontend
```

Build Command：

```text
npm run build
```

Output Directory：

```text
dist
```

环境变量：

```text
VITE_API_URL=https://你的-render-service.onrender.com
VITE_WS_URL=wss://你的-render-service.onrender.com/ws
```

`frontend/vercel.json` 已经配置了 SPA rewrite，刷新页面不会 404。

## 4. 本地开发

后端：

```powershell
cd backend
copy .env.example .env
npm install
npm run migrate
npm run dev
```

前端：

```powershell
cd frontend
copy .env.example .env
npm install
npm run dev
```

默认地址：

```text
前端：http://localhost:5173
后端：http://localhost:10000
WebSocket：ws://localhost:10000/ws
```

## 5. 数据库说明

核心表：

- `app_users`：用户、密码哈希
- `auth_sessions`：免登录令牌
- `usage_sessions`：账号占用时段
- `chat_messages`：聊天与系统消息

`usage_sessions` 上有一个部分唯一索引，保证同一时刻最多只有一个未结束的使用会话。

## 6. 当前限制

- 免费 Render 服务无人访问时会休眠，首次打开可能需要等待冷启动。
- 页面关闭会通过 `fetch(..., keepalive)` 尝试立即结束使用；如果浏览器或网络没来得及发送，后端会用 90 秒心跳超时兜底。
- 真正部署前不要使用默认 `SESSION_SECRET`。

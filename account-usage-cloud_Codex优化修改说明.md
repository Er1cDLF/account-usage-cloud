# account-usage-cloud 优化修改说明（给 Codex）

> 目标：在**不牺牲现有功能**的前提下，尽量降低长期运行成本、减少无意义流量、清理历史架构和无用依赖，并修正几个明显的安全/维护问题。  
> 原则：**不要为了“理论优化”增加不必要复杂度**。当前用户规模较小，重点是低成本、稳定、易维护。

---

## 一、当前项目情况

当前线上架构：

- 前端：React + Vite
- 后端：Node.js + Express + WebSocket
- Web 服务器：Nginx
- 数据库：Supabase PostgreSQL
- ECS：阿里云香港抢占式实例
- 当前前端与后端同源部署
- 当前后端 API 端口：10000
- 当前 Nginx：
  - 静态托管 `frontend/dist`
  - `/api/` 代理到后端
  - `/ws` 代理到后端 WebSocket

当前仓库主要实际使用目录：

```text
frontend/
backend/
supabase/
```

仓库中还存在旧架构或历史残留，例如：

```text
app/
pages/
public/
frontend/api/
render.yaml
vercel.json
frontend/vercel.json
根目录 package.json（vinext / next 相关）
```

当前真实线上部署已经不是 Vercel / Render / vinext / Next.js 主架构。

---

# 二、必须修改 1：前端不要每 10 秒全量轮询 `/api/status`

## 当前问题

当前 `frontend/src/main.jsx` 中，登录后存在类似：

```js
setInterval(() => refreshStatus(), 10000)
```

也就是：

```text
每个在线用户
↓
每 10 秒请求一次
↓
GET /api/status
↓
后端重新返回完整 state
```

当前 `/api/status` 的 `getState()` 会返回：

```text
accounts
active
history（最多 500 条）
messages（最多 300 条）
users
heartbeatTimeoutMs
serverTime
```

这意味着随着历史记录和聊天增加，即使没有任何人操作页面，也会反复传输相同数据。

这是当前最值得优化的流量点。

---

## 目标方案

**使用现有 WebSocket 作为主要实时同步方式。**

后端已经存在：

```text
/ws
WebSocketServer
broadcastState()
```

并且在以下事件中已经会触发状态广播：

- 注册
- 开始使用账号
- 结束使用账号
- 聊天
- 分组变化
- 离线超时
- 其他 state 改变

所以不要重写一套实时系统，只需要让前端真正接入现有 `/ws`。

---

## 修改要求

登录成功后：

```text
1. GET /api/me
2. GET /api/status
3. 建立 WebSocket
4. 后续主要依靠 WebSocket 接收状态变化
```

WebSocket 地址：

```js
/ws?token=<当前登录 token>
```

自动根据 HTTP / HTTPS 选择：

```js
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${protocol}//${location.host}/ws?token=${encodeURIComponent(token())}`;
```

收到：

```json
{
  "type": "state",
  "state": { ... }
}
```

时：

```js
receiveState(payload.state)
```

---

## WebSocket 重连

必须实现简单自动重连。

建议：

```text
连接断开
↓
3~5 秒后重新连接
↓
重新连接成功
↓
主动执行一次 refreshStatus()
```

不需要复杂指数退避。

---

## HTTP 轮询策略

删除当前：

```text
每 10 秒 /api/status
```

可以保留一个**低频兜底同步**：

```text
每 5 分钟一次
```

或者：

```text
仅在 WebSocket 断线时轮询
```

推荐后者。

最简单实现：

```text
WebSocket 正常：
    不轮询

WebSocket 断线：
    每 30 秒 refreshStatus()

WebSocket 恢复：
    停止轮询
```

---

# 三、必须保留 heartbeat

不要删除当前：

```text
POST /api/heartbeat
```

目前：

```text
约每 30 秒发送一次
```

它用于：

```text
判断用户是否仍然在线
防止网页异常关闭后 usage_session 一直保持 active
```

请求很小，对流量基本没有影响。

所以：

```text
WebSocket：负责状态实时同步
heartbeat：负责使用状态保活
```

二者功能不同。

---

# 四、不要做 IndexedDB 本地数据库同步

暂时不要为了节省流量加入：

```text
IndexedDB
复杂增量数据库同步
客户端历史记录数据库
版本 diff 系统
```

原因：

只要去掉“每 10 秒全量 `/api/status`”，当前规模下流量已经足够低。

浏览器正常 HTTP 缓存 + WebSocket 已经够用。

---

# 五、优化静态资源缓存

目标：

```text
静态文件第一次加载
↓
浏览器本地缓存
↓
后续访问直接使用缓存
↓
只有文件变化才重新下载
```

优先通过 Nginx 实现。

建议为 Vite 构建产物设置：

```nginx
location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
}
```

对图片：

```nginx
location ~* \.(png|jpg|jpeg|gif|svg|webp|ico)$ {
    expires 7d;
    add_header Cache-Control "public";
}
```

`index.html` 不要长期缓存：

```nginx
location = /index.html {
    add_header Cache-Control "no-cache";
}
```

注意：

Vite 的 `/assets/xxx-hash.js` 自带 hash，非常适合长期缓存。

---

# 六、压缩 favicon 和 Logo

当前静态文件中：

```text
frontend/public/Logo.png
约 880 KB

frontend/public/favicon.png
约 880 KB

frontend/public/ChatGPT-Logo.png
约 173 KB
```

其中：

```text
favicon.png 与 Logo.png 大小完全一样
```

favicon 明显不应该接近 1 MB。

要求：

## favicon

生成适合浏览器 favicon 的小尺寸版本，例如：

```text
32×32
48×48
64×64
```

优先控制：

```text
< 30 KB
```

如果使用 PNG 即可，不必为了几 KB 再引入复杂转换工具。

---

## Logo

如果不明显降低视觉质量，可以将 Logo 压缩。

目标：

```text
最好 < 200 KB
```

但如果视觉损失明显，可以保留原图。

**这一项主要为了加载速度，不是为了省阿里云费用。**

---

# 七、清理前端无用依赖

当前 `frontend/package.json` 中包含：

```json
"cors"
"express"
"pg"
```

这些属于后端依赖，React/Vite 前端不需要。

删除：

```text
cors
express
pg
```

保留前端实际需要：

```text
react
react-dom
vite
@vitejs/plugin-react
@fullcalendar/*
```

然后：

```bash
npm install
npm run build
```

确认能够正常构建。

---

# 八、清理仓库历史架构

目标：

避免以后 Codex、开发者或部署脚本误判真正项目入口。

当前实际架构：

```text
frontend/
backend/
supabase/
```

检查并清理明显属于旧方案的内容。

候选：

```text
app/
pages/
public/
frontend/api/
render.yaml
vercel.json
frontend/vercel.json
根目录 package.json
```

但是：

**删除前必须先确认这些文件没有被当前 ECS 构建、运行或脚本引用。**

不要盲删。

建议步骤：

```text
1. 搜索引用
2. 确认 ECS 当前启动脚本
3. 确认 frontend npm build
4. 确认 backend npm start
5. 再删除旧架构
```

如果某些文件只是历史残留，直接删除。

---

# 九、更新 README

README 应改成当前 ECS 架构。

不要继续把：

```text
Vercel
Render
vinext
```

描述成主部署方式。

README 至少说明：

```text
项目结构
frontend
backend
supabase

前端构建：
cd frontend
npm install
npm run build

后端：
cd backend
npm install
npm start

后端端口：
10000

Nginx：
托管 frontend/dist
代理 /api
代理 /ws

数据库：
Supabase PostgreSQL
```

---

# 十、修复静态管理口令问题

当前前端页面中存在类似：

```text
输入静态口令 WoAiXueXi 后可修改密码
```

这是不合理的。

要求：

## 前端

删除：

```text
WoAiXueXi
```

不要向用户显示真正口令。

改成：

```text
请输入管理口令
```

即可。

---

## 后端

当前后端类似：

```js
const INVITE_CODE = process.env.INVITE_CODE || "WAYTOAGI";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-me";
const PROFILE_PASSPHRASE = process.env.PROFILE_PASSPHRASE || "WoAiXueXi";
```

生产环境不要有可直接使用的默认安全值。

建议：

```js
const requiredEnv = [
  "DATABASE_URL",
  "INVITE_CODE",
  "SESSION_SECRET",
  "PROFILE_PASSPHRASE",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}
```

然后：

```js
const INVITE_CODE = process.env.INVITE_CODE;
const SESSION_SECRET = process.env.SESSION_SECRET;
const PROFILE_PASSPHRASE = process.env.PROFILE_PASSPHRASE;
```

`PORT` 可以继续有默认值：

```js
const PORT = Number(process.env.PORT || 10000);
```

---

# 十一、不要为了 HTTPS 做额外改动

当前项目暂时不要求 HTTPS。

不要：

```text
自动安装 Certbot
自动申请证书
强制 HTTP → HTTPS
修改当前 IP 访问方式
```

保持当前 HTTP 可以正常访问。

---

# 十二、阿里云费用优化：系统盘 40 GiB → 20 GiB

这一项不是代码修改。

当前：

```text
ECS 系统盘约 40 GiB
```

计划：

```text
未来新建 ECS 时选择 20 GiB 系统盘
```

不要尝试直接缩小现有云盘。

推荐迁移方案：

```text
旧 ECS
↓
新建相同地域香港 ECS
↓
系统盘选 20 GiB
↓
安装 Node / npm / Git / Nginx
↓
clone GitHub
↓
frontend build
↓
backend npm install
↓
恢复 .env
↓
配置 Nginx
↓
测试
↓
EIP 从旧 ECS 解绑
↓
绑定新 ECS
↓
确认正常
↓
删除旧 ECS
```

数据库在 Supabase，因此服务器迁移不需要迁移核心数据库数据。

---

# 十三、不要为了省流量过度优化

当前阿里云香港公网流量免费额度足够本项目规模使用。

所以暂时不要增加：

```text
CDN
OSS 前端托管
复杂增量同步
图片服务器
Redis
消息队列
客户端数据库
Service Worker 离线应用
```

除非以后真实流量统计表明有必要。

---

# 十四、后端 state 可以做的轻量优化

当前：

```text
/api/status
```

返回：

```text
500 条 history
300 条 messages
```

在 WebSocket 改好以后，可以进一步轻量优化：

## 首页状态

WebSocket 状态中优先包含：

```text
accounts
active
users
最近少量 messages
```

不要每次实时状态变化都广播全部：

```text
500 history
300 messages
```

但这属于**第二优先级**。

如果修改会明显增加代码复杂度，可以先不做。

第一阶段只需要：

```text
取消 10 秒轮询
使用 WebSocket
```

即可。

---

# 十五、验收标准

修改后必须满足以下功能全部正常。

## 登录

```text
注册正常
登录正常
刷新页面仍保持登录
退出登录正常
```

---

## 使用状态

```text
用户 A 点击“开始使用”
用户 B 页面无需刷新，几秒内自动看到 A 在线

A 点击“结束使用”
B 页面自动更新

关闭 A 页面
heartbeat 超时后自动结束使用
```

---

## 聊天

```text
A 发消息
B 不刷新页面即可看到

B 浏览器切到后台时
仍保留原有未读提示 / Notification 行为
```

---

## 日历

```text
历史记录仍正常
正在使用中的记录仍正常显示
```

---

## WebSocket

浏览器 DevTools → Network → WS：

应该看到：

```text
/ws?token=...
```

保持连接。

正常情况下 Network 不应该再出现：

```text
每 10 秒一次 /api/status
```

---

## 流量目标

正常在线但无人操作时：

```text
主要只有 WebSocket ping/pong
以及 heartbeat
```

不要持续传输完整：

```text
history
messages
users
accounts
```

---

## 构建

必须确保：

```bash
cd frontend
npm install
npm run build
```

成功。

以及：

```bash
cd backend
npm install
npm start
```

成功。

---

# 十六、Codex 修改原则

请严格遵循：

```text
不要重写整个项目
不要换技术栈
不要改 UI 风格
不要删除现有功能
不要改数据库结构，除非确实必要
不要引入 Redis
不要引入新的云服务
不要引入复杂缓存系统
不要为 HTTPS 做修改
```

优先：

```text
最小改动
复用现有代码
复用现有 WebSocket
保持当前 UI
保持当前 API 行为
降低无意义网络请求
清理历史代码
```

---

# 十七、建议执行顺序

Codex 请按以下顺序执行：

```text
1. 阅读整个仓库结构
2. 确认当前 frontend / backend 真实运行路径
3. 前端接入现有 WebSocket
4. 删除 10 秒 /api/status 全量轮询
5. 保留 heartbeat
6. 增加 WebSocket 断线重连
7. 增加断线期间低频 HTTP fallback
8. 测试实时状态
9. 清理 frontend 无用依赖
10. 修正管理口令显示
11. 修正后端环境变量默认值
12. 检查并清理旧 Vercel / Render / Next / vinext 文件
13. 更新 README
14. 优化 favicon
15. npm build
16. 检查 git diff
17. 最后汇报所有修改
```

---

# 十八、最终要求 Codex 输出

完成后请输出：

```text
1. 修改了哪些文件
2. 每个文件修改了什么
3. 删除了哪些旧文件
4. 是否有需要我手动操作的服务器步骤
5. frontend build 是否成功
6. backend 是否能正常启动
7. WebSocket 是否替代了 10 秒轮询
8. 是否仍保留 heartbeat
9. 是否发现其他明显问题
```

如果需要修改 Nginx，请给出：

```text
完整 nginx server 配置
```

不要只给局部片段。

如果涉及服务器命令，请给出：

```text
可直接复制执行的命令
```

但不要自动删除旧 ECS 或修改阿里云资源。


# OTP 功能开发与部署移交说明

> 整理时间：2026-09。本文档记录「手势密码查看 TOTP 验证码」功能从开发、部署到运维的完整过程，作为项目移交依据。
>
> 本文档**不包含**任何真实密钥、手势哈希、数据库密码或 TOTP secret。所有敏感值都只保存在服务器 `.env` 中。

---

## 一、功能是什么

成员登录网页后，在「账号总览」页面的账号卡片上点击「**查看验证码**」，先画一个**九宫格手势密码**，验证通过后显示该共享账号（ChatGPT）官网登录所需的 **6 位 TOTP 一次性验证码**，并带 30 秒倒计时。

核心安全原则：

- TOTP 密钥（seed）**只保存在后端 `.env`**，绝不出现在前端代码或网络响应中；
- 前端只负责「画手势 + 展示结果」，TOTP 生成逻辑完全在后端；
- OTP 接口要求有效登录令牌，未授权成员和未登录访客无法调用；
- 加了**限流**（1 分钟 10 次），防止恶意刷接口打爆 512MB 内存的小服务器。

---

## 二、代码改动清单

已提交到 GitHub，commit：`5604b6d`（message: `Add gesture-password TOTP OTP feature`）。

### 后端 `backend/`

| 文件 | 改动 |
| --- | --- |
| `package.json` | 新增依赖 `otplib@^12.0.1`、`express-rate-limit@^7.4.0` |
| `src/server.js` | ① import `authenticator`（otplib）和 `rateLimit`；② 新增环境变量 `GESTURE_HASH`、`TOTP_SECRET_A`、`TOTP_SECRET_B`；③ 新增 `app.set("trust proxy", 1)`；④ 新增 `POST /api/otp/get` 接口（限流 + `timingSafeEqual` 校验 + `authenticator.generate` 生成 TOTP） |
| `.env.example` | 新增 `GESTURE_HASH`、`TOTP_SECRET_A`、`TOTP_SECRET_B` 三个占位变量（带注释） |

### 前端 `frontend/`

| 文件 | 改动 |
| --- | --- |
| `src/main.jsx` | ① 新增 `sha256Hex()`（用 `crypto.subtle.digest` 算 SHA-256）；② 新增 `GesturePad` 组件（3×3 九宫格手势输入，触屏/鼠标都支持）；③ 新增 `GestureSetup` 组件（`?setup-gesture` 设置页）；④ App 内新增 OTP 状态与处理函数（`openOtp`/`handleGestureComplete`/`closeOtp`/`refreshOtp`）、倒计时 `useEffect`、`setup-gesture` 路由判断；⑤ 账号卡片新增「查看验证码」按钮；⑥ 新增 OTP 弹窗（手势区 / 加载中 / 6 位数字 + 倒计时进度条 / 过期打码） |
| `src/styles.css` | 新增手势九宫格、OTP 弹窗、倒计时进度条、验证码数字等样式 |

---

## 三、接口规范

### `POST /api/otp/get`

该接口必须携带当前登录令牌：`Authorization: Bearer <token>`。

请求体：

```json
{ "gestureHash": "手势序列的 SHA-256 十六进制小写哈希（64 位）", "account": "A" }
```

`account` 取 `"A"` 或 `"B"`（对应账号 A / B）。

成功响应：

```json
{ "ok": true, "otp": "492810", "remainingSeconds": 14 }
```

失败响应：

```json
{ "ok": false, "error": "手势错误" }
```

或 HTTP 429（限流）：

```json
{ "ok": false, "error": "请求过于频繁，请稍后再试。" }
```

逻辑要点：

- `gestureHash` 用正则 `/^[0-9a-f]{64}$/` 先校验格式，再用 `crypto.timingSafeEqual` 与 `.env` 的 `GESTURE_HASH` 比对（防时序攻击）；
- 通过后按 `account` 读取对应 `TOTP_SECRET_A` / `TOTP_SECRET_B`，用 `authenticator.generate(secret)` 生成当前 6 位 TOTP；
- `remainingSeconds = 30 - (Date.now()/1000 % 30)`；
- **绝不返回 secret**。

### 手势密码编码规则（重要）

九宫格编号（左上到右下）：

```text
1 2 3
4 5 6
7 8 9
```

- 手势序列 = 连接点编号按顺序拼接的字符串，例如「1→4→7→8→9」= `14789`；
- `GESTURE_HASH` = `SHA256("14789")` 的十六进制小写字符串；
- 前端 `GesturePad` 与后端校验必须用**同一套编号规则**。

---

## 四、环境变量

后端 `backend/.env` 新增三个变量（`backend/.env.example` 已有模板）：

```env
GESTURE_HASH=<手势序列的 SHA-256 小写哈希>
TOTP_SECRET_A=<账号 A 的 TOTP 密钥，Base32>
TOTP_SECRET_B=<账号 B 的 TOTP 密钥，Base32>
```

- `.env` 已被 `.gitignore` 忽略，不会上传到 GitHub；
- TOTP 密钥和手势哈希都**不要**发到聊天、不要提交到仓库。

---

## 五、部署记录（本次已执行的步骤）

服务器路径：`/opt/account-usage-cloud`，香港 ECS，Alpine Linux，2 vCPU / 512MB 内存。

1. 同步代码：`git pull`（切到 `main`，落到 `5604b6d`）；
2. 后端装依赖：`cd backend && npm install`（`added 8 packages`）；
3. 前端构建：`cd frontend && npm run build`（`✓ built in 3.27s`）；
4. 配置 `.env`：已填 `GESTURE_HASH`、`TOTP_SECRET_A`；`TOTP_SECRET_B` **待补**；
5. 用 pm2 启动后端：`pm2 start src/server.js --name account-usage-backend` + `pm2 save`；
6. 健康检查：`curl http://127.0.0.1:10000/health` 返回 `{"ok":true}`。

后端进程现在由 **pm2** 管理，进程名 `account-usage-backend`（之前是裸 `node` 跑的，本次已改用 pm2）。

---

## 六、运维速查

> 规律：**改前端 → 重新构建；改后端/配置 → `pm2 restart`；改密钥/手势 → 改 `.env` + `pm2 restart`。**

### 改手势密码

```sh
sed -i '/^GESTURE_HASH=/d' /opt/account-usage-cloud/backend/.env
echo 'GESTURE_HASH=新哈希' >> /opt/account-usage-cloud/backend/.env
pm2 restart account-usage-backend
```

（新哈希通过浏览器打开 `https://study-share.duckdns.org/?setup-gesture` 画手势获取）

### 改 TOTP 密钥

```sh
sed -i '/^TOTP_SECRET_A=/d' /opt/account-usage-cloud/backend/.env
echo 'TOTP_SECRET_A=新密钥' >> /opt/account-usage-cloud/backend/.env
pm2 restart account-usage-backend
```

（改账号 B 把 `TOTP_SECRET_A` 换成 `TOTP_SECRET_B`）

### 改前端页面

```sh
cd /opt/account-usage-cloud/frontend && npm run build
```

### 改后端逻辑

```sh
pm2 restart account-usage-backend
```

### 查看后端日志

```sh
pm2 logs account-usage-backend --lines 50
```

### 本地改代码后同步到服务器

```sh
# 本地
git add . && git commit -m "说明" && git push origin main
# 服务器
cd /opt/account-usage-cloud && git pull
```

---

## 七、安全注意事项

1. **TOTP secret 与手势哈希只存在 `.env`**，不要发聊天、不要提交到仓库。
2. **手势哈希有被暴力破解的风险**：九宫格手势空间很小（约百万级），一旦哈希泄露，攻击者可枚举所有手势序列反推出你的手势。所以手势哈希也要当密码对待。
3. **限流**：接口已设 1 分钟 10 次；后端已加 `trust proxy`，但 Nginx **尚未配置 `X-Forwarded-For`**（用户当时主动跳过），因此当前限流是**全站共享**（所有人合计 1 分钟 10 次），触发后等一分钟即可。若要按 IP 区分，需在 Nginx 的 `/api`、`/ws` 转发里补 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` 并 `rc-service nginx reload`。
4. **倒计时过期不自动刷新**：前端过期后显示 `******`，需用户手动点「点击刷新」重新画手势，符合安全要求。
5. **前端缓存**：同一会话 10 秒内再次点开，用 `sessionStorage` 缓存，避免重复请求。

---

## 八、已知事项 / 未完成项

- **`TOTP_SECRET_B` 尚未配置**（账号 B 的 TOTP 密钥当时未拿到，待补）。补上后 `pm2 restart account-usage-backend` 即可，账号 B 的「查看验证码」才可用。
- **Nginx 未配 X-Forwarded-For**（见上，限流全站共享）。
- 账号 A / B 的 TOTP 密钥获取方式：登录对应 ChatGPT 账号 → 设置「两步验证 / Two-factor authentication」→ 若之前开启过需**重新开启**（密钥只在开启时显示一次）→ 复制二维码旁/「手动输入」的 Base32 字符串。

---

## 九、验收（建议上线前走一遍）

1. 登录网页 → 账号 A 卡片点「查看验证码」→ 画正确手势 → 显示 6 位数字 + 倒计时；
2. 画错误手势 → 提示「手势错误」；
3. 倒计时归零 → 变 `******`，点「点击刷新」重新画手势；
4. 连续多次请求 → 触发 429「请求过于频繁」；
5. 账号 B 待补 `TOTP_SECRET_B` 后再测。

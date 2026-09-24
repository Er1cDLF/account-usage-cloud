# OTP 功能开发与部署移交说明

> 更新时间：2026-09-24。九宫格手势密码已经取消。本文档不包含任何真实 TOTP 密钥、数据库密码或其他凭证。

## 一、当前功能

已登录且经过管理员授权的成员，在“账号总览”中点击“查看验证码”，网页直接显示对应学习账号的 6 位 TOTP 一次性验证码和剩余秒数。

- TOTP 密钥只保存在后端 `.env`，不进入前端代码和网络响应。
- OTP 接口必须携带有效登录令牌。
- 未授权账号无法登录，已经取消授权的旧会话也不能调用接口。
- 接口保留 1 分钟 10 次限流。
- 验证码过期后显示 `******`，点击“点击刷新”可直接获取新验证码。
- 同一浏览器会话短时间重复打开时使用 `sessionStorage` 缓存，减少重复请求。

## 二、接口

### `POST /api/otp/get`

请求头：

```text
Authorization: Bearer <当前登录令牌>
```

请求体：

```json
{ "account": "A" }
```

`account` 只能是 `A` 或 `B`。

成功响应：

```json
{ "ok": true, "otp": "492810", "remainingSeconds": 14 }
```

常见失败：

- 未登录或授权已取消：HTTP 401。
- 当前账号没有配置 TOTP 密钥：HTTP 503。
- 请求过于频繁：HTTP 429。

## 三、环境变量

后端 `backend/.env` 使用：

```env
TOTP_SECRET_A=<账号 A 的 Base32 TOTP 密钥>
TOTP_SECRET_B=<账号 B 的 Base32 TOTP 密钥>
```

`GESTURE_HASH` 已经停用，可以从服务器 `.env` 删除。即使暂时保留，后端也不会读取。

TOTP 密钥不要发送到聊天，不要提交到 GitHub。

## 四、更新密钥

账号 A：

```sh
sed -i '/^TOTP_SECRET_A=/d' /opt/account-usage-cloud/backend/.env
echo 'TOTP_SECRET_A=新密钥' >> /opt/account-usage-cloud/backend/.env
pm2 restart account-usage-backend --update-env
```

账号 B 将变量名替换成 `TOTP_SECRET_B`。

## 五、部署

```sh
cd /opt/account-usage-cloud
git pull

cd backend
npm install
pm2 restart account-usage-backend --update-env
pm2 save

cd ../frontend
npm install
npm run build
```

检查：

```sh
curl http://127.0.0.1:10000/health
pm2 logs account-usage-backend --lines 30
```

## 六、验收

1. 未登录访问 OTP 接口返回 401。
2. 已授权成员登录后点击“查看验证码”，直接出现 6 位数字和倒计时。
3. 倒计时归零后显示 `******`，点击刷新可以重新获取。
4. 管理员取消某成员授权后，该成员无法继续获取验证码。
5. 账号 B 只有配置 `TOTP_SECRET_B` 后才可使用。

## 七、当前已知事项

- 账号 B 的密钥是否已配置，需要在服务器 `.env` 中确认。
- Nginx 若没有传递 `X-Forwarded-For`，限流可能由所有用户共享。

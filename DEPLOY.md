# Ant Motors 部署说明（B 方案 · 正式账户体系）

## 一、为什么必须常驻后端

登录 / 注册 / 找回密码全部由 `server/server.js` 处理（密码哈希、验证码、失败锁定都在服务端）。
纯静态托管（只上传 `app/index.html`）**无法注册**，只能离线看车。

## 二、本地启动（自用 / 测试）

```bash
cd /path/to/project
PORT=8899 DB="$PWD/.workbuddy/data/antmotors.db" node server/server.js
```

打开 `http://localhost:8899`，在「设置 → 服务器地址」填 `http://localhost:8899` 即可注册。

同一 WiFi 下手机访问：把地址换成电脑内网 IP，例如 `http://192.168.1.20:8899`。

## 三、公网常驻部署

### 方案 A：自有 VPS（推荐，数据自己掌握）

```bash
# 1. 装 Node 18+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. 上传项目后
cd /opt/antmotors
npm i -g pm2
PORT=8080 DB=/opt/antmotors/data/antmotors.db pm2 start server/server.js --name antmotors
pm2 save && pm2 startup     # 开机自启

# 3. Nginx 反代 + HTTPS
sudo certbot --nginx -d sync.yourdomain.com
```

Nginx 配置片段：

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
}
```

### 方案 B：Railway / Render（零运维，几分钟上线）

项目根目录已备好 `package.json`（`npm start` → `node server/server.js`）。

1. 把代码推到 GitHub
2. Railway → New Project → Deploy from GitHub
3. 环境变量：`PORT`（平台自动注入）、`DB=/data/antmotors.db`
4. **务必挂载持久卷**到 `/data`，否则每次重启数据库会被清空

> ⚠️ Render 免费层会休眠，首次访问慢 30 秒左右；付费层无此问题。

## 四、密码策略（服务端强制）

- 长度 8–64 位
- 必须含：小写字母、大写字母、数字、符号
- 存储：`node:crypto` scrypt 加盐哈希，永不明文
- 连续 5 次登录失败 → 锁定 15 分钟
- 重置密码后，该账号所有旧 token 立即失效（全端登出）

## 五、找回密码的邮件配置

未配置邮件时为「自用模式」：验证码打印在服务器控制台，并直接回填到页面。
要真正发邮件，在 `server/config.json` 里加：

```json
{
  "permanentCompanyCodes": ["你的邀请码"],
  "smtp": {
    "host": "smtp.qq.com",
    "port": 465,
    "secure": true,
    "user": "you@qq.com",
    "pass": "授权码（不是登录密码）",
    "from": "Ant Motors <you@qq.com>"
  }
}
```

QQ 邮箱 / 163 需在邮箱设置里开启 SMTP 并生成**授权码**，填 `pass` 字段。

## 六、老账号兼容

旧的 4–8 位 PIN 账号**仍可登录**，登录后会提示「请通过忘记密码设置正式密码」。
不会强制踢人，可平滑过渡。

## 七、数据备份

数据库是单文件，直接复制即可：

```bash
cp data/antmotors.db data/antmotors.$(date +%F).db
```

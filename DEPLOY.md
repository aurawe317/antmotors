# Ant Motors 部署说明（B 方案 · 正式账户体系）

## 一、为什么必须常驻后端

登录 / 注册 / 找回密码全部由 `server/server.js` 处理（密码哈希、验证码、失败锁定都在服务端）。
纯静态托管（只上传 `app/index.html`）**无法注册**，只能离线看车。

---

## 二、本地启动（自用 / 测试）

```bash
cd /path/to/project
PORT=8899 DB="$PWD/.workbuddy/data/antmotors.db" node server/server.js
```

打开 `http://localhost:8899`，在「设置 → 服务器地址」填 `http://localhost:8899` 即可注册。
同一 WiFi 下手机访问：把地址换成电脑内网 IP，例如 `http://192.168.1.20:8899`。

> 需要 Node **≥ 22.13.0**（`node:sqlite` 内置模块要求）。可用 `nvm use` 切到本仓库 `.nvmrc` 指定的版本。

---

## 三、公网常驻部署

### 方案 B（已选）：Railway / Render — 零运维，几分钟上线

#### 路径 1 · Railway（推荐，$5/月起步）

1. **推到 GitHub**（仓库已 git init 完毕）
   ```bash
   # 在 GitHub 上新建空仓库 antmotors，然后：
   git remote add origin git@github.com:你的用户名/antmotors.git
   git branch -M main
   git push -u origin main
   ```

2. **Railway 接入**
   - 打开 https://railway.app → New Project → Deploy from GitHub repo
   - 选 `antmotors` 仓库
   - Railway 会自动识别 `Dockerfile` 开始构建

3. **【必做】挂载持久卷**
   - 进项目 → 点 service → 顶部 `Volumes` 标签 → `+ New Volume`
   - Mount Path 填 `/data`（与 `Dockerfile` 里的 `ENV DB=/data/antmotors.db` 对齐）
   - 一定要做，否则**每次重新部署数据库会被清空**

4. **设置环境变量**（service → `Variables` 标签）
   ```
   PERMANENT_CODES = ANT-XXXX   ← 你的自用永久会员邀请码
   SELF_SERVE_RESET_CODE = true ← 没配 SMTP 时，验证码会回显到页面
   ```
   `PORT` 由 Railway 自动注入，不用设。

5. **拿公网地址**
   - service → `Settings` → `Domains` → `Generate Domain`
   - 得到形如 `antmotors-production.up.railway.app` 的地址
   - 在 App「设置 → 服务器地址」填这个地址，完成绑定

6. **查看日志 / 重启**
   - service → `Deployments` 标签 → 点最新一次 → `View Logs`
   - 启动时若看到 `storage: persistent volume at /data ✓` 即挂载成功

#### 路径 2 · Render（备选）

- 打开 https://render.com → New → Blueprint → 选 GitHub 仓库
- Render 自动读 `render.yaml` 创建一个 `web` 服务 + 1GB 磁盘
- 同样在 `Environment` 里设 `PERMANENT_CODES`、`SELF_SERVE_RESET_CODE`
- 免费层会休眠，首次访问要等 30 秒；付费层（Starter $7/月）无此问题

---

### 方案 A：自有 VPS（数据自己掌握，长期最省）

适合你决定"对外收费运营"之后再迁。

```bash
# 1. 装 Node 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
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
  client_max_body_size 20m;   # 注册/上传图需要
}
```

---

## 四、B → A 数据迁移（之后想从 Railway 迁到 VPS 时）

数据库就是单文件 `antmotors.db`，直接拷过去：

```bash
# 在 Railway（或其控制台 shell）打包
# 用 railway run 执行：
railway run cp /data/antmotors.db /tmp/migrate.db
railway run cat /tmp/migrate.db > antmotors.db   # 下载

# 拷到 VPS
scp antmotors.db user@your-vps:/opt/antmotors/data/antmotors.db
```

代码本身从 Git 同步就行（`git pull`）。配置改成在 VPS 上写 `server/config.json`（或继续用环境变量，两边格式一致）。

---

## 五、密码策略（服务端强制）

- 长度 8–64 位
- 必须含：小写字母、大写字母、数字、符号
- 存储：`node:crypto` scrypt 加盐哈希，永不明文
- 连续 5 次登录失败 → 锁定 15 分钟
- 重置密码后，该账号所有旧 token 立即失效（全端登出）

---

## 六、找回密码的邮件配置

未配置邮件时为「自用模式」：验证码打印在服务器控制台，并直接回填到页面（`SELF_SERVE_RESET_CODE=true`）。
要真正发邮件，两种方式选一种：

### 方式 1 · 环境变量（推荐，云端好管理）

```
SMTP_HOST = smtp.qq.com
SMTP_PORT = 465
SMTP_USER = you@qq.com
SMTP_PASS = 授权码（不是登录密码）
SMTP_FROM = Ant Motors <you@qq.com>
SELF_SERVE_RESET_CODE = false   ← 一旦配好 SMTP，就关掉回显
```

### 方式 2 · `server/config.json`（本地开发用）

```json
{
  "permanentCompanyCodes": ["你的邀请码"],
  "smtp": {
    "host": "smtp.qq.com",
    "port": 465,
    "secure": true,
    "user": "you@qq.com",
    "pass": "授权码",
    "from": "Ant Motors <you@qq.com>"
  }
}
```

QQ 邮箱 / 163 / Gmail 需在邮箱设置里开启 SMTP 并生成**授权码**，填 `pass` 字段。
**配置优先级**：环境变量 > `server/config.json`（即云端改 env 即可生效，不用动文件）。

---

## 七、老账号兼容

旧的 4–8 位 PIN 账号**仍可登录**，登录后会提示「请通过忘记密码设置正式密码」。
不会强制踢人，可平滑过渡。种子数据（`server/seed.json`）里的演示账号（`boss / 8888` 等）也照常可用。

---

## 八、Alipay 收款配置（之后上线时再配）

暂未配 Alipay 时为「模拟模式」——点击订阅会立刻激活会员，让你跑通全流程。

正式上线时选一种：

### 方式 1 · 环境变量
```
ALIPAY_APP_ID          = 2021000000000000
ALIPAY_PRIVATE_KEY     = -----BEGIN RSA PRIVATE KEY-----...（含换行）
ALIPAY_PUBLIC_KEY      = -----BEGIN PUBLIC KEY-----...
ALIPAY_NOTIFY_URL      = https://yourdomain.com/api/alipay/notify
ALIPAY_GATEWAY         = https://openapi.alipay.com/gateway.do
```

### 方式 2 · `server/alipay.config.json`（本地）

参考 `server/alipay.config.json.example`。

---

## 九、数据备份

数据库是单文件，直接复制即可：

```bash
cp data/antmotors.db data/antmotors.$(date +%F).db
```

云端建议每天跑一次定时备份（Railway → Cron Job，把 `/data/antmotors.db` 拷到外部存储）。

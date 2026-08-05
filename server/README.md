# Ant Motors — 同步服务器

让老板、合伙人、经理、销售在**各自的手机上看到同一份库存和价格**。
零第三方依赖，只需要 Node ≥ 22.5（用 Node 内置的 `node:sqlite` 和 `node:http`）。

---

## 1. 启动

```bash
cd server
node server.js
# → http://localhost:8787
```

可用环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `DB` | `./antmotors.db` | SQLite 数据库文件路径（**这就是全部数据，备份它就够了**） |
| `APP_DIR` | `../app` | 前端目录；服务器同时把 App 托管在 `/`，一个进程搞定 |

启动后 `http://<服务器地址>/` 就是员工/客户打开的网页，`/api/*` 是同步接口。

## 2. 默认账号（**上线前必须改**）

首次启动会用 `seed.json` 初始化 9 台车和 6 个账号：

| 账号 ID | 角色 | 默认 PIN |
|---|---|---|
| `boss` | 老板 | `8888` |
| `partnerA` / `partnerB` | 合伙人 | `1111` / `2222` |
| `kwame` | 高级销售 | `1001` |
| `ama` | 销售 | `1002` |
| `kwasi` | 销售 | `1003` |

改 PIN：编辑 `seed.json` 里的 `pins`，删除 `antmotors.db` 后重启（会重新播种）；
或后续加一个改密接口。PIN 用 scrypt 加盐哈希存储，数据库里看不到明文。

## 3. 权限（服务器强制，改前端没用）

这是关键：权限判断在**服务器**做，员工就算改了手机上的 App 代码也绕不过去。

| 操作 | 老板 / 合伙人 | 经理 / 销售 |
|---|---|---|
| 看进价、底价、报价 | ✅ | ✅（谈判需要） |
| **改任何价格** | ✅ | ❌ 服务器打回 `price_forbidden`，价格自动还原 |
| 新增车辆（不带价格） | ✅ | ✅ |
| 新增车辆（带价格） | ✅ | ❌ 打回 |
| 改自己的电话 / WhatsApp | ✅ | ✅ |
| 改别人的账号 | ✅ | ❌ 打回 `not_your_account` |
| 分配等级 / 调岗 | ✅ | ❌ 打回 `tier_forbidden` |

被打回时 App 会弹出中文提示，告诉员工为什么没保存成功。

## 4. 客户看到的东西（重要）

客户点开分享链接走的是**免登录的公开接口**，返回的数据里
**只有报价 `quote`，没有进价 `cost` 和底价 `floorA/floorB`**：

```
GET /api/public/car/lc?ref=kwame   → { car:{...price:{quote:38500}}, photos:[], agent:{name,wa,phone} }
GET /api/public/cars               → 全部在售车（同样只有报价，供客户浏览其他车）
```

`ref=kwame` 决定客户只能联系到 Kwame —— **谁分享的链接就只能联系到谁**。

> ✅ **已解决**：`app/index.html` 现在不再内置任何车辆数据或价格阶梯。首次打开会从 `/api/public/*` 拉取公开数据，员工登录后从 `/api/pull` 拉取完整数据。懂技术的客户查看网页源码也看不到进价/底价。

## 5. 同步机制

离线优先，不怕断网：

1. 手机上任何改动都打上时间戳存进本地队列，**先存本地再说**；
2. 联网后自动上传，服务器按「后写入者胜」合并，并拒绝越权写入；
3. 拉取自上次游标之后变化的数据（增量，不是全量）；
4. 断网时改动留在队列里，设置页显示「N 条修改待上传」，恢复网络自动补传；
5. App 每 60 秒、以及每次改动后 1.5 秒自动同步一次，也可手动点「立即同步」。

设备时钟不准也没问题：服务器会把未来时间戳钳制到服务器当前时间，
防止一台时间错乱的手机永远「赢」掉所有合并。

## 6. 部署到线上

必须有一个**固定的公网地址**，员工手机才能连。三种常见方式：

**A. 云服务器（推荐，最可控）**
```bash
# Ubuntu 示例
sudo apt install -y nodejs        # 需要 Node ≥ 22.5
git clone <你的仓库> /opt/antmotors && cd /opt/antmotors/server
sudo tee /etc/systemd/system/antmotors.service <<'EOF'
[Unit]
Description=Ant Motors sync
[Service]
ExecStart=/usr/bin/node /opt/antmotors/server/server.js
Environment=PORT=8787 DB=/var/lib/antmotors/am.db
Restart=always
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now antmotors
```
前面挂 Nginx / Caddy 做 HTTPS（**必须上 HTTPS**，否则 iOS 上 App 里的请求会被拦）。

**B. Docker**
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY app ./app
VOLUME /data
ENV DB=/data/antmotors.db PORT=8787
EXPOSE 8787
CMD ["node","server/server.js"]
```

**C. 托管平台**（Railway / Fly.io / 腾讯云轻量应用）
直接跑 `node server/server.js`，**记得把 `DB` 指向一块持久磁盘**，
否则平台重新部署会把数据库清空。

## 7. 员工怎么连

App 里 → 设置 ⚙ → **云同步**：
1. 服务器地址填 `https://你的域名`
2. 员工账号 + PIN → 「登录并同步」
3. 状态变绿「已同步」即可；之后自动同步，不用再管

服务器地址留空 = 纯离线，只用本机数据。

## 8. 备份

整个系统的数据就是一个文件。定时复制走即可：

```bash
sqlite3 /var/lib/antmotors/am.db ".backup '/backup/am-$(date +%F).db'"
```

App 里的「导出备份」按钮是第二道保险（导出 JSON 到手机）。

## 9. 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 存活检查 + 车辆总数 |
| POST | `/api/login` | 否 | `{id,pin}` → `{token,employee}` |
| GET | `/api/me` | 是 | 当前账号 + 是否可改价 |
| GET | `/api/pull?since=&photos=1` | 是 | 增量拉取 |
| POST | `/api/push` | 是 | 批量上传，返回 `{applied,rejected}` |
| GET | `/api/public/cars` | 否 | 客户可见车列表（仅报价） |
| GET | `/api/public/car/:id?ref=` | 否 | 客户单车详情 + 绑定的销售 |
| GET | `/api/showrooms` | 否 | 门店列表 |
| GET | `/api/audit` | 老板 | 最近 200 条操作日志 |

所有改动都会写 `audit` 表：谁、什么时候、改了哪台车/哪个账号。

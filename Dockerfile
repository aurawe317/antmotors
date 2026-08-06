# ANT MOTORS — multi-stage Docker build for Railway / Render / Fly / any container host
#
# 阶段 1: 安装依赖（无 — 零依赖，仅用 node 标准库）
# 阶段 2: 复制源码，运行 server.js

FROM node:22.13-alpine

WORKDIR /app

# 仅复制清单以便利用缓存
COPY package.json ./

# 复制源码
COPY server ./server
COPY app ./app
COPY ant-motors-prototype.html ./
COPY native ./native

# Railway/Render 通过 PORT 环境变量暴露端口
ENV NODE_ENV=production
ENV PORT=3000

# 持久卷（Railway Volume、Render Disk 挂到这里）
ENV DB=/data/antmotors.db

EXPOSE 3000

# 启动前的健康检查（Railway/Render 都用 /api/health）。
# 注意: Railway 会在运行时把 PORT 改成它分配的值, 不能写死 3000, 否则容器被误判为不健康。
# 这里用 $PORT (缺省 3000) 让健康检查跟随 Railway 实际端口。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c 'wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-3000}/api/health || exit 1'

# --experimental-sqlite is required on Node 22.13 (the base image) and harmless
# on later 22.x; node:sqlite needs it before it was unflagged in newer releases.
CMD ["node", "--experimental-sqlite", "server/server.js"]

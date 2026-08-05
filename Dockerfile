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

# 启动前的健康检查（Railway/Render 都用 /api/health）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server/server.js"]

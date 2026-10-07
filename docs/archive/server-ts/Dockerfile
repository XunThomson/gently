# syntax=docker/dockerfile:1
#
# gently 后端镜像（多阶段）。
#
# 构建上下文 = **仓库根**，不是 server/：
#   docker build -f server/Dockerfile -t gently-server .
# 原因：server 是 pnpm workspace 的子包，安装必须能读到根 pnpm-workspace.yaml 与 pnpm-lock.yaml，
# 否则 `--frozen-lockfile` 无锁可依，`--filter @gently/server` 也找不到工作区成员。
# 副作用：以仓库根为上下文时 Docker 只读与 Dockerfile 同名的忽略文件
# （即 server/Dockerfile.dockerignore；server/.dockerignore 仅在 `docker build server/` 时生效）。
# 下面的 COPY 只给最小路径，即使忽略文件未生效也不会把 node_modules / .env 拷进镜像。

# ------------------------------------------------------------------ 阶段 1：依赖
FROM node:22-alpine AS deps

# 固定 pnpm 版本（= 开发机版本），避免镜像构建随 pnpm 新版漂移。
# 若基础镜像自带的 corepack 不认该版本，可替换为：RUN npm install -g pnpm@11.25.0
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

WORKDIR /repo

# 先只拷清单与锁文件：源码改动不会让这一层缓存失效。
# 根 package.json 也要拷——pnpm 把仓库根也当作 workspace 项目，
# 缺了它会因 manifest 缺失 / lockfile importers 不匹配而在 --frozen-lockfile 下直接失败。
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/package.json

# --filter：只装 @gently/server，不装桌面端那套（React / Vite / Tauri）依赖；
# --frozen-lockfile：镜像内依赖版本与仓库锁文件完全一致，不允许隐式升级。
RUN pnpm install --frozen-lockfile --filter @gently/server

# ------------------------------------------------------------------ 阶段 2：构建
FROM deps AS build
WORKDIR /repo

# tsconfig 的 rootDir 为 "."，所以 server/src/main.ts 编译到 dist/src/main.js
# （已用 tsc --outDir 实测核对，见 CMD 注释）。
# test/ 与 scripts/ 是开发期工具（.dockerignore 亦排除 test），不进镜像；
# tsconfig 的 include 里未被拷贝的模式匹配为空，不影响编译。
COPY server/tsconfig.json server/tsconfig.json
COPY server/src server/src
RUN pnpm --filter @gently/server build

# 生产依赖：同一份安装结果上再装一次 --prod，把 typescript / vitest / drizzle-kit 等剪掉。
# 单独一个阶段，是为了让 runtime 只拷贝干净的生产依赖。
FROM deps AS prod-deps
WORKDIR /repo
RUN pnpm install --frozen-lockfile --prod --filter @gently/server

# ------------------------------------------------------------------ 阶段 3：运行
FROM node:22-alpine AS runtime

# production 下 src/config/env.ts 会强制要求 JWT_SECRET（≥32 字符），
# 未提供则进程启动即失败——这是刻意的：不带密钥跑生产是不允许的。
# 启动示例：
#   docker run --rm -p 8787:8787 -e JWT_SECRET="$(openssl rand -base64 48)" gently-server
# DATABASE_URL / REDIS_URL 可选：不配则降级运行，/ready 返回 degraded。
ENV NODE_ENV=production
# 必须监听所有网卡：HOST 缺省值 127.0.0.1 会让容器内的服务从宿主机端口映射不可达。
# （HEALTHCHECK 走 127.0.0.1，属于同一进程的 loopback，不受影响。）
ENV HOST=0.0.0.0

WORKDIR /app/server

# pnpm 的 node_modules 不是拷贝即用的扁平结构：
#   /app/server/node_modules/<pkg> -> ../../node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>
# 是相对符号链接，所以「根的虚拟 store + 子包的链接层」必须按原相对位置一起拷，
# 只拷 server/node_modules 会得到一堆悬空链接。
COPY --from=prod-deps /repo/node_modules /app/node_modules
COPY --from=prod-deps /repo/server/node_modules /app/server/node_modules
# 编译产物入口固定为 dist/src/main.js（rootDir 为 "."，不是 dist/main.js）。
COPY --from=build /repo/server/dist ./dist
COPY server/package.json ./package.json

# 插件目录（PLUGIN_DIR，缺省 plugins）不入镜像：插件是可替换的声明式数据，
# 运行时挂载即可：-v "$PWD/server/plugins:/app/server/plugins"。
# 目录不存在时宿主只记一条日志、不阻塞启动。

EXPOSE 8787

# 非 root 运行；/app 下的产物对 node 只读即可（插件目录单独挂载时注意属主）。
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node","dist/src/main.js"]

FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl jq tar gzip procps less vim-tiny python3 \
    && rm -rf /var/lib/apt/lists/*

# registry.npmjs.org 在本集群链路上吞吐极低，改用国内镜像。
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @e2b/cli

WORKDIR /home/user

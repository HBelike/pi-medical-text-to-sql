# 启动命令变更记录

更新：2026-10-19。

- 目标：将日常启动缩短为在 `Pi-智能问数` 根目录执行 `npm start`，无需记忆工作区名称。
- 文件与调用链：根 `package.json` 新增 `scripts.start` → `npm run start --workspace=@medical/pi-query` → 应用已有 `start` → `src/server.ts`；JSON 不支持注释，封装原因和行为在本文记录。
- 技术取舍：复用 npm 工作区转发，工作目录由 npm 切换到问数应用，保留现有 Node 参数、配置加载、端口与数据目录，不新增依赖或独立启动器。
- 使用说明：同步 `apps/medical-query/README.md` 的日常启动命令与 `Ctrl+C` 停止方式；首次配置与数据准备流程沿用原步骤。
- 验证：根 `npm run check` 通过；npm 命令映射、工作区执行目录和入口路径核对通过，无递归调用。本次未实际启动或重启服务、未调用模型，服务运行情况未另行验证。

# Fork 说明:兼容 DeepSeek Harness 0.2.x

本仓库是 [lanlandeli/dsh-usage-stats](https://github.com/lanlandeli/dsh-usage-stats) v0.1.16 的个人 fork(已更名 `dsh-usage-monitor`),
修复了其在 **DeepSeek Harness(DSH)0.2.1-rc.2** 上无法加载的问题(升级 DSH 后,侧边栏左下角的用量入口消失)。

## 与上游 v0.1.16 的差异(commit 2)

### 1. `package.json` → `dsh.client.inject`:移除 `@deepseek-ai/dsh-client-runtime`

- **原因**:`@deepseek-ai/dsh-client-runtime` 包在 DSH 0.2.x 中已被移除(不再作为独立 client module 提供)。
  插件声明了不存在的 inject 依赖,导致整个 client 入口无法加载——表现为:侧边栏左下角的用量按钮消失。
- **安全性**:bundle 实际只 `require` 了 `react / react/jsx-runtime / react-dom`,并未引用该包;所需能力
  (`ctx.locale`、`ctx.slots`)由平台 ctx 直接提供,删除声明完全无副作用。

### 2. `package.json` → `peerDependencies`:放宽 7 个 `@deepseek-ai/*` 范围

- **原因**:原声明 `>=0.1.0-rc.6 <0.2.0`,而 DSH 0.2.1-rc.2 的对应包是 `0.2.1-rc.2`,超出上界。
  DSH 插件管理器按 peer 范围做兼容门禁,直接拒绝激活,报错:
  `与 DSH 0.2.1-rc.2 不兼容……请卸载后重新安装与当前 DSH 兼容的版本`。
- **安全性**:逐项核对过插件运行时实际调用的 API ——
  `sessionQuery.listSessions()/readSession()`、`webServer.register({kind:"prefix"})`、`ctx.on("session/event")`、
  `ctx.locale`、`ctx.effect`、`ctx.logger` —— 在 0.2.1-rc.2 上全部存在且行为一致
  (同作者另一插件 dsh-token-usage 修补后走完全相同的调用路径,已实测可用)。
- 改动方式:去掉 `<0.2.0` 上界,保留 `>=0.1.0-rc.6` 下界。

## 验证结果(DSH 0.2.1-rc.2 + Windows 11 + Node 24)

- 重启 DSH 后,侧边栏左下角用量按钮恢复,点击可打开用量页面(每日 Token 柱状图、模型分布、明细、导出)。
- 后台索引器恢复正常写入(`~/.dsh/usage-stats/index-v1.json`),22 个会话、日桶含真实 token 统计。

## 注意事项

- 已知边界:DSH 重启期间的少量事件不会被实时追加(增量索引依赖 live 事件流);删除
  `~/.dsh/usage-stats/index-v1.json` 后重启可强制全量重建,数据会从会话日志完整恢复。
- 本 fork 面向个人使用,未改变上游的功能逻辑;上游发布适配 0.2.x 的版本后建议切回官方版。

## 在 DSH 中使用本 fork(注意:包已更名为 dsh-usage-monitor)

profile(`~/.dsh/profiles/web/package.json`)中把依赖指向本仓库:

```json
"dsh-usage-monitor": "github:<你的用户名>/dsh-usage-monitor"
```

并确认它在 `dsh.profile.bundles` 数组中,重启 DSH 即可。

# jev-mcp

把 TypeSafe 的 System One 模型 **Jev** 包成一个 stdio MCP 服务，供 CodeXH 在任务中调用。

> Jev 不是对话模型。它接收 `state` 与一组类型化问题，返回 `answers`（`noul` / `choice` / `score` 及概率、confidence），
> 不生成文本、不做工具调用。所以它只能作为一个「决策调用」被接入，而不能替换聊天模型。
> 参考：[Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents)。

## 目录说明

| 文件 | 作用 |
| --- | --- |
| `jev-api.mjs` | 与 TypeSafe 交互的纯逻辑：入参校验、请求组装、错误映射。可单独单测。 |
| `server.mjs` | MCP 协议层，只暴露一个工具 `jev_evaluate`，把调用透传给 `jev-api.mjs`。 |

本目录不在 pnpm workspace 的 `apps/*`、`packages/*` 范围内，因此不产生任何安装步骤；
`@modelcontextprotocol/sdk` 由仓库根 `node_modules` 提供。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | 是 | TypeSafe 密钥，在 <https://console.typesafe.ai/keys> 生成。也接受 `JEV_API_KEY`。 |
| `TYPESAFE_API_KEY_FILE` | 否 | 改用文件提供密钥，读取后去除首尾空白。 |
| `TYPESAFE_BASE_URL` | 否 | 覆盖接口地址，默认 `https://api.typesafe.ai`。 |
| `TYPESAFE_TIMEOUT_MS` | 否 | 单次调用超时，默认 30000。 |

> MCP 的 stdio 子进程只继承 PATH、TEMP 等白名单变量，系统级环境变量不会自动传进来。
> 因此密钥必须写在 MCP 服务配置的「环境变量」里。

## 在 CodeXH 中配置

1. 打开「设置 -> MCP」，该服务已注册为 `jev`（命令 `node`，参数为 `server.mjs` 的绝对路径）。
2. 在该服务的「环境变量（KEY=VALUE）」中填写 `TYPESAFE_API_KEY=ts_xxx`，每行一个变量。
3. 保存并重连服务，随后在对话里让它调用 `jev_evaluate` 验证。

## 本地手动验证

最省事的验证是不带密钥启动，确认服务本身能握手并给出配置提示：

```powershell
'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node tools/jev-mcp/server.mjs
```

配好密钥后，可对真实接口打一发：

```powershell
$env:TYPESAFE_API_KEY = 'ts_xxx'
'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"jev_evaluate","arguments":{"state":"Payouts have been failing for 3 days, this is urgent","questions":{"is_urgent":{"type":"noul","instructions":"Does this convey urgency?"}}}}}' | node tools/jev-mcp/server.mjs
```

## 刻意不做的事

- 不自动重试：限流和服务端错误会带着 HTTP 状态与响应片段返回，是否重试由调用方决定。
- 不改写响应：上游 `answers` 的字段、概率与 confidence 原样返回，便于直接入库或做特征。
- 不做阈值判断：拿到的永远只是数值与标签，动作由业务代码决定。

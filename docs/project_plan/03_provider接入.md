# 03 provider 接入

## 职责

解析 ZCode 的 provider 配置并完成安全子 agent 的 LLM 调用（需求6）。
零第三方依赖：Node 18+ 内置 `fetch`，无 SDK。

## 配置来源与解析顺序

读取本机 ZCode 配置（存在性依次探测）：

1. `~/.zcode/v2/config.json`（本机实测的实际生效路径）
2. `~/.zcode/cli/config.json`（官方文档路径，兼容其他版本布局）

解析规则：

```
provider 选取 = settings.provider 非空
    ? config.provider["builtin:" + settings.provider] 或 config.provider[settings.provider]（用户显式指定，需求6"与主 agent 不同"）
    : 第一个 enabled === true 的 provider（跟随主 agent 当前 provider）
model 选取 = settings.model 非空 ? settings.model : 该 provider models 的第一个键
```

provider 对象需要的字段（本机实测结构）：

```json
{
  "kind": "anthropic",
  "options": { "baseURL": "https://.../api/anthropic", "apiKey": "..." },
  "models": { "glm-5.3": {...}, "glm-5.3-flash": {...} }
}
```

- `kind=anthropic` → Anthropic Messages 协议
- `kind=openai`（或缺失）→ OpenAI Chat Completions 协议
- `apiKey` 缺失 / baseURL 缺失 / 无 enabled provider → 判定"provider 不可用"，
  调用方走兜底 ask，并在日志给出精确原因（不打印密钥）

## 两种协议的请求构造

### anthropic（本机所有 provider 均为此类）

```
POST {baseURL}/v1/messages
headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }
body: {
  "model": model,
  "max_tokens": 1024,
  "system": <安全提示词>,
  "messages": [{ "role": "user", "content": <审查载荷> }]
}
```

响应取 `data.content` 中 `type === "text"` 的块拼接。

### openai

```
POST {baseURL}/chat/completions
headers: { "Authorization": "Bearer " + apiKey }
body: { "model": model, "messages": [{role:"system",...},{role:"user",...}], "max_tokens": 1024 }
```

响应取 `data.choices[0].message.content`。

## 超时与重试

- 超时：`AbortController`，默认 30000ms（settings.timeout_ms 可配），
  必须小于 hook 总预算 60000ms——加载配置时强制钳制；
- 重试：不重试。单次失败直接兜底 ask——审查是低频关键路径，
  重试只会把延迟放大到 hook 超时，让客户端杀进程。

## 安全注意

- apiKey 只在内存中拼请求头，不写入任何日志 / 缓存 / reason；
- 配置解析失败时的错误消息只包含字段路径与原因，不包含配置文件原始内容。

# Forge 已有插件包导入规范（v1）

Forge 接收的是**受管远程 Worker 插件包**，不是可在 Runner 中直接安装的 npm/DSH 包。上传不会执行压缩包内的 JavaScript、安装依赖或运行安装脚本。

## 包结构

当前只接收 ZIP，根目录必须包含 `forge.plugin.json`：

```text
acme-contacts-1.2.3.zip
└── forge.plugin.json
```

限制：压缩包最大 5 MB、最多 64 个文件、解压后最多 12 MB；不允许绝对路径、`..` 路径或符号链接。

## Manifest

```json
{
  "id": "acme-contacts",
  "package": "@acme/contacts-worker",
  "displayName": "Acme Contacts",
  "description": "企业已有的联系人查询 Worker。",
  "version": "1.2.3",
  "runtime": "forge-remote-worker-v1",
  "execution": {
    "kind": "remote-worker",
    "endpoint": "https://plugins.acme.example/invoke",
    "networkDomains": ["plugins.acme.example"],
    "timeoutSeconds": 15
  },
  "permissions": ["contacts:read"],
  "tools": [
    {
      "name": "acme_find_contact",
      "title": "查询联系人",
      "description": "按邮箱或姓名查询联系人。",
      "permission": "read",
      "risk": "read",
      "inputSchema": {
        "type": "object",
        "properties": { "query": { "type": "string" } },
        "required": ["query"],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": { "contacts": { "type": "array" } },
        "required": ["contacts"],
        "additionalProperties": false
      }
    }
  ]
}
```

`id` 和 `version` 共同确定不可变 release。同一个插件 ID 的同一版本不能被不同文件覆盖；修订必须升级版本号。`forge-` 是平台保留前缀，上传的企业插件应使用自己的命名，例如 `acme-contacts`。

工具的 `permission: "read"` 必须配合 `risk: "read"`。`permission: "approval"` 才能声明 `write` 或 `external_side_effect`，并会在调用前逐次请求批准。

## Remote Worker 协议

Forge Plugin Worker 仅向 Manifest 固定的 HTTPS endpoint 发出 POST 请求，禁用重定向。endpoint 的主机名必须精确存在于 `networkDomains` 中，不能使用 IP、URL 凭据、查询参数或片段。

请求：

```json
{
  "tool": "acme_find_contact",
  "arguments": { "query": "alex@example.com" }
}
```

成功响应：

```json
{ "result": { "contacts": [] } }
```

失败时应返回非 2xx 和一个 JSON 消息：

```json
{ "message": "联系人服务暂时不可用" }
```

远程 Worker 的身份认证、业务侧凭据和数据域控制由企业 Worker/Gateway 管理；它们不会进入 DSH Runner 或场景 Bundle。

## 发布流程

上传后插件版本处于“待审核”，无法被场景引用。管理员必须检查工具 Schema、权限、风险、远程域名和业务 Worker 后再批准。批准的版本可被场景选择；场景发布和会话创建都会固定版本与 ZIP 的 SHA-256。

停用或撤销版本会阻止新会话使用，但不会删除历史场景 Bundle、会话事件或审计记录。

## 原生 DeepSeek Harness 包

如果已有包导出 `apply(ctx)`、Bundle patch 或 Cordis patch，它是 **原生 DSH 系统插件**，不是本规范的远程 Worker 插件。可以登记为 `runtime: "dsh-native"` 的候选制品，但 Forge 不会把它直接安装到业务 Runner。它需要平台团队进行代码审查、隔离镜像兼容性测试和专用 Runner 灰度发布。

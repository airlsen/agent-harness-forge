# MCP 接入一期

## 本期范围

一期完成远程 MCP 服务的登记、常见 `mcpServers` JSON 导入、认证头加密保存、连接测试、工具发现、启停与删除。仅支持 HTTPS Streamable HTTP；不执行导入配置中的本机命令，不支持 stdio / SSE / OAuth 浏览器授权流程。本期服务连接与工具发现可用，尚未接入场景装配和聊天工具调用。

## JSON 示例

```json
{
  "mcpServers": {
    "sample-service": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-real-secret"
      }
    }
  }
}
```

MCP 规范不规定客户端配置文件的 JSON 格式。平台接受 `mcpServers` 结构并转换为自己的远程连接配置；真实认证头加密保存在本地 SQLite，不通过查询接口返回。示例域名和令牌不可直接用于连接。

## 安全限制

- 只接受 HTTPS 地址；拒绝 URL 中的账号密码、查询参数和片段。
- 拒绝 localhost、私网、保留地址和不能解析到公网的目标；请求不跟随重定向，并设置连接/读取超时。
- 拒绝 `Host`、`Content-Length`、`Connection`、`Transfer-Encoding` 和 MCP session 等平台保留请求头。
- 导入后服务默认停用，必须测试连接发现工具；需发现至少一个工具才可启用。
- 配置和工具列表仅由已登录管理页面访问；Runner 尚未收到或执行这些 MCP 凭据。

这是一道应用级防护，不替代生产网络的出站防火墙 / egress 代理，也不能抵御所有 DNS 重绑定场景。生产部署建议在网络层限制 MCP 出站地址并做域名审核。

## 本地数据

MCP 元数据和发现的工具 schema 保存于 SQLite `mcp_server` 表。认证头经现有 Fernet 本地密钥加密后落库。备份必须同时保存 SQLite、应用 `data/encryption.key`，并以受限权限保存备份；丢失加密密钥将不能解密已有认证头。

## 下一期

场景按服务及工具选择白名单；场景发布保存工具 schema/version 快照；Runner 在每次工具调用前再次校验白名单，连接 MCP、调用 `tools/call`，将结果纳入会话轨迹，并复用现有审批策略。之后单独评估经审核、版本锁定和进程隔离的 stdio 支持。

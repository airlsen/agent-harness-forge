# 企业远程插件示例

1. 在企业内部实现 `POST /invoke` 和 `GET /healthz`。`server.py` 是不依赖第三方包的示例；生产部署应使用自己的 Web 服务和 HTTPS 网关。
2. 将同一随机长密钥配置到企业 Worker，以及 Forge Runner 的 `FORGE_PLUGIN_AUTH_ACME_CONTACTS` 环境变量。密钥不放入 ZIP、Manifest 或场景 Bundle；Worker 验证 `Authorization: Bearer <密钥>`。
3. 将 `forge.plugin.json` 中的 `endpoint` 和域名改为企业网关的公网 HTTPS 域名。网关将请求转发到内部 Worker；Forge 不直接连任意内网地址。
4. 将清单放到 ZIP 根目录，上传到插件管理页。在插件详情页用只读工具试运行，审核发布，再在企业场景中选择插件工具。
5. 修改工具或地址时增加 `version`，上传新的不可变版本。先试运行，批准后手动设为默认版本。旧场景的已发布版本不随默认版本变化。

本例的 `forge_sdk.py` 是最小协议样例，不承担生产服务部署、租户身份或业务权限管理。企业 Worker 应自行校验调用者的业务权限及参数。

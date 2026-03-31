# Team Handoff

## 拉取与启动

```powershell
git clone <NEW_REPO_URL>
cd ozon-auto-listing-console-share
npm install
npm run console
```

打开：

```text
http://localhost:3456
```

## 配置 Ozon API

先复制配置模板：

```powershell
copy config\\ozon-api.example.json config\\ozon-api.json
```

然后把自己的 `clientId` 和 `apiKey` 填进去。

## 给 AI/同事的工作提示词

```text
这是一个 Ozon 自动上架工作台项目。

你需要遵守以下规则：
1. 先阅读 README.md 和 AI-ACCESS.md，再动代码。
2. 默认使用本项目现有的前端控制台和上传链路，不要另起一套上传器。
3. 商品知识库主目录在 knowledge-base/products/<slug>/。
4. 映射优先级：
   - configs/mappings/<slug>.json
   - knowledge-base/products/<slug>/ozon-import-mapping.json
5. 如果某个商品缺图，优先复用本地已有图片与 1688-competitor-offers.json，不要随意删改已有映射。
6. 不要提交任何真实密钥、cookie、.profiles、logs、output、node_modules。
7. 如果要上架，优先检查：
   - config/ozon-api.json
   - /api/ozon/upload-ready
   - knowledge-base/products/*/ozon-import-mapping.json
8. 改动前先判断是“修前端”、“修知识库映射”还是“修上传 API”，不要混着改。

目标：
- 保持前端可用
- 让可提交商品数量稳定
- 减少 Ozon 图片告警、重复卡、属性错误
```

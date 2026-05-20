# TODO

## 1. 展示再次加强

- [ ] 设计更简洁的默认展示格式，避免重复英文原文、技术 marker、过多标题层级。
- [ ] 支持配置展示模式：仅译文 / 中英对照 / 折叠详情。
- [x] 默认只持久化最近几条译文，降低卸载插件后的历史上下文污染面。
- [ ] 清理小模型常见包裹输出，例如 `<text>...</text>`、多余解释、代码块包裹。
- [ ] 明确异常展示策略：翻译失败时只提示一次，不污染主消息。

验收标准：
- 默认模式只追加必要译文。
- 不显示内部 marker。
- 长 thinking 不显著刷屏。

## 2. 确认不进入对话流

- [ ] 验证追加译文是否会进入后续 LLM 上下文。
- [x] 如果会进入上下文，通过 `context` 与 `session_before_compact` 边界过滤展示译文。
- [ ] 验证 compaction 时不会把译文当作模型原始 thinking 参与摘要。
- [ ] 在 README 里说明对会话上下文和思考内容的影响边界。

验收标准：
- 翻译展示不改变原始 thinking/reasoning block。
- 翻译展示不会影响后续模型思考内容。
- 可通过最小复现步骤确认上下文无污染。

## 3. 添加 API 翻译支持

- [ ] 在保留 model-based translation 的基础上，抽象 translator provider 接口。
- [ ] 支持 Google Cloud Translation API。
- [ ] 支持 MyMemory 免费接口，并处理单次长度限制。
- [ ] 支持 LibreTranslate / 自部署 API。
- [ ] 所有 API key 和 endpoint 只从配置文件读取，不使用环境变量。
- [ ] README 里明确各 API 的免费额度、限制和隐私风险。

验收标准：
- 配置文件可切换 `model` / `google` / `mymemory` / `libretranslate`。
- API 翻译失败时自动给出清晰错误，不影响主对话。
- 不提交任何用户本地 key 或私有配置。

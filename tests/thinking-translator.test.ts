import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "../extensions/thinking-translator.ts";

const baseConfig = {
	...__testing.DEFAULT_CONFIG,
	contentTypes: ["thinking"] as Array<"thinking" | "reasoning" | "reasoning_summary" | "text">,
};

test("built-in defaults do not choose a translator model", () => {
	// 默认不绑定具体模型，用户显式配置 translatorModel 后才会发起翻译请求。
	assert.equal(__testing.DEFAULT_CONFIG.translatorModel, undefined);
	assert.equal(__testing.DEFAULT_CONFIG.enabled, true);
});

test("normalizeContentTypes keeps thinking-only default safe", () => {
	// 默认只翻译 thinking，非法或空配置都回退到安全默认值。
	assert.deepEqual(__testing.normalizeContentTypes(undefined), ["thinking"]);
	assert.deepEqual(__testing.normalizeContentTypes([]), ["thinking"]);
	assert.deepEqual(__testing.normalizeContentTypes(["text", "image", "text"]), ["text"]);
});

test("mergeConfig supports partial global and project overrides", () => {
	// 配置层是 partial override：项目层可只改模型 id，其他值继承全局或内置默认。
	const globalConfig = __testing.mergeConfig(__testing.DEFAULT_CONFIG, {
		translatorModel: { provider: "ollama", id: "qwen2.5:7b" },
		contentTypes: ["thinking", "text"],
	});
	const projectConfig = __testing.mergeConfig(globalConfig, {
		translatorModel: { provider: "ollama", id: "qwen3:8b" },
	});

	assert.deepEqual(projectConfig.translatorModel, { provider: "ollama", id: "qwen3:8b" });
	assert.deepEqual(projectConfig.contentTypes, ["thinking", "text"]);
});

test("getTranslatableBlockSource respects configured content types", () => {
	// 只有配置白名单里的文本类 block 会被提取，tool/image 等结构不会误处理。
	assert.deepEqual(__testing.getTranslatableBlockSource({ type: "thinking", thinking: "Need to inspect files" }, baseConfig), {
		type: "thinking",
		field: "thinking",
		text: "Need to inspect files",
	});
	assert.equal(__testing.getTranslatableBlockSource({ type: "text", text: "Normal answer" }, baseConfig), undefined);
	assert.deepEqual(
		__testing.getTranslatableBlockSource({ type: "text", text: "Normal answer" }, { ...baseConfig, contentTypes: ["thinking", "text"] }),
		{ type: "text", field: "text", text: "Normal answer" },
	);
});

test("cleanTranslation removes common model wrappers", () => {
	// 小模型常把结果包进标签或代码块，清理后界面只保留译文正文。
	assert.equal(__testing.cleanTranslation("```markdown\n你好\n```"), "你好");
	assert.equal(__testing.cleanTranslation("<thinking>\n你好\n</thinking>"), "你好");
	assert.equal(__testing.cleanTranslation("<text>\n你好\n</text>"), "你好");
});

test("parseTranslationJsonResponse requires translation JSON", () => {
	// 翻译输出必须是 JSON，防止模型把源文本里的任务当成问题继续回答。
	assert.equal(__testing.parseTranslationJsonResponse('{"translation":"需要检查文件"}'), "需要检查文件");
	assert.equal(__testing.parseTranslationJsonResponse('```json\n{"translation":"需要检查"}\n```'), "需要检查");
	assert.throws(() => __testing.parseTranslationJsonResponse("需要检查文件"), /non-JSON/);
	assert.throws(() => __testing.parseTranslationJsonResponse('{"text":"需要检查"}'), /translation field/);
});

test("getAssistantMessageForTranslation keeps only finished assistant messages", () => {
	// 兼容旧的完整消息提取逻辑：user 和无内容消息都要跳过。
	const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "Need to inspect" }] };
	const user = { role: "user", content: [] };
	assert.deepEqual(__testing.getAssistantMessageForTranslation(assistant), assistant);
	assert.equal(__testing.getAssistantMessageForTranslation(user), undefined);
	assert.equal(__testing.getAssistantMessageForTranslation({ role: "assistant", content: null }), undefined);
});

test("getStreamEventBlockSource respects thinking_end and text_end config", () => {
	// 流式翻译只在 block end 事件触发；text_end 必须由 contentTypes 显式启用。
	assert.deepEqual(__testing.getStreamEventBlockSource({ type: "thinking_end", content: "Need to inspect" }, baseConfig), {
		type: "thinking",
		field: "thinking",
		text: "Need to inspect",
	});
	assert.equal(__testing.getStreamEventBlockSource({ type: "text_end", content: "Done" }, baseConfig), undefined);
	assert.deepEqual(__testing.getStreamEventBlockSource({ type: "text_end", content: "Done" }, { ...baseConfig, contentTypes: ["thinking", "text"] }), {
		type: "text",
		field: "text",
		text: "Done",
	});
});

test("formatTranslationNotification returns translation text only", () => {
	// 通知不再添加 Thinking Translator、类型标题或分隔线，避免 UI 出现额外包装文本。
	const message = __testing.formatTranslationNotification([
		{ source: { type: "thinking", field: "thinking", text: "Need to inspect" }, translation: "需要检查" },
		{ source: { type: "text", field: "text", text: "Done" }, translation: "完成\n下一步" },
	]);

	assert.equal(message, ["需要检查", "完成", "下一步"].join("\n"));
});

test("resolveTranslatorModel skips safely when registry or model is unavailable", () => {
	// 运行时缺少 modelRegistry 或找不到模型时只警告并跳过，不能影响主对话流程。
	const notices: string[] = [];
	const ctxWithoutRegistry = { ui: { notify: (message: string) => notices.push(message) } };
	assert.equal(__testing.resolveTranslatorModel(ctxWithoutRegistry, { ...baseConfig, translatorModel: { provider: "missing", id: "model" } }), undefined);
	assert.match(notices.at(-1) ?? "", /model registry is unavailable/);

	const ctxWithMissingModel = {
		ui: { notify: (message: string) => notices.push(message) },
		modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) },
	};
	assert.equal(__testing.resolveTranslatorModel(ctxWithMissingModel, { ...baseConfig, translatorModel: { provider: "missing", id: "model" } }), undefined);
	assert.match(notices.at(-1) ?? "", /model not found: missing\/model/);
});

test("extractTextResponse validates provider response shape", () => {
	// provider 请求成功但响应结构异常时返回明确错误，正常文本块会被拼接成译文。
	assert.equal(__testing.extractTextResponse({ content: [{ type: "text", text: "你好" }, { type: "tool_use", text: "ignored" }] }), "你好");
	assert.throws(() => __testing.extractTextResponse(undefined), /invalid response/);
	assert.throws(() => __testing.extractTextResponse({ content: null }), /invalid response/);
});

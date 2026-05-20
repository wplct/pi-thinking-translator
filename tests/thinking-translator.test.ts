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
		maxPersistedTranslations: 0,
	});

	assert.deepEqual(projectConfig.translatorModel, { provider: "ollama", id: "qwen3:8b" });
	assert.deepEqual(projectConfig.contentTypes, ["thinking", "text"]);
	assert.equal(projectConfig.maxPersistedTranslations, 0);
});

test("stripTranslatedThinkingFromMessages restores merged thinking blocks", () => {
	// 进入上下文前必须还原原始 thinking，避免展示译文污染后续模型请求。
	const messages = [
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Original thinking\n\n译文",
					translatedBy: "pi-thinking-translator",
					metadata: {
						piThinkingTranslator: {
							displayOnly: true,
							originalField: "thinking",
							originalText: "Original thinking",
						},
					},
				},
			],
		},
	];

	const stripped = __testing.stripTranslatedThinkingFromMessages(messages);
	assert.notEqual(stripped, messages);
	assert.deepEqual(stripped[0].content, [{ type: "thinking", thinking: "Original thinking" }]);
});

test("stripTranslatedThinkingFromMessages restores opt-in text blocks", () => {
	// text 是最终回答正文，启用翻译后也必须能在 context/compaction 前恢复原文。
	const messages = [
		{
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Final answer\n\n最终回答",
					metadata: {
						piThinkingTranslator: {
							displayOnly: true,
							originalBlockType: "text",
							originalField: "text",
							originalText: "Final answer",
						},
					},
				},
			],
		},
	];

	const stripped = __testing.stripTranslatedThinkingFromMessages(messages);
	assert.deepEqual(stripped[0].content, [{ type: "text", text: "Final answer" }]);
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

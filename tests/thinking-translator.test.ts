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

test("getAssistantMessageForTranslation keeps only finished assistant messages", () => {
	// 兼容旧的完整消息提取逻辑：user 和无内容消息都要跳过。
	const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "Need to inspect" }] };
	const user = { role: "user", content: [] };
	assert.deepEqual(__testing.getAssistantMessageForTranslation(assistant), assistant);
	assert.equal(__testing.getAssistantMessageForTranslation(user), undefined);
	assert.equal(__testing.getAssistantMessageForTranslation({ role: "assistant", content: null }), undefined);
});

test("isThinkingTitleLine detects short title followed by blank line", () => {
	// 行级启发式只负责识别"标题行 + 空行"边界，供流式时机判断使用。
	const lines = ["Searching for plugins", "", "I should inspect the filesystem first."];
	assert.equal(__testing.isThinkingTitleLine(lines, 0), true);
	assert.equal(__testing.isThinkingTitleLine(["This line is intentionally much longer than forty characters and should not count", "", "Body"], 0), false);
	assert.equal(__testing.isThinkingTitleLine(["Body before", "Searching for plugins", "", "Body after"], 1), false);
});

test("isShortTitleParagraph keeps only short single-line paragraphs as titles", () => {
	// 真正的分段以空行分段后的段落为单位：只有短单行段落才会与后一个正文段合并。
	assert.equal(__testing.isShortTitleParagraph("Searching for plugins"), true);
	assert.equal(__testing.isShortTitleParagraph("Searching for plugins\nMore"), false);
	assert.equal(__testing.isShortTitleParagraph("This paragraph is intentionally much longer than forty characters and should not count"), false);
});

test("splitThinkingSections groups title and body into one section", () => {
	// 短标题和它后面的正文应该合并成一个段，下一组标题再开新段。
	const text = [
		"Searching for plugins",
		"",
		"I should inspect the filesystem first.",
		"",
		"Locating the plugin",
		"",
		"I found a likely repository path.",
	].join("\n");

	assert.deepEqual(__testing.splitThinkingSections(text), [
		["Searching for plugins", "", "I should inspect the filesystem first."].join("\n"),
		["Locating the plugin", "", "I found a likely repository path."].join("\n"),
	]);
});

test("getCompletedThinkingSections excludes trailing unfinished section", () => {
	// thinking 尚未结束时，只能翻译已经被下一段标题闭合的上一段。
	const text = [
		"Searching for plugins",
		"",
		"I should inspect the filesystem first.",
		"",
		"Locating the plugin",
		"",
		"I found a likely repository path.",
	].join("\n");

	assert.deepEqual(__testing.getCompletedThinkingSections(text, false), [["Searching for plugins", "", "I should inspect the filesystem first."].join("\n")]);
	assert.deepEqual(__testing.getCompletedThinkingSections(text, true), [
		["Searching for plugins", "", "I should inspect the filesystem first."].join("\n"),
		["Locating the plugin", "", "I found a likely repository path."].join("\n"),
	]);
});

test("formatTranslationWidgetLines wraps long CJK lines instead of truncating", () => {
	// 中文超长行应自动换行，而非截断加省略号。
	const width = 20;
	const future = Date.now() + 60_000;
	const result = __testing.formatTranslationWidgetLines([{ text: "这是一段很长的中文翻译内容", expiresAt: future }], width);
	// 格式：标题 + 正文 + 底部分隔线
	assert.ok(result[0]?.includes("思考翻译"), `标题应包含"思考翻译": ${result[0]}`);
	assert.ok(result.length > 3, `长中文应有多行，实际 ${result.length}`);
});

test("formatTranslationWidgetLines wraps mixed CJK+ASCII correctly", () => {
	// 中英混合内容按终端列宽换行，不丢失英文单词。
	const width = 30;
	const future = Date.now() + 60_000;
	const result = __testing.formatTranslationWidgetLines([{ text: "需要检查 plugin 配置文件是否正确加载", expiresAt: future }], width);
	// 标题 + 正文 + 底部
	const bodyLines = result.slice(1, -1);
	assert.ok(bodyLines.length >= 2, `应该至少有 2 行正文，实际 ${bodyLines.length}`);
});

test("formatTranslationWidgetLines returns empty when no active entries", () => {
	// 无有效条目时不展示 widget。
	const past = Date.now() - 1000;
	const result = __testing.formatTranslationWidgetLines([{ text: "过期", expiresAt: past }], 80);
	assert.deepEqual(result, []);
});

test("formatTranslationWidgetLines renders widget from history array", () => {
	const width = 80;
	const future = Date.now() + 60_000;
	const mk = (text: string) => ({ text, expiresAt: future });

	// 标题 + 2 行正文 + 底部分隔线 = 4 行
	const result = __testing.formatTranslationWidgetLines([mk("第一段\n第二行")], width);
	assert.equal(result.length, 4);
	assert.ok(result[0]?.includes("思考翻译"));
	assert.equal(result[1], "第一段");
	assert.equal(result[2], "第二行");

	// 超过 30 行正文时只保留最后 30 行 + 标题 + 底部
	const many = Array.from({ length: 40 }, (_, i) => mk(`行${i + 1}`));
	const resultMany = __testing.formatTranslationWidgetLines(many, width);
	assert.equal(resultMany.length, 32); // 标题 + 30 行正文 + 底部
	assert.ok(resultMany[0]?.includes("思考翻译"));
	assert.equal(resultMany[1], "行11");
	assert.equal(resultMany[30], "行40");
});

test("formatTranslationWidgetLines filters expired entries", () => {
	const width = 80;
	const past = Date.now() - 1000;
	const future = Date.now() + 60_000;
	const entries = [{ text: "过期文本", expiresAt: past }, { text: "有效文本", expiresAt: future }];
	const result = __testing.formatTranslationWidgetLines(entries, width);
	// 标题 + 1 行正文 + 底部 = 3
	assert.equal(result.length, 3);
	assert.equal(result[1], "有效文本");
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

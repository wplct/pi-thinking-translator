import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "../extensions/thinking-translator.ts";

const baseConfig = {
	...__testing.DEFAULT_CONFIG,
	contentTypes: ["thinking"] as Array<"thinking" | "reasoning" | "reasoning_summary" | "text">,
};

test("built-in defaults do not choose a translator model", () => {
	assert.equal(__testing.DEFAULT_CONFIG.translatorModel, undefined);
	assert.equal(__testing.DEFAULT_CONFIG.enabled, true);
});

test("normalizeContentTypes keeps thinking-only default safe", () => {
	assert.deepEqual(__testing.normalizeContentTypes(undefined), ["thinking"]);
	assert.deepEqual(__testing.normalizeContentTypes([]), ["thinking"]);
	assert.deepEqual(__testing.normalizeContentTypes(["text", "image", "text"]), ["text"]);
});

test("mergeConfig supports partial global and project overrides", () => {
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
	assert.deepEqual(__testing.getTranslatableBlockSource({ type: "thinking", thinking: "Need to inspect files" }, baseConfig), {
		type: "thinking", field: "thinking", text: "Need to inspect files",
	});
	assert.equal(__testing.getTranslatableBlockSource({ type: "text", text: "Normal answer" }, baseConfig), undefined);
	assert.deepEqual(
		__testing.getTranslatableBlockSource({ type: "text", text: "Normal answer" }, { ...baseConfig, contentTypes: ["thinking", "text"] }),
		{ type: "text", field: "text", text: "Normal answer" },
	);
});

test("cleanTranslation removes common model wrappers", () => {
	assert.equal(__testing.cleanTranslation("```markdown\n你好\n```"), "你好");
	assert.equal(__testing.cleanTranslation("<thinking>\n你好\n</thinking>"), "你好");
	assert.equal(__testing.cleanTranslation("<text>\n你好\n</text>"), "你好");
});

test("getAssistantMessageForTranslation keeps only finished assistant messages", () => {
	const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "Need to inspect" }] };
	assert.deepEqual(__testing.getAssistantMessageForTranslation(assistant), assistant);
	assert.equal(__testing.getAssistantMessageForTranslation({ role: "user", content: [] }), undefined);
	assert.equal(__testing.getAssistantMessageForTranslation({ role: "assistant", content: null }), undefined);
});

test("isThinkingTitleLine detects short title followed by blank line", () => {
	const lines = ["Searching for plugins", "", "I should inspect the filesystem first."];
	assert.equal(__testing.isThinkingTitleLine(lines, 0), true);
	assert.equal(__testing.isThinkingTitleLine(["This line is intentionally much longer than forty characters and should not count", "", "Body"], 0), false);
	assert.equal(__testing.isThinkingTitleLine(["Body before", "Searching for plugins", "", "Body after"], 1), false);
});

test("isShortTitleParagraph keeps only short single-line paragraphs as titles", () => {
	assert.equal(__testing.isShortTitleParagraph("Searching for plugins"), true);
	assert.equal(__testing.isShortTitleParagraph("Searching for plugins\nMore"), false);
	assert.equal(__testing.isShortTitleParagraph("This paragraph is intentionally much longer than forty characters and should not count"), false);
});

test("splitThinkingSections groups title and body into one section", () => {
	const text = ["Searching for plugins", "", "I should inspect the filesystem first.", "", "Locating the plugin", "", "I found a likely repository path."].join("\n");
	assert.deepEqual(__testing.splitThinkingSections(text), [
		["Searching for plugins", "", "I should inspect the filesystem first."].join("\n"),
		["Locating the plugin", "", "I found a likely repository path."].join("\n"),
	]);
});

test("getCompletedThinkingSections excludes trailing unfinished section", () => {
	const text = ["Searching for plugins", "", "I should inspect the filesystem first.", "", "Locating the plugin", "", "I found a likely repository path."].join("\n");
	assert.deepEqual(__testing.getCompletedThinkingSections(text, false), [["Searching for plugins", "", "I should inspect the filesystem first."].join("\n")]);
	assert.deepEqual(__testing.getCompletedThinkingSections(text, true), [
		["Searching for plugins", "", "I should inspect the filesystem first."].join("\n"),
		["Locating the plugin", "", "I found a likely repository path."].join("\n"),
	]);
});

test("formatTranslationWidgetLines wraps long CJK lines instead of truncating", () => {
	const width = 20;
	const future = Date.now() + 60_000;
	const result = __testing.formatTranslationWidgetLines([{ text: "这是一段很长的中文翻译内容", expiresAt: future }], width);
	assert.ok(result[0]?.includes("思考翻译"), `标题应包含"思考翻译": ${result[0]}`);
	assert.ok(result.length > 2, `长中文应有多行，实际 ${result.length}`);
});

test("formatTranslationWidgetLines wraps mixed CJK+ASCII correctly", () => {
	const width = 30;
	const future = Date.now() + 60_000;
	const result = __testing.formatTranslationWidgetLines([{ text: "需要检查 plugin 配置文件是否正确加载", expiresAt: future }], width);
	const bodyLines = result.slice(1);
	assert.ok(bodyLines.length >= 2, `应该至少有 2 行正文，实际 ${bodyLines.length}`);
});

test("formatTranslationWidgetLines returns empty when no active entries", () => {
	const past = Date.now() - 1000;
	assert.deepEqual(__testing.formatTranslationWidgetLines([{ text: "过期", expiresAt: past }], 80), []);
});

test("formatTranslationWidgetLines renders widget from history array", () => {
	const width = 80;
	const future = Date.now() + 60_000;
	const mk = (text: string) => ({ text, expiresAt: future });

	// 标题 + 2 行正文 = 3 行
	const result = __testing.formatTranslationWidgetLines([mk("第一段\n第二行")], width);
	assert.equal(result.length, 3);
	assert.ok(result[0]?.includes("思考翻译"));
	assert.equal(result[1], "第一段");
	assert.equal(result[2], "第二行");

	// 超过 20 行正文时只保留最后 20 行
	const many = Array.from({ length: 30 }, (_, i) => mk(`行${i + 1}`));
	const resultMany = __testing.formatTranslationWidgetLines(many, width);
	assert.equal(resultMany.length, 21); // 标题 + 20 行正文
	assert.ok(resultMany[0]?.includes("思考翻译"));
	assert.equal(resultMany[1], "行11");
	assert.equal(resultMany[20], "行30");
});

test("formatTranslationWidgetLines filters expired entries", () => {
	const width = 80;
	const past = Date.now() - 1000;
	const future = Date.now() + 60_000;
	const entries = [{ text: "过期文本", expiresAt: past }, { text: "有效文本", expiresAt: future }];
	const result = __testing.formatTranslationWidgetLines(entries, width);
	assert.equal(result.length, 2); // 标题 + 1 行正文
	assert.equal(result[1], "有效文本");
});

test("resolveTranslatorModel skips safely when registry or model is unavailable", () => {
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

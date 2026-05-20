import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AssistantMessage = { role: string; content?: Array<Record<string, unknown>> };
type ModelRef = { provider: string; id: string };
type TranslatorConfig = {
	enabled?: boolean;
	targetLanguage?: string;
	minLatinChars?: number;
	translatorModel?: ModelRef;
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "thinking-translator.json");
const TRANSLATED_BY_EXTENSION = "pi-thinking-translator";
const DEFAULT_CONFIG: Required<TranslatorConfig> = {
	enabled: true,
	targetLanguage: "Simplified Chinese",
	minLatinChars: 24,
	translatorModel: { provider: "ollama", id: "qwen2.5:3b-instruct" },
};

/**
 * 注册 thinking 翻译扩展；在 assistant 消息结束后追加译文 thinking block，让展示颜色保持与原 thinking 一致。
 */
export default function thinkingTranslator(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// 启动时提示扩展已加载，方便本地 package 测试和排查自动发现是否生效。
		ctx.ui.notify("thinking-translator loaded", "info");
	});

	pi.on("message_end", async (event, ctx) => {
		// 每次处理时重读配置，方便用户调整目标语言和翻译模型后直接 /reload 或下一轮生效。
		const config = loadConfig();
		if (!config.enabled) return;

		const message = event.message as AssistantMessage;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		if (hasTranslatedThinking(message)) return;

		const thinkingText = collectThinkingText(message);
		if (!shouldTranslate(thinkingText, config)) return;

		try {
			const translated = await translateThinking(thinkingText, ctx, config);
			const cleaned = cleanTranslation(translated);
			if (!cleaned) return;

			return {
				message: {
					...message,
					content: [
						...message.content,
						{
							type: "thinking",
							thinking: cleaned,
							translatedBy: TRANSLATED_BY_EXTENSION,
						},
					],
				},
			};
		} catch (error) {
			// 翻译失败不应影响主对话，只提示一次错误并保留原始消息。
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify("thinking translation failed: " + message, "warning");
		}
	});
}

function loadConfig(): Required<TranslatorConfig> {
	// 配置文件缺失时使用 Ollama 小模型作为默认翻译后端。
	if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as TranslatorConfig;
		return {
			...DEFAULT_CONFIG,
			...raw,
			translatorModel: { ...DEFAULT_CONFIG.translatorModel, ...raw.translatorModel },
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

function hasTranslatedThinking(message: AssistantMessage): boolean {
	// 用额外字段做内部标记，避免重复追加；该标记不会作为可见标题显示。
	return (message.content ?? []).some((block) => block.translatedBy === TRANSLATED_BY_EXTENSION);
}

function collectThinkingText(message: AssistantMessage): string {
	// 只收集原生 thinking/reasoning 内容；跳过本扩展追加的译文 block。
	const parts: string[] = [];
	for (const block of message.content ?? []) {
		if (block.translatedBy === TRANSLATED_BY_EXTENSION) continue;
		const type = typeof block.type === "string" ? block.type : "";
		if (type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
		if ((type === "reasoning" || type === "reasoning_summary") && typeof block.text === "string") parts.push(block.text);
		if (Array.isArray(block.summary)) {
			for (const item of block.summary as Array<Record<string, unknown>>) {
				if (typeof item.text === "string") parts.push(item.text);
			}
		}
	}
	return parts.join("\n\n");
}

function shouldTranslate(text: string, config: Required<TranslatorConfig>): boolean {
	// 只翻译明显包含英文自然语言的内容，避免处理纯中文或纯代码片段。
	const latin = (text.match(/[A-Za-z]/g) ?? []).length;
	const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
	return latin >= config.minLatinChars && latin > cjk;
}

async function translateThinking(text: string, ctx: any, config: Required<TranslatorConfig>): Promise<string> {
	// 使用 Pi 已配置模型翻译，避免 package 绑定具体第三方翻译 API。
	const model = ctx.modelRegistry.find(config.translatorModel.provider, config.translatorModel.id);
	if (!model) throw new Error("translator model not found: " + config.translatorModel.provider + "/" + config.translatorModel.id);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);

	const prompt = [
		"Translate the following visible assistant thinking into " + config.targetLanguage + ".",
		"",
		"Rules:",
		"- Output only the translation.",
		"- Translate headings and short title lines too.",
		"- Preserve Markdown structure.",
		"- Preserve code identifiers, file paths, commands, API names, and original error messages.",
		"- Do not add labels such as EN, ZH, Original, Translation, or notes like 'original unchanged'.",
		"- Do not wrap the result in XML tags or code fences.",
		"",
		"<thinking>",
		text,
		"</thinking>",
	].join("\n");

	const response = await complete(
		model,
		{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: Math.min(8192, Math.max(1024, Math.ceil(text.length * 1.3))), signal: ctx.signal },
	);

	return response.content
		.filter((content: any) => content.type === "text" && typeof content.text === "string")
		.map((content: any) => content.text)
		.join("\n")
		.trim();
}

function cleanTranslation(text: string): string {
	// 清理小模型常见的包裹和解释性废话，保持界面只出现译文正文。
	return text
		.trim()
		.replace(/^```(?:markdown|text)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.replace(/^<thinking>\s*/i, "")
		.replace(/\s*<\/thinking>$/i, "")
		.replace(/^<text>\s*/i, "")
		.replace(/\s*<\/text>$/i, "")
		.replace(/（?原文保持不变）?/g, "")
		.trim();
}

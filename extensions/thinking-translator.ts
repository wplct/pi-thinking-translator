import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AssistantMessage = { role: string; content?: Array<Record<string, unknown>> };
type ModelRef = { provider: string; id: string };
type TranslatableBlockType = "thinking" | "reasoning" | "reasoning_summary" | "text";
type TranslatableBlockSource = { type: TranslatableBlockType; field: "thinking" | "text"; text: string };
type TranslatorConfig = {
	enabled?: boolean;
	targetLanguage?: string;
	contentTypes?: TranslatableBlockType[];
	minLatinChars?: number;
	translatorModel?: ModelRef | null;
};
type ResolvedTranslatorConfig = Omit<Required<TranslatorConfig>, "translatorModel"> & { translatorModel?: ModelRef };
type NotifyLevel = "info" | "warning" | "error";
type NotifierContext = { ui?: { notify?: (message: string, level?: NotifyLevel) => void }; cwd?: string; modelRegistry?: any };
type ConfigPathInfo = { scope: "global" | "project"; path: string; exists: boolean };
type ConfigLoadError = { scope: "global" | "project"; path: string; error: unknown };
type ConfigState = { config: ResolvedTranslatorConfig; paths: ConfigPathInfo[]; errors: ConfigLoadError[] };

const CONFIG_FILE_NAME = "thinking-translator.json";
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", CONFIG_FILE_NAME);
const DEFAULT_CONFIG: ResolvedTranslatorConfig = {
	enabled: true,
	targetLanguage: "Simplified Chinese",
	contentTypes: ["thinking"],
	minLatinChars: 24,
};
const configErrorNotified = new Set<string>();
let missingModelWarningKey: string | undefined;

/**
 * 注册 thinking 翻译扩展；在 assistant 消息结束后用临时 UI 提示展示译文，避免改写会话消息和模型缓存。
 */
export default function thinkingTranslator(pi: ExtensionAPI) {
	pi.registerCommand("thinking-translator", {
		description: "Show or initialize thinking-translator configuration",
		getArgumentCompletions: (prefix) => {
			// 命令参数保持极简：默认 status，init 可显式选择全局或项目配置文件。
			const options = ["status", "init", "init --global", "init --project"];
			return options.filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			// 配置命令只做显式展示或初始化，避免安装/启动时自动写入用户文件。
			await handleConfigCommand(args, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// 启动时只提示扩展已加载，不写入会话消息或执行历史清理。
		ctx.ui.notify("thinking-translator loaded", "info");
	});

	pi.on("message_end", async (event, ctx): Promise<void> => {
		// 每次处理时重读配置，方便用户调整目标语言和翻译模型后直接 /reload 或下一轮生效。
		const config = loadConfig(ctx);
		if (!config.enabled) return;

		const message = event.message as AssistantMessage;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;

		const translatorModel = resolveTranslatorModel(ctx, config);
		if (!translatorModel) return;

		try {
			await notifyTranslationsForContent(message.content, ctx, config, translatorModel);
		} catch (error) {
			// 翻译失败不应影响主对话，只提示一次错误并保留原始消息。
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify("thinking translation failed: " + message, "warning");
		}
	});
}

async function handleConfigCommand(args: string, ctx: any): Promise<void> {
	// /thinking-translator 默认展示状态；init 只有用户显式调用时才写配置文件。
	const normalized = args.trim();
	if (normalized.startsWith("init")) {
		const scope = normalized.includes("--project") || /\bproject\b/.test(normalized) ? "project" : "global";
		initConfigFile(ctx, scope);
		return;
	}
	showConfigStatus(ctx);
}

function getProjectConfigPath(cwd: string | undefined): string | undefined {
	// 项目配置跟随 Pi 的 .pi/settings.json 习惯，允许特定项目覆盖全局翻译策略。
	return cwd ? join(cwd, ".pi", CONFIG_FILE_NAME) : undefined;
}

function getConfigPaths(ctx?: NotifierContext): ConfigPathInfo[] {
	// 配置加载顺序与 Pi settings 一致：全局先读，项目后读并覆盖全局。
	const projectPath = getProjectConfigPath(ctx?.cwd);
	return [
		{ scope: "global", path: GLOBAL_CONFIG_PATH, exists: existsSync(GLOBAL_CONFIG_PATH) },
		...(projectPath ? [{ scope: "project" as const, path: projectPath, exists: existsSync(projectPath) }] : []),
	];
}

function loadConfig(ctx?: NotifierContext): ResolvedTranslatorConfig {
	// 事件处理只需要最终配置；详细路径和错误留给 status 命令展示。
	return loadConfigState(ctx).config;
}

function loadConfigState(ctx?: NotifierContext): ConfigState {
	// 内置默认值不落盘；用户配置只作为覆盖层，项目配置优先于全局配置。
	const paths = getConfigPaths(ctx);
	const errors: ConfigLoadError[] = [];
	let config = { ...DEFAULT_CONFIG };

	for (const info of paths) {
		if (!info.exists) {
			configErrorNotified.delete(info.path);
			continue;
		}
		try {
			const raw = JSON.parse(readFileSync(info.path, "utf8")) as TranslatorConfig;
			configErrorNotified.delete(info.path);
			config = mergeConfig(config, raw);
		} catch (error) {
			errors.push({ scope: info.scope, path: info.path, error });
			notifyConfigLoadError(ctx, info.path, error);
		}
	}

	if (errors.length > 0) return { config: { ...config, enabled: false }, paths, errors };
	return { config, paths, errors };
}

function mergeConfig(base: ResolvedTranslatorConfig, raw: TranslatorConfig): ResolvedTranslatorConfig {
	// 每层配置都是 partial override；translatorModel 允许项目层只覆盖 provider 或 id。
	return {
		...base,
		...raw,
		contentTypes: raw.contentTypes === undefined ? base.contentTypes : normalizeContentTypes(raw.contentTypes),
		translatorModel: normalizeTranslatorModel(raw.translatorModel, base.translatorModel),
	};
}

function normalizeTranslatorModel(value: unknown, fallback?: ModelRef): ModelRef | undefined {
	// 不提供默认模型；只有用户显式配置了 provider 和 id 后才启用翻译请求。
	if (value === undefined) return fallback;
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const provider = typeof raw.provider === "string" ? raw.provider : fallback?.provider;
	const id = typeof raw.id === "string" ? raw.id : fallback?.id;
	return provider && id ? { provider, id } : undefined;
}

function notifyConfigLoadError(ctx: NotifierContext | undefined, path: string, error: unknown): void {
	// 配置错误只提示一次，避免每个消息周期重复刷屏；禁用翻译比静默回退更安全。
	if (configErrorNotified.has(path)) return;
	configErrorNotified.add(path);
	const message = error instanceof Error ? error.message : String(error);
	ctx?.ui?.notify?.(`thinking-translator config invalid, translation disabled: ${path}: ${message}`, "warning");
}

function resolveTranslatorModel(ctx: any, config: ResolvedTranslatorConfig): any | undefined {
	// 启用但未配置模型时只提示并跳过翻译，不把缺省模型强加给用户。
	const modelRef = config.translatorModel;
	if (!modelRef) {
		notifyMissingModel(ctx, "not-configured", "thinking-translator enabled but translatorModel is not configured; translation skipped");
		return undefined;
	}

	const model = ctx.modelRegistry.find(modelRef.provider, modelRef.id);
	if (!model) {
		notifyMissingModel(ctx, `${modelRef.provider}/${modelRef.id}`, `thinking-translator model not found: ${modelRef.provider}/${modelRef.id}; translation skipped`);
		return undefined;
	}
	missingModelWarningKey = undefined;
	return model;
}

function notifyMissingModel(ctx: NotifierContext, key: string, message: string): void {
	// 同一个缺模型状态只提示一次，用户修正配置后 key 变化会再次提示新问题。
	if (missingModelWarningKey === key) return;
	missingModelWarningKey = key;
	ctx.ui?.notify?.(message, "warning");
}

function showConfigStatus(ctx: any): void {
	// status 汇总有效配置、配置来源和模型可用性，帮助用户决定是否需要 init 或修改 JSON。
	const state = loadConfigState(ctx);
	const modelRef = state.config.translatorModel;
	const modelStatus = modelRef ? (ctx.modelRegistry.find(modelRef.provider, modelRef.id) ? "available" : "not found") : "not configured";
	const lines = [
		"thinking-translator status",
		`enabled: ${state.config.enabled}`,
		`targetLanguage: ${state.config.targetLanguage}`,
		`contentTypes: ${state.config.contentTypes.join(", ")}`,
		`minLatinChars: ${state.config.minLatinChars}`,
		`translatorModel: ${modelRef ? `${modelRef.provider}/${modelRef.id}` : "not configured"}`,
		`model: ${modelStatus}`,
		...state.paths.map((info) => `${info.scope} config: ${info.path} (${info.exists ? "found" : "not found"})`),
		...state.errors.map((item) => `${item.scope} config error: ${item.error instanceof Error ? item.error.message : String(item.error)}`),
	];
	ctx.ui.notify(lines.join("\n"), state.errors.length > 0 ? "warning" : "info");
}

function initConfigFile(ctx: any, scope: "global" | "project"): void {
	// init 生成禁用状态的最小模板，不写默认模型；用户填入 translatorModel 并启用后才会请求翻译模型。
	const path = scope === "project" ? getProjectConfigPath(ctx.cwd) : GLOBAL_CONFIG_PATH;
	if (!path) {
		ctx.ui.notify("thinking-translator project config path is unavailable", "warning");
		return;
	}
	if (existsSync(path)) {
		ctx.ui.notify(`thinking-translator config already exists: ${path}`, "info");
		return;
	}

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify(
			{
				enabled: false,
				targetLanguage: DEFAULT_CONFIG.targetLanguage,
				contentTypes: DEFAULT_CONFIG.contentTypes,
			},
			null,
			2,
		) + "\n",
		"utf8",
	);
	ctx.ui.notify(`created ${scope} config: ${path}\nAdd translatorModel and set enabled to true when ready.`, "info");
}

function normalizeContentTypes(value: unknown): TranslatableBlockType[] {
	// 只允许翻译明确支持的文本类 block；text 是最终回答正文，默认不开但允许用户显式启用。
	const allowed = new Set<TranslatableBlockType>(["thinking", "reasoning", "reasoning_summary", "text"]);
	if (!Array.isArray(value)) return DEFAULT_CONFIG.contentTypes;
	const normalized = value.filter((item): item is TranslatableBlockType => typeof item === "string" && allowed.has(item as TranslatableBlockType));
	return normalized.length > 0 ? Array.from(new Set(normalized)) : DEFAULT_CONFIG.contentTypes;
}

async function notifyTranslationsForContent(
	content: Array<Record<string, unknown>>,
	ctx: any,
	config: ResolvedTranslatorConfig,
	translatorModel: any,
): Promise<void> {
	// 译文只通过临时 UI 提示展示，不写回 assistant message，避免影响后续上下文和 provider 缓存。
	const notices: Array<{ source: TranslatableBlockSource; translation: string }> = [];

	for (const block of content) {
		const source = getTranslatableBlockSource(block, config);
		if (!source || !shouldTranslate(source.text, config)) continue;

		const translated = await translateThinking(source.text, ctx, config, translatorModel);
		const cleaned = cleanTranslation(translated);
		if (!cleaned) continue;

		notices.push({ source, translation: cleaned });
	}

	if (notices.length === 0) return;
	ctx.ui.notify(formatTranslationNotice(notices), "info");
}

function formatTranslationNotice(notices: Array<{ source: TranslatableBlockSource; translation: string }>): string {
	// 多个 block 合并成一次 notify，避免 Pi 连续 status 提示被折叠成只显示最后一条。
	return notices
		.map((notice) => `${getTranslationNoticeTitle(notice.source.type)}:\n${notice.translation}`)
		.join("\n\n---\n\n");
}

function getTranslationNoticeTitle(type: TranslatableBlockType): string {
	// 标题保留 block 来源，方便用户判断译文是在解释思考过程还是最终回答。
	if (type === "text") return "Answer translation";
	if (type === "reasoning" || type === "reasoning_summary") return "Reasoning translation";
	return "Thinking translation";
}

function getTranslatableBlockSource(block: Record<string, unknown>, config: ResolvedTranslatorConfig): TranslatableBlockSource | undefined {
	// 按配置白名单提取可翻译文本；译文只展示在 UI 中，不写回原 block。
	const type = typeof block.type === "string" ? block.type : "";
	if (!config.contentTypes.includes(type as TranslatableBlockType)) return undefined;
	if (type === "thinking" && typeof block.thinking === "string") return { type, field: "thinking", text: block.thinking };
	if ((type === "reasoning" || type === "reasoning_summary" || type === "text") && typeof block.text === "string") {
		return { type, field: "text", text: block.text };
	}
	return undefined;
}

function shouldTranslate(text: string, config: ResolvedTranslatorConfig): boolean {
	// 只翻译明显包含英文自然语言的内容，避免处理纯中文或纯代码片段。
	const latin = (text.match(/[A-Za-z]/g) ?? []).length;
	const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
	return latin >= config.minLatinChars && latin > cjk;
}

async function translateThinking(text: string, ctx: any, config: ResolvedTranslatorConfig, translatorModel: any): Promise<string> {
	// 使用用户显式配置的 Pi 模型翻译，避免 package 绑定具体第三方翻译 API 或默认模型。
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(translatorModel);
	if (!auth.ok) throw new Error(auth.error);

	const prompt = [
		"Translate the following visible assistant content into " + config.targetLanguage + ".",
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
		translatorModel,
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

export const __testing = {
	// 测试只暴露纯逻辑入口，避免测试直接依赖 Pi runtime hook 调度。
	CONFIG_FILE_NAME,
	DEFAULT_CONFIG,
	cleanTranslation,
	getProjectConfigPath,
	getTranslatableBlockSource,
	mergeConfig,
	normalizeContentTypes,
	normalizeTranslatorModel,
	shouldTranslate,
} as const;

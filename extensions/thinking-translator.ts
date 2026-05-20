import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
	maxPersistedTranslations?: number;
};
type ResolvedTranslatorConfig = Omit<Required<TranslatorConfig>, "translatorModel"> & { translatorModel?: ModelRef };
type NotifyLevel = "info" | "warning" | "error";
type NotifierContext = { ui?: { notify?: (message: string, level?: NotifyLevel) => void }; cwd?: string; modelRegistry?: any };
type ConfigPathInfo = { scope: "global" | "project"; path: string; exists: boolean };
type ConfigLoadError = { scope: "global" | "project"; path: string; error: unknown };
type ConfigState = { config: ResolvedTranslatorConfig; paths: ConfigPathInfo[]; errors: ConfigLoadError[] };

const CONFIG_FILE_NAME = "thinking-translator.json";
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", CONFIG_FILE_NAME);
const TRANSLATED_BY_EXTENSION = "pi-thinking-translator";
const TRANSLATION_METADATA_KEY = "piThinkingTranslator";
const DEFAULT_CONFIG: ResolvedTranslatorConfig = {
	enabled: true,
	targetLanguage: "Simplified Chinese",
	contentTypes: ["thinking"],
	minLatinChars: 24,
	maxPersistedTranslations: 3,
};
const configErrorNotified = new Set<string>();
let missingModelWarningKey: string | undefined;

/**
 * 注册 thinking 翻译扩展；在 assistant 消息结束后追加译文 thinking block，让展示颜色保持与原 thinking 一致。
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
		// 启动时清理超出最近窗口的历史译文，降低卸载插件后历史 session 污染上下文的风险。
		safePrunePersistedTranslations(ctx);
		ctx.ui.notify("thinking-translator loaded", "info");
	});

	pi.on("agent_end", async (_event, ctx) => {
		// 当前 assistant 消息会在 message_end 后持久化；agent_end 再收敛一次，只保留最近 N 条译文。
		safePrunePersistedTranslations(ctx);
	});

	pi.on("context", (event) => {
		// 发送给模型前剥离译文 block，避免展示层翻译进入后续 LLM 上下文。
		return { messages: stripTranslatedThinkingFromMessages(event.messages as any[]) };
	});

	pi.on("session_before_compact", (event) => {
		// compaction 会单独序列化 assistant thinking；摘要前也必须剥离译文，避免中文翻译被写入压缩记忆。
		event.preparation.messagesToSummarize = stripTranslatedThinkingFromMessages(event.preparation.messagesToSummarize as any[]) as any;
		event.preparation.turnPrefixMessages = stripTranslatedThinkingFromMessages(event.preparation.turnPrefixMessages as any[]) as any;
	});

	pi.on("message_end", async (event, ctx): Promise<any> => {
		// 每次处理时重读配置，方便用户调整目标语言和翻译模型后直接 /reload 或下一轮生效。
		const config = loadConfig(ctx);
		if (!config.enabled) return;

		const message = event.message as AssistantMessage;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		if (hasTranslatedThinking(message)) return;

		const translatorModel = resolveTranslatorModel(ctx, config);
		if (!translatorModel) return;

		try {
			const translatedContent = await mergeTranslationsIntoThinkingBlocks(message.content, ctx, config, translatorModel);
			if (translatedContent === message.content) return;

			return {
				message: {
					...message,
					content: translatedContent,
				},
			};
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
		maxPersistedTranslations:
			raw.maxPersistedTranslations === undefined
				? base.maxPersistedTranslations
				: normalizeMaxPersistedTranslations(raw.maxPersistedTranslations),
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
		`maxPersistedTranslations: ${state.config.maxPersistedTranslations}`,
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

function normalizeMaxPersistedTranslations(value: unknown): number {
	// 允许用户把持久化窗口设为 0；非法值回退到默认窗口，避免配置错误导致清理失效。
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONFIG.maxPersistedTranslations;
	return Math.max(0, Math.floor(value));
}

function hasTranslatedThinking(message: AssistantMessage): boolean {
	// 用额外字段做内部标记，避免重复追加；该标记不会作为可见标题显示。
	return (message.content ?? []).some(isTranslatedThinkingBlock);
}

function isTranslatedThinkingBlock(block: Record<string, unknown>): boolean {
	// 同时识别旧版 translatedBy 标记和新版 displayOnly 元数据，便于清理已经写入的历史译文。
	return block.translatedBy === TRANSLATED_BY_EXTENSION || !!getTranslationMarker(block);
}

function getTranslationMarker(block: Record<string, unknown>): Record<string, unknown> | undefined {
	// marker 集中解析，保证过滤、还原、清理对 displayOnly 语义的判断一致。
	const metadata = block.metadata;
	if (!metadata || typeof metadata !== "object") return undefined;
	const marker = (metadata as Record<string, unknown>)[TRANSLATION_METADATA_KEY];
	if (!marker || typeof marker !== "object") return undefined;
	return (marker as Record<string, unknown>).displayOnly === true ? (marker as Record<string, unknown>) : undefined;
}

function stripTranslatedThinkingFromMessages(messages: any[]): any[] {
	// 保持消息数组结构不变，只移除本扩展添加的展示译文 block，便于 context 和 compaction 复用同一隔离逻辑。
	let changed = false;
	const stripped = messages.map((message) => {
		const nextMessage = stripTranslatedThinkingFromMessage(message);
		if (nextMessage !== message) changed = true;
		return nextMessage;
	});
	return changed ? stripped : messages;
}

function stripTranslatedThinkingFromMessage(message: any): any {
	// 只有 assistant 的 content block 可能包含展示译文；其他消息原样保留，避免误伤工具结果或用户输入。
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;

	let changed = false;
	const content: Array<Record<string, unknown>> = [];
	for (const block of message.content as Array<Record<string, unknown>>) {
		const restored = restoreOriginalThinkingBlock(block);
		if (restored === undefined) {
			changed = true;
			continue;
		}
		if (restored !== block) changed = true;
		content.push(restored);
	}

	return changed ? { ...message, content } : message;
}

function restoreOriginalThinkingBlock(block: Record<string, unknown>): Record<string, unknown> | undefined {
	// 新版译文合并在原 thinking block 内，进入上下文前要还原原文；旧版独立译文 block 则直接丢弃。
	const marker = getTranslationMarker(block);
	if (!marker) return block.translatedBy === TRANSLATED_BY_EXTENSION ? undefined : block;

	const originalField = marker.originalField === "text" ? "text" : "thinking";
	const originalText = typeof marker.originalText === "string" ? marker.originalText : marker.originalThinking;
	if (typeof originalText !== "string") return undefined;

	const metadata = { ...((block.metadata as Record<string, unknown> | undefined) ?? {}) };
	delete metadata[TRANSLATION_METADATA_KEY];
	const restored: Record<string, unknown> = {
		...block,
		[originalField]: originalText,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
	};
	delete restored.translatedBy;
	if (restored.metadata === undefined) delete restored.metadata;
	return restored;
}

function safePrunePersistedTranslations(ctx: any): void {
	// 清理失败只影响降级保护，不应阻断主对话或翻译展示。
	try {
		prunePersistedTranslations(ctx, loadConfig(ctx));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify("thinking translation prune failed: " + message, "warning");
	}
}

function prunePersistedTranslations(ctx: any, config: ResolvedTranslatorConfig): void {
	// SessionManager 没有公开“更新旧消息”的 API，这里只重写当前 session JSONL，并同步修改 getEntries() 返回的内存对象。
	const sessionFile = ctx.sessionManager.getSessionFile?.();
	const entries = ctx.sessionManager.getEntries?.();
	if (!sessionFile || !Array.isArray(entries)) return;

	let remaining = config.maxPersistedTranslations;
	let changed = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		if (!message.content.some(isTranslatedThinkingBlock)) continue;

		if (remaining > 0) {
			remaining--;
			continue;
		}

		const stripped = stripTranslatedThinkingFromMessage(message);
		if (stripped !== message) {
			entry.message = stripped;
			changed = true;
		}
	}

	if (!changed) return;
	writeSessionEntriesAtomically(sessionFile, entries);
}

function writeSessionEntriesAtomically(sessionFile: string, entries: unknown[]): void {
	// 先写临时 JSONL 再 rename 覆盖，避免进程中断时把 session 文件截断成半成品。
	const tempFile = join(dirname(sessionFile), `.${basename(sessionFile)}.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tempFile, entries.map((entry: unknown) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	renameSync(tempFile, sessionFile);
}

async function mergeTranslationsIntoThinkingBlocks(
	content: Array<Record<string, unknown>>,
	ctx: any,
	config: ResolvedTranslatorConfig,
	translatorModel: any,
): Promise<Array<Record<string, unknown>>> {
	// 把译文合并进同一个 source block，避免 Pi 最终消息排序变化时把译文和原文隔到正文两侧。
	const nextContent: Array<Record<string, unknown>> = [];
	let changed = false;

	for (const block of content) {
		const source = getTranslatableBlockSource(block, config);
		if (!source || !shouldTranslate(source.text, config)) {
			nextContent.push(block);
			continue;
		}

		const translated = await translateThinking(source.text, ctx, config, translatorModel);
		const cleaned = cleanTranslation(translated);
		if (!cleaned) {
			nextContent.push(block);
			continue;
		}

		nextContent.push({
			...block,
			[source.field]: `${source.text}\n\n${cleaned}`,
			translatedBy: TRANSLATED_BY_EXTENSION,
			metadata: {
				...((block.metadata as Record<string, unknown> | undefined) ?? {}),
				[TRANSLATION_METADATA_KEY]: {
					displayOnly: true,
					version: 3,
					originalBlockType: source.type,
					originalField: source.field,
					originalText: source.text,
					originalThinking: source.field === "thinking" ? source.text : undefined,
				},
			},
		});
		changed = true;
	}

	return changed ? nextContent : content;
}

function getTranslatableBlockSource(block: Record<string, unknown>, config: ResolvedTranslatorConfig): TranslatableBlockSource | undefined {
	// 按配置白名单提取可翻译文本，并记录写回字段，方便 context 阶段精确还原原文。
	if (isTranslatedThinkingBlock(block)) return undefined;

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
	restoreOriginalThinkingBlock,
	shouldTranslate,
	stripTranslatedThinkingFromMessages,
} as const;

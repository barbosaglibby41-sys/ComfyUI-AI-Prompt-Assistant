import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

function ensureStyles() {
    const styles = [
        ["aipa-styles", "./style.css"],
        ["aipa-studio-styles", "./studio.css"],
    ];
    for (const [id, href] of styles) {
        if (document.getElementById(id)) continue;
        const stylesheet = document.createElement("link");
        stylesheet.id = id;
        stylesheet.rel = "stylesheet";
        stylesheet.href = new URL(href, import.meta.url).href;
        document.head.append(stylesheet);
    }
}

ensureStyles();

const NODE_TYPES = {
    planner: "AIPromptPlanner",
    reviewer: "AIImageReviewer",
};

// Keep machine-facing field names unchanged, but show creators clear Chinese
// labels on the canvas. Existing workflows and serialized connections retain
// their original field names.
const NODE_CANVAS_LABELS = {
    AIPromptPlanner: {
        title: "AI 提示词规划",
        inputs: {
            creative_brief: "创作需求",
            image_model: "出图模型",
            prompt_format: "提示词格式",
            seed: "随机种子",
            style_or_constraints: "风格与约束",
            strip_style: "去掉画风词",
            negative_prompt: "固定反向提示词",
            lora_context: "LoRA Manager 上下文",
            sampler_name: "采样器",
            scheduler: "调度器",
            steps: "迭代步数",
            cfg: "CFG 引导",
            width: "宽度",
            height: "高度",
            denoise: "降噪强度",
        },
        outputs: {
            positive_prompt: "正向提示词",
            negative_prompt: "反向提示词",
            sampler_name: "采样器",
            scheduler: "调度器",
            steps: "迭代步数",
            cfg: "CFG 引导",
            width: "宽度",
            height: "高度",
            denoise: "降噪强度",
            seed: "随机种子",
            reasoning: "规划说明",
        },
    },
    AIImageReviewer: {
        title: "AI 图片评审",
        inputs: {
            image: "成图",
            current_positive_prompt: "当前正向提示词",
            current_negative_prompt: "当前反向提示词",
            revision_request: "修改要求",
            enable_review: "启用 AI 图片评审",
            image_model: "出图模型",
            prompt_format: "提示词格式",
            seed: "随机种子",
            sampler_name: "采样器",
            scheduler: "调度器",
            steps: "迭代步数",
            cfg: "CFG 引导",
            width: "宽度",
            height: "高度",
            denoise: "降噪强度",
            lora_context: "LoRA Manager 上下文",
        },
        outputs: {
            positive_prompt: "优化后的正向提示词",
            negative_prompt: "优化后的反向提示词",
            sampler_name: "采样器",
            scheduler: "调度器",
            steps: "迭代步数",
            cfg: "CFG 引导",
            width: "宽度",
            height: "高度",
            denoise: "降噪强度",
            seed: "随机种子",
            reasoning: "评审说明",
        },
    },
};

function localizeAssistantNode(node) {
    const labels = NODE_CANVAS_LABELS[node?.comfyClass || node?.type];
    if (!labels) return;
    node.title = labels.title;
    for (const input of node.inputs || []) {
        if (labels.inputs[input.name]) input.label = labels.inputs[input.name];
    }
    for (const output of node.outputs || []) {
        if (labels.outputs[output.name]) output.label = labels.outputs[output.name];
    }
    for (const item of node.widgets || []) {
        const label = labels.inputs[item.name];
        if (label) item.label = label;
    }
    node.setDirtyCanvas?.(true, true);
}

const PROMPT_FORMATS = [
    { value: "tag", label: "Tag 标签（英文逗号分隔）" },
    { value: "natural", label: "英文自然语言" },
    { value: "structured", label: "结构化描述" },
];

const REVIEW_SCORE_LABELS = {
    composition: "构图",
    prompt_alignment: "提示词一致性",
    subject_clarity: "主体清晰度",
    technical_quality: "技术质量",
};

const MAPPING_ROLES = [
    { key: "positive", label: "正向提示词", emptyText: "未识别正向提示词节点" },
    { key: "negative", label: "负向提示词", emptyText: "未识别负向提示词节点" },
    { key: "sampler", label: "采样器", emptyText: "未识别采样器" },
    { key: "latent", label: "画幅 / Latent", emptyText: "未识别画幅节点" },
    { key: "image", label: "成图来源", emptyText: "未识别可连接的 IMAGE 输出" },
    { key: "lora", label: "LoRA Loader (LoraManager)", emptyText: "未识别 LoRA Loader" },
];

const CHAT_SESSION_STORAGE_KEY = "aipa.agent-session.v1";
const PANEL_SIZE_STORAGE_KEY = "aipa.panel-size.v3";
const FOCUS_MODE_STORAGE_KEY = "aipa.focus-mode.v1";
const COMIC_MODE_STORAGE_KEY = "aipa.comic-mode.v1";
const COMIC_CONTINUATION_STORAGE_KEY = "aipa.comic-continuation.v1";
const COMIC_PROMPT_FORMAT_STORAGE_KEY = "aipa.comic-prompt-format.v1";
const STRIP_STYLE_STORAGE_KEY = "aipa.strip-style.v1";
const COMIC_HISTORY_STORAGE_KEY = "aipa.comic-history.v1";
const REVIEW_LOOP_STORAGE_KEY = "aipa.review-loop.v1";
const MAX_COMIC_HISTORY_ITEMS = 12;
const COMIC_PROMPT_FORMATS = PROMPT_FORMATS.filter((format) => format.value === "tag" || format.value === "natural");
const PANEL_MIN_WIDTH = 340;
const PANEL_MIN_HEIGHT = 360;
const INITIAL_AGENT_MESSAGE = "我是你的创作 Agent。告诉我一个模糊想法、角色片段、情绪或参考图，我会持续整理创作简报；方案准备好后，你可以直接交给当前工作流。";

const FOCUS_MODES = [
    {
        id: "explore",
        index: "A",
        short: "发散",
        title: "把可能性打开",
        note: "先保留歧义。我会给出彼此有距离的方向，并说明每条路会失去什么。",
        prompt: "先不要给最终提示词。请从叙事、构图、材质三个方向各提出一个明显不同的方案，并指出每个方案的风险。",
        placeholder: "写下一个还不完整的想法，让我们先打开可能性",
        angle: -135,
    },
    {
        id: "frame",
        index: "B",
        short: "定调",
        title: "让决定有边界",
        note: "把必须保留、可以变化与尚未确定的部分分开，先建立画面的判断标准。",
        prompt: "请把这个想法整理成清晰边界：列出必须保留、可以变化、需要我确认的内容，再给出一个主方向。",
        placeholder: "告诉我什么必须保留，什么可以被重新解释",
        angle: -45,
    },
    {
        id: "make",
        index: "C",
        short: "执行",
        title: "把判断压成指令",
        note: "减少修辞，检查冲突，把已确认的方向翻译成当前工作流可以执行的描述。",
        prompt: "请把已经确认的方向压缩成可直接交给当前工作流的创作需求，主动检查风格、构图与参数是否冲突。",
        placeholder: "给出已经确认的方向，我会把它压成可执行简报",
        angle: 45,
    },
    {
        id: "review",
        index: "D",
        short: "复盘",
        title: "从结果倒推偏差",
        note: "不只说好不好。我会区分概念、提示词、构图与参数分别出了什么问题。",
        prompt: "请用反证方式审视当前方案：指出最可能失败的三个地方，并分别判断问题来自概念、提示词、构图还是参数。",
        placeholder: "描述不满意的地方，或上传成图让我们倒推偏差",
        angle: 135,
    },
];

function restoreFocusMode() {
    try {
        const saved = window.localStorage.getItem(FOCUS_MODE_STORAGE_KEY);
        return FOCUS_MODES.some((mode) => mode.id === saved) ? saved : FOCUS_MODES[0].id;
    } catch {
        return FOCUS_MODES[0].id;
    }
}

function persistFocusMode(mode) {
    try {
        window.localStorage.setItem(FOCUS_MODE_STORAGE_KEY, mode);
    } catch {
        // The focus choice remains available during this page session.
    }
}

function restorePanelSize() {
    try {
        const saved = JSON.parse(window.localStorage.getItem(PANEL_SIZE_STORAGE_KEY) || "null");
        const width = Number(saved?.width);
        const height = Number(saved?.height);
        if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
    } catch {
        // A damaged saved preference should not prevent the panel from opening.
    }
    return null;
}

function persistPanelSize(size) {
    try {
        window.localStorage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify(size));
    } catch {
        // The panel remains resizable when browser storage is unavailable.
    }
}

function restoreComicMode() {
    try {
        return window.localStorage.getItem(COMIC_MODE_STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

function persistComicMode(enabled) {
    try {
        window.localStorage.setItem(COMIC_MODE_STORAGE_KEY, String(Boolean(enabled)));
    } catch {
        // The mode remains available during this session when browser storage is unavailable.
    }
}

function restoreComicContinuation() {
    try {
        return window.localStorage.getItem(COMIC_CONTINUATION_STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

function persistComicContinuation(enabled) {
    try {
        window.localStorage.setItem(COMIC_CONTINUATION_STORAGE_KEY, String(Boolean(enabled)));
    } catch {
        // The choice remains available during this page session when storage is unavailable.
    }
}

function restoreComicPromptFormat() {
    try {
        const value = window.localStorage.getItem(COMIC_PROMPT_FORMAT_STORAGE_KEY);
        return COMIC_PROMPT_FORMATS.some((format) => format.value === value) ? value : "tag";
    } catch {
        return "tag";
    }
}

function persistComicPromptFormat(value) {
    try {
        window.localStorage.setItem(COMIC_PROMPT_FORMAT_STORAGE_KEY, value);
    } catch {
        // The format remains selected for this page session when storage is unavailable.
    }
}

function restoreStripStyle() {
    try {
        const saved = window.localStorage.getItem(STRIP_STYLE_STORAGE_KEY);
        return saved === null ? true : saved === "true";
    } catch {
        return true;
    }
}

function persistStripStyle(enabled) {
    try {
        window.localStorage.setItem(STRIP_STYLE_STORAGE_KEY, String(Boolean(enabled)));
    } catch {
        // The preference remains available during this page session when storage is unavailable.
    }
}

function restoreReviewLoopPreferences() {
    const fallback = { mode: "rounds", maxRounds: 3, threshold: 85, autoApply: true, autoGenerate: true };
    try {
        const saved = JSON.parse(window.localStorage.getItem(REVIEW_LOOP_STORAGE_KEY) || "null");
        const mode = saved?.mode === "satisfied" ? "satisfied" : fallback.mode;
        const maxRounds = Math.max(1, Math.min(10, Number.parseInt(saved?.maxRounds, 10) || fallback.maxRounds));
        const threshold = Math.max(60, Math.min(100, Number(saved?.threshold) || fallback.threshold));
        return {
            mode,
            maxRounds,
            threshold,
            autoApply: saved?.autoApply !== false,
            autoGenerate: saved?.autoGenerate !== false,
        };
    } catch {
        return fallback;
    }
}

function persistReviewLoopPreferences(preferences) {
    try {
        window.localStorage.setItem(REVIEW_LOOP_STORAGE_KEY, JSON.stringify({
            mode: preferences.mode === "satisfied" ? "satisfied" : "rounds",
            maxRounds: Math.max(1, Math.min(10, Number.parseInt(preferences.maxRounds, 10) || 3)),
            threshold: Math.max(60, Math.min(100, Number(preferences.threshold) || 85)),
            autoApply: preferences.autoApply !== false,
            autoGenerate: preferences.autoGenerate !== false,
        }));
    } catch {
        // The loop remains configurable for this page session.
    }
}

function comicHistoryId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `comic-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanComicImage(image) {
    const filename = String(image?.filename || "").trim();
    if (!filename) return null;
    const type = image?.type === "temp" ? "temp" : "output";
    return {
        filename: filename.slice(0, 512),
        subfolder: String(image?.subfolder || "").slice(0, 512),
        type,
    };
}

function cleanComicPlan(plan) {
    if (!plan || typeof plan !== "object") return null;
    const panels = (Array.isArray(plan.panels) ? plan.panels : []).map((panel, index) => ({
        index: Number.isFinite(Number(panel?.index)) ? Number(panel.index) : index + 1,
        shot: String(panel?.shot || "").slice(0, 300),
        beat: String(panel?.beat || "").slice(0, 1200),
        continuity: String(panel?.continuity || "").slice(0, 1200),
        positive_prompt: String(panel?.positive_prompt || ""),
        continuation_note: String(panel?.continuation_note || "").slice(0, 1200),
    })).filter((panel) => panel.positive_prompt);
    if (!panels.length) return null;
    return {
        title: String(plan.title || "未命名漫画").slice(0, 120),
        logline: String(plan.logline || "").slice(0, 1200),
        character_bible: String(plan.character_bible || "").slice(0, 5000),
        visual_bible: String(plan.visual_bible || "").slice(0, 5000),
        panels,
    };
}

function restoreComicHistory() {
    try {
        const saved = JSON.parse(window.localStorage.getItem(COMIC_HISTORY_STORAGE_KEY) || "null");
        const items = Array.isArray(saved?.items) ? saved.items : [];
        return items.map((item) => {
            const plan = cleanComicPlan(item?.plan);
            if (!plan) return null;
            const collectedImages = (Array.isArray(item?.collectedImages) ? item.collectedImages : [])
                .map((result) => {
                    const image = cleanComicImage(result?.image);
                    return image ? { panelIndex: Math.max(0, Number(result?.panelIndex) || 0), image } : null;
                })
                .filter(Boolean);
            const status = ["planned", "paused", "completed", "error", "generating"].includes(item?.status) ? item.status : "planned";
            return {
                id: String(item?.id || comicHistoryId()),
                title: String(item?.title || plan.title || "未命名漫画").slice(0, 120),
                idea: String(item?.idea || "").slice(0, 3000),
                panelCount: Math.max(1, Math.min(12, Number(item?.panelCount) || plan.panels.length)),
                promptFormat: COMIC_PROMPT_FORMATS.some((format) => format.value === item?.promptFormat) ? item.promptFormat : "tag",
                continueWithImage: Boolean(item?.continueWithImage),
                createdAt: Number(item?.createdAt) || Date.now(),
                updatedAt: Number(item?.updatedAt) || Date.now(),
                status,
                currentIndex: Math.max(0, Math.min(plan.panels.length, Number(item?.currentIndex) || collectedImages.length)),
                plan,
                collectedImages,
            };
        }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_COMIC_HISTORY_ITEMS);
    } catch {
        return [];
    }
}

function persistComicHistory(items) {
    try {
        window.localStorage.setItem(COMIC_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, items: items.slice(0, MAX_COMIC_HISTORY_ITEMS) }));
    } catch {
        // History is optional; the active comic remains usable if storage is full.
    }
}

function chatSessionId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function newChatSession(title = "新对话") {
    return {
        id: chatSessionId(),
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sending: false,
        abortController: null,
        activeRequestId: 0,
        nextRequestId: 0,
        attachment: null,
        memory: "",
        messages: [{ role: "assistant", content: INITIAL_AGENT_MESSAGE }],
        lastPlan: null,
    };
}

function restoreChatSessions() {
    try {
        const saved = JSON.parse(window.localStorage.getItem(CHAT_SESSION_STORAGE_KEY) || "null");
        const rawSessions = Array.isArray(saved?.sessions)
            ? saved.sessions
            : (saved && Array.isArray(saved.messages) ? [{ ...saved, title: "历史对话" }] : []);
        const sessions = rawSessions.map((raw, index) => {
            const messages = (Array.isArray(raw?.messages) ? raw.messages : []).slice(-60).map((message) => ({
                role: message?.role === "user" ? "user" : "assistant",
                content: String(message?.content || "").slice(0, 4000),
                attachmentName: String(message?.attachmentName || "").slice(0, 120),
                plan: message?.plan && typeof message.plan === "object" ? normalizeChatPlan(message.plan) : null,
            })).filter((message) => message.content);
            const fallback = newChatSession(index === 0 ? "历史对话" : "新对话");
            return {
                ...fallback,
                id: String(raw?.id || fallback.id),
                title: String(raw?.title || (index === 0 ? "历史对话" : "新对话")).slice(0, 60),
                createdAt: Number(raw?.createdAt) || fallback.createdAt,
                updatedAt: Number(raw?.updatedAt) || fallback.updatedAt,
                memory: String(raw?.memory || "").slice(0, 1600),
                messages: messages.length ? messages : fallback.messages,
                lastPlan: raw?.lastPlan && typeof raw.lastPlan === "object" ? normalizeChatPlan(raw.lastPlan) : null,
            };
        });
        const safeSessions = sessions.length ? sessions : [newChatSession()];
        const activeId = safeSessions.some((session) => session.id === saved?.activeId) ? saved.activeId : safeSessions[0].id;
        return { sessions: safeSessions, activeId };
    } catch {
        const session = newChatSession();
        return { sessions: [session], activeId: session.id };
    }
}

const INITIAL_CHAT_STATE = restoreChatSessions();
const INITIAL_COMIC_HISTORY = restoreComicHistory();

function persistChatSessions(sessions, activeId) {
    try {
        window.localStorage.setItem(CHAT_SESSION_STORAGE_KEY, JSON.stringify({
            version: 2,
            activeId,
            sessions: sessions.map((chat) => ({
                id: chat.id,
                title: String(chat.title || "新对话").slice(0, 60),
                createdAt: chat.createdAt,
                updatedAt: chat.updatedAt,
                memory: String(chat.memory || "").slice(0, 1600),
                messages: chat.messages.slice(-60),
                lastPlan: chat.lastPlan,
            })),
        }));
    } catch {
        // The agent remains usable when browser storage is unavailable.
    }
}

function persistChatSession(chat = state.chat) {
    if (!chat) return;
    const sessions = Array.isArray(state.chatSessions) ? state.chatSessions : [chat];
    if (!sessions.some((item) => item.id === chat.id)) sessions.unshift(chat);
    persistChatSessions(sessions, state.activeChatId || chat.id);
}

const state = {
    open: true,
    chatExpanded: true,
    view: "main",
    tab: "chat",
    focusMode: restoreFocusMode(),
    stripStyle: restoreStripStyle(),
    counterpoint: false,
    mapping: {
        planner: "",
        reviewer: "",
        positive: "",
        negative: "",
        sampler: "",
        latent: "",
        image: "",
        lora: "",
    },
    manualRoles: new Set(),
    mappingRestored: false,
    pendingPlannerApply: false,
    pendingReviewerApply: false,
    lastReview: null,
    reviewLoop: {
        ...restoreReviewLoopPreferences(),
        running: false,
        paused: false,
        phase: "idle",
        currentRound: 0,
        history: [],
        activePromptId: "",
        awaitingStart: false,
        currentRunImages: [],
        currentPromptBefore: "",
        finishing: false,
        submissionToken: 0,
        plannerMode: null,
        reviewerMode: null,
        handledPromptIds: new Set(),
    },
    status: { kind: "idle", text: "" },
    settings: {
        loading: false,
        saving: false,
        refreshing: false,
        models: [],
        apiKeySet: false,
        allowParameterTuning: true,
    },
    localGeneration: {
        refreshing: false,
        models: [],
        samplers: [],
        schedulers: [],
    },
    generation: {
        signature: "",
    },
    comic: {
        enabled: restoreComicMode(),
        continueWithImage: restoreComicContinuation(),
        promptFormat: restoreComicPromptFormat(),
        continuing: false,
        continuationAbortController: null,
        continuationWarning: "",
        planning: false,
        running: false,
        phase: "idle",
        idea: "",
        panelCount: 4,
        plan: null,
        currentIndex: 0,
        collectedImages: [],
        currentRunImages: [],
        activePromptId: "",
        awaitingStart: false,
        finishing: false,
        submissionToken: 0,
        plannerMode: null,
        reviewerMode: null,
        history: INITIAL_COMIC_HISTORY,
        historyId: "",
    },
    chatSessions: INITIAL_CHAT_STATE.sessions,
    activeChatId: INITIAL_CHAT_STATE.activeId,
    chat: INITIAL_CHAT_STATE.sessions.find((session) => session.id === INITIAL_CHAT_STATE.activeId) || INITIAL_CHAT_STATE.sessions[0],
    reverse: {
        image: null,
        result: null,
        notes: "",
        phase: "idle",
        error: "",
        sending: false,
        abortController: null,
        activeRequestId: 0,
        nextRequestId: 0,
    },
};

function currentGraph() {
    // Recent ComfyUI builds throw while the graph getter is initializing.
    // The panel can safely render first and pick up the graph on the next tick.
    try {
        return app.graph || null;
    } catch {
        return null;
    }
}

function allNodes() {
    const graph = currentGraph();
    return graph?._nodes || [];
}

function nodesOf(type) {
    return allNodes().filter((node) => node.comfyClass === type || node.type === type);
}

function nodeById(id) {
    return allNodes().find((node) => String(node.id) === String(id));
}

function widget(node, name) {
    return node?.widgets?.find((item) => item.name === name);
}

function setWidget(node, name, value) {
    const item = widget(node, name);
    if (!item) return false;
    const previousValue = item.value;
    if (previousValue === value) return true;
    item.value = value;
    item.callback?.(value);
    node?.onWidgetChanged?.(name, value, previousValue, item);
    node?.graph?.setDirtyCanvas(true, true);
    return true;
}

function updateWidgetOptions(node, name, values, asCombo = false) {
    const item = widget(node, name);
    if (!item || !Array.isArray(values) || !values.length) return false;
    item.options = { ...(item.options || {}), values };
    if (asCombo) item.type = "combo";
    if (!values.includes(item.value)) item.value = values[0];
    item.callback?.(item.value);
    node?.graph?.setDirtyCanvas(true, true);
    return true;
}

function applyLocalGenerationOptions() {
    const { models, samplers, schedulers } = state.localGeneration;
    for (const node of [...nodesOf(NODE_TYPES.planner), ...nodesOf(NODE_TYPES.reviewer)]) {
        updateWidgetOptions(node, "image_model", models);
    }
    for (const node of allNodes()) {
        updateWidgetOptions(node, "sampler_name", samplers, true);
        updateWidgetOptions(node, "scheduler", schedulers, true);
    }
    state.generation.signature = "";
}

function nodeLabel(node) {
    const type = node.comfyClass || node.type || "节点";
    return `${node.title || type} #${node.id}`;
}

function hasWidget(node, name) {
    return Boolean(widget(node, name));
}

function typeText(node) {
    return `${node.comfyClass || ""} ${node.type || ""} ${node.title || ""}`.toLowerCase();
}

function linkById(id) {
    const links = currentGraph()?.links;
    if (!links) return null;
    return typeof links.get === "function" ? links.get(id) : links[id];
}

function linkedPromptRole(node) {
    for (const output of node.outputs || []) {
        for (const linkId of output.links || []) {
            const link = linkById(linkId);
            if (!link) continue;
            const target = nodeById(link.target_id ?? link[3]);
            const input = target?.inputs?.[link.target_slot ?? link[4]];
            const name = String(input?.name || "").toLowerCase();
            if (name === "positive" || /正向|正面/.test(name)) return "positive";
            if (name === "negative" || /负向|负面/.test(name)) return "negative";
        }
    }
    return "";
}

function promptScore(node, role) {
    if (!hasWidget(node, "text") && !hasWidget(node, "prompt")) return -1;
    const text = `${typeText(node)} ${widget(node, "text")?.value || ""}`.toLowerCase();
    const promptLike = /clip.*text|text.*encode|prompt/.test(text) ? 30 : 0;
    const positiveTerms = /positive|正向|正面|prompt/.test(text) ? 60 : 0;
    const negativeTerms = /negative|负向|负面|low quality|bad anatomy/.test(text) ? 90 : 0;
    const connectedRole = linkedPromptRole(node);
    if (!promptLike && !connectedRole) return -1;
    const connectionScore = connectedRole === role ? 240 : connectedRole ? -240 : 0;
    return role === "positive" ? promptLike + positiveTerms - negativeTerms + connectionScore : promptLike + negativeTerms - positiveTerms + connectionScore;
}

function candidatesFor(role) {
    if (role === "image") return imageSourceCandidates();
    const nodes = allNodes().filter((node) => !Object.values(NODE_TYPES).includes(node.comfyClass || node.type));
    const scored = nodes.map((node) => {
        const text = typeText(node);
        let score = null;
        if (role === "positive" || role === "negative") score = promptScore(node, role);
        if (role === "sampler" && (/ksampler|sampler/.test(text) || (hasWidget(node, "steps") && hasWidget(node, "cfg")))) score = 100;
        if (role === "latent" && ((hasWidget(node, "width") && hasWidget(node, "height")) || /empty.*latent|latent.*image/.test(text))) score = 100;
        if (role === "lora" && (/lora\s*loader.*loramanager|loraloaderlm|lora\s*stacker.*loramanager/.test(text))) score = 260;
        return { node, score };
    });
    return scored.filter((item) => item.score !== null && item.score !== -1).sort((a, b) => b.score - a.score || Number(a.node.id) - Number(b.node.id)).map((item) => item.node);
}

function imageOutputSlots(node) {
    return (node?.outputs || []).map((output, index) => ({ output, index })).filter(({ output }) => {
        const type = String(output?.type || "").toUpperCase();
        return type.split(",").map((part) => part.trim()).includes("IMAGE");
    });
}

function imageInputSlot(node) {
    const inputs = node?.inputs || [];
    const namedSlot = inputs.findIndex((input) => String(input?.name || "").toLowerCase() === "image");
    if (namedSlot >= 0) return namedSlot;
    return inputs.findIndex((input) => String(input?.type || "").toUpperCase().split(",").map((part) => part.trim()).includes("IMAGE"));
}

function linkOrigin(link) {
    if (!link) return { nodeId: undefined, slot: undefined };
    return { nodeId: link.origin_id ?? link[1], slot: link.origin_slot ?? link[2] };
}

function imageSourceCandidates() {
    return allNodes().map((node) => {
        const slots = imageOutputSlots(node);
        if (!slots.length) return null;
        const isConnectedToImageSink = slots.some(({ output }) => (output.links || []).some((linkId) => {
            const link = linkById(linkId);
            const target = nodeById(link?.target_id ?? link?.[3]);
            const input = target?.inputs?.[link?.target_slot ?? link?.[4]];
            return /images?/.test(String(input?.name || "").toLowerCase());
        }));
        const decodeLike = /vae.*decode|decode.*vae/.test(typeText(node));
        return { node, score: 100 + (isConnectedToImageSink ? 120 : 0) + (decodeLike ? 40 : 0) };
    }).filter(Boolean).sort((a, b) => b.score - a.score || Number(a.node.id) - Number(b.node.id)).map((item) => item.node);
}

function reviewConnectionState(source = mappingNode("image"), reviewer = mappingNode("reviewer")) {
    if (!reviewer) return { kind: "error", text: "未选择图片评审节点。" };
    if (!source) return { kind: "error", text: "未选择成图来源。" };
    const inputSlot = imageInputSlot(reviewer);
    const sourceSlot = imageOutputSlots(source)[0]?.index;
    if (inputSlot < 0) return { kind: "error", text: "评审节点没有 IMAGE 输入。" };
    if (sourceSlot === undefined) return { kind: "error", text: "成图来源没有 IMAGE 输出。" };
    const link = linkById(reviewer.inputs?.[inputSlot]?.link);
    if (!link) return { kind: "ready", text: "待连接：成图来源将接入评审节点。" };
    const origin = linkOrigin(link);
    if (String(origin.nodeId) === String(source.id) && Number(origin.slot) === sourceSlot) {
        return { kind: "connected", text: "已连接：评审将使用当前成图来源。" };
    }
    return { kind: "ready", text: "评审节点已有其他图片来源，连接时会替换为当前选择。" };
}

function connectReviewImage(source, reviewer) {
    const graph = currentGraph();
    const inputSlot = imageInputSlot(reviewer);
    const sourceSlot = imageOutputSlots(source)[0]?.index;
    if (!graph || inputSlot < 0 || sourceSlot === undefined || typeof source?.connect !== "function") {
        throw new Error("无法建立图片连线，请确认成图来源和评审节点。");
    }
    const current = reviewConnectionState(source, reviewer);
    if (current.kind === "connected") return { replaced: false, reused: true };
    const hadLink = Boolean(reviewer.inputs?.[inputSlot]?.link);
    graph.beforeChange?.();
    try {
        if (hadLink) reviewer.disconnectInput?.(inputSlot);
        // Recent ComfyUI LiteGraph wrappers require the target node object,
        // rather than its numeric id, when creating a link.
        source.connect(sourceSlot, reviewer, inputSlot);
    } finally {
        graph.afterChange?.();
    }
    const confirmed = reviewConnectionState(source, reviewer);
    if (confirmed.kind !== "connected") throw new Error("图片连线未成功，请手动检查节点类型。");
    graph.setDirtyCanvas?.(true, true);
    return { replaced: hadLink, reused: false };
}

function refreshSelect(select, list, selectedId, emptyText, includeNone = false) {
    const old = selectedId || select.value;
    select.replaceChildren();
    if (includeNone) {
        const option = document.createElement("option");
        option.textContent = "不使用此节点";
        option.value = "";
        select.append(option);
    }
    if (!list.length) {
        const option = document.createElement("option");
        option.textContent = emptyText;
        option.value = "";
        select.append(option);
        return "";
    }
    for (const node of list) {
        const option = document.createElement("option");
        option.value = String(node.id);
        option.textContent = nodeLabel(node);
        select.append(option);
    }
    const next = list.some((node) => String(node.id) === old) ? old : (includeNone && old === "" ? "" : String(list[0].id));
    select.value = next;
    return next;
}

function mappingNode(role) {
    return nodeById(state.mapping[role]);
}

function restoreManualMapping() {
    if (state.mappingRestored) return;
    const graph = currentGraph();
    if (!graph) return;
    state.mappingRestored = true;
    const saved = graph.extra?.aiPromptAssistantMapping;
    if (!saved || typeof saved !== "object") return;
    for (const role of [...MAPPING_ROLES.map((item) => item.key), "planner", "reviewer"]) {
        if (!Object.prototype.hasOwnProperty.call(saved, role)) continue;
        state.mapping[role] = String(saved[role] ?? "");
        state.manualRoles.add(role);
    }
}

function persistManualMapping() {
    const graph = currentGraph();
    if (!graph) return;
    const saved = {};
    for (const role of state.manualRoles) saved[role] = state.mapping[role] || "";
    graph.extra = graph.extra || {};
    graph.extra.aiPromptAssistantMapping = saved;
    graph.setDirtyCanvas?.(true, true);
}

function autoMap(force = false) {
    if (force) state.manualRoles.clear();
    const used = new Set();
    for (const role of ["positive", "negative", "sampler", "latent", "image", "lora"]) {
        let existing = mappingNode(role);
        // Older versions could persist Save Image as the source. It accepts an
        // image but cannot feed the reviewer, so discard that stale mapping.
        if (role === "image" && existing && !imageOutputSlots(existing).length) {
            state.mapping.image = "";
            state.manualRoles.delete("image");
            existing = null;
        }
        if (!existing && state.mapping[role] && state.manualRoles.has(role)) state.manualRoles.delete(role);
        if (existing && !force) {
            used.add(String(existing.id));
            continue;
        }
        if (state.manualRoles.has(role)) continue;
        const candidates = candidatesFor(role);
        const chosen = candidates.find((node) => !used.has(String(node.id))) || candidates[0];
        state.mapping[role] = chosen ? String(chosen.id) : "";
        if (chosen) used.add(String(chosen.id));
    }
    for (const role of ["planner", "reviewer"]) {
        const existing = mappingNode(role);
        if (!existing && state.mapping[role] && state.manualRoles.has(role)) state.manualRoles.delete(role);
        if (existing && !force) continue;
        if (state.manualRoles.has(role)) continue;
        const candidate = nodesOf(NODE_TYPES[role])[0];
        state.mapping[role] = candidate ? String(candidate.id) : "";
    }
}

function workflowSignature() {
    return allNodes().map((node) => {
        const links = (node.inputs || []).map((input) => input.link || "").join(",");
        const values = (node.widgets || []).map((item) => `${item.name}:${String(item.value ?? "")}`).join(",");
        return `${node.id}:${node.comfyClass || node.type}:${node.title || ""}:${links}:${values}`;
    }).join("|");
}

function selectCanvasNode(node) {
    if (!node || !app.canvas) return;
    app.canvas.selectNode(node, false);
    app.canvas.centerOnNode?.(node);
    app.canvas.setDirty(true, true);
}

function queue() {
    if (typeof app.queuePrompt !== "function") throw new Error("当前 ComfyUI 前端无法提交工作流。");
    return app.queuePrompt(0);
}

function addAssistantNode(role, focus = true) {
    const graph = currentGraph();
    const node = window.LiteGraph?.createNode(NODE_TYPES[role]);
    if (!graph || !node) throw new Error("无法创建节点，请检查插件是否已加载。");
    const canvas = app.canvas;
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    const viewport = canvas?.canvas;
    const horizontalOffset = role === "planner" ? -180 : 180;
    if (viewport) node.pos = [(viewport.width / 2 - offset[0]) / scale + horizontalOffset, (viewport.height / 2 - offset[1]) / scale];
    graph.beforeChange?.();
    try {
        graph.add(node, false);
    } finally {
        graph.afterChange?.();
    }
    graph.setDirtyCanvas?.(true, true);
    state.mapping[role] = String(node.id);
    state.manualRoles.add(role);
    persistManualMapping();
    if (focus) selectCanvasNode(node);
    return node;
}

function outputValue(output, name) {
    const value = output?.[name];
    return Array.isArray(value) ? value[0] : value;
}

function outputObject(value) {
    const first = Array.isArray(value) ? value[0] : value;
    if (!first || typeof first === "object") return first || null;
    if (typeof first !== "string") return null;
    try {
        const parsed = JSON.parse(first);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function normalizedNodeOutput(output) {
    const syncOutput = outputObject(output?.ai_prompt_sync)
        || outputObject(output?.prompt_sync)
        || outputObject(output?.ui?.ai_prompt_sync)
        || outputObject(output?.ui?.prompt_sync);
    const result = output?.result;
    const tuple = Array.isArray(result?.[0]) ? result[0] : (Array.isArray(result) ? result : []);
    const aliases = [
        "positive_prompt", "negative_prompt", "sampler_name", "scheduler",
        "steps", "cfg", "width", "height", "denoise", "seed", "reasoning",
    ];
    const normalized = { ...(output || {}), ...(syncOutput || {}) };
    for (const [index, name] of aliases.entries()) {
        if (normalized[name] === undefined && tuple[index] !== undefined) normalized[name] = tuple[index];
    }
    return normalized;
}

function applyAiOutputToWorkflow(output) {
    output = normalizedNodeOutput(output);
    let applied = 0;
    const positive = outputValue(output, "positive_prompt");
    if (typeof positive === "string" && positive.trim() && setWidget(mappingNode("positive"), "text", positive.trim())) applied += 1;
    if (state.settings.allowParameterTuning === false) return applied;
    const sampler = mappingNode("sampler");
    const latent = mappingNode("latent");
    for (const name of ["sampler_name", "scheduler", "steps", "cfg", "denoise"]) {
        const value = outputValue(output, name);
        if (value !== undefined && setWidget(sampler, name, value)) applied += 1;
    }
    for (const name of ["width", "height"]) {
        const value = outputValue(output, name);
        if (value !== undefined && setWidget(latent, name, value)) applied += 1;
    }
    return applied;
}

function loraManagerContext() {
    const node = mappingNode("lora");
    if (!node) return "未检测到 Lora Loader (LoraManager)。正向提示词将直接写入当前映射的文本编码节点。";
    const entries = widgetValue(node, "loras");
    const active = Array.isArray(entries)
        ? entries.filter((item) => item && item.active !== false).map((item) => {
            const name = String(item.name || "").trim();
            const strength = item.strength ?? item.model_strength;
            return name ? `${name}${strength === undefined ? "" : `:${strength}`}` : "";
        }).filter(Boolean)
        : [];
    return [
        "已检测到 Lora Loader (LoraManager)。",
        active.length ? `当前启用 LoRA：${active.join(", ")}` : "当前没有从 loras 控件读取到启用项。",
        "LoRA 由 Loader 的 loras 配置加载，触发词由其输出传给 Prompt (LoraManager)；不要把 <lora:...> 语法或自动触发词重复写进正向提示词。",
    ].join("\n");
}

function widgetValue(node, name) {
    return widget(node, name)?.value;
}

function syncReviewerInputsFromWorkflow(reviewer) {
    let synced = 0;
    const promptValues = [
        ["current_positive_prompt", widgetValue(mappingNode("positive"), "text")],
        ["current_negative_prompt", widgetValue(mappingNode("negative"), "text")],
    ];
    for (const [name, value] of promptValues) {
        if (typeof value === "string" && setWidget(reviewer, name, value)) synced += 1;
    }
    if (setWidget(reviewer, "lora_context", loraManagerContext())) synced += 1;
    const sampler = mappingNode("sampler");
    const latent = mappingNode("latent");
    for (const name of ["sampler_name", "scheduler", "steps", "cfg", "denoise"]) {
        const value = widgetValue(sampler, name);
        if (value !== undefined && setWidget(reviewer, name, value)) synced += 1;
    }
    for (const name of ["width", "height"]) {
        const value = widgetValue(latent, name);
        if (value !== undefined && setWidget(reviewer, name, value)) synced += 1;
    }
    return synced;
}

function syncLockedPlannerParametersFromWorkflow() {
    if (state.settings.allowParameterTuning !== false) return 0;
    const planner = mappingNode("planner");
    const sampler = mappingNode("sampler");
    const latent = mappingNode("latent");
    let synced = 0;
    const copy = (source, target, name) => {
        const value = widgetValue(source, name);
        if (value !== undefined && widgetValue(target, name) !== value && setWidget(target, name, value)) synced += 1;
    };
    for (const name of ["sampler_name", "scheduler", "steps", "cfg", "denoise"]) copy(sampler, planner, name);
    for (const name of ["width", "height"]) copy(latent, planner, name);
    return synced;
}

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) node.append(child);
    return node;
}

const ICON_PATHS = {
    plus: ["M12 5v14", "M5 12h14"],
    expand: ["M8 3H5a2 2 0 0 0-2 2v3", "M16 3h3a2 2 0 0 1 2 2v3", "M8 21H5a2 2 0 0 1-2-2v-3", "M16 21h3a2 2 0 0 0 2-2v-3"],
    shrink: ["M8 8H3V3", "M16 8h5V3", "M8 16H3v5", "M16 16h5v5"],
    settings: ["M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.02 1.56V20.3h-3v-.08a1.7 1.7 0 0 0-1.02-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7.06 15a1.7 1.7 0 0 0-1.56-1.02H5.4v-3h.1A1.7 1.7 0 0 0 7.06 9.96a1.7 1.7 0 0 0-.34-1.88l-.06-.06L8.78 5.9l.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.02-1.56V4.66h3v.08a1.7 1.7 0 0 0 1.02 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.02h.1v3h-.1A1.7 1.7 0 0 0 19.4 15Z"],
    minimize: ["M5 12h14"],
    arrow: ["M5 12h14", "m14 0-5-5", "m14 0-5 5"],
    copy: ["M8 8h11v11H8z", "M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1"],
    spark: ["m12 3 .9 3.1L16 7l-3.1.9L12 11l-.9-3.1L8 7l3.1-.9L12 3Z", "m18 14 .6 2.1 2.1.6-2.1.6L18 19.5l-.6-2.2-2.2-.6 2.2-.6L18 14Z", "M5 13v6", "M2 16h6"],
};

function icon(name, className = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("aipa-icon");
    if (className) svg.classList.add(className);
    for (const data of ICON_PATHS[name] || []) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", data);
        svg.append(path);
    }
    return svg;
}

function stageTab(index, label, detail, ariaLabel) {
    return el("button", { className: "aipa-tab", type: "button", role: "tab", ariaLabel }, [
        el("span", { className: "aipa-tab-index", textContent: index }),
        el("span", { className: "aipa-tab-copy" }, [
            el("strong", { textContent: label }),
            el("small", { textContent: detail }),
        ]),
    ]);
}

function focusModeById(id) {
    return FOCUS_MODES.find((mode) => mode.id === id) || FOCUS_MODES[0];
}

function makeFocusInstrument({ onModeChange, onApply }) {
    const root = el("section", { className: "aipa-focus-instrument", ariaLabel: "创作对焦仪" });
    const eyebrow = el("span", { className: "aipa-focus-eyebrow", textContent: "SECOND SIGHT / 创作对焦仪" });
    const carryReadout = el("span", { className: "aipa-focus-carry" });
    const stageReadout = el("span", { className: "aipa-focus-stage", textContent: "构想阶段" });
    const heading = el("h2");
    const description = el("p", { className: "aipa-focus-description" });
    const counterpoint = el("p", {
        className: "aipa-focus-counterpoint",
        textContent: "反证层：先问清楚什么不能改变，再讨论还能增加什么。",
        role: "status",
        ariaLive: "polite",
    });
    const apply = el("button", { className: "aipa-focus-apply", type: "button" }, [
        el("span", { textContent: "把这个角度带入对话" }),
        icon("arrow"),
    ]);

    const dial = el("div", { className: "aipa-focus-dial", role: "group", ariaLabel: "拖动或选择协作焦段" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("aipa-focus-map");
    const orbit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    orbit.setAttribute("cx", "50");
    orbit.setAttribute("cy", "50");
    orbit.setAttribute("r", "36");
    orbit.classList.add("aipa-focus-orbit");
    const crossA = document.createElementNS("http://www.w3.org/2000/svg", "path");
    crossA.setAttribute("d", "M14 50H86M50 14V86");
    crossA.classList.add("aipa-focus-cross");
    const signal = document.createElementNS("http://www.w3.org/2000/svg", "path");
    signal.classList.add("aipa-focus-signal");
    const pulse = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pulse.classList.add("aipa-focus-pulse");
    svg.append(orbit, crossA, signal, pulse);

    const core = el("button", {
        className: "aipa-focus-core",
        type: "button",
        title: "切换反证层",
        ariaLabel: "切换隐藏的反证视角",
        ariaPressed: "false",
    }, [el("span", { textContent: "2ND" }), el("small", { textContent: "SIGHT" })]);
    const handle = el("button", {
        className: "aipa-focus-handle",
        type: "button",
        title: "拖动调整焦段；方向键切换",
        ariaLabel: "当前协作焦段，可拖动或用方向键切换",
        ariaKeyShortcuts: "ArrowLeft ArrowRight ArrowUp ArrowDown",
    });
    dial.append(svg, core, handle);

    const modeButtons = FOCUS_MODES.map((mode) => {
        const button = el("button", { className: "aipa-focus-mode", type: "button", ariaLabel: `选择${mode.short}焦段` }, [
            el("span", { textContent: mode.index }),
            el("strong", { textContent: mode.short }),
        ]);
        button.dataset.mode = mode.id;
        return button;
    });
    const modeList = el("div", { className: "aipa-focus-modes", role: "list" }, modeButtons);
    const copy = el("div", { className: "aipa-focus-copy" }, [eyebrow, heading, description, counterpoint, apply]);
    const head = el("div", { className: "aipa-focus-head" }, [eyebrow.cloneNode(true), carryReadout, stageReadout]);
    root.append(head, el("div", { className: "aipa-focus-stagecraft" }, [copy, dial]), modeList);

    let selectedIndex = Math.max(0, FOCUS_MODES.findIndex((mode) => mode.id === state.focusMode));
    let transitionTimer = 0;
    let committing = false;
    let commitTimers = [];

    function setGeometry(mode, immediate = false) {
        const radians = mode.angle * Math.PI / 180;
        const x = 50 + Math.cos(radians) * 36;
        const y = 50 + Math.sin(radians) * 36;
        root.style.setProperty("--aipa-focus-x", `${x}%`);
        root.style.setProperty("--aipa-focus-y", `${y}%`);
        const bend = selectedIndex % 2 === 0 ? 18 : -18;
        const path = `M 50 50 C ${50 + bend} ${50 - bend}, ${x - bend * 0.45} ${y + bend * 0.45}, ${x} ${y}`;
        signal.setAttribute("d", path);
        pulse.setAttribute("d", path);
        if (immediate) return;
        root.classList.remove("is-transitioning");
        window.clearTimeout(transitionTimer);
        window.requestAnimationFrame(() => root.classList.add("is-transitioning"));
        transitionTimer = window.setTimeout(() => root.classList.remove("is-transitioning"), 1050);
    }

    function render(immediate = false) {
        const mode = focusModeById(state.focusMode);
        const reverseStage = root.dataset.stage === "reverse";
        selectedIndex = Math.max(0, FOCUS_MODES.indexOf(mode));
        root.dataset.mode = mode.id;
        heading.textContent = reverseStage ? "从可见证据开始" : mode.title;
        description.textContent = reverseStage
            ? "先确认图片里真正看见了什么，再把主体、构图、光线和材质整理成可执行的提示词。"
            : mode.note;
        if (!committing) apply.firstElementChild.textContent = reverseStage ? "把观察带入对话" : "把这个角度带入对话";
        carryReadout.textContent = `携带焦段 ${mode.index} / ${mode.short}`;
        handle.ariaLabel = `当前为${mode.short}焦段，可拖动或用方向键切换`;
        handle.title = `${mode.index} ${mode.short}：${mode.title}`;
        for (const button of modeButtons) {
            const selected = button.dataset.mode === mode.id;
            button.classList.toggle("is-active", selected);
            button.ariaPressed = String(selected);
        }
        setGeometry(mode, immediate);
    }

    function selectMode(index, announce = true) {
        if (committing) resetCommit();
        const next = (index + FOCUS_MODES.length) % FOCUS_MODES.length;
        const mode = FOCUS_MODES[next];
        if (mode.id === state.focusMode) return;
        selectedIndex = next;
        state.focusMode = mode.id;
        persistFocusMode(mode.id);
        render();
        onModeChange?.(mode, announce);
    }

    for (const [index, button] of modeButtons.entries()) button.onclick = () => selectMode(index);
    function resetCommit() {
        commitTimers.forEach((timer) => window.clearTimeout(timer));
        commitTimers = [];
        committing = false;
        root.classList.remove("is-committing", "is-routing", "is-resolving");
        apply.firstElementChild.textContent = "把这个角度带入对话";
    }

    function finishCommit(mode) {
        resetCommit();
        onApply?.(mode);
    }

    apply.onclick = () => {
        const mode = focusModeById(state.focusMode);
        if (committing) {
            finishCommit(mode);
            return;
        }
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        committing = true;
        root.classList.add("is-committing");
        apply.firstElementChild.textContent = "校准角度 01/03";
        if (reducedMotion) {
            finishCommit(mode);
            return;
        }
        commitTimers.forEach((timer) => window.clearTimeout(timer));
        commitTimers = [
            window.setTimeout(() => {
                root.classList.add("is-routing");
                apply.firstElementChild.textContent = "收束判断 02/03";
            }, 360),
            window.setTimeout(() => {
                root.classList.add("is-resolving");
                apply.firstElementChild.textContent = "写入对话 03/03";
            }, 840),
            window.setTimeout(() => finishCommit(mode), 1320),
        ];
    };
    core.onclick = () => {
        if (committing) resetCommit();
        state.counterpoint = !state.counterpoint;
        root.classList.toggle("is-counterpoint", state.counterpoint);
        core.ariaPressed = String(state.counterpoint);
    };
    handle.onkeydown = (event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        selectMode(selectedIndex + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1));
    };

    function modeFromPointer(event) {
        const rect = dial.getBoundingClientRect();
        const x = event.clientX - rect.left - rect.width / 2;
        const y = event.clientY - rect.top - rect.height / 2;
        const angle = Math.atan2(y, x) * 180 / Math.PI;
        let bestIndex = 0;
        let bestDistance = Infinity;
        for (const [index, mode] of FOCUS_MODES.entries()) {
            const difference = Math.abs(((angle - mode.angle + 540) % 360) - 180);
            if (difference < bestDistance) {
                bestDistance = difference;
                bestIndex = index;
            }
        }
        selectMode(bestIndex, false);
    }
    handle.onpointerdown = (event) => {
        event.preventDefault();
        if (committing) resetCommit();
        root.classList.add("is-dragging");
        handle.setPointerCapture(event.pointerId);
        modeFromPointer(event);
    };
    handle.onpointermove = (event) => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        modeFromPointer(event);
    };
    const finishDrag = (event) => {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        root.classList.remove("is-dragging");
        onModeChange?.(focusModeById(state.focusMode), true);
    };
    handle.onpointerup = finishDrag;
    handle.onpointercancel = finishDrag;

    function update({ stage = "chat", working = false } = {}) {
        const labels = { chat: "构想阶段", reverse: "图片反推", comic: "连续分镜", planner: "定稿阶段", reviewer: "复盘阶段", settings: "系统设置" };
        root.dataset.stage = stage;
        root.classList.toggle("is-working", working);
        root.classList.toggle("is-counterpoint", state.counterpoint);
        stageReadout.textContent = labels[stage] || labels.chat;
        render(true);
    }

    render(true);
    return { element: root, update, selectMode };
}

function label(text, input) {
    const wrap = el("label", { className: "aipa-field" });
    wrap.append(el("span", { className: "aipa-label", textContent: text }), input);
    return wrap;
}

function makePromptFormatSelect(ariaLabel) {
    const select = el("select", { ariaLabel });
    for (const format of PROMPT_FORMATS) {
        select.append(el("option", { value: format.value, textContent: format.label }));
    }
    select.value = "tag";
    return select;
}

function makeComicPromptFormatSelect(ariaLabel) {
    const select = el("select", { ariaLabel });
    for (const format of COMIC_PROMPT_FORMATS) {
        select.append(el("option", { value: format.value, textContent: format.label }));
    }
    select.value = state.comic.promptFormat;
    return select;
}

function syncFormatFromNode(select, node) {
    const value = widget(node, "prompt_format")?.value;
    if (PROMPT_FORMATS.some((format) => format.value === value)) select.value = value;
}

function promptFormatLabel(value) {
    return PROMPT_FORMATS.find((format) => format.value === value)?.label || "标签格式";
}

function nodePromptFormat(node, fallback = "tag") {
    const value = widget(node, "prompt_format")?.value;
    return PROMPT_FORMATS.some((format) => format.value === value) ? value : fallback;
}

function setStatus(kind, text) {
    state.status = { kind, text };
}

async function aipaRequest(path, options = {}) {
    const request = {
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
    };
    const response = await (typeof api.fetchApi === "function" ? api.fetchApi(path, request) : fetch(path, request));
    let body = null;
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) throw new Error(body?.error || `请求失败（${response.status}）`);
    return body;
}

function makeWorkflowMapping() {
    const section = el("section", { className: "aipa-mapping" });
    const header = el("div", { className: "aipa-mapping-header" });
    const heading = el("div", {}, [
        el("strong", { textContent: "工作流节点映射" }),
        el("small", { textContent: "自动识别后仍可逐项指定" }),
    ]);
    const detect = el("button", { className: "aipa-secondary aipa-detect", type: "button", textContent: "重新识别", ariaLabel: "重新识别工作流节点" });
    const status = el("p", { className: "aipa-mapping-status", role: "status", ariaLive: "polite" });
    const fields = el("div", { className: "aipa-mapping-fields" });
    const selects = {};

    for (const role of MAPPING_ROLES) {
        const select = el("select", { ariaLabel: `配置${role.label}节点` });
        const locate = el("button", { className: "aipa-locate", type: "button", textContent: "定位", ariaLabel: `定位${role.label}节点` });
        const control = el("div", { className: "aipa-mapping-control" }, [select, locate]);
        fields.append(label(role.label, control));
        selects[role.key] = select;
        select.onchange = () => {
            state.mapping[role.key] = select.value;
            state.manualRoles.add(role.key);
            persistManualMapping();
            update();
        };
        locate.onclick = () => selectCanvasNode(mappingNode(role.key));
    }

    detect.onclick = () => {
        autoMap(true);
        persistManualMapping();
        update();
    };
    header.append(heading, detect);
    section.append(header, status, fields);

    function update() {
        restoreManualMapping();
        autoMap();
        let configured = 0;
        for (const role of MAPPING_ROLES) {
            const candidates = candidatesFor(role.key);
            const selected = mappingNode(role.key);
            if (selected && !candidates.some((node) => String(node.id) === String(selected.id))) candidates.unshift(selected);
            state.mapping[role.key] = refreshSelect(selects[role.key], candidates, state.mapping[role.key], role.emptyText, true);
            if (state.mapping[role.key]) configured += 1;
        }
        const manual = MAPPING_ROLES.filter((role) => state.manualRoles.has(role.key)).length;
        status.textContent = configured
            ? `已映射 ${configured}/${MAPPING_ROLES.length} 项${manual ? `，其中 ${manual} 项为手动配置` : ""}`
            : "未找到可映射的基础节点；请手动选择，或先在画布中添加工作流节点。";
    }

    return { element: section, update };
}

function makeReport(report) {
    const area = el("div", { className: "aipa-report", role: "status", ariaLive: "polite" });
    if (!report) {
        area.append(el("p", { className: "aipa-empty", textContent: "执行图片评审后，这里会显示评分和修改建议。" }));
        return area;
    }
    if (report.enabled === false) {
        area.append(el("p", { className: "aipa-empty", textContent: report.summary || "图片评审未执行，因此没有生成评分。" }));
        return area;
    }
    const scoreValue = normalizedScore(report.score);
    const score = scoreValue === null ? "--" : `${scoreValue}/100`;
    const confidence = Number.isFinite(Number(report.confidence)) ? `${Math.round(Number(report.confidence) * 100)}%` : "--";
    const summary = el("p", { className: "aipa-summary", textContent: report.summary || "评审完成。" });
    const scorePanel = el("section", { className: "aipa-score-panel", ariaLabel: "图片质量评分" });
    const scoreRing = el("div", { className: `aipa-score-ring ${scoreTone(scoreValue)}` });
    if (scoreValue !== null) scoreRing.style.setProperty("--aipa-score-value", "0%");
    scoreRing.append(el("strong", { textContent: scoreValue === null ? "--" : String(scoreValue) }), el("span", { textContent: "/ 100" }));
    const scoreCopy = el("div", { className: "aipa-score-copy" }, [
        el("strong", { textContent: scoreLabel(scoreValue) }),
        el("span", { textContent: scoreValue === null ? "模型没有返回评分" : "本次生成结果的综合评估" }),
    ]);
    scorePanel.append(scoreRing, scoreCopy);
    const reviewMetrics = [
        el("span", { className: "aipa-metric", textContent: `置信度 ${confidence}` }),
        el("span", { className: "aipa-metric", textContent: formatLabel(report.prompt_format) }),
        el("span", { className: "aipa-metric aipa-action", textContent: actionLabel(report.action) }),
    ];
    if (report.satisfied === true) reviewMetrics.push(el("span", { className: "aipa-metric aipa-satisfied", textContent: "AI 判定满意" }));
    area.append(scorePanel, el("div", { className: "aipa-metrics" }, reviewMetrics), summary);
    if (report.stop_reason) area.append(el("p", { className: "aipa-review-stop-reason", textContent: `收束依据：${String(report.stop_reason)}` }));
    if (scoreValue !== null) window.requestAnimationFrame(() => scoreRing.style.setProperty("--aipa-score-value", `${scoreValue}%`));
    const scores = report.scores && typeof report.scores === "object" ? report.scores : {};
    const scoreEntries = Object.entries(REVIEW_SCORE_LABELS).map(([key, label]) => ({ key, label, value: normalizedScore(scores[key]) })).filter((item) => item.value !== null);
    if (scoreEntries.length) {
        const section = el("section", { className: "aipa-score-breakdown", ariaLabel: "图片质量维度评分" });
        section.append(el("h4", { textContent: "质量维度" }));
        for (const item of scoreEntries) {
            const row = el("div", { className: "aipa-score-row" });
            const track = el("div", { className: "aipa-score-track", role: "progressbar", ariaLabel: item.label, ariaValueMin: "0", ariaValueMax: "100", ariaValueNow: String(item.value) });
            const fill = el("span", { className: `aipa-score-fill ${scoreTone(item.value)}` });
            fill.style.width = `${item.value}%`;
            track.append(fill);
            row.append(el("span", { className: "aipa-score-name", textContent: item.label }), track, el("strong", { className: "aipa-score-number", textContent: String(item.value) }));
            section.append(row);
        }
        area.append(section);
    }
    for (const [title, key] of [["观察", "observations"], ["保留", "preserve"], ["修改", "changes"]]) {
        const items = Array.isArray(report[key]) ? report[key].filter(Boolean) : [];
        if (!items.length) continue;
        const section = el("section", { className: "aipa-report-section" });
        section.append(el("h4", { textContent: title }));
        const list = el("ul");
        for (const item of items.slice(0, 6)) list.append(el("li", { textContent: String(item) }));
        section.append(list);
        area.append(section);
    }
    return area;
}

function normalizedScore(value) {
    const score = Number(value);
    return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function scoreTone(score) {
    if (score === null) return "is-unknown";
    if (score >= 85) return "is-strong";
    if (score >= 65) return "is-acceptable";
    return "is-needs-work";
}

function scoreLabel(score) {
    if (score === null) return "未评分";
    if (score >= 85) return "表现优秀";
    if (score >= 65) return "质量良好";
    if (score >= 45) return "仍可优化";
    return "建议重做";
}

function actionLabel(action) {
    return ({ prompt_only: "建议改提示词", parameters: "建议调参数", inpaint: "建议局部重绘" })[action] || "建议继续观察";
}

function formatLabel(format) {
    return PROMPT_FORMATS.find((item) => item.value === format)?.label || "提示词格式未指定";
}

function normalizeChatList(value, maximumItems = 5, maximumLength = 300) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => String(item || "").trim().slice(0, maximumLength))
        .filter(Boolean)
        .slice(0, maximumItems);
}

function normalizeChatPlan(result) {
    const requestedFormat = result?.prompt_format ?? result?.promptFormat;
    const promptFormat = PROMPT_FORMATS.some((item) => item.value === requestedFormat) ? requestedFormat : "tag";
    const creativeBrief = String(result?.creative_brief ?? result?.creativeBrief ?? "").trim();
    const creativeTitle = String(result?.creative_title ?? result?.creativeTitle ?? "").trim().slice(0, 80);
    const conceptSummary = String(result?.concept_summary ?? result?.conceptSummary ?? "").trim().slice(0, 500);
    return {
        reply: String(result?.reply || "已为你整理好一套创作方案。").trim(),
        creativeTitle,
        conceptSummary,
        decisions: normalizeChatList(result?.creative_decisions ?? result?.decisions),
        questions: normalizeChatList(result?.open_questions ?? result?.questions, 2),
        creativeBrief,
        constraints: String(result?.style_or_constraints ?? result?.constraints ?? "").trim(),
        promptFormat,
        ready: (result?.ready_to_generate === true || result?.ready === true) && Boolean(creativeBrief),
        nextAction: ["chat", "update_plan", "generate"].includes(result?.next_action ?? result?.nextAction) ? (result?.next_action ?? result?.nextAction) : (creativeBrief ? "update_plan" : "chat"),
    };
}

function normalizeReversePromptResult(result) {
    const prompt = String(result?.prompt ?? result?.positive_prompt ?? result?.positivePrompt ?? "").trim();
    const details = Array.isArray(result?.details)
        ? result.details.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8)
        : [];
    return {
        summary: String(result?.summary ?? result?.image_summary ?? "").trim().slice(0, 1000),
        prompt,
        negativePrompt: String(result?.negative_prompt ?? result?.negativePrompt ?? "").trim().slice(0, 3000),
        details,
        promptFormat: result?.prompt_format === "natural" ? "natural" : "tag",
        engine: result?.engine === "wd_tagger" ? "wd_tagger" : "ai",
    };
}

function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "未知大小";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function imageFileToDataUrl(file) {
    if (!file?.type?.startsWith("image/")) throw new Error("请选择 PNG、JPG、WEBP 或 GIF 图片。");
    if (Number(file.size) > 12 * 1024 * 1024) throw new Error("图片不能超过 12 MB。");
    const objectUrl = URL.createObjectURL(file);
    try {
        const source = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("图片无法读取，请换一张常见格式的图片。"));
            image.src = objectUrl;
        });
        const sourceWidth = Math.max(1, source.naturalWidth || source.width);
        const sourceHeight = Math.max(1, source.naturalHeight || source.height);
        const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("浏览器无法处理这张图片，请重试。");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(source, 0, 0, width, height);
        return {
            dataUrl: canvas.toDataURL("image/jpeg", 0.86),
            width: sourceWidth,
            height: sourceHeight,
            processedWidth: width,
            processedHeight: height,
            originalSize: Number(file.size) || 0,
        };
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function buildPanel() {
    const root = el("section", { className: "aipa-panel", ariaLabel: "AI Prompt Assistant" });
    const header = el("header", { className: "aipa-header" });
    const title = el("div", { className: "aipa-title" }, [el("span", { className: "aipa-mark", textContent: "A/I" }), el("div", {}, [el("strong", { textContent: "AI Prompt Assistant" }), el("small", { textContent: "第二双眼 / CREATIVE INSTRUMENT" })])]);
    const newChatButton = el("button", { className: "aipa-icon-button aipa-new-chat-button", type: "button", title: "开始新对话", ariaLabel: "开始新对话" }, [icon("plus")]);
    const chatExpandButton = el("button", { className: "aipa-icon-button aipa-chat-expand-button", type: "button", title: "进入完整聊天工作台", ariaLabel: "进入完整聊天工作台" }, [icon("expand")]);
    const settingsButton = el("button", { className: "aipa-icon-button aipa-settings-button", type: "button", title: "打开 API 设置", ariaLabel: "打开 API 设置" }, [icon("settings")]);
    const minimize = el("button", { className: "aipa-icon-button", type: "button", title: "收起窗口", ariaLabel: "收起窗口" }, [icon("minimize")]);
    const headerActions = el("div", { className: "aipa-header-actions" }, [newChatButton, chatExpandButton, settingsButton, minimize]);
    header.append(title, headerActions);
    const resizeHandle = el("button", {
        className: "aipa-resize-handle",
        type: "button",
        title: "窗口边框可拖拽调整大小；方向键微调；Home 恢复默认",
        ariaLabel: "调整悬浮窗大小。可用方向键微调，按 Home 恢复默认大小",
        ariaKeyShortcuts: "ArrowUp ArrowDown ArrowLeft ArrowRight Home",
    });
    const resizeBorders = ["n", "e", "s", "w", "ne", "nw", "se", "sw"].map((direction) => {
        const border = el("div", { className: `aipa-resize-border aipa-resize-border-${direction}`, ariaHidden: "true" });
        border.dataset.direction = direction;
        return border;
    });
    const tabs = el("div", { className: "aipa-tabs", role: "tablist" });
    const chatTab = stageTab("01", "构想", "对话", "打开 AI 对话");
    const reverseTab = stageTab("02", "反推", "图片", "打开图片反推");
    const comicTab = stageTab("03", "分镜", "连续", "打开漫画模式");
    const plannerTab = stageTab("04", "定稿", "规划", "打开提示词规划");
    const reviewerTab = stageTab("05", "复盘", "评审", "打开图片评审");
    tabs.append(chatTab, reverseTab, comicTab, plannerTab, reviewerTab);
    const body = el("div", { className: "aipa-body" });

    const chat = el("div", { className: "aipa-view aipa-chat-view" });
    const chatWorkspace = el("div", { className: "aipa-chat-workspace" });
    const chatSessions = el("aside", { className: "aipa-chat-sessions", ariaLabel: "对话记录" });
    const chatSessionHeader = el("div", { className: "aipa-chat-sessions-header" }, [el("strong", { textContent: "对话记录" })]);
    const chatSessionList = el("div", { className: "aipa-chat-session-list" });
    chatSessions.append(chatSessionHeader, chatSessionList);
    const chatMessages = el("div", { className: "aipa-chat-messages", role: "log", ariaLive: "polite", ariaLabel: "与 AI 的对话" });
    const chatSuggestions = el("div", { className: "aipa-chat-suggestions", ariaLabel: "灵感建议" });
    const chatInput = el("textarea", { rows: 2, placeholder: "例如：我没有想法，帮我设计一张有故事感的二次元壁纸", ariaLabel: "输入想法或出图需求" });
    const chatStripStyleToggle = el("input", { type: "checkbox", checked: state.stripStyle, ariaLabel: "去掉画风词，让 LoRA 负责画风" });
    const chatStripStyleRow = label("去掉画风词，让 LoRA 负责画风", chatStripStyleToggle);
    chatStripStyleRow.classList.add("aipa-toggle", "aipa-style-toggle");
    const focusInstrument = makeFocusInstrument({
        onModeChange(mode, announce) {
            chatInput.placeholder = mode.placeholder;
            if (announce) setStatus("success", `已切换到${mode.short}焦段：${mode.title}。`);
            update();
        },
        onApply(mode) {
            const current = chatInput.value.trim();
            chatInput.value = current ? `${current}\n\n${mode.prompt}` : mode.prompt;
            chatInput.focus();
            setStatus("success", `已把${mode.short}焦段加入对话。你仍可继续补充具体想法。`);
            update();
        },
    });
    const chatAttachment = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", className: "aipa-image-input", ariaLabel: "上传参考图片" });
    const chatAttachmentButton = el("button", { className: "aipa-secondary aipa-attachment-button", type: "button", textContent: "上传图片", ariaLabel: "上传参考图片" });
    const chatReversePrompt = el("button", { className: "aipa-secondary aipa-reverse-button", type: "button", textContent: "打开图片反推", ariaLabel: "打开图片反推页面" });
    const chatAttachmentName = el("span", { className: "aipa-attachment-name", role: "status", ariaLive: "polite" });
    const chatSend = el("button", { className: "aipa-primary", type: "button", textContent: "发送给 AI", ariaLabel: "发送消息给 AI" });
    const chatWritePlan = el("button", { className: "aipa-secondary", type: "button", textContent: "写入创作需求", ariaLabel: "将 AI 方案写入创作需求" });
    const chatGenerate = el("button", { className: "aipa-primary", type: "button", textContent: "交给工作流生成", ariaLabel: "使用 AI 方案生成提示词并排队" });
    const agentBrief = el("section", { className: "aipa-agent-brief", ariaLabel: "当前创作简报" });
    const agentBriefHeader = el("div", { className: "aipa-agent-brief-header" });
    const agentBriefKicker = el("span", { className: "aipa-agent-brief-kicker", textContent: "当前创作简报" });
    const agentBriefState = el("span", { className: "aipa-agent-brief-state", role: "status", ariaLive: "polite" });
    const agentBriefTitle = el("strong", { className: "aipa-agent-brief-title" });
    const agentBriefSummary = el("p", { className: "aipa-agent-brief-summary" });
    const agentBriefMeta = el("div", { className: "aipa-agent-brief-meta" });
    const agentBriefDecisions = el("ul", { className: "aipa-agent-brief-list aipa-agent-decisions" });
    const agentBriefQuestions = el("div", { className: "aipa-agent-question" });
    const agentBriefActions = el("div", { className: "aipa-actions aipa-agent-brief-actions" }, [chatWritePlan, chatGenerate]);
    agentBriefHeader.append(agentBriefKicker, agentBriefState);
    agentBrief.append(agentBriefHeader, agentBriefTitle, agentBriefSummary, agentBriefMeta, agentBriefDecisions, agentBriefQuestions, agentBriefActions);
    const inspirationPrompts = [
        "我没有想法，帮我设计一个有故事感的二次元壁纸",
        "帮我先设计角色设定，再给出第一张出图方案",
        "我想要电影感镜头，但还没有明确场景，帮我提出一个方向",
    ];
    for (const prompt of inspirationPrompts) {
        const suggestion = el("button", { className: "aipa-suggestion", type: "button", textContent: prompt, ariaLabel: `使用灵感：${prompt}` });
        suggestion.onclick = () => { chatInput.value = prompt; chatInput.focus(); update(); };
        chatSuggestions.append(suggestion);
    }
    const chatAttachmentBar = el("div", { className: "aipa-chat-attachment-bar" }, [chatAttachmentButton, chatReversePrompt, chatAttachmentName, chatAttachment]);
    const chatComposer = el("section", { className: "aipa-chat-composer", ariaLabel: "对话输入" });
    const chatMain = el("div", { className: "aipa-chat-main" });
    const comicModeToggle = el("input", { type: "checkbox", checked: state.comic.enabled, ariaLabel: "开启漫画模式" });
    const comicModeToggleRow = label("连续叙事模式", comicModeToggle);
    comicModeToggleRow.classList.add("aipa-toggle", "aipa-comic-toggle");
    const dialogueHeader = el("header", { className: "aipa-dialogue-header" }, [
        el("div", { className: "aipa-dialogue-kicker" }, [
            el("span", { className: "aipa-dialogue-led", ariaHidden: "true" }),
            el("span", { textContent: "AI 创作 Agent" }),
            el("small", { textContent: "CONTINUOUS DIALOGUE" }),
        ]),
        el("h2", { textContent: "把模糊想法，聊成一套画面。" }),
        el("p", { textContent: "每一次对话都会成为下一次创作判断的上下文。" }),
    ]);
    const chatActions = el("div", { className: "aipa-actions aipa-chat-actions" }, [chatAttachmentBar, chatSend]);
    chatComposer.append(
        chatSuggestions,
        label("你的想法", chatInput),
        chatStripStyleRow,
        chatActions,
    );
    chatMain.append(dialogueHeader, comicModeToggleRow, agentBrief, chatMessages, chatComposer);
    chatWorkspace.append(chatSessions, chatMain);
    chat.append(chatWorkspace);

    const reverse = el("div", { className: "aipa-view aipa-reverse-view" });
    const reverseImageInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", className: "aipa-image-input", ariaLabel: "选择要反推的图片" });
    const reverseDropzone = el("button", { className: "aipa-reverse-dropzone", type: "button", ariaLabel: "选择或粘贴要反推的图片" }, [
        el("span", { className: "aipa-reverse-dropzone-index", textContent: "01 / INPUT" }),
        el("strong", { textContent: "把图片放到这里" }),
        el("small", { textContent: "点击选择文件 · Ctrl+V 粘贴 · 也可以直接拖入" }),
    ]);
    const reversePreview = el("figure", { className: "aipa-reverse-preview" });
    const reversePreviewImage = el("img", { className: "aipa-reverse-preview-image", alt: "待反推图片", hidden: true });
    const reversePreviewEmpty = el("div", { className: "aipa-reverse-preview-empty" }, [
        el("span", { className: "aipa-reverse-preview-cross", ariaHidden: "true" }),
        el("strong", { textContent: "等待一张图片" }),
        el("small", { textContent: "图片会先在本地缩放，再发送给视觉模型" }),
    ]);
    const reversePreviewMeta = el("figcaption", { className: "aipa-reverse-preview-meta" });
    const reverseClearButton = el("button", { className: "aipa-secondary aipa-reverse-clear", type: "button", textContent: "清除图片", ariaLabel: "清除当前图片" });
    reversePreview.append(reversePreviewImage, reversePreviewEmpty, reversePreviewMeta, reverseClearButton);
    const reverseNotes = el("textarea", { rows: 4, placeholder: "可选：希望重点观察什么？例如“重点还原镜头和布光，不要补写画面外的信息”", ariaLabel: "图片反推补充要求" });
    const reverseEngine = el("select", { ariaLabel: "选择图片反推引擎" });
    reverseEngine.append(
        el("option", { value: "ai", textContent: "AI 视觉模型" }),
        el("option", { value: "wd_tagger", textContent: "WD-EVA02 标签器（本地）" }),
    );
    const reversePromptFormat = el("select", { ariaLabel: "选择图片反推输出形式" });
    for (const format of PROMPT_FORMATS.filter((item) => item.value === "tag" || item.value === "natural")) {
        reversePromptFormat.append(el("option", { value: format.value, textContent: format.value === "natural" ? "English natural language" : "英文标签（逗号分隔）" }));
    }
    reversePromptFormat.value = "tag";
    const reverseStripStyleToggle = el("input", { type: "checkbox", checked: state.stripStyle, ariaLabel: "去掉画风词，让 LoRA 负责画风" });
    const reverseStripStyleRow = label("去掉画风词，让 LoRA 负责画风", reverseStripStyleToggle);
    reverseStripStyleRow.classList.add("aipa-toggle", "aipa-style-toggle");
    const reverseRunButton = el("button", { className: "aipa-primary aipa-reverse-run", type: "button", textContent: "开始反推", ariaLabel: "开始反推图片提示词" });
    const reverseSource = el("section", { className: "aipa-reverse-source", ariaLabel: "图片输入" }, [
        el("div", { className: "aipa-reverse-section-heading" }, [
            el("div", {}, [el("strong", { textContent: "放入参考图" }), el("small", { textContent: "本页支持桌面剪贴板" })]),
            el("span", { className: "aipa-reverse-stage-mark", textContent: "A" }),
        ]),
        reverseDropzone,
        reversePreview,
        label("反推引擎", reverseEngine),
        label("提示词输出形式", reversePromptFormat),
        reverseStripStyleRow,
        label("补充观察要求", reverseNotes),
        el("div", { className: "aipa-actions aipa-reverse-actions" }, [reverseRunButton]),
        reverseImageInput,
    ]);
    const reverseResultStatus = el("p", { className: "aipa-reverse-result-status", role: "status", ariaLive: "polite" });
    const reverseResultHost = el("div", { className: "aipa-reverse-result-host" });
    const reverseResult = el("section", { className: "aipa-reverse-result", ariaLabel: "图片反推结果" }, [
        el("div", { className: "aipa-reverse-section-heading" }, [
            el("div", {}, [el("strong", { textContent: "整理视觉证据" }), el("small", { textContent: "结果会拆成可直接使用的文本" })]),
            el("span", { className: "aipa-reverse-stage-mark is-result", textContent: "B" }),
        ]),
        reverseResultStatus,
        reverseResultHost,
    ]);
    reverse.append(
        el("section", { className: "aipa-reverse-intro" }, [
            el("div", { className: "aipa-reverse-kicker" }, [el("span", { className: "aipa-dialogue-led", ariaHidden: "true" }), el("span", { textContent: "SECOND SIGHT / IMAGE TRACE" })]),
            el("h2", { textContent: "先看清，再把画面写出来。" }),
            el("p", { textContent: "独立的图片反推工作台。它只处理眼前这张图，不混入聊天历史，让每一条提示词都能回到可见证据。" }),
        ]),
        el("div", { className: "aipa-reverse-layout" }, [reverseSource, reverseResult]),
    );

    const comic = el("div", { className: "aipa-view aipa-comic-view" });
    const comicIdea = el("textarea", { rows: 4, placeholder: "例如：一个失去记忆的少女，在雨夜列车上追寻一封未寄出的信", ariaLabel: "漫画想法" });
    const comicCount = el("input", { type: "number", min: "1", max: "12", step: "1", inputMode: "numeric", ariaLabel: "漫画出图数量" });
    const comicFormat = makeComicPromptFormatSelect("选择漫画提示词格式");
    const comicContinuationToggle = el("input", { type: "checkbox", checked: state.comic.continueWithImage, ariaLabel: "启用 AI 看图续写" });
    const comicContinuationToggleRow = label("AI 看图续写（每格完成后优化下一格提示词）", comicContinuationToggle);
    comicContinuationToggleRow.classList.add("aipa-toggle", "aipa-comic-toggle");
    const comicContinuationHint = el("p", { className: "aipa-comic-continuation-hint", textContent: "开启后，已生成的图片会发送给当前配置的 AI 服务，用于保持下一格的角色和画面连续性。" });
    const comicPlanButton = el("button", { className: "aipa-primary", type: "button", textContent: "让 AI 设计分镜", ariaLabel: "让 AI 设计漫画分镜" });
    const comicRunButton = el("button", { className: "aipa-secondary", type: "button", textContent: "开始逐张生成", ariaLabel: "开始逐张生成漫画" });
    const comicHistoryHost = el("section", { className: "aipa-comic-history", ariaLabel: "漫画记录" });
    const comicProgress = el("p", { className: "aipa-comic-progress", role: "status", ariaLive: "polite" });
    const comicContinuationWarning = el("p", { className: "aipa-comic-continuation-warning", role: "status", ariaLive: "polite" });
    const comicPlanHost = el("div", { className: "aipa-comic-plan", ariaLive: "polite" });
    const comicGallery = el("div", { className: "aipa-comic-gallery", ariaLabel: "已完成漫画" });
    comic.append(
        el("section", { className: "aipa-comic-intro" }, [
            el("strong", { textContent: "连续分镜创作" }),
            el("p", { textContent: "输入一句想法，AI 会先统一角色与画风，再按分镜逐张生成。" }),
        ]),
        comicHistoryHost,
        label("漫画想法", comicIdea),
        label("出图数量（1-12）", comicCount),
        label("提示词格式", comicFormat),
        comicContinuationToggleRow,
        comicContinuationHint,
        el("div", { className: "aipa-actions aipa-comic-actions" }, [comicPlanButton, comicRunButton]),
        comicProgress,
        comicContinuationWarning,
        comicPlanHost,
        comicGallery,
    );

    const planner = el("div", { className: "aipa-view" });
    const plannerSelect = el("select", { ariaLabel: "选择提示词规划节点" });
    const plannerAdd = el("button", { className: "aipa-secondary aipa-add-node", type: "button", textContent: "添加", title: "添加提示词规划节点", ariaLabel: "添加提示词规划节点" });
    const plannerControl = el("div", { className: "aipa-node-control" }, [plannerSelect, plannerAdd]);
    const plannerFormat = makePromptFormatSelect("选择规划提示词格式");
    const brief = el("textarea", { rows: 4, placeholder: "例如：雨夜街头的电影感人像，保留红色雨伞" });
    const constraints = el("textarea", { rows: 2, placeholder: "可选：画幅、服装、镜头或必须保留的内容" });
    const negativePrompt = el("textarea", { rows: 3, placeholder: "例如：low quality, bad anatomy, extra fingers" });
    const generationModel = el("select", { ariaLabel: "选择本机出图模型" });
    const generationSampler = el("select", { ariaLabel: "选择采样器" });
    const generationScheduler = el("select", { ariaLabel: "选择调度器" });
    const generationSteps = el("input", { type: "number", min: "1", max: "80", step: "1", inputMode: "numeric", ariaLabel: "迭代步数" });
    const generationCfg = el("input", { type: "number", min: "0", max: "20", step: "0.1", inputMode: "decimal", ariaLabel: "CFG 引导" });
    const generationWidth = el("input", { type: "number", min: "64", max: "2048", step: "8", inputMode: "numeric", ariaLabel: "宽度" });
    const generationHeight = el("input", { type: "number", min: "64", max: "2048", step: "8", inputMode: "numeric", ariaLabel: "高度" });
    const refreshGenerationButton = el("button", { className: "aipa-secondary aipa-generation-refresh", type: "button", textContent: "读取工作流", ariaLabel: "从工作流读取出图参数" });
    const applyGenerationButton = el("button", { className: "aipa-secondary aipa-generation-refresh", type: "button", textContent: "应用到工作流", ariaLabel: "将出图参数应用到工作流" });
    const generationGrid = el("div", { className: "aipa-generation-grid" }, [
        label("出图模型", generationModel),
        label("采样器", generationSampler),
        label("调度器", generationScheduler),
        label("迭代步数", generationSteps),
        label("CFG", generationCfg),
        label("宽度", generationWidth),
        label("高度", generationHeight),
    ]);
    const generationSettings = el("section", { className: "aipa-generation-settings", ariaLabel: "出图参数" }, [
        el("div", { className: "aipa-generation-heading" }, [el("strong", { textContent: "出图参数" }), el("div", { className: "aipa-generation-actions" }, [refreshGenerationButton, applyGenerationButton])]),
        el("p", { className: "aipa-generation-hint", textContent: "提交时会同步到当前采样器、Latent 和 AI 节点。" }),
        generationGrid,
    ]);
    const plannerApply = el("button", { className: "aipa-primary", type: "button", textContent: "生成提示词并排队" });
    const plannerLocate = el("button", { className: "aipa-secondary", type: "button", textContent: "定位节点" });
    const workflowMapping = makeWorkflowMapping();
    const workflowState = el("section", { className: "aipa-workflow-state", ariaLabel: "工作流状态" });
    const workflowStateHeading = el("strong", { textContent: "工作流状态" });
    const workflowStages = el("div", { className: "aipa-workflow-stages" });
    workflowState.append(workflowStateHeading, workflowStages);
    planner.append(workflowState, label("规划节点", plannerControl), workflowMapping.element, label("提示词格式", plannerFormat), label("创作需求", brief), label("风格与约束", constraints), label("固定反向提示词（AI 不会修改）", negativePrompt), generationSettings, el("div", { className: "aipa-actions" }, [plannerApply, plannerLocate]));

    const reviewer = el("div", { className: "aipa-view aipa-reviewer-view" });
    const reviewerIntro = el("section", { className: "aipa-reviewer-intro" }, [
        el("div", { className: "aipa-reviewer-kicker" }, [el("span", { className: "aipa-dialogue-led", ariaHidden: "true" }), el("span", { textContent: "ITERATIVE REVIEW / IMAGE LOOP" })]),
        el("h2", { textContent: "让每一轮成图，成为下一轮的证据。" }),
        el("p", { textContent: "AI 会评审当前成图，写回提示词，再按你的停止条件继续生成。" }),
    ]);
    const reviewerSelect = el("select", { ariaLabel: "选择图片评审节点" });
    const reviewerAdd = el("button", { className: "aipa-secondary aipa-add-node", type: "button", textContent: "添加", title: "添加图片评审节点", ariaLabel: "添加图片评审节点" });
    const reviewerControl = el("div", { className: "aipa-node-control" }, [reviewerSelect, reviewerAdd]);
    const reviewImageSelect = el("select", { ariaLabel: "选择图片评审的成图来源" });
    const reviewerFormat = makePromptFormatSelect("选择评审提示词格式");
    const request = el("textarea", { rows: 3, placeholder: "例如：保留构图，让脸更自然，外套改成深红色" });
    const enable = el("input", { type: "checkbox" });
    const enableRow = label("启用 AI 图片评审（会上传当前图片）", enable);
    enableRow.classList.add("aipa-toggle");
    const reviewConnection = el("p", { className: "aipa-review-connection", role: "status", ariaLive: "polite" });
    const reviewerApply = el("button", { className: "aipa-primary", type: "button", textContent: "连接成图并评审" });
    const reviewerLocate = el("button", { className: "aipa-secondary", type: "button", textContent: "定位节点" });
    const reviewLoopMode = el("select", { ariaLabel: "自动评审停止模式" }, [
        el("option", { value: "rounds", textContent: "固定评审轮数" }),
        el("option", { value: "satisfied", textContent: "直到 AI 判定满意" }),
    ]);
    const reviewLoopMaxRounds = el("input", { type: "number", min: "1", max: "10", step: "1", inputMode: "numeric", ariaLabel: "最大评审轮数" });
    const reviewLoopThreshold = el("input", { type: "range", min: "60", max: "100", step: "1", id: "aipa-review-loop-threshold", ariaLabel: "满意评分阈值" });
    const reviewLoopThresholdValue = el("output", { className: "aipa-review-loop-threshold-value", htmlFor: "aipa-review-loop-threshold" });
    reviewLoopThresholdValue.textContent = "85";
    const reviewLoopThresholdControl = el("div", { className: "aipa-review-loop-range" }, [reviewLoopThreshold, reviewLoopThresholdValue]);
    const reviewLoopApplyToggle = el("input", { type: "checkbox", ariaLabel: "自动写回优化后的正向提示词" });
    const reviewLoopApplyRow = label("自动写回优化提示词", reviewLoopApplyToggle);
    reviewLoopApplyRow.classList.add("aipa-toggle");
    const reviewLoopGenerateToggle = el("input", { type: "checkbox", ariaLabel: "自动重新生成下一轮图片" });
    const reviewLoopGenerateRow = label("自动重新生成下一轮", reviewLoopGenerateToggle);
    reviewLoopGenerateRow.classList.add("aipa-toggle");
    const reviewLoopStart = el("button", { className: "aipa-primary", type: "button", textContent: "开始自动评审", ariaLabel: "开始自动评审循环" });
    const reviewLoopPause = el("button", { className: "aipa-secondary", type: "button", textContent: "暂停", ariaLabel: "暂停自动评审循环" });
    const reviewLoopStop = el("button", { className: "aipa-secondary", type: "button", textContent: "停止", ariaLabel: "停止自动评审循环" });
    const reviewLoopStatus = el("p", { className: "aipa-review-loop-status", role: "status", ariaLive: "polite" });
    const reviewLoopStages = el("div", { className: "aipa-review-loop-stages", ariaLabel: "自动评审阶段" });
    const reviewLoopHistoryHost = el("div", { className: "aipa-review-loop-history", ariaLabel: "自动评审轮次记录" });
    const reviewLoopPanel = el("section", { className: "aipa-review-loop-panel", ariaLabel: "自动评审设置与进度" }, [
        el("div", { className: "aipa-review-loop-heading" }, [
            el("div", {}, [el("strong", { textContent: "自动评审" }), el("small", { textContent: "每轮结果都会保留" })]),
            el("span", { className: "aipa-review-loop-badge", textContent: "AI 生成" }),
        ]),
        el("div", { className: "aipa-review-loop-controls" }, [
            label("停止模式", reviewLoopMode),
            label("最大轮数", reviewLoopMaxRounds),
            label("满意阈值", reviewLoopThresholdControl),
        ]),
        reviewLoopApplyRow,
        reviewLoopGenerateRow,
        el("div", { className: "aipa-actions aipa-review-loop-actions" }, [reviewLoopStart, reviewLoopPause, reviewLoopStop]),
        reviewLoopStatus,
        reviewLoopStages,
        reviewLoopHistoryHost,
    ]);
    const reportHost = el("div");
    reviewer.append(reviewerIntro, label("评审节点", reviewerControl), label("成图来源", reviewImageSelect), reviewConnection, label("输出提示词格式", reviewerFormat), label("修改要求", request), enableRow, el("div", { className: "aipa-actions" }, [reviewerApply, reviewerLocate]), reviewLoopPanel, reportHost);

    const settings = el("div", { className: "aipa-view aipa-settings-view" });
    const settingsHeading = el("div", { className: "aipa-settings-heading" }, [
        el("div", {}, [el("strong", { textContent: "API 与模型" }), el("small", { textContent: "配置后供提示词规划和图片评审使用" })]),
        el("button", { className: "aipa-secondary aipa-back-button", type: "button", textContent: "返回", ariaLabel: "返回工作台" }),
    ]);
    const apiUrlInput = el("input", { type: "url", inputMode: "url", autocomplete: "url", placeholder: "https://api.openai.com/v1" });
    const apiKeyInput = el("input", { type: "password", autocomplete: "new-password", placeholder: "输入 API Key（已配置则留空）" });
    // Use a real select after discovery. A datalist filters its popup by the
    // current text, which made an API result such as "21 models" look like
    // only two models were available.
    const modelInput = el("select", { ariaLabel: "选择 AI 模型" });
    const refreshModelsButton = el("button", { className: "aipa-secondary", type: "button", textContent: "刷新模型列表", ariaLabel: "刷新模型列表" });
    const modelControl = el("div", { className: "aipa-settings-model-control" }, [modelInput, refreshModelsButton]);
    const refreshLocalModelsButton = el("button", { className: "aipa-secondary aipa-local-models-button", type: "button", textContent: "刷新本机出图模型", ariaLabel: "刷新本机出图模型" });
    const localModelsStatus = el("p", { className: "aipa-settings-status", role: "status", ariaLive: "polite" });
    const timeoutInput = el("input", { type: "number", min: "10", max: "300", step: "1", inputMode: "numeric" });
    const appendChatCompletionsInput = el("input", { type: "checkbox" });
    const appendChatCompletionsRow = label("自动补全 /chat/completions（推荐）", appendChatCompletionsInput);
    appendChatCompletionsRow.classList.add("aipa-toggle");
    const parameterTuningInput = el("input", { type: "checkbox" });
    const parameterTuningRow = label("允许 AI 在完成后覆盖出图参数", parameterTuningInput);
    parameterTuningRow.classList.add("aipa-toggle");
    const useSystemProxyInput = el("input", { type: "checkbox" });
    const useSystemProxyRow = label("通过系统代理访问 AI 服务", useSystemProxyInput);
    useSystemProxyRow.classList.add("aipa-toggle");
    const jsonModeInput = el("input", { type: "checkbox" });
    const jsonModeRow = label("启用 JSON mode（兼容性更好时可关闭）", jsonModeInput);
    jsonModeRow.classList.add("aipa-toggle");
    const reasoningEffortInput = el("select", { ariaLabel: "AI 思考强度" });
    setSelectOptions(reasoningEffortInput, ["off", "low", "medium", "high"], "off");
    const reasoningEffortLabels = { off: "关闭（兼容所有模型）", low: "低", medium: "中", high: "高" };
    for (const option of reasoningEffortInput.options) option.textContent = reasoningEffortLabels[option.value] || option.value;
    const settingsError = el("p", { className: "aipa-settings-error", role: "alert", ariaLive: "polite" });
    const settingsStatus = el("p", { className: "aipa-settings-status", role: "status", ariaLive: "polite" });
    const wdTaggerPathInput = el("input", { type: "text", spellcheck: "false", placeholder: "例如：D:\\AI\\models\\wd-eva02-large-tagger-v3", ariaLabel: "WD-EVA02 模型路径" });
    const wdTaggerStatus = el("p", { className: "aipa-settings-status", role: "status", ariaLive: "polite" });
    const saveSettingsButton = el("button", { className: "aipa-primary", type: "button", textContent: "保存配置" });
    // Keep model-discovery feedback next to the button that triggered it.
    // The settings sheet can be tall, so placing errors at the bottom made
    // failed refreshes appear to have no response.
    settings.append(settingsHeading, label("API 地址", apiUrlInput), appendChatCompletionsRow, label("API Key", apiKeyInput), label("模型", modelControl), settingsError, settingsStatus, label("AI 思考强度", reasoningEffortInput), label("WD-EVA02 模型目录或 model.onnx 路径", wdTaggerPathInput), wdTaggerStatus, label("本机出图模型", refreshLocalModelsButton), localModelsStatus, label("请求超时（秒）", timeoutInput), parameterTuningRow, useSystemProxyRow, jsonModeRow, el("div", { className: "aipa-actions" }, [saveSettingsButton]));

    const statusHost = el("p", { className: "aipa-operation-status", role: "status", ariaLive: "polite" });
    body.append(statusHost);

    body.append(chat, reverse, comic, planner, reviewer, settings);
    root.append(header, tabs, focusInstrument.element, body, ...resizeBorders, resizeHandle);
    document.body.append(root);
    const launcher = el("button", { className: "aipa-launcher", type: "button", textContent: "AI", title: "打开 AI Prompt Assistant", ariaLabel: "打开 AI Prompt Assistant" });
    document.body.append(launcher);

    function uniqueOptions(values, fallback) {
        return [...new Set([...(Array.isArray(values) ? values : []), fallback].filter(Boolean))];
    }

    function setSelectOptions(select, values, selected, preserveMissing = false) {
        const options = preserveMissing ? uniqueOptions(values, selected) : (Array.isArray(values) && values.length ? values : uniqueOptions([], selected));
        select.replaceChildren();
        for (const value of options) select.append(el("option", { value, textContent: value }));
        select.value = options.includes(selected) ? selected : (options[0] || "");
    }

    function generationSignature() {
        const plannerNode = mappingNode("planner");
        const samplerNode = mappingNode("sampler");
        const latentNode = mappingNode("latent");
        return [
            state.mapping.planner,
            state.mapping.reviewer,
            state.mapping.sampler,
            state.mapping.latent,
            state.mapping.negative,
            state.localGeneration.models.join("|"),
            state.localGeneration.samplers.join("|"),
            state.localGeneration.schedulers.join("|"),
            widgetValue(plannerNode, "image_model"),
            widgetValue(plannerNode, "negative_prompt"),
            widgetValue(samplerNode, "sampler_name"),
            widgetValue(samplerNode, "scheduler"),
            widgetValue(samplerNode, "steps"),
            widgetValue(samplerNode, "cfg"),
            widgetValue(latentNode, "width"),
            widgetValue(latentNode, "height"),
        ].join(";");
    }

    function syncGenerationControls(force = false) {
        const signature = generationSignature();
        if (!force && state.generation.signature === signature) return;
        const plannerNode = mappingNode("planner");
        const reviewerNode = mappingNode("reviewer");
        const samplerNode = mappingNode("sampler");
        const latentNode = mappingNode("latent");
        const model = widgetValue(plannerNode, "image_model") || widgetValue(reviewerNode, "image_model") || state.localGeneration.models[0] || "";
        const sampler = widgetValue(samplerNode, "sampler_name") || widgetValue(plannerNode, "sampler_name") || state.localGeneration.samplers[0] || "euler";
        const scheduler = widgetValue(samplerNode, "scheduler") || widgetValue(plannerNode, "scheduler") || state.localGeneration.schedulers[0] || "normal";
        setSelectOptions(generationModel, state.localGeneration.models, model);
        setSelectOptions(generationSampler, state.localGeneration.samplers, sampler);
        setSelectOptions(generationScheduler, state.localGeneration.schedulers, scheduler);
        generationSteps.value = widgetValue(samplerNode, "steps") ?? widgetValue(plannerNode, "steps") ?? 28;
        generationCfg.value = widgetValue(samplerNode, "cfg") ?? widgetValue(plannerNode, "cfg") ?? 5;
        generationWidth.value = widgetValue(latentNode, "width") ?? widgetValue(plannerNode, "width") ?? 1024;
        generationHeight.value = widgetValue(latentNode, "height") ?? widgetValue(plannerNode, "height") ?? 1024;
        negativePrompt.value = widgetValue(plannerNode, "negative_prompt") || widgetValue(mappingNode("negative"), "text") || "";
        state.generation.signature = signature;
    }

    function generationNumber(input, fallback) {
        const value = Number(input.value);
        return Number.isFinite(value) ? value : fallback;
    }

    function writeGenerationControlsToWorkflow() {
        const values = {
            image_model: generationModel.value,
            sampler_name: generationSampler.value,
            scheduler: generationScheduler.value,
            steps: generationNumber(generationSteps, 28),
            cfg: generationNumber(generationCfg, 5),
            width: generationNumber(generationWidth, 1024),
            height: generationNumber(generationHeight, 1024),
        };
        let applied = 0;
        const plannerNode = mappingNode("planner");
        const reviewerNode = mappingNode("reviewer");
        const samplerNode = mappingNode("sampler");
        const latentNode = mappingNode("latent");
        const set = (node, name, value) => { if (setWidget(node, name, value)) applied += 1; };
        for (const node of [plannerNode, reviewerNode]) {
            set(node, "image_model", values.image_model);
            set(node, "sampler_name", values.sampler_name);
            set(node, "scheduler", values.scheduler);
            set(node, "steps", values.steps);
            set(node, "cfg", values.cfg);
            set(node, "width", values.width);
            set(node, "height", values.height);
        }
        set(plannerNode, "negative_prompt", negativePrompt.value);
        set(mappingNode("negative"), "text", negativePrompt.value);
        set(samplerNode, "sampler_name", values.sampler_name);
        set(samplerNode, "scheduler", values.scheduler);
        set(samplerNode, "steps", values.steps);
        set(samplerNode, "cfg", values.cfg);
        set(latentNode, "width", values.width);
        set(latentNode, "height", values.height);
        return applied;
    }

    function reviewLoopCurrentPrompt() {
        return String(widgetValue(mappingNode("positive"), "text") || "").trim();
    }

    function syncReviewLoopPreferences() {
        const loop = state.reviewLoop;
        loop.mode = reviewLoopMode.value === "satisfied" ? "satisfied" : "rounds";
        loop.maxRounds = Math.max(1, Math.min(10, Number.parseInt(reviewLoopMaxRounds.value, 10) || 3));
        loop.threshold = Math.max(60, Math.min(100, Number.parseInt(reviewLoopThreshold.value, 10) || 85));
        loop.autoApply = reviewLoopApplyToggle.checked;
        loop.autoGenerate = reviewLoopGenerateToggle.checked;
        persistReviewLoopPreferences(loop);
        reviewLoopMaxRounds.value = String(loop.maxRounds);
        reviewLoopThreshold.value = String(loop.threshold);
        reviewLoopThresholdValue.textContent = String(loop.threshold);
    }

    function reviewLoopPhaseIndex() {
        const loop = state.reviewLoop;
        if (loop.phase === "completed") return 4;
        if (loop.phase === "reviewing") return 1;
        if (loop.phase === "applying") return 2;
        if (loop.phase === "generating") return loop.currentRound > 1 ? 3 : 0;
        return -1;
    }

    function reviewLoopStatusText() {
        const loop = state.reviewLoop;
        if (loop.phase === "idle") return "准备从当前工作流生成第一张候选图。";
        if (loop.phase === "generating") return `第 ${loop.currentRound} 轮：正在生成候选图，完成后会自动进入视觉评审。`;
        if (loop.phase === "reviewing") return `第 ${loop.currentRound} 轮：视觉评审已完成，正在整理评分与修改方向。`;
        if (loop.phase === "applying") return `第 ${loop.currentRound} 轮：正在把评审结果写回正向提示词。`;
        if (loop.phase === "paused") return `已暂停在第 ${loop.currentRound} 轮。当前已提交任务不会被强行中断。`;
        if (loop.phase === "completed") return `自动评审完成，共保留 ${loop.history.length} 轮结果。`;
        if (loop.phase === "stopped") return `自动评审已停止，已保留 ${loop.history.length} 轮结果。`;
        if (loop.phase === "error") return "自动评审遇到错误，已停止并恢复节点状态。";
        return "等待自动评审开始。";
    }

    function renderReviewLoopHistory() {
        const loop = state.reviewLoop;
        reviewLoopHistoryHost.replaceChildren();
        if (!loop.history.length) {
            reviewLoopHistoryHost.append(el("p", { className: "aipa-empty", textContent: "完成第一轮评审后，这里会形成逐轮证据轨道。" }));
            return;
        }
        for (const entry of loop.history.slice().reverse()) {
            const score = normalizedScore(entry.score);
            const item = el("article", { className: `aipa-review-loop-entry ${scoreTone(score)}` });
            const entryHead = el("div", { className: "aipa-review-loop-entry-head" });
            const roundMark = el("span", { className: "aipa-review-loop-round", textContent: `R${entry.round}` });
            const entryTitle = el("div", { className: "aipa-review-loop-entry-title" }, [
                el("strong", { textContent: score === null ? "未评分" : `${score} / 100` }),
                el("small", { textContent: entry.modelSatisfied ? "AI 判定满意" : (entry.scoreSatisfied ? "达到评分阈值" : (entry.status === "max_rounds" ? "达到轮数上限" : "需要下一轮")) }),
            ]);
            const thumb = entry.image ? el("img", { className: "aipa-review-loop-thumb", src: comicImageUrl(entry.image), alt: `第 ${entry.round} 轮成图`, loading: "lazy" }) : el("div", { className: "aipa-review-loop-thumb is-empty", ariaHidden: "true" });
            entryHead.append(roundMark, thumb, entryTitle);
            item.append(entryHead, el("p", { className: "aipa-review-loop-summary", textContent: entry.summary || "本轮评审没有返回摘要。" }));
            if (entry.stopReason) item.append(el("p", { className: "aipa-review-loop-stop-reason", textContent: `收束依据：${entry.stopReason}` }));
            if (entry.changes?.length) {
                item.append(el("p", { className: "aipa-review-loop-change", textContent: `下一轮：${entry.changes[0]}` }));
            }
            if (entry.promptBefore || entry.promptAfter) {
                const details = el("details", { className: "aipa-review-loop-prompts" });
                details.append(el("summary", { textContent: "查看提示词变化" }));
                details.append(
                    el("div", { className: "aipa-review-loop-prompt" }, [el("small", { textContent: "评审前" }), el("p", { textContent: entry.promptBefore || "未读取" })]),
                    el("div", { className: "aipa-review-loop-prompt" }, [el("small", { textContent: "写回后" }), el("p", { textContent: entry.promptAfter || "未写回" })]),
                );
                item.append(details);
            }
            reviewLoopHistoryHost.append(item);
        }
    }

    function renderReviewLoop() {
        const loop = state.reviewLoop;
        reviewLoopMode.value = loop.mode;
        reviewLoopMaxRounds.value = String(loop.maxRounds);
        reviewLoopThreshold.value = String(loop.threshold);
        reviewLoopThresholdValue.textContent = String(loop.threshold);
        reviewLoopApplyToggle.checked = loop.autoApply;
        reviewLoopGenerateToggle.checked = loop.autoGenerate;
        reviewLoopStatus.textContent = reviewLoopStatusText();
        reviewLoopStatus.dataset.phase = loop.phase;
        const activeStage = reviewLoopPhaseIndex();
        reviewLoopStages.replaceChildren();
        for (const [index, labelText] of ["读取成图", "视觉评审", "写回提示词", "重新生成"].entries()) {
            const stage = el("div", { className: `aipa-review-loop-stage ${index < activeStage ? "is-done" : ""} ${index === activeStage ? "is-active" : ""}` });
            stage.append(el("span", { className: "aipa-review-loop-stage-index", textContent: `0${index + 1}` }), el("span", { textContent: labelText }));
            reviewLoopStages.append(stage);
        }
        renderReviewLoopHistory();
    }

    function restoreReviewLoopNodeModes() {
        const loop = state.reviewLoop;
        const plannerNode = mappingNode("planner");
        if (plannerNode && loop.plannerMode !== null && loop.plannerMode !== undefined) {
            plannerNode.mode = loop.plannerMode;
            plannerNode.graph?.setDirtyCanvas?.(true, true);
        }
        const reviewerNode = mappingNode("reviewer");
        if (reviewerNode && loop.reviewerMode !== null && loop.reviewerMode !== undefined) {
            reviewerNode.mode = loop.reviewerMode;
            reviewerNode.graph?.setDirtyCanvas?.(true, true);
        }
        loop.plannerMode = null;
        loop.reviewerMode = null;
    }

    function prepareReviewLoopNodes() {
        const loop = state.reviewLoop;
        const plannerNode = mappingNode("planner");
        if (plannerNode && loop.plannerMode === null) {
            loop.plannerMode = plannerNode.mode ?? 0;
            plannerNode.mode = 2;
            plannerNode.graph?.setDirtyCanvas?.(true, true);
        }
        const reviewerNode = mappingNode("reviewer");
        if (reviewerNode && loop.reviewerMode === null) {
            loop.reviewerMode = reviewerNode.mode ?? 0;
            reviewerNode.mode = 0;
            reviewerNode.graph?.setDirtyCanvas?.(true, true);
        }
    }

    function prepareReviewLoopConnection() {
        const reviewerNode = mappingNode("reviewer");
        const imageSource = mappingNode("image");
        if (!reviewerNode) throw new Error("未找到图片评审节点，请先添加或选择评审节点。");
        if (!imageSource) throw new Error("未找到成图来源，请先选择带 IMAGE 输出的节点。");
        const connection = connectReviewImage(imageSource, reviewerNode);
        setWidget(reviewerNode, "enable_review", true);
        setWidget(reviewerNode, "revision_request", request.value);
        setWidget(reviewerNode, "prompt_format", reviewerFormat.value);
        writeGenerationControlsToWorkflow();
        const synced = syncReviewerInputsFromWorkflow(reviewerNode);
        if (!reviewLoopCurrentPrompt()) throw new Error("未识别正向提示词，请先在工作流映射中选择正向 CLIP Text Encode 节点。");
        prepareReviewLoopNodes();
        return { connection, synced };
    }

    function stopReviewLoop(message, kind = "success") {
        const loop = state.reviewLoop;
        if (loop.activePromptId) loop.handledPromptIds.add(loop.activePromptId);
        loop.running = false;
        loop.paused = false;
        loop.awaitingStart = false;
        loop.activePromptId = "";
        loop.currentRunImages = [];
        loop.finishing = false;
        loop.submissionToken += 1;
        loop.phase = kind === "error" ? "error" : "stopped";
        restoreReviewLoopNodeModes();
        setStatus(kind, message);
        update();
    }

    function completeReviewLoop(message) {
        const loop = state.reviewLoop;
        if (loop.activePromptId) loop.handledPromptIds.add(loop.activePromptId);
        loop.running = false;
        loop.paused = false;
        loop.awaitingStart = false;
        loop.activePromptId = "";
        loop.currentRunImages = [];
        loop.finishing = false;
        loop.phase = "completed";
        restoreReviewLoopNodeModes();
        setStatus("success", message);
        update();
    }

    function pauseReviewLoop() {
        const loop = state.reviewLoop;
        if (!loop.running) return;
        loop.running = false;
        loop.paused = true;
        loop.phase = "paused";
        if (!loop.activePromptId) restoreReviewLoopNodeModes();
        setStatus("success", "自动评审已暂停；当前已经提交的任务会完成，但不会自动进入下一轮。" );
        update();
    }

    function reviewLoopDelay(milliseconds) {
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        return new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 0 : milliseconds));
    }

    async function finishReviewLoopRound(report, output, promptId) {
        const loop = state.reviewLoop;
        if (loop.finishing || loop.activePromptId !== promptId || (!loop.running && !loop.paused)) return;
        loop.finishing = true;
        loop.phase = "reviewing";
        state.lastReview = report;
        update();
        let image = outputComicImage(loop.currentRunImages);
        if (!image) image = outputComicImage(await comicImagesFromHistory(promptId, 10));
        if (loop.activePromptId !== promptId || (!loop.running && !loop.paused)) {
            loop.finishing = false;
            return;
        }
        const normalized = normalizedNodeOutput(output);
        const promptAfter = String(outputValue(normalized, "positive_prompt") || "").trim();
        const score = normalizedScore(report.score);
        const modelSatisfied = report.satisfied === true;
        const scoreSatisfied = score !== null && score >= loop.threshold;
        const hasModelDecision = typeof report.satisfied === "boolean";
        const satisfied = loop.mode === "satisfied" && (modelSatisfied || (!hasModelDecision && scoreSatisfied));
        const reachedLimit = loop.currentRound >= loop.maxRounds;
        const entry = {
            round: loop.currentRound,
            image: cleanComicImage(image),
            score,
            scores: report.scores || {},
            confidence: report.confidence,
            satisfied,
            modelSatisfied,
            scoreSatisfied,
            summary: report.summary || "",
            observations: Array.isArray(report.observations) ? report.observations.slice(0, 6) : [],
            preserve: Array.isArray(report.preserve) ? report.preserve.slice(0, 6) : [],
            changes: Array.isArray(report.changes) ? report.changes.slice(0, 6) : [],
            stopReason: String(report.stop_reason || "").trim(),
            promptBefore: loop.currentPromptBefore,
            promptAfter,
            status: "reviewed",
        };
        loop.history.push(entry);
        loop.currentRunImages = [];
        update();
        if (report.enabled === false) {
            stopReviewLoop("评审节点返回了关闭状态，自动评审已停止。", "error");
            return;
        }
        if (satisfied) {
            entry.status = "satisfied";
            loop.finishing = false;
            completeReviewLoop(`AI 判定第 ${loop.currentRound} 轮已满意（${score === null ? "无评分" : `${score} 分`}）。`);
            return;
        }
        if (reachedLimit) {
            entry.status = "max_rounds";
            loop.finishing = false;
            completeReviewLoop(`已完成设定的 ${loop.maxRounds} 轮评审，当前保留最后一版结果。`);
            return;
        }
        if (!loop.autoApply) {
            entry.status = "awaiting_apply";
            loop.finishing = false;
            loop.running = false;
            loop.paused = true;
            loop.phase = "paused";
            restoreReviewLoopNodeModes();
            setStatus("success", "评审完成。自动写回已关闭，请检查结果后手动处理。" );
            update();
            return;
        }
        loop.phase = "applying";
        update();
        const applied = applyAiOutputToWorkflow(output);
        if (!applied) {
            stopReviewLoop("评审完成，但没有找到可写入的正向提示词节点。", "error");
            return;
        }
        entry.status = "applied";
        entry.promptAfter = reviewLoopCurrentPrompt() || promptAfter;
        update();
        if (!loop.autoGenerate) {
            loop.finishing = false;
            loop.running = false;
            loop.paused = true;
            loop.phase = "paused";
            restoreReviewLoopNodeModes();
            setStatus("success", "优化提示词已写回；自动重新生成已关闭。" );
            update();
            return;
        }
        await reviewLoopDelay(900);
        if (!loop.running || loop.activePromptId !== promptId) {
            loop.finishing = false;
            loop.activePromptId = "";
            restoreReviewLoopNodeModes();
            update();
            return;
        }
        loop.finishing = false;
        loop.activePromptId = "";
        loop.awaitingStart = false;
        queueReviewLoopRound();
    }

    async function watchReviewLoopHistory(promptId, token) {
        for (let attempt = 0; attempt < 900; attempt += 1) {
            const loop = state.reviewLoop;
            if ((!loop.running && !loop.paused) || loop.submissionToken !== token || loop.activePromptId !== promptId) return;
            if (outputComicImage(loop.currentRunImages)) return;
            const image = outputComicImage(await comicImagesFromHistory(promptId, 1));
            if (image && loop.submissionToken === token && loop.activePromptId === promptId) {
                loop.currentRunImages.push(image);
                update();
                return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
    }

    async function queueReviewLoopRound() {
        const loop = state.reviewLoop;
        if (!loop.running || loop.paused || loop.finishing) return;
        if (loop.currentRound >= loop.maxRounds) {
            completeReviewLoop(`已完成设定的 ${loop.maxRounds} 轮评审。`);
            return;
        }
        const reviewerNode = mappingNode("reviewer");
        const prompt = reviewLoopCurrentPrompt();
        if (!reviewerNode || !prompt) {
            stopReviewLoop("无法开始下一轮：缺少图片评审节点或正向提示词。", "error");
            return;
        }
        setWidget(reviewerNode, "enable_review", true);
        setWidget(reviewerNode, "revision_request", request.value);
        setWidget(reviewerNode, "prompt_format", reviewerFormat.value);
        syncReviewerInputsFromWorkflow(reviewerNode);
        prepareReviewLoopNodes();
        loop.currentRound += 1;
        loop.currentPromptBefore = prompt;
        loop.currentRunImages = [];
        loop.activePromptId = "";
        loop.awaitingStart = true;
        loop.finishing = false;
        const token = loop.submissionToken + 1;
        loop.submissionToken = token;
        loop.phase = "generating";
        setStatus("working", `第 ${loop.currentRound} 轮已提交：先生成候选图，再交给视觉模型评审。` );
        update();
        try {
            const result = await queue();
            if (!loop.running || loop.paused || loop.submissionToken !== token) return;
            const promptId = promptIdFromQueueResponse(result);
            if (promptId) {
                loop.activePromptId = promptId;
                loop.awaitingStart = false;
                setStatus("working", `第 ${loop.currentRound} 轮正在生成图片，完成后会自动评审。` );
                void watchReviewLoopHistory(promptId, token);
            } else {
                setStatus("working", `第 ${loop.currentRound} 轮已提交，正在确认任务编号...` );
            }
            update();
        } catch (error) {
            if (loop.running && loop.submissionToken === token) stopReviewLoop(`第 ${loop.currentRound} 轮提交失败：${error.message || "无法提交工作流"}`, "error");
        }
    }

    function startReviewLoop() {
        const loop = state.reviewLoop;
        if (loop.running) return;
        syncReviewLoopPreferences();
        if (loop.paused && loop.activePromptId) {
            loop.running = true;
            loop.paused = false;
            loop.phase = "generating";
            setStatus("working", "自动评审已继续；当前任务完成后会按原停止条件运行。" );
            update();
            return;
        }
        try {
            prepareReviewLoopConnection();
        } catch (error) {
            setStatus("error", error.message || "无法准备自动评审。" );
            update();
            return;
        }
        loop.running = true;
        loop.paused = false;
        loop.phase = "idle";
        loop.currentRound = 0;
        loop.history = [];
        loop.activePromptId = "";
        loop.awaitingStart = false;
        loop.currentRunImages = [];
        loop.currentPromptBefore = "";
        loop.finishing = false;
        loop.handledPromptIds = new Set();
        state.lastReview = null;
        setStatus("working", `自动评审已开始：${loop.mode === "satisfied" ? `直到 AI 满意，最多 ${loop.maxRounds} 轮` : `固定 ${loop.maxRounds} 轮` }。` );
        update();
        queueReviewLoopRound();
    }

    function renderAgentBrief() {
        const plan = state.chat?.lastPlan;
        const hasPlan = Boolean(plan?.creativeBrief || plan?.conceptSummary || plan?.creativeTitle);
        const ready = Boolean(plan?.ready);
        const waiting = hasPlan && !ready;
        agentBrief.classList.toggle("is-empty", !hasPlan);
        agentBrief.classList.toggle("is-ready", ready);
        agentBrief.classList.toggle("is-waiting", waiting);
        agentBrief.dataset.state = ready ? "ready" : (waiting ? "waiting" : "empty");
        agentBriefState.textContent = ready ? "可交给工作流" : (waiting ? "等待确认" : "等待想法");
        agentBriefTitle.textContent = hasPlan
            ? (plan.creativeTitle || (ready ? "已整理出可生成方案" : "正在建立创作方向"))
            : "从一句想法开始";
        agentBriefSummary.textContent = hasPlan
            ? (plan.conceptSummary || (ready ? "方案已整理完成，可继续编辑或直接发送给工作流。" : "Agent 正在收集决定创作方向的关键信息。"))
            : "告诉 Agent 主题、角色、情绪或参考图；它会把零散灵感整理成可执行的出图方案。";

        agentBriefMeta.replaceChildren();
        if (hasPlan) {
            agentBriefMeta.append(
                el("span", { className: "aipa-agent-meta-pill", textContent: formatLabel(plan.promptFormat) }),
                el("span", { className: "aipa-agent-meta-pill", textContent: "独立对话记忆" }),
            );
        }

        agentBriefDecisions.replaceChildren();
        const decisions = normalizeChatList(plan?.decisions, 4);
        for (const decision of decisions) {
            agentBriefDecisions.append(el("li", { textContent: decision }));
        }
        agentBriefDecisions.hidden = !decisions.length;

        agentBriefQuestions.replaceChildren();
        const question = normalizeChatList(plan?.questions, 1)[0];
        if (question) {
            agentBriefQuestions.append(
                el("strong", { textContent: "下一步需要确认" }),
                el("p", { textContent: question }),
            );
        }
        agentBriefQuestions.hidden = !question;
        agentBriefActions.hidden = !ready;
    }

    function renderChatMessages() {
        chatMessages.replaceChildren();
        for (const message of state.chat.messages.slice(-24)) {
            const bubble = el("article", { className: `aipa-chat-message is-${message.role}` });
            bubble.append(el("span", { className: "aipa-chat-speaker", textContent: message.role === "user" ? "你" : "AI 创作 Agent" }));
            if (message.attachmentName) bubble.append(el("small", { className: "aipa-chat-message-attachment", textContent: `已附加图片：${message.attachmentName}` }));
            bubble.append(el("p", { textContent: message.content }));
            if (message.plan?.ready) {
                const plan = message.plan;
                const planCard = el("section", { className: "aipa-chat-plan", ariaLabel: "AI 整理的创作方案" });
                planCard.append(
                    el("strong", { textContent: plan.creativeTitle ? `可出图方案 · ${plan.creativeTitle}` : "已整理为可出图方案" }),
                    el("p", { textContent: plan.creativeBrief }),
                    plan.constraints ? el("small", { textContent: plan.constraints }) : el("small", { textContent: formatLabel(plan.promptFormat) }),
                );
                bubble.append(planCard);
            }
            chatMessages.append(bubble);
        }
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function renderChatSessions() {
        chatSessionList.replaceChildren();
        for (const session of state.chatSessions.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
            const button = el("button", {
                className: `aipa-chat-session ${session.id === state.activeChatId ? "is-active" : ""}`,
                type: "button",
                ariaLabel: `切换到对话：${session.title}`,
            });
            const firstUserMessage = session.messages.find((message) => message.role === "user")?.content || "等待你的第一个想法";
            button.append(el("strong", { textContent: session.title || "新对话" }), el("small", { textContent: `${session.messages.filter((message) => message.role === "user").length} 条消息 · ${firstUserMessage.slice(0, 28)}` }));
            button.onclick = () => {
                if (session.id === state.activeChatId) return;
                if (state.chat.sending) cancelChat();
                state.activeChatId = session.id;
                state.chat = session;
                state.chat.attachment = null;
                updateAttachmentUI();
                setStatus("success", `已切换到“${session.title}”。每个对话使用独立记忆。`);
                persistChatSession(session);
                update();
            };
            chatSessionList.append(button);
        }
    }

    function updateAttachmentUI() {
        const attachment = state.chat.attachment;
        chatAttachmentName.textContent = attachment ? `${attachment.name}（已附加）` : "未选择图片";
        chatReversePrompt.disabled = state.chat.sending;
        chatAttachmentButton.disabled = state.chat.sending;
    }

    function renderReversePreview() {
        const image = state.reverse.image;
        const isBusy = state.reverse.sending || state.reverse.phase === "loading";
        reverseDropzone.disabled = isBusy;
        reverseImageInput.disabled = isBusy;
        reverseDropzone.dataset.state = image ? "ready" : "empty";
        reversePreview.classList.toggle("has-image", Boolean(image));
        reversePreviewImage.hidden = !image;
        reversePreviewEmpty.hidden = Boolean(image);
        reverseClearButton.disabled = !image || isBusy;
        if (!image) {
            reversePreviewMeta.replaceChildren();
            return;
        }
        reversePreviewImage.src = image.dataUrl;
        reversePreviewImage.alt = `待反推图片：${image.name}`;
        const meta = [
            el("strong", { textContent: image.name }),
            el("span", { textContent: `${image.width} × ${image.height} · 原图 ${formatBytes(image.originalSize)}` }),
        ];
        if (image.processedWidth && image.processedHeight) meta.push(el("small", { textContent: `发送尺寸 ${image.processedWidth} × ${image.processedHeight}` }));
        reversePreviewMeta.replaceChildren(...meta);
    }

    function reversePromptSection(title, prompt, modifier = "") {
        const copyButton = el("button", { className: "aipa-reverse-copy", type: "button", ariaLabel: `复制${title}` }, [icon("copy"), el("span", { textContent: "复制" })]);
        const section = el("section", { className: `aipa-reverse-result-section ${modifier}` });
        const code = el("pre", { className: "aipa-reverse-prompt", textContent: prompt });
        copyButton.onclick = () => { void copyText(prompt, title); };
        section.append(el("div", { className: "aipa-reverse-result-heading" }, [el("strong", { textContent: title }), copyButton]), code);
        return section;
    }

    function renderReverseResult() {
        const { image, result, sending, phase, error } = state.reverse;
        reverseRunButton.disabled = !image && !sending;
        reverseRunButton.textContent = sending ? "停止反推" : "开始反推";
        reverseRunButton.ariaLabel = sending ? "停止图片反推" : "开始反推图片提示词";
        reverseRunButton.classList.toggle("aipa-cancel", sending);
        reverseResult.classList.toggle("is-working", sending);
        reverseResult.dataset.state = sending ? "working" : (phase === "error" ? "error" : (result ? "complete" : "empty"));
        reverseResultStatus.textContent = sending
            ? (reverseEngine.value === "wd_tagger" ? "WD-EVA02 正在本地识别视觉标签……" : "视觉模型正在逐层整理主体、构图、光线与材质……")
            : (phase === "error" ? error : (result ? (result.engine === "wd_tagger" ? "本地 WD-EVA02 反推完成。每一段都可以单独复制。" : "反推完成。每一段都可以单独复制。") : "把图片放入左侧，结果会在这里归档。"));
        reverseResultStatus.dataset.kind = sending ? "working" : (phase === "error" ? "error" : "");
        reverseResultHost.replaceChildren();
        if (phase === "error") {
            reverseResultHost.append(el("div", { className: "aipa-reverse-empty is-error" }, [
                el("span", { className: "aipa-reverse-empty-mark", textContent: "!" }),
                el("strong", { textContent: "这次没有形成可用结果" }),
                el("p", { textContent: error || "请检查模型是否支持图片输入，然后重试。" }),
            ]));
            return;
        }
        if (!result) {
            reverseResultHost.append(el("div", { className: `aipa-reverse-empty ${sending ? "is-scanning" : ""}` }, [
                el("div", { className: "aipa-reverse-scan-line", ariaHidden: "true" }),
                el("span", { className: "aipa-reverse-empty-mark", textContent: sending ? "//" : "B" }),
                el("strong", { textContent: sending ? "正在读取画面" : "等待视觉证据" }),
                el("p", { textContent: sending ? "先确认看见了什么，再把它压成可执行的提示词。" : "这里不会复述聊天记录，只呈现这张图片本身带来的观察。" }),
            ]));
            return;
        }
        const summary = el("section", { className: "aipa-reverse-summary" }, [
            el("div", { className: "aipa-reverse-result-heading" }, [el("strong", { textContent: "图片理解" }), el("span", { className: "aipa-reverse-result-count", textContent: `${result.details.length || 0} 条观察` })]),
            el("p", { textContent: result.summary || "模型没有返回额外摘要，但已生成可用提示词。" }),
        ]);
        reverseResultHost.append(summary);
        if (result.details.length) {
            const detailList = el("ul", { className: "aipa-reverse-details" });
            for (const detail of result.details) detailList.append(el("li", { textContent: detail }));
            reverseResultHost.append(detailList);
        }
        reverseResultHost.append(reversePromptSection("正向提示词", result.prompt, "is-positive"));
        if (result.negativePrompt) reverseResultHost.append(reversePromptSection("负向提示词", result.negativePrompt, "is-negative"));
        const bringButton = el("button", { className: "aipa-secondary aipa-reverse-bring", type: "button", ariaLabel: "把正向提示词带入 AI 对话" }, [el("span", { textContent: "带入 AI 对话" }), icon("arrow")]);
        bringButton.onclick = () => {
            state.chat.attachment = image;
            state.tab = "chat";
            state.view = "main";
            state.chatExpanded = true;
            const existing = chatInput.value.trim();
            const carry = `根据这张图整理的正向提示词：\n${result.prompt}`;
            chatInput.value = existing ? `${existing}\n\n${carry}` : carry;
            setStatus("success", "已把图片和正向提示词带入 AI 对话，可以继续让 Agent 改写或定稿。 ");
            update();
            chatInput.focus();
        };
        reverseResultHost.append(el("div", { className: "aipa-actions aipa-reverse-result-actions" }, [bringButton]));
    }

    async function copyText(value, labelText) {
        const text = String(value || "");
        if (!text) return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                const helper = el("textarea", { value: text, ariaHidden: "true" });
                try {
                    helper.style.position = "fixed";
                    helper.style.opacity = "0";
                    document.body.append(helper);
                    helper.select();
                    if (!document.execCommand("copy")) throw new Error("clipboard unavailable");
                } finally {
                    helper.remove();
                }
            }
            setStatus("success", `${labelText}已复制到剪贴板。`);
        } catch {
            setStatus("error", "复制失败，请选中结果文本后手动复制。");
        }
        update();
    }

    async function readReverseImage(file) {
        if (!file || state.reverse.sending) return;
        state.reverse.phase = "loading";
        state.reverse.error = "";
        setStatus("working", "正在准备图片，先压缩到适合视觉模型的尺寸…");
        update();
        try {
            const prepared = await imageFileToDataUrl(file);
            state.reverse.image = {
                name: String(file.name || "粘贴的图片").slice(0, 160),
                ...prepared,
            };
            state.reverse.result = null;
            state.reverse.phase = "ready";
            setStatus("success", `已载入“${state.reverse.image.name}”，可以开始反推。`);
        } catch (error) {
            state.reverse.phase = "error";
            state.reverse.error = error.message || "图片读取失败，请重试。";
            setStatus("error", state.reverse.error);
        } finally {
            update();
        }
    }

    async function readAttachment(file) {
        if (!file) return;
        try {
            const prepared = await imageFileToDataUrl(file);
            state.chat.attachment = { name: String(file.name || "参考图片").slice(0, 160), ...prepared };
            chatInput.placeholder = "可以补充要求，也可以打开“图片反推”";
            setStatus("success", `已附加图片“${state.chat.attachment.name}”，可发送给 AI 或打开图片反推。`);
        } catch (error) {
            setStatus("error", error.message || "图片读取失败，请重试。 ");
        }
        updateAttachmentUI();
        update();
    }

    function buildAgentWorkflowContext() {
        const plannerNode = mappingNode("planner");
        const samplerNode = mappingNode("sampler");
        const latentNode = mappingNode("latent");
        const imageNode = mappingNode("image");
        return [
            `提示词规划节点：${plannerNode ? "已连接" : "未添加"}`,
            `正向提示词：${widgetValue(mappingNode("positive"), "text") || "未识别"}`,
            `固定反向提示词：${widgetValue(mappingNode("negative"), "text") || negativePrompt.value || "未填写"}`,
            `本机出图模型：${generationModel.value || widgetValue(plannerNode, "image_model") || "未选择"}`,
            `采样器：${widgetValue(samplerNode, "sampler_name") || generationSampler.value || "未识别"}`,
            `调度器：${widgetValue(samplerNode, "scheduler") || generationScheduler.value || "未识别"}`,
            `画幅：${widgetValue(latentNode, "width") || generationWidth.value || "未识别"} x ${widgetValue(latentNode, "height") || generationHeight.value || "未识别"}`,
            `成图来源：${imageNode ? nodeLabel(imageNode) : "未识别"}`,
            loraManagerContext(),
        ].join("\n");
    }

    function applyChatPlan(plan) {
        if (!plan?.ready) return false;
        brief.value = plan.creativeBrief;
        constraints.value = plan.constraints;
        let plannerNode = mappingNode("planner");
        // A format selected on the workflow node is an explicit user choice.
        // The chat model may recommend a format for a new workflow, but must
        // never override an existing planner node while delivering a plan.
        const promptFormat = nodePromptFormat(plannerNode, plan.promptFormat);
        try {
            if (!plannerNode) plannerNode = addAssistantNode("planner", false);
        } catch (error) {
            setStatus("error", error.message || "无法添加提示词规划节点。" );
            return false;
        }
        plannerFormat.value = promptFormat;
        const synced = [
            setWidget(plannerNode, "creative_brief", plan.creativeBrief),
            setWidget(plannerNode, "style_or_constraints", plan.constraints),
            setWidget(plannerNode, "strip_style", state.stripStyle),
            setWidget(plannerNode, "prompt_format", promptFormat),
            setWidget(plannerNode, "lora_context", loraManagerContext()),
        ].filter(Boolean).length;
        state.generation.signature = "";
        setStatus("success", `AI 方案已写入创作需求和提示词规划节点（${promptFormatLabel(promptFormat)}，已同步 ${synced} 项）。`);
        return true;
    }

    function submitPlanner(source = "提示词规划", focusNode = true) {
        let node = mappingNode("planner");
        if (!node) {
            try {
                node = addAssistantNode("planner", focusNode);
                syncGenerationControls(true);
            } catch (error) {
                setStatus("error", error.message || "添加提示词规划节点失败。");
                return false;
            }
        }
        if (!brief.value.trim()) {
            setStatus("error", "请先填写创作需求。" );
            return false;
        }
        const configured = writeGenerationControlsToWorkflow();
        const promptFormat = nodePromptFormat(node, plannerFormat.value);
        plannerFormat.value = promptFormat;
        setWidget(node, "creative_brief", brief.value);
        setWidget(node, "style_or_constraints", constraints.value);
        setWidget(node, "strip_style", state.stripStyle);
        setWidget(node, "prompt_format", promptFormat);
        setWidget(node, "lora_context", loraManagerContext());
        if (focusNode) selectCanvasNode(node);
        state.pendingPlannerApply = true;
        setStatus("working", `已同步 ${configured} 项用户设置，${source}已提交。`);
        queue();
        return true;
    }

    function comicPromptFormat() {
        return COMIC_PROMPT_FORMATS.some((format) => format.value === state.comic.promptFormat)
            ? state.comic.promptFormat
            : "tag";
    }

    function outputComicImage(images) {
        const validImages = (Array.isArray(images) ? images : []).filter((image) => image?.filename);
        // Prefer a durable Save Image result; Preview Image is a safe fallback
        // when the workflow intentionally has no Save Image node.
        return validImages.find((image) => String(image.type || "output").toLowerCase() === "output")
            || validImages.find((image) => String(image.type || "").toLowerCase() === "temp")
            || null;
    }

    function comicImageUrl(image) {
        const filename = encodeURIComponent(String(image?.filename || ""));
        const subfolder = encodeURIComponent(String(image?.subfolder || ""));
        const type = encodeURIComponent(String(image?.type || "output"));
        return `/view?filename=${filename}&subfolder=${subfolder}&type=${type}`;
    }

    function comicHistoryStatus() {
        if (state.comic.running) return "generating";
        if (state.comic.phase === "completed") return "completed";
        if (state.comic.phase === "paused") return "paused";
        if (state.comic.phase === "error") return "error";
        return "planned";
    }

    function saveComicHistory(create = false) {
        const plan = cleanComicPlan(state.comic.plan);
        if (!plan) return;
        const now = Date.now();
        if (create || !state.comic.historyId) state.comic.historyId = comicHistoryId();
        const existing = state.comic.history.find((item) => item.id === state.comic.historyId);
        const item = {
            id: state.comic.historyId,
            title: plan.title,
            idea: String(state.comic.idea || "").slice(0, 3000),
            panelCount: plan.panels.length,
            promptFormat: comicPromptFormat(),
            continueWithImage: state.comic.continueWithImage,
            createdAt: existing?.createdAt || now,
            updatedAt: now,
            status: comicHistoryStatus(),
            currentIndex: Math.max(0, Math.min(plan.panels.length, state.comic.currentIndex)),
            plan,
            collectedImages: state.comic.collectedImages.map((result) => {
                const image = cleanComicImage(result?.image);
                return image ? { panelIndex: Math.max(0, Number(result?.panelIndex) || 0), image } : null;
            }).filter(Boolean),
        };
        state.comic.history = [item, ...state.comic.history.filter((entry) => entry.id !== item.id)]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_COMIC_HISTORY_ITEMS);
        persistComicHistory(state.comic.history);
    }

    function formatComicHistoryTime(value) {
        try {
            return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
        } catch {
            return "刚刚";
        }
    }

    function newComicWorkspace() {
        if (state.comic.running || state.comic.continuing || state.comic.planning) return;
        state.comic.idea = "";
        state.comic.panelCount = 4;
        state.comic.plan = null;
        state.comic.currentIndex = 0;
        state.comic.collectedImages = [];
        state.comic.currentRunImages = [];
        state.comic.historyId = "";
        state.comic.phase = "idle";
        state.comic.continuationWarning = "";
        setStatus("success", "已新建漫画项目；历史记录仍会保留。 ");
        update();
    }

    function loadComicHistory(item) {
        if (!item || state.comic.running || state.comic.continuing || state.comic.planning) return;
        const plan = cleanComicPlan(item.plan);
        if (!plan) return;
        state.comic.historyId = item.id;
        state.comic.idea = item.idea;
        state.comic.panelCount = item.panelCount;
        state.comic.promptFormat = item.promptFormat;
        persistComicPromptFormat(item.promptFormat);
        state.comic.continueWithImage = item.continueWithImage;
        persistComicContinuation(item.continueWithImage);
        state.comic.plan = plan;
        state.comic.currentIndex = Math.max(0, Math.min(plan.panels.length, item.currentIndex));
        state.comic.collectedImages = item.collectedImages.map((result) => ({ ...result, image: { ...result.image } }));
        state.comic.currentRunImages = [];
        state.comic.awaitingStart = false;
        state.comic.activePromptId = "";
        state.comic.finishing = false;
        state.comic.continuationWarning = "";
        state.comic.phase = item.status === "completed" ? "completed" : (item.status === "error" ? "error" : (item.status === "paused" || item.status === "generating" ? "paused" : "idle"));
        setStatus("success", `已加载《${plan.title}》。确认分镜后可继续逐张生成。`);
        update();
    }

    function deleteComicHistory(id) {
        const item = state.comic.history.find((entry) => entry.id === id);
        if (!item || !window.confirm(`删除漫画记录《${item.title}》？已生成的图片文件不会删除。`)) return;
        state.comic.history = state.comic.history.filter((entry) => entry.id !== id);
        if (state.comic.historyId === id) state.comic.historyId = "";
        persistComicHistory(state.comic.history);
        setStatus("success", "漫画记录已删除；已生成的图片文件仍保留在 ComfyUI 输出目录。 ");
        update();
    }

    function renderComicHistory() {
        comicHistoryHost.replaceChildren();
        const newButton = el("button", { className: "aipa-secondary aipa-comic-new", type: "button", textContent: "新建", ariaLabel: "新建漫画项目" });
        newButton.onclick = newComicWorkspace;
        comicHistoryHost.append(el("div", { className: "aipa-comic-history-heading" }, [
            el("div", {}, [el("strong", { textContent: "漫画记录" }), el("small", { textContent: state.comic.history.length ? "加载后可继续生成" : "最近的漫画项目会保存在这里" })]),
            newButton,
        ]));
        if (!state.comic.history.length) {
            comicHistoryHost.append(el("p", { className: "aipa-empty", textContent: "还没有漫画记录。完成分镜设计后会自动保存。" }));
            return;
        }
        const list = el("div", { className: "aipa-comic-history-list" });
        const statusLabels = { planned: "待生成", generating: "生成中", paused: "已暂停", completed: "已完成", error: "异常停止" };
        for (const item of state.comic.history) {
            const count = item.plan?.panels?.length || item.panelCount;
            const load = el("button", { className: `aipa-comic-history-item ${state.comic.historyId === item.id ? "is-active" : ""}`, type: "button", ariaLabel: `加载漫画记录：${item.title}` }, [
                el("strong", { textContent: item.title }),
                el("span", { textContent: `${item.collectedImages.length} / ${count} 张 · ${statusLabels[item.status] || "待生成"}` }),
                el("small", { textContent: formatComicHistoryTime(item.updatedAt) }),
            ]);
            load.onclick = () => loadComicHistory(item);
            const remove = el("button", { className: "aipa-comic-history-delete", type: "button", textContent: "删除", ariaLabel: `删除漫画记录：${item.title}` });
            remove.onclick = () => deleteComicHistory(item.id);
            list.append(el("div", { className: "aipa-comic-history-row" }, [load, remove]));
        }
        comicHistoryHost.append(list);
    }

    function renderComicPlan() {
        comicPlanHost.replaceChildren();
        const plan = state.comic.plan;
        if (!plan) {
            comicPlanHost.append(el("p", { className: "aipa-empty", textContent: "AI 设计完成后，这里会显示角色设定、画风规则和可编辑的逐格提示词。" }));
            return;
        }
        const overview = el("section", { className: "aipa-comic-overview" });
        overview.append(
            el("h3", { textContent: plan.title || "未命名漫画" }),
            plan.logline ? el("p", { textContent: plan.logline }) : el("span"),
            el("div", { className: "aipa-comic-bible" }, [
                el("strong", { textContent: "角色设定" }),
                el("p", { textContent: plan.character_bible || "AI 未返回角色设定。" }),
                el("strong", { textContent: "视觉规则" }),
                el("p", { textContent: plan.visual_bible || "AI 未返回视觉规则。" }),
            ]),
        );
        comicPlanHost.append(overview);
        const list = el("div", { className: "aipa-comic-panel-list", ariaLabel: "漫画分镜列表" });
        for (const panel of plan.panels || []) {
            const item = el("article", { className: `aipa-comic-panel-item ${state.comic.running && panel.index === state.comic.currentIndex + 1 ? "is-rendering" : ""}` });
            const prompt = el("textarea", { rows: 3, value: panel.positive_prompt, ariaLabel: `第 ${panel.index} 格英文正向提示词` });
            prompt.oninput = () => { panel.positive_prompt = prompt.value; };
            item.append(
                el("div", { className: "aipa-comic-panel-heading" }, [el("strong", { textContent: `第 ${panel.index} 格` }), el("span", { textContent: panel.shot || "" })]),
                el("p", { textContent: panel.beat || "" }),
                el("small", { textContent: `连续性：${panel.continuity || "保持角色与画风一致"}` }),
                panel.continuation_note ? el("small", { className: "aipa-comic-continuity-note", textContent: `AI 看图续写：${panel.continuation_note}` }) : el("span"),
                label("英文正向提示词", prompt),
            );
            list.append(item);
        }
        comicPlanHost.append(list);
    }

    function renderComicGallery() {
        comicGallery.replaceChildren();
        const panels = state.comic.plan?.panels || [];
        if (!state.comic.collectedImages.length) return;
        comicGallery.append(el("h3", { textContent: state.comic.phase === "completed" ? "漫画成图" : "已完成画面" }));
        for (const result of state.comic.collectedImages) {
            const panel = panels[result.panelIndex] || {};
            const card = el("article", { className: "aipa-comic-image-card" });
            const image = el("img", { src: comicImageUrl(result.image), loading: "lazy", alt: `第 ${result.panelIndex + 1} 格：${panel.beat || "漫画画面"}` });
            card.append(image, el("strong", { textContent: `第 ${result.panelIndex + 1} 格` }), el("small", { textContent: panel.beat || "" }));
            comicGallery.append(card);
        }
    }

    function comicProgressText() {
        const count = state.comic.plan?.panels?.length || state.comic.panelCount;
        if (state.comic.planning) return "AI 正在设计角色设定与连续分镜...";
        if (state.comic.continuing) return `AI 正在分析第 ${state.comic.currentIndex + 1} 格成图，并优化第 ${state.comic.currentIndex + 2} 格提示词...`;
        if (state.comic.running) return `正在生成第 ${Math.min(state.comic.currentIndex + 1, count)} / ${count} 张...`;
        if (state.comic.phase === "paused") return `已暂停。已完成 ${state.comic.currentIndex} / ${count} 张；当前一张若已开始，仍会完成。`;
        if (state.comic.phase === "completed") return `全部完成，共生成 ${state.comic.currentIndex} 张，已在下方汇总展示。`;
        if (state.comic.plan) return `分镜已就绪，共 ${count} 格。确认后即可逐张生成。`;
        return "先让 AI 设计分镜，再开始逐张生成。";
    }

    function stopComic(message, kind = "error") {
        state.comic.running = false;
        state.comic.awaitingStart = false;
        state.comic.activePromptId = "";
        state.comic.finishing = false;
        // Invalidate a pending history watcher from an earlier panel.
        state.comic.submissionToken += 1;
        state.comic.phase = kind === "success" ? "completed" : "error";
        restoreComicNodeModes();
        saveComicHistory();
        setStatus(kind, message);
        update();
    }

    function restoreComicNodeModes() {
        const planner = mappingNode("planner");
        if (planner && state.comic.plannerMode !== null && state.comic.plannerMode !== undefined) {
            planner.mode = state.comic.plannerMode;
            planner.graph?.setDirtyCanvas?.(true, true);
        }
        state.comic.plannerMode = null;
        const reviewer = mappingNode("reviewer");
        if (reviewer && state.comic.reviewerMode !== null && state.comic.reviewerMode !== undefined) {
            reviewer.mode = state.comic.reviewerMode;
            reviewer.graph?.setDirtyCanvas?.(true, true);
        }
        state.comic.reviewerMode = null;
    }

    function promptIdFromQueueResponse(result) {
        if (!result || typeof result !== "object") return "";
        return String(result.prompt_id ?? result.promptId ?? result?.data?.prompt_id ?? result?.data?.promptId ?? "");
    }

    function finishComicPanel(image, promptId) {
        // Pausing stops the next panel only. A panel already submitted to
        // ComfyUI still belongs in the comic history when it finishes.
        if (!image?.filename || state.comic.finishing || (!state.comic.running && state.comic.phase !== "paused")) return;
        if (!state.comic.activePromptId || String(promptId) !== state.comic.activePromptId) return;
        state.comic.finishing = true;
        void advanceComicAfterImage(image);
    }

    async function watchComicPromptHistory(promptId, token) {
        // Websocket image events are inconsistent across ComfyUI frontends.
        // The prompt-specific history entry is the authoritative source and
        // prevents a previous workflow image being reused by a new panel.
        for (let attempt = 0; attempt < 900; attempt += 1) {
            if ((!state.comic.running && state.comic.phase !== "paused") || state.comic.submissionToken !== token || state.comic.activePromptId !== promptId) return;
            const images = await comicImagesFromHistory(promptId, 1);
            const image = outputComicImage(images);
            if (image) {
                finishComicPanel(image, promptId);
                return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
        if ((state.comic.running || state.comic.phase === "paused") && state.comic.submissionToken === token && state.comic.activePromptId === promptId) {
            stopComic(`漫画第 ${state.comic.currentIndex + 1} 格等待图片超时。请确认工作流末端有 Save Image 或 Preview Image 节点。`);
        }
    }

    async function queueComicPanel() {
        const panels = state.comic.plan?.panels || [];
        if (!state.comic.running || state.comic.continuing) return;
        // Read the live control at queue time so changing the checkbox takes
        // effect for the very next panel, even after a restored history entry.
        state.comic.continueWithImage = Boolean(comicContinuationToggle.checked);
        if (state.comic.currentIndex >= panels.length) {
            stopComic("漫画已全部生成完成。", "success");
            return;
        }
        const positive = mappingNode("positive");
        const prompt = String(panels[state.comic.currentIndex]?.positive_prompt || "").trim();
        if (!positive || !prompt || !setWidget(positive, "text", prompt)) {
            stopComic("无法写入正向提示词。请在“提示词规划”页的工作流节点映射中选择正向 CLIP Text Encode 节点。");
            return;
        }
        const planner = mappingNode("planner");
        if (planner && state.comic.plannerMode === null) {
            state.comic.plannerMode = planner.mode;
            // The planner is an output node and would otherwise run again on
            // every queued panel, replacing the panel prompt we just wrote.
            planner.mode = 2; // LiteGraph NEVER: skip this output node for comic panel renders.
            planner.graph?.setDirtyCanvas?.(true, true);
        }
        const reviewer = mappingNode("reviewer");
        if (reviewer && state.comic.reviewerMode === null) {
            state.comic.reviewerMode = reviewer.mode;
            // Comic continuation uses the saved image through its own API.
            // Running this separate output node would trigger an unrelated review.
            reviewer.mode = 2; // LiteGraph NEVER
            reviewer.graph?.setDirtyCanvas?.(true, true);
        }
        state.comic.currentRunImages = [];
        state.comic.activePromptId = "";
        state.comic.awaitingStart = true;
        state.comic.finishing = false;
        const token = state.comic.submissionToken + 1;
        state.comic.submissionToken = token;
        state.comic.phase = "rendering";
        saveComicHistory();
        setStatus("working", `第 ${state.comic.currentIndex + 1} 格提示词已写入，正在提交工作流...`);
        update();
        try {
            const result = await queue();
            if (!state.comic.running || state.comic.submissionToken !== token) return;
            const promptId = promptIdFromQueueResponse(result);
            if (promptId) {
                state.comic.activePromptId = promptId;
                state.comic.awaitingStart = false;
                setStatus("working", `正在生成第 ${state.comic.currentIndex + 1} 格...`);
                void watchComicPromptHistory(promptId, token);
            } else {
                // Older frontends do not return the ID from queuePrompt; the
                // following execution_start event will bind this panel.
                setStatus("working", `第 ${state.comic.currentIndex + 1} 格已提交，正在确认任务...`);
            }
            update();
        } catch (error) {
            if (state.comic.running && state.comic.submissionToken === token) {
                stopComic(`漫画第 ${state.comic.currentIndex + 1} 格提交失败：${error.message || "无法提交工作流"}`);
            }
        }
    }

    async function advanceComicAfterImage(image) {
        const finishedIndex = state.comic.currentIndex;
        const panels = state.comic.plan?.panels || [];
        state.comic.collectedImages.push({ panelIndex: finishedIndex, image });
        state.comic.currentRunImages = [];
        state.comic.activePromptId = "";
        state.comic.awaitingStart = false;
        state.comic.finishing = false;
        const nextIndex = finishedIndex + 1;
        state.comic.continuationWarning = "";

        const continueWithImage = Boolean(comicContinuationToggle.checked && state.comic.continueWithImage);
        state.comic.continueWithImage = continueWithImage;
        if (continueWithImage && nextIndex < panels.length) {
            state.comic.continuing = true;
            const controller = new AbortController();
            state.comic.continuationAbortController = controller;
            state.comic.phase = "continuing";
            setStatus("working", `第 ${finishedIndex + 1} 格已完成，AI 正在看图优化第 ${nextIndex + 1} 格。`);
            update();
            try {
                const result = await aipaRequest("/aipa/comic-continue", {
                    method: "POST",
                    body: JSON.stringify({
                        previous_image: image,
                        next_panel: panels[nextIndex],
                        character_bible: state.comic.plan?.character_bible || "",
                        visual_bible: state.comic.plan?.visual_bible || "",
                        prompt_format: comicPromptFormat(),
                    }),
                    signal: controller.signal,
                });
                if (!controller.signal.aborted && state.comic.continueWithImage) {
                    panels[nextIndex].positive_prompt = result.positive_prompt;
                    panels[nextIndex].continuation_note = result.continuity_note || "已按上一格实际成图优化提示词。";
                }
            } catch (error) {
                if (!controller.signal.aborted) {
                    state.comic.continuationWarning = `AI 看图续写失败，已使用原分镜提示词继续：${error.message || "请求失败"}`;
                    setStatus("error", state.comic.continuationWarning);
                }
            } finally {
                if (state.comic.continuationAbortController === controller) {
                    state.comic.continuationAbortController = null;
                    state.comic.continuing = false;
                }
            }
        }

        state.comic.currentIndex = nextIndex;
        saveComicHistory();
        if (!state.comic.running) {
            state.comic.phase = "paused";
            update();
            return;
        }
        queueComicPanel();
    }

    async function comicImagesFromHistory(promptId, attempts = 10) {
        if (!promptId) return [];
        const findImages = (history, preferredId = "") => {
            const entries = Object.entries(history || {});
            const preferred = preferredId ? entries.find(([id]) => id === preferredId)?.[1] : null;
            const candidates = preferred ? [preferred] : [];
            return candidates.flatMap((entry) => Object.values(entry?.outputs || {}).flatMap((output) => Array.isArray(output?.images) ? output.images : []));
        };
        // Some ComfyUI builds omit output image metadata from websocket events,
        // while the completed prompt history always contains the durable result.
        const maximumAttempts = Math.max(1, Number(attempts) || 1);
        for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
            try {
                const history = await aipaRequest(`/history/${encodeURIComponent(promptId)}`, { method: "GET" });
                const images = findImages(history, promptId);
                if (images.length) return images;
            } catch {
                // The completion signal can arrive a moment before history commits.
            }
            if (attempt < maximumAttempts - 1) await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        return [];
    }

    async function completeComicExecution(detail) {
        if ((!state.comic.running && state.comic.phase !== "paused") || state.comic.continuing || state.comic.finishing || !state.comic.activePromptId) return;
        const promptId = String(detail?.prompt_id ?? detail?.promptId ?? "");
        if (!promptId || promptId !== state.comic.activePromptId) return;
        let image = outputComicImage(state.comic.currentRunImages);
        if (!image) {
            image = outputComicImage(await comicImagesFromHistory(promptId));
        }
        if (!image) {
            // Image metadata can be written slightly after the completion
            // event. The prompt-specific watcher will keep waiting for it.
            setStatus("working", `第 ${state.comic.currentIndex + 1} 格已完成，正在读取保存的图片...`);
            update();
            return;
        }
        finishComicPanel(image, promptId);
    }

    async function createComicPlan() {
        const idea = comicIdea.value.trim();
        const panelCount = Math.max(1, Math.min(12, Number.parseInt(comicCount.value, 10) || 4));
        if (!idea || state.comic.planning || state.comic.running) return;
        state.comic.idea = idea;
        state.comic.panelCount = panelCount;
        state.comic.planning = true;
        state.comic.phase = "idle";
        state.comic.plan = null;
        state.comic.collectedImages = [];
        state.comic.continuationWarning = "";
        setStatus("working", "AI 正在设计角色设定、画风规则和连续分镜...");
        update();
        try {
            const result = await aipaRequest("/aipa/comic-plan", {
                method: "POST",
                body: JSON.stringify({
                    idea,
                    panel_count: panelCount,
                    prompt_format: comicPromptFormat(),
                    workflow_context: buildAgentWorkflowContext(),
                }),
            });
            state.comic.plan = result;
            state.comic.currentIndex = 0;
            state.comic.historyId = "";
            saveComicHistory(true);
            setStatus("success", `AI 已完成《${result.title || "未命名漫画"}》的 ${result.panels?.length || panelCount} 格分镜设计。`);
        } catch (error) {
            state.comic.phase = "error";
            setStatus("error", error.message || "漫画分镜设计失败。");
        } finally {
            state.comic.planning = false;
            update();
        }
    }

    function update() {
        allNodes().forEach(localizeAssistantNode);
        autoMap();
        state.mapping.planner = refreshSelect(plannerSelect, nodesOf(NODE_TYPES.planner), state.mapping.planner, "画布中没有规划节点");
        state.mapping.reviewer = refreshSelect(reviewerSelect, nodesOf(NODE_TYPES.reviewer), state.mapping.reviewer, "画布中没有评审节点");
        const imageSources = candidatesFor("image");
        const selectedImage = mappingNode("image");
        if (selectedImage && imageOutputSlots(selectedImage).length && !imageSources.some((node) => String(node.id) === String(selectedImage.id))) imageSources.unshift(selectedImage);
        state.mapping.image = refreshSelect(reviewImageSelect, imageSources, state.mapping.image, "画布中没有 IMAGE 输出", true);
        syncLockedPlannerParametersFromWorkflow();
        plannerSelect.value = state.mapping.planner;
        reviewerSelect.value = state.mapping.reviewer;
        reviewImageSelect.value = state.mapping.image;
        syncFormatFromNode(plannerFormat, mappingNode("planner"));
        syncFormatFromNode(reviewerFormat, mappingNode("reviewer"));
        syncGenerationControls();
        workflowMapping.update();
        renderWorkflowStages();
        renderChatSessions();
        renderAgentBrief();
        renderChatMessages();
        updateAttachmentUI();
        renderReversePreview();
        renderReverseResult();
        if (document.activeElement !== comicIdea) comicIdea.value = state.comic.idea;
        if (document.activeElement !== comicCount) comicCount.value = String(state.comic.panelCount);
        if (document.activeElement !== reverseNotes) reverseNotes.value = state.reverse.notes;
        chatStripStyleToggle.checked = state.stripStyle;
        reverseStripStyleToggle.checked = state.stripStyle;
        reverseEngine.disabled = state.reverse.sending || state.reverse.phase === "loading";
        reversePromptFormat.disabled = state.reverse.sending || state.reverse.phase === "loading";
        reverseStripStyleToggle.disabled = state.reverse.sending || state.reverse.phase === "loading";
        reverseEngine.querySelector('option[value="wd_tagger"]').disabled = reversePromptFormat.value === "natural";
        if (reversePromptFormat.value === "natural" && reverseEngine.value === "wd_tagger") reverseEngine.value = "ai";
        comicFormat.value = comicPromptFormat();
        comicFormat.disabled = state.comic.planning || state.comic.running || state.comic.continuing;
        comicModeToggle.checked = state.comic.enabled;
        comicContinuationToggle.checked = state.comic.continueWithImage;
        comicContinuationToggle.disabled = state.comic.planning;
        comicContinuationWarning.textContent = state.comic.continuationWarning;
        comicContinuationWarning.hidden = !state.comic.continuationWarning;
        comicProgress.textContent = comicProgressText();
        renderComicPlan();
        renderComicGallery();
        renderComicHistory();
        chat.classList.toggle("is-active", state.view === "main" && state.tab === "chat");
        reverse.classList.toggle("is-active", state.view === "main" && state.tab === "reverse");
        comic.classList.toggle("is-active", state.view === "main" && state.tab === "comic" && state.comic.enabled);
        planner.classList.toggle("is-active", state.view === "main" && state.tab === "planner");
        reviewer.classList.toggle("is-active", state.view === "main" && state.tab === "reviewer");
        settings.classList.toggle("is-active", state.view === "settings");
        tabs.classList.toggle("is-hidden", state.view === "settings");
        chatTab.classList.toggle("is-active", state.tab === "chat");
        reverseTab.classList.toggle("is-active", state.tab === "reverse");
        comicTab.classList.toggle("is-active", state.tab === "comic");
        plannerTab.classList.toggle("is-active", state.tab === "planner");
        reviewerTab.classList.toggle("is-active", state.tab === "reviewer");
        chatTab.ariaSelected = String(state.tab === "chat");
        reverseTab.ariaSelected = String(state.tab === "reverse");
        comicTab.ariaSelected = String(state.tab === "comic");
        plannerTab.ariaSelected = String(state.tab === "planner");
        reviewerTab.ariaSelected = String(state.tab === "reviewer");
        const activeStage = state.view === "settings" ? "settings" : state.tab;
        root.dataset.stage = activeStage;
        chatInput.placeholder = focusModeById(state.focusMode).placeholder;
        focusInstrument.update({ stage: activeStage, working: state.status.kind === "working" || state.chat.sending || state.reverse.sending || state.reverse.phase === "loading" || state.comic.running || state.comic.planning || state.reviewLoop.running });
        root.classList.toggle("is-collapsed", !state.open);
        root.classList.toggle("is-chat-expanded", state.chatExpanded && state.view === "main" && state.tab === "chat");
        root.classList.toggle("is-reverse-expanded", state.chatExpanded && state.view === "main" && state.tab === "reverse");
        chatExpandButton.replaceChildren(icon(state.chatExpanded ? "shrink" : "expand"));
        chatExpandButton.title = state.chatExpanded ? "返回悬浮窗" : "进入完整聊天工作台";
        chatExpandButton.ariaLabel = state.chatExpanded ? "返回悬浮窗" : "进入完整聊天工作台";
        launcher.classList.toggle("is-visible", !state.open);
        reportHost.replaceChildren(makeReport(state.lastReview));
        statusHost.textContent = state.status.text;
        statusHost.dataset.kind = state.status.kind;
        settingsStatus.dataset.kind = state.settings.saving || state.settings.refreshing ? "working" : (settingsError.textContent ? "error" : "");
        refreshModelsButton.disabled = state.settings.refreshing || state.settings.saving;
        refreshLocalModelsButton.disabled = state.localGeneration.refreshing;
        saveSettingsButton.disabled = state.settings.saving || state.settings.refreshing;
        plannerAdd.disabled = Boolean(mappingNode("planner"));
        reviewerAdd.disabled = Boolean(mappingNode("reviewer"));
        chatSend.disabled = !state.chat.sending && !chatInput.value.trim() && !state.chat.attachment;
        chatSend.textContent = state.chat.sending ? "终止生成" : "发送给 AI";
        chatSend.title = state.chat.sending ? "终止本次 AI 生成" : "发送消息给 AI";
        chatSend.ariaLabel = state.chat.sending ? "终止本次 AI 生成" : "发送消息给 AI";
        chatSend.classList.toggle("aipa-cancel", state.chat.sending);
        chatInput.disabled = state.chat.sending;
        chatInput.ariaBusy = String(state.chat.sending);
        chatWritePlan.disabled = state.chat.sending || !state.chat.lastPlan?.ready;
        chatGenerate.disabled = state.chat.sending || !state.chat.lastPlan?.ready;
        comicTab.hidden = !state.comic.enabled;
        comicPlanButton.disabled = state.comic.planning || state.comic.running || state.comic.continuing;
        comicPlanButton.textContent = state.comic.planning ? "AI 正在设计分镜" : "让 AI 设计分镜";
        comicRunButton.disabled = state.comic.planning || state.comic.continuing || (!state.comic.running && !state.comic.plan);
        comicRunButton.textContent = state.comic.continuing ? "AI 正在看图续写" : (state.comic.running ? "暂停后续生成" : (state.comic.phase === "paused" ? "继续逐张生成" : "开始逐张生成"));
        comicRunButton.classList.toggle("aipa-primary", state.comic.running || state.comic.phase === "paused");
        comicRunButton.classList.toggle("aipa-secondary", !(state.comic.running || state.comic.phase === "paused"));
        const connection = reviewConnectionState();
        reviewConnection.textContent = connection.text;
        reviewConnection.dataset.kind = connection.kind;
        renderReviewLoop();
        const reviewLoopBusy = state.reviewLoop.running || state.reviewLoop.finishing;
        reviewLoopMode.disabled = reviewLoopBusy;
        reviewLoopMaxRounds.disabled = reviewLoopBusy;
        reviewLoopThreshold.disabled = reviewLoopBusy;
        reviewLoopApplyToggle.disabled = reviewLoopBusy;
        reviewLoopGenerateToggle.disabled = reviewLoopBusy;
        reviewerApply.disabled = reviewLoopBusy;
        reviewLoopStart.disabled = state.reviewLoop.running;
        reviewLoopStart.textContent = state.reviewLoop.paused ? "继续自动评审" : (state.reviewLoop.running ? "自动评审进行中" : "开始自动评审");
        reviewLoopPause.disabled = !state.reviewLoop.running;
        reviewLoopStop.disabled = !state.reviewLoop.running && !state.reviewLoop.paused;
    }

    function renderWorkflowStages() {
        const reviewConnection = reviewConnectionState();
        const stages = [
            { label: "提示词规划", ready: Boolean(mappingNode("planner")), pending: "待添加" },
            { label: "成图来源", ready: Boolean(mappingNode("image")), pending: "待选择" },
            { label: "图片评审", ready: reviewConnection.kind === "connected", pending: reviewConnection.kind === "ready" ? "待连接" : "待添加" },
        ];
        workflowStages.replaceChildren();
        for (const stage of stages) {
            const row = el("div", { className: `aipa-workflow-stage ${stage.ready ? "is-ready" : "is-pending"}` });
            row.append(el("span", { className: "aipa-workflow-stage-name", textContent: stage.label }), el("span", { className: "aipa-workflow-stage-state", textContent: stage.ready ? "已就绪" : stage.pending }));
            workflowStages.append(row);
        }
    }
    plannerSelect.onchange = () => {
        state.mapping.planner = plannerSelect.value;
        state.manualRoles.add("planner");
        persistManualMapping();
        syncFormatFromNode(plannerFormat, mappingNode("planner"));
        update();
    };
    reviewerSelect.onchange = () => {
        state.mapping.reviewer = reviewerSelect.value;
        state.manualRoles.add("reviewer");
        persistManualMapping();
        syncFormatFromNode(reviewerFormat, mappingNode("reviewer"));
        update();
    };
    function savePromptFormat(role, select, nodeName) {
        const node = mappingNode(role);
        const value = PROMPT_FORMATS.some((format) => format.value === select.value) ? select.value : "tag";
        select.value = value;
        if (!node) {
            setStatus("error", `请先添加或选择${nodeName}，再保存提示词格式。`);
            update();
            return;
        }
        const changed = widgetValue(node, "prompt_format") !== value;
        setWidget(node, "prompt_format", value);
        state.generation.signature = "";
        if (changed) setStatus("success", `${nodeName}提示词格式已保存为${promptFormatLabel(value)}。`);
        update();
    }
    plannerFormat.onchange = () => savePromptFormat("planner", plannerFormat, "提示词规划节点");
    reviewerFormat.onchange = () => savePromptFormat("reviewer", reviewerFormat, "图片评审节点");
    plannerAdd.onclick = () => {
        try {
            const node = addAssistantNode("planner");
            setWidget(node, "prompt_format", plannerFormat.value);
            setStatus("success", `已添加提示词规划节点，提示词格式为${promptFormatLabel(plannerFormat.value)}。`);
        } catch (error) {
            setStatus("error", error.message || "添加提示词规划节点失败。");
        }
        update();
    };
    reviewerAdd.onclick = () => {
        try {
            const node = addAssistantNode("reviewer");
            setWidget(node, "prompt_format", reviewerFormat.value);
            setStatus("success", `已添加图片评审节点，输出格式为${promptFormatLabel(reviewerFormat.value)}。`);
        } catch (error) {
            setStatus("error", error.message || "添加图片评审节点失败。");
        }
        update();
    };
    reviewImageSelect.onchange = () => {
        state.mapping.image = reviewImageSelect.value;
        state.manualRoles.add("image");
        persistManualMapping();
        update();
    };
    chatTab.onclick = () => {
        state.view = "main";
        state.tab = "chat";
        state.chatExpanded = true;
        body.scrollTop = 0;
        chat.scrollTop = 0;
        update();
        window.requestAnimationFrame(() => {
            body.scrollTop = 0;
            chat.scrollTop = 0;
        });
    };
    reverseTab.onclick = () => {
        state.view = "main";
        state.tab = "reverse";
        state.chatExpanded = true;
        body.scrollTop = 0;
        update();
    };
    comicTab.onclick = () => {
        if (!state.comic.enabled) return;
        state.tab = "comic";
        update();
    };
    plannerTab.onclick = () => { state.tab = "planner"; update(); };
    reviewerTab.onclick = () => { state.tab = "reviewer"; update(); };
    settingsButton.onclick = () => { state.view = "settings"; settingsError.textContent = ""; update(); loadSettings(); };
    settingsHeading.querySelector(".aipa-back-button").onclick = () => { state.view = "main"; update(); };
    newChatButton.onclick = () => {
        if (state.chat.sending) cancelChat();
        const session = newChatSession();
        state.chatSessions.unshift(session);
        state.activeChatId = session.id;
        state.chat = session;
        state.tab = "chat";
        state.chatExpanded = true;
        setStatus("success", "已开始新对话。每个对话都有独立记忆。" );
        persistChatSession(session);
        update();
    };
    chatExpandButton.onclick = () => {
        state.chatExpanded = !state.chatExpanded;
        state.view = "main";
        if (state.tab !== "reverse") state.tab = "chat";
        setStatus("success", state.chatExpanded ? "已进入完整聊天工作台。" : "已返回悬浮窗。" );
        update();
    };
    minimize.onclick = () => { state.open = false; update(); };
    launcher.onclick = () => { state.open = true; update(); };
    plannerLocate.onclick = () => selectCanvasNode(mappingNode("planner"));
    reviewerLocate.onclick = () => selectCanvasNode(mappingNode("reviewer"));
    plannerApply.onclick = () => {
        const promptFormat = nodePromptFormat(mappingNode("planner"), plannerFormat.value);
        plannerFormat.value = promptFormat;
        submitPlanner(`${promptFormatLabel(promptFormat)}规划`);
        update();
    };
    comicModeToggle.onchange = () => {
        state.comic.enabled = comicModeToggle.checked;
        persistComicMode(state.comic.enabled);
        if (state.comic.enabled) {
            state.view = "main";
            state.tab = "comic";
            setStatus("success", "已开启漫画模式。输入一句想法后，AI 会设计连续分镜。" );
        } else {
            if (state.comic.running) {
                state.comic.running = false;
                state.comic.phase = "paused";
                restoreComicNodeModes();
            }
            state.tab = "chat";
            setStatus("success", "已关闭漫画模式。现有分镜会保留到本次页面会话结束。" );
        }
        update();
    };
    comicContinuationToggle.onchange = () => {
        state.comic.continueWithImage = comicContinuationToggle.checked;
        persistComicContinuation(state.comic.continueWithImage);
        if (!state.comic.continueWithImage && state.comic.continuationAbortController) {
            state.comic.continuationAbortController.abort();
            setStatus("working", "已关闭 AI 看图续写，正在直接提交下一格。" );
            update();
            return;
        }
        setStatus("success", state.comic.continueWithImage ? "已开启 AI 看图续写。每格完成后会发送成图来优化下一格提示词。" : "已关闭 AI 看图续写。后续将只使用原分镜提示词。" );
        update();
    };
    comicFormat.onchange = () => {
        const value = COMIC_PROMPT_FORMATS.some((format) => format.value === comicFormat.value) ? comicFormat.value : "tag";
        if (value === state.comic.promptFormat) return;
        state.comic.promptFormat = value;
        persistComicPromptFormat(value);
        if (state.comic.plan) {
            state.comic.plan = null;
            state.comic.currentIndex = 0;
            state.comic.collectedImages = [];
            state.comic.continuationWarning = "";
            setStatus("success", `漫画提示词格式已切换为${promptFormatLabel(value)}，请重新让 AI 设计分镜。`);
        } else {
            setStatus("success", `漫画提示词格式已保存为${promptFormatLabel(value)}。`);
        }
        update();
    };
    comicPlanButton.onclick = () => { createComicPlan(); };
    comicRunButton.onclick = () => {
        if (state.comic.running) {
            state.comic.running = false;
            state.comic.awaitingStart = false;
            state.comic.phase = "paused";
            restoreComicNodeModes();
            setStatus("success", "已暂停后续生成；当前已经提交的一张不会被中断。" );
            update();
            return;
        }
        if (!state.comic.plan) return;
        state.comic.running = true;
        queueComicPanel();
    };

    function cancelReversePrompt() {
        if (!state.reverse.sending) return;
        state.reverse.abortController?.abort();
        state.reverse.abortController = null;
        state.reverse.activeRequestId = 0;
        state.reverse.sending = false;
        state.reverse.phase = state.reverse.image ? "ready" : "idle";
        setStatus("success", "已停止图片反推。你可以修改补充要求后再次运行。 ");
        update();
    }

    async function runReversePrompt() {
        if (state.reverse.sending) {
            cancelReversePrompt();
            return;
        }
        if (!state.reverse.image) {
            state.reverse.phase = "error";
            state.reverse.error = "请先选择或粘贴一张图片。";
            setStatus("error", state.reverse.error);
            update();
            reverseDropzone.focus();
            return;
        }
        const requestId = ++state.reverse.nextRequestId;
        const abortController = new AbortController();
        state.reverse.sending = true;
        state.reverse.activeRequestId = requestId;
        state.reverse.abortController = abortController;
        state.reverse.phase = "working";
        state.reverse.error = "";
        state.reverse.result = null;
        setStatus("working", "图片反推开始：视觉模型正在读取画面…");
        update();
        try {
            const response = await aipaRequest("/aipa/reverse-prompt", {
                method: "POST",
                body: JSON.stringify({
                    image_data_url: state.reverse.image.dataUrl,
                    notes: state.reverse.notes.trim(),
                    engine: reverseEngine.value,
                    prompt_format: reversePromptFormat.value,
                    strip_style: state.stripStyle,
                }),
                signal: abortController.signal,
            });
            if (state.reverse.activeRequestId !== requestId) return;
            const result = normalizeReversePromptResult(response);
            if (!result.prompt) throw new Error("AI 没有返回可用的正向提示词，请确认当前模型支持图片输入后重试。");
            state.reverse.result = result;
            state.reverse.phase = "complete";
            setStatus("success", "图片反推完成。正向提示词已经整理成可直接复制的版本。 ");
        } catch (error) {
            if (state.reverse.activeRequestId !== requestId) return;
            if (error?.name === "AbortError") {
                state.reverse.phase = state.reverse.image ? "ready" : "idle";
                setStatus("success", "已停止图片反推。你可以修改补充要求后再次运行。 ");
            } else {
                state.reverse.phase = "error";
                state.reverse.error = error.message || "图片反推失败，请检查 API 设置后重试。";
                setStatus("error", state.reverse.error);
            }
        } finally {
            if (state.reverse.activeRequestId !== requestId) return;
            state.reverse.sending = false;
            state.reverse.abortController = null;
            state.reverse.activeRequestId = 0;
            update();
        }
    }

    function cancelChat() {
        if (!state.chat.sending) return;
        state.chat.abortController?.abort();
        state.chat.abortController = null;
        state.chat.activeRequestId = 0;
        state.chat.sending = false;
        setStatus("success", "已终止本次 AI 生成。你可以继续输入新的要求。" );
        persistChatSession(state.chat);
        update();
    }

    async function sendChat(options = {}) {
        const message = chatInput.value.trim();
        const attachment = state.chat.attachment;
        if ((!message && !attachment) || state.chat.sending) return;
        const history = state.chat.messages
            .filter((item) => item.role === "user" || item.role === "assistant")
            .slice(-16)
            .map((item) => ({ role: item.role, content: item.content }));
        state.chat.messages.push({ role: "user", content: message || "请分析这张参考图。", attachmentName: attachment?.name || "" });
        if (state.chat.messages.filter((item) => item.role === "user").length === 1) {
            state.chat.title = (message || "图片反推").slice(0, 28);
        }
        state.chat.updatedAt = Date.now();
        const requestId = ++state.chat.nextRequestId;
        const abortController = new AbortController();
        state.chat.sending = true;
        state.chat.activeRequestId = requestId;
        state.chat.abortController = abortController;
        chatInput.value = "";
        setStatus("working", "创作 Agent 正在思考…");
        persistChatSession(state.chat);
        update();
        try {
            const result = await aipaRequest("/aipa/chat", {
                method: "POST",
                body: JSON.stringify({
                    message,
                    history,
                    session_memory: state.chat.memory,
                    workflow_context: buildAgentWorkflowContext(),
                    image_data_url: attachment?.dataUrl || "",
                    reverse_prompt: options.reversePrompt === true,
                    strip_style: state.stripStyle,
                }),
                signal: abortController.signal,
            });
            if (state.chat.activeRequestId !== requestId) return;
            const plan = normalizeChatPlan(result);
            state.chat.memory = String(result.session_memory || state.chat.memory || "").slice(0, 1600);
            if (plan.creativeBrief) state.chat.lastPlan = plan;
            if (state.chat.messages.filter((item) => item.role === "user").length === 1 && plan.creativeTitle) {
                state.chat.title = plan.creativeTitle;
            }
            state.chat.messages.push({ role: "assistant", content: plan.reply, plan });
            state.chat.updatedAt = Date.now();
            setStatus(
                "success",
                plan.ready
                    ? "方案已准备好。可在“当前创作简报”中写入创作需求，或直接交给工作流生成。"
                    : (plan.questions.length ? "Agent 已整理当前方向，并在创作简报中标出下一步需要确认的内容。" : "Agent 已记录当前对话，可以继续补充创作要求。"),
            );
        } catch (error) {
            if (state.chat.activeRequestId !== requestId) return;
            if (error?.name === "AbortError") {
                setStatus("success", "已终止本次 AI 生成。你可以继续输入新的要求。" );
                return;
            }
            setStatus("error", error.message || "AI 对话失败，请检查 API 设置后重试。" );
        } finally {
            if (state.chat.activeRequestId !== requestId) return;
            state.chat.sending = false;
            state.chat.abortController = null;
            state.chat.activeRequestId = 0;
            state.chat.attachment = null;
            chatInput.placeholder = "例如：我没有想法，帮我设计一张有故事感的二次元壁纸";
            persistChatSession(state.chat);
            update();
        }
    }

    chatSend.onclick = () => { if (state.chat.sending) cancelChat(); else void sendChat(); };
    chatInput.oninput = () => update();
    chatStripStyleToggle.onchange = () => {
        state.stripStyle = chatStripStyleToggle.checked;
        persistStripStyle(state.stripStyle);
        reverseStripStyleToggle.checked = state.stripStyle;
        setStatus("success", state.stripStyle ? "已开启去除画风词，LoRA 将负责画风。" : "已关闭去除画风词，Agent 会保留可见或要求中的画风描述。");
        update();
    };
    chatAttachmentButton.onclick = () => chatAttachment.click();
    chatAttachment.onchange = () => { void readAttachment(chatAttachment.files?.[0]); chatAttachment.value = ""; };
    chatReversePrompt.onclick = () => {
        if (state.chat.sending) return;
        const attachment = state.chat.attachment;
        if (attachment) {
            state.reverse.image = attachment;
            state.reverse.result = null;
            state.reverse.phase = "ready";
            state.reverse.error = "";
        }
        state.view = "main";
        state.tab = "reverse";
        state.chatExpanded = true;
        body.scrollTop = 0;
        setStatus("success", attachment ? "已把聊天中的参考图带入图片反推页。" : "已打开图片反推页，请选择或粘贴一张图片。 ");
        update();
    };
    reverseDropzone.onclick = () => reverseImageInput.click();
    reverseImageInput.onchange = () => { void readReverseImage(reverseImageInput.files?.[0]); reverseImageInput.value = ""; };
    reverseDropzone.ondragover = (event) => {
        event.preventDefault();
        if (!state.reverse.sending) {
            reverseDropzone.classList.add("is-dragging");
            event.dataTransfer.dropEffect = "copy";
        }
    };
    reverseDropzone.ondragleave = () => reverseDropzone.classList.remove("is-dragging");
    reverseDropzone.ondrop = (event) => {
        event.preventDefault();
        reverseDropzone.classList.remove("is-dragging");
        const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith("image/"));
        if (file) void readReverseImage(file);
        else {
            state.reverse.phase = "error";
            state.reverse.error = "拖入的文件不是可识别的图片。";
            setStatus("error", state.reverse.error);
            update();
        }
    };
    reverseNotes.oninput = () => { state.reverse.notes = reverseNotes.value.slice(0, 2000); };
    reversePromptFormat.onchange = () => {
        if (reversePromptFormat.value === "natural") reverseEngine.value = "ai";
        setStatus("success", reversePromptFormat.value === "natural" ? "图片反推将输出英文自然语言描述。" : "图片反推将输出英文标签提示词。");
        update();
    };
    reverseEngine.onchange = () => {
        setStatus("success", reverseEngine.value === "wd_tagger" ? "将使用本地 WD-EVA02 标签器，不调用远程 AI。" : "将使用已配置的 AI 视觉模型进行反推。");
        update();
    };
    reverseStripStyleToggle.onchange = () => {
        state.stripStyle = reverseStripStyleToggle.checked;
        persistStripStyle(state.stripStyle);
        chatStripStyleToggle.checked = state.stripStyle;
        setStatus("success", state.stripStyle ? "已开启去除画风词，LoRA 将负责画风。" : "已关闭去除画风词，反推会保留画风描述。");
        update();
    };
    reverseClearButton.onclick = () => {
        if (state.reverse.sending) return;
        state.reverse.image = null;
        state.reverse.result = null;
        state.reverse.phase = "idle";
        state.reverse.error = "";
        setStatus("success", "已清除图片，可以放入下一张参考图。 ");
        update();
        reverseDropzone.focus();
    };
    reverseRunButton.onclick = () => { void runReversePrompt(); };
    document.addEventListener("paste", (event) => {
        if (state.view !== "main" || state.tab !== "reverse" || state.reverse.sending) return;
        const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
        const file = item?.getAsFile();
        if (!file) return;
        event.preventDefault();
        void readReverseImage(file);
    });
    chatInput.onkeydown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void sendChat();
        }
    };
    chatWritePlan.onclick = () => {
        if (applyChatPlan(state.chat.lastPlan)) update();
    };
    chatGenerate.onclick = () => {
        if (!applyChatPlan(state.chat.lastPlan)) return;
        submitPlanner("AI 对话方案", false);
        update();
    };
    reviewerApply.onclick = () => {
        const node = mappingNode("reviewer");
        if (!node) {
            setStatus("error", "未找到图片评审节点，请先添加或重新选择节点。");
            update();
            return;
        }
        setWidget(node, "enable_review", enable.checked);
        if (!enable.checked) {
            state.pendingReviewerApply = false;
            setStatus("success", "图片评审已关闭：未连接图片，也没有提交任务。");
            update();
            return;
        }
        const imageSource = mappingNode("image");
        if (!imageSource) {
            setStatus("error", "未找到可连接的成图来源，请先选择带 IMAGE 输出的节点。");
            update();
            reviewImageSelect.focus();
            return;
        }
        let connection;
        try {
            connection = connectReviewImage(imageSource, node);
        } catch (error) {
            setStatus("error", error.message || "图片连线失败，请手动检查节点。");
            update();
            return;
        }
        setWidget(node, "revision_request", request.value);
        setWidget(node, "prompt_format", reviewerFormat.value);
        writeGenerationControlsToWorkflow();
        const synced = syncReviewerInputsFromWorkflow(node);
        if (!widgetValue(node, "current_positive_prompt")?.trim()) {
            setStatus("error", "未识别正向提示词。请在工作流节点映射中选择 CLIP Text Encode 正向节点后重试。");
            update();
            return;
        }
        selectCanvasNode(node);
        state.pendingReviewerApply = true;
        const connectionText = connection.reused ? "已使用现有成图连线。" : (connection.replaced ? "已替换成图连线。" : "已连接成图来源。");
        setStatus("working", enable.checked ? `${connectionText} 已同步 ${synced} 项工作流设置，图片评审已提交。` : `${connectionText} 已同步 ${synced} 项工作流设置，图片评审保持关闭。`);
        update();
        queue();
    };
    reviewLoopMode.onchange = () => {
        syncReviewLoopPreferences();
        setStatus("success", reviewLoopMode.value === "satisfied" ? "自动评审将持续到 AI 判定满意，最多执行设定轮数。" : "自动评审将严格执行设定轮数。" );
        update();
    };
    reviewLoopMaxRounds.oninput = () => { syncReviewLoopPreferences(); update(); };
    reviewLoopMaxRounds.onchange = () => { syncReviewLoopPreferences(); update(); };
    reviewLoopThreshold.oninput = () => { syncReviewLoopPreferences(); update(); };
    reviewLoopApplyToggle.onchange = () => { syncReviewLoopPreferences(); update(); };
    reviewLoopGenerateToggle.onchange = () => { syncReviewLoopPreferences(); update(); };
    reviewLoopStart.onclick = () => { startReviewLoop(); };
    reviewLoopPause.onclick = () => { pauseReviewLoop(); };
    reviewLoopStop.onclick = () => {
        if (state.reviewLoop.running || state.reviewLoop.paused) stopReviewLoop("自动评审已停止，当前轮次结果已保留。" );
    };

    function setSettingsError(message = "") {
        settingsError.textContent = message;
        settingsError.hidden = !message;
    }

    function renderModels(selected = modelInput.value) {
        const models = [...new Set([...(state.settings.models || []), selected].filter(Boolean))];
        modelInput.replaceChildren();
        if (!models.length) modelInput.append(el("option", { value: "", textContent: "请先刷新模型列表" }));
        for (const model of models) modelInput.append(el("option", { value: model, textContent: model }));
        modelInput.value = selected || models[0] || "";
    }

    async function loadLocalGenerationOptions(showStatus = false) {
        state.localGeneration.refreshing = true;
        if (showStatus) localModelsStatus.textContent = "正在读取 checkpoints 和 UNet 模型…";
        update();
        try {
            const options = await aipaRequest("/aipa/local-generation-options");
            state.localGeneration.models = Array.isArray(options.models) ? options.models : [];
            state.localGeneration.samplers = Array.isArray(options.samplers) ? options.samplers : [];
            state.localGeneration.schedulers = Array.isArray(options.schedulers) ? options.schedulers : [];
            applyLocalGenerationOptions();
            if (showStatus) localModelsStatus.textContent = `已载入 ${state.localGeneration.models.length} 个本机出图模型、${state.localGeneration.samplers.length} 个采样器和 ${state.localGeneration.schedulers.length} 个调度器。`;
        } catch (error) {
            if (showStatus) localModelsStatus.textContent = "读取本机模型失败，请重启 ComfyUI 后重试。";
        } finally {
            state.localGeneration.refreshing = false;
            update();
        }
    }

    async function loadSettings() {
        state.settings.loading = true;
        setSettingsError("");
        update();
        try {
            const config = await aipaRequest("/aipa/settings");
            apiUrlInput.value = config.api_url || "";
            timeoutInput.value = config.timeout_seconds ?? 90;
            appendChatCompletionsInput.checked = config.append_chat_completions !== false;
            parameterTuningInput.checked = config.allow_parameter_tuning !== false;
            state.settings.allowParameterTuning = parameterTuningInput.checked;
            useSystemProxyInput.checked = config.use_system_proxy === true;
            jsonModeInput.checked = config.use_json_mode !== false;
            reasoningEffortInput.value = ["off", "low", "medium", "high"].includes(config.reasoning_effort) ? config.reasoning_effort : "off";
            wdTaggerPathInput.value = config.wd_tagger_path || "";
            wdTaggerStatus.textContent = config.wd_tagger_message || "尚未配置 WD-EVA02 模型路径。";
            wdTaggerStatus.dataset.kind = config.wd_tagger_available ? "success" : "";
            state.settings.apiKeySet = Boolean(config.api_key_set);
            apiKeyInput.value = "";
            apiKeyInput.placeholder = config.api_key_masked ? `已配置 ${config.api_key_masked}，留空则保留` : "输入 API Key";
            renderModels(config.model || "");
            settingsStatus.textContent = config.api_key_set ? "已读取本地配置。" : "尚未配置 API Key。";
        } catch (error) {
            setSettingsError(error.message || "读取配置失败。");
            settingsStatus.textContent = "";
        } finally {
            state.settings.loading = false;
            update();
        }
    }

    refreshModelsButton.onclick = async () => {
        const apiUrl = apiUrlInput.value.trim();
        const apiKey = apiKeyInput.value.trim();
        if (!apiUrl) { setSettingsError("请先填写 API 地址。"); update(); apiUrlInput.focus(); return; }
        if (!apiKey && !state.settings.apiKeySet) { setSettingsError("请先填写 API Key。"); update(); apiKeyInput.focus(); return; }
        state.settings.refreshing = true;
        settingsStatus.textContent = "正在获取模型列表（最长 30 秒）…";
        setSettingsError("");
        update();
        try {
            const result = await aipaRequest("/aipa/models", {
                method: "POST",
                body: JSON.stringify({
                    api_url: apiUrl,
                    api_key: apiKey,
                    timeout_seconds: 30,
                    use_system_proxy: useSystemProxyInput.checked,
                }),
            });
            const models = Array.isArray(result.models) ? result.models.filter((model) => typeof model === "string" && model.trim()) : [];
            state.settings.models = [...new Set(models)];
            // A different API endpoint must not keep a stale model selected.
            // Keep the current value only when the refreshed endpoint actually
            // returned it; otherwise select the first model it returned.
            const currentModel = modelInput.value.trim();
            renderModels(state.settings.models.includes(currentModel) ? currentModel : (state.settings.models[0] || ""));
            settingsStatus.textContent = state.settings.models.length ? `已获取 ${state.settings.models.length} 个模型。` : "接口返回的模型列表为空。";
        } catch (error) {
            setSettingsError(error.message || "获取模型列表失败。");
            settingsStatus.textContent = "";
        } finally {
            state.settings.refreshing = false;
            update();
        }
    };

    const markModelsStale = () => {
        if (state.settings.refreshing) return;
        // Do not display a model from the previous provider as if it belonged
        // to the newly typed endpoint.
        state.settings.models = [];
        renderModels("");
        setSettingsError("");
        settingsStatus.textContent = "地址或 API Key 已修改，旧模型已清除；请刷新模型列表。";
        update();
    };
    apiUrlInput.addEventListener("input", markModelsStale);
    apiKeyInput.addEventListener("input", markModelsStale);

    refreshLocalModelsButton.onclick = () => { void loadLocalGenerationOptions(true); };
    refreshGenerationButton.onclick = () => { syncGenerationControls(true); setStatus("success", "已从当前工作流读取出图参数。"); update(); };
    applyGenerationButton.onclick = () => { const applied = writeGenerationControlsToWorkflow(); state.generation.signature = ""; setStatus("success", `已写入 ${applied} 项出图设置到工作流。`); update(); };

    saveSettingsButton.onclick = async () => {
        const apiUrl = apiUrlInput.value.trim();
        const model = modelInput.value.trim();
        if (!apiUrl) { setSettingsError("请先填写 API 地址。"); update(); apiUrlInput.focus(); return; }
        if (!model) { setSettingsError("请先刷新模型列表，或直接输入模型名称。"); update(); modelInput.focus(); return; }
        state.settings.saving = true;
        settingsStatus.textContent = "正在保存配置…";
        setSettingsError("");
        update();
        try {
            const config = await aipaRequest("/aipa/settings", { method: "POST", body: JSON.stringify({ api_url: apiUrl, api_key: apiKeyInput.value.trim(), model, timeout_seconds: timeoutInput.value, append_chat_completions: appendChatCompletionsInput.checked, allow_parameter_tuning: parameterTuningInput.checked, use_system_proxy: useSystemProxyInput.checked, use_json_mode: jsonModeInput.checked, reasoning_effort: reasoningEffortInput.value, wd_tagger_path: wdTaggerPathInput.value.trim() }) });
            state.settings.apiKeySet = Boolean(config.api_key_set);
            state.settings.allowParameterTuning = config.allow_parameter_tuning !== false;
            apiKeyInput.value = "";
            apiKeyInput.placeholder = config.api_key_masked ? `已配置 ${config.api_key_masked}，留空则保留` : "输入 API Key";
            settingsStatus.textContent = `配置已保存到${config.config_storage || "ComfyUI 用户配置目录"}，后续 AI 节点会立即使用新设置。`;
            wdTaggerStatus.textContent = config.wd_tagger_message || "WD-EVA02 路径已保存。";
            wdTaggerStatus.dataset.kind = config.wd_tagger_available ? "success" : "";
        } catch (error) {
            setSettingsError(error.message || "保存配置失败。");
            settingsStatus.textContent = "";
        } finally {
            state.settings.saving = false;
            update();
        }
    };

    const savedPanelSize = restorePanelSize();
    function clampPanelSize(width, height) {
        return {
            width: Math.round(Math.min(Math.max(PANEL_MIN_WIDTH, width), Math.max(PANEL_MIN_WIDTH, window.innerWidth - 16))),
            height: Math.round(Math.min(Math.max(PANEL_MIN_HEIGHT, height), Math.max(PANEL_MIN_HEIGHT, window.innerHeight - 16))),
        };
    }

    function applyPanelSize(size) {
        const next = clampPanelSize(size.width, size.height);
        root.style.width = `${next.width}px`;
        root.style.height = `${next.height}px`;
        root.style.maxHeight = "none";
        return next;
    }

    function resetPanelSize() {
        root.style.removeProperty("width");
        root.style.removeProperty("height");
        root.style.removeProperty("max-height");
        try { window.localStorage.removeItem(PANEL_SIZE_STORAGE_KEY); } catch { /* no-op */ }
    }

    if (savedPanelSize) applyPanelSize(savedPanelSize);

    let drag;
    header.onpointerdown = (event) => {
        // Header actions remain clickable; only the empty title area starts a drag.
        if (headerActions.contains(event.target)) return;
        const rect = root.getBoundingClientRect();
        drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        header.setPointerCapture(event.pointerId);
    };
    header.onpointermove = (event) => {
        if (!drag) return;
        root.style.left = `${Math.max(8, event.clientX - drag.x)}px`;
        root.style.top = `${Math.max(8, event.clientY - drag.y)}px`;
        root.style.right = "auto";
        root.style.bottom = "auto";
    };
    header.onpointerup = () => { drag = null; };

    let resize;
    function startResize(event, direction) {
        event.preventDefault();
        event.stopPropagation();
        const rect = root.getBoundingClientRect();
        resize = {
            pointerId: event.pointerId,
            direction,
            startX: event.clientX,
            startY: event.clientY,
            width: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top,
        };
        root.classList.add("is-resizing");
        event.currentTarget.setPointerCapture(event.pointerId);
    }
    function resizePanel(event) {
        if (!resize || event.pointerId !== resize.pointerId) return;
        const deltaX = event.clientX - resize.startX;
        const deltaY = event.clientY - resize.startY;
        let width = resize.width;
        let height = resize.height;
        if (resize.direction.includes("e")) width += deltaX;
        if (resize.direction.includes("w")) width -= deltaX;
        if (resize.direction.includes("s")) height += deltaY;
        if (resize.direction.includes("n")) height -= deltaY;
        const size = applyPanelSize({ width, height });
        const left = resize.direction.includes("w") ? resize.left + resize.width - size.width : resize.left;
        const top = resize.direction.includes("n") ? resize.top + resize.height - size.height : resize.top;
        root.style.left = `${Math.max(8, Math.min(left, window.innerWidth - size.width - 8))}px`;
        root.style.top = `${Math.max(8, Math.min(top, window.innerHeight - size.height - 8))}px`;
        root.style.right = "auto";
        root.style.bottom = "auto";
    }
    function finishResize(event) {
        if (!resize || (event && event.pointerId !== resize.pointerId)) return;
        const rect = root.getBoundingClientRect();
        persistPanelSize(clampPanelSize(rect.width, rect.height));
        root.classList.remove("is-resizing");
        resize = null;
    }
    for (const border of resizeBorders) {
        border.onpointerdown = (event) => startResize(event, border.dataset.direction);
        border.onpointermove = resizePanel;
        border.onpointerup = finishResize;
        border.onpointercancel = finishResize;
    }
    resizeHandle.onpointerdown = (event) => startResize(event, "se");
    resizeHandle.onpointermove = resizePanel;
    resizeHandle.onpointerup = finishResize;
    resizeHandle.onpointercancel = finishResize;
    resizeHandle.onkeydown = (event) => {
        if (event.key === "Home") {
            event.preventDefault();
            resetPanelSize();
            setStatus("success", "已恢复悬浮窗默认大小。");
            update();
            return;
        }
        const step = event.shiftKey ? 48 : 16;
        const rect = root.getBoundingClientRect();
        let width = rect.width;
        let height = rect.height;
        if (event.key === "ArrowRight") width += step;
        else if (event.key === "ArrowLeft") width -= step;
        else if (event.key === "ArrowDown") height += step;
        else if (event.key === "ArrowUp") height -= step;
        else return;
        event.preventDefault();
        persistPanelSize(applyPanelSize({ width, height }));
    };
    window.addEventListener("resize", () => {
        if (root.style.width && root.style.height) {
            const rect = root.getBoundingClientRect();
            persistPanelSize(applyPanelSize({ width: rect.width, height: rect.height }));
        }
        update();
    });
    restoreManualMapping();
    syncFormatFromNode(plannerFormat, mappingNode("planner"));
    syncFormatFromNode(reviewerFormat, mappingNode("reviewer"));
    let lastWorkflowSignature = workflowSignature();
    const workflowWatcher = window.setInterval(() => {
        const signature = workflowSignature();
        if (signature === lastWorkflowSignature) return;
        lastWorkflowSignature = signature;
        update();
    }, 1000);
    window.addEventListener("beforeunload", () => window.clearInterval(workflowWatcher), { once: true });
    update();
    void loadSettings();
    void loadLocalGenerationOptions();
    return {
        update,
        reportHost,
        finishReviewLoopRound,
        watchReviewLoopHistory,
        stopReviewLoop,
        advanceComicAfterImage,
        completeComicExecution,
        queueComicPanel,
        watchComicPromptHistory,
        stopComic,
        setStatus: (kind, text) => { setStatus(kind, text); update(); },
    };
}

app.registerExtension({
    name: "ComfyUI.AIPromptAssistant",
    beforeRegisterNodeDef(nodeType, nodeData) {
        const labels = NODE_CANVAS_LABELS[nodeData?.name];
        if (!labels) return;
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = originalOnNodeCreated?.apply(this, args);
            localizeAssistantNode(this);
            return result;
        };
    },
    setup() {
        try {
            const ui = buildPanel();
            api.addEventListener("execution_start", ({ detail }) => {
                if (state.reviewLoop.awaitingStart && (state.reviewLoop.running || state.reviewLoop.paused)) {
                    const promptId = String(detail?.prompt_id ?? detail?.promptId ?? "");
                    if (promptId && (!state.reviewLoop.activePromptId || promptId === state.reviewLoop.activePromptId)) {
                        state.reviewLoop.activePromptId = promptId;
                        state.reviewLoop.awaitingStart = false;
                        ui.setStatus("working", `第 ${state.reviewLoop.currentRound} 轮正在生成图片，完成后会自动评审。`);
                        ui.update();
                        void ui.watchReviewLoopHistory(promptId, state.reviewLoop.submissionToken);
                    }
                }
                if (!state.comic.running || !state.comic.awaitingStart) return;
                const promptId = String(detail?.prompt_id ?? detail?.promptId ?? "");
                if (!promptId) return;
                if (state.comic.activePromptId && promptId !== state.comic.activePromptId) return;
                state.comic.activePromptId = promptId;
                state.comic.awaitingStart = false;
                void ui.watchComicPromptHistory(promptId, state.comic.submissionToken);
            });
            api.addEventListener("executed", ({ detail }) => {
                const comicPromptId = String(detail?.prompt_id ?? detail?.promptId ?? "");
                const currentComicPrompt = state.comic.activePromptId;
                // Never accept an image event without an exact prompt ID.
                // Preview/old websocket events otherwise make every comic
                // panel display the same previous image.
                const belongsToComic = Boolean(state.comic.running && currentComicPrompt && comicPromptId === currentComicPrompt);
                if (belongsToComic && Array.isArray(detail?.output?.images)) {
                    for (const image of detail.output.images) {
                        if (!image?.filename) continue;
                        const key = `${image.filename}|${image.subfolder || ""}|${image.type || "output"}`;
                        if (!state.comic.currentRunImages.some((item) => `${item.filename}|${item.subfolder || ""}|${item.type || "output"}` === key)) {
                            state.comic.currentRunImages.push(image);
                        }
                    }
                }
                const nodeId = String(detail?.node ?? detail?.node_id ?? "");
                if (comicPromptId && state.reviewLoop.handledPromptIds.has(comicPromptId)) return;
                const currentReviewPrompt = state.reviewLoop.activePromptId;
                const belongsToReview = Boolean((state.reviewLoop.running || state.reviewLoop.paused) && currentReviewPrompt && comicPromptId === currentReviewPrompt);
                const isReviewLoopReviewer = nodeId === String(state.mapping.reviewer);
                if (belongsToReview) {
                    if (Array.isArray(detail?.output?.images)) {
                        for (const image of detail.output.images) {
                            if (!image?.filename) continue;
                            const key = `${image.filename}|${image.subfolder || ""}|${image.type || "output"}`;
                            if (!state.reviewLoop.currentRunImages.some((item) => `${item.filename}|${item.subfolder || ""}|${item.type || "output"}` === key)) state.reviewLoop.currentRunImages.push(image);
                        }
                    }
                    if (isReviewLoopReviewer && detail?.output?.ai_review?.length) {
                        state.reviewLoop.handledPromptIds.add(currentReviewPrompt);
                        let report;
                        try {
                            report = JSON.parse(detail.output.ai_review[0]);
                        } catch {
                            report = { enabled: true, summary: String(detail.output.ai_review[0]) };
                        }
                        void ui.finishReviewLoopRound(report, detail.output, currentReviewPrompt);
                    }
                    return;
                }
                const isPlanner = nodeId === String(state.mapping.planner);
                const isReviewer = nodeId === String(state.mapping.reviewer);
                if ((isPlanner || isReviewer) && !state.comic.running) {
                    state.pendingPlannerApply = false;
                    state.pendingReviewerApply = false;
                    const applied = applyAiOutputToWorkflow(detail?.output);
                    const action = isPlanner ? "提示词规划" : "图片评审";
                    ui.setStatus(
                        "success",
                        applied
                            ? `${action}完成，正向提示词已实时写入工作流${applied > 1 ? `，另更新 ${applied - 1} 项出图设置。` : "。"}`
                            : `${action}完成，但未找到可写入的正向提示词节点。请在工作流节点映射中选择正向 CLIP Text Encode 节点。`,
                    );
                }
                if (!detail?.output?.ai_review?.length) return;
                try {
                    state.lastReview = JSON.parse(detail.output.ai_review[0]);
                } catch {
                    state.lastReview = { summary: String(detail.output.ai_review[0]) };
                }
                ui.update();
            });
            api.addEventListener("execution_success", ({ detail }) => {
                ui.completeComicExecution(detail);
            });
            // ComfyUI 0.30.x and several frontend builds signal the end of a
            // prompt as `executing` with a null node instead of emitting the
            // legacy `execution_success` event.
            api.addEventListener("executing", ({ detail }) => {
                const node = detail?.node ?? detail?.node_id;
                if (node === null || node === undefined || node === "") ui.completeComicExecution(detail);
            });
            api.addEventListener("execution_error", ({ detail }) => {
                const promptId = String(detail?.prompt_id ?? detail?.promptId ?? "");
                if ((state.reviewLoop.running || state.reviewLoop.paused) && state.reviewLoop.activePromptId && promptId === state.reviewLoop.activePromptId) {
                    const reviewMessage = detail?.exception_message || detail?.error || "自动评审工作流执行失败，请检查生成链路。";
                    ui.stopReviewLoop(`第 ${state.reviewLoop.currentRound} 轮失败：${reviewMessage}`, "error");
                    return;
                }
                if (state.comic.running && state.comic.activePromptId && promptId === state.comic.activePromptId) {
                    const comicMessage = detail?.exception_message || detail?.error || "漫画生成失败，请检查工作流后重试。";
                    ui.stopComic(`漫画第 ${state.comic.currentIndex + 1} 格失败：${comicMessage}`);
                    return;
                }
                const nodeId = String(detail?.node_id ?? detail?.node ?? "");
                if (![state.mapping.planner, state.mapping.reviewer].includes(nodeId)) return;
                const message = detail?.exception_message || detail?.error || "AI 调用失败，请检查接口配置后重试。";
                ui.setStatus("error", String(message));
            });
            api.addEventListener("graphChanged", ui.update);
        } catch (error) {
            console.error("[AI Prompt Assistant] setup failed", error?.stack || error);
        }
    },
});

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

function ensureStyles() {
    const id = "aipa-styles";
    if (document.getElementById(id)) return;
    const stylesheet = document.createElement("link");
    stylesheet.id = id;
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("./style.css", import.meta.url).href;
    document.head.append(stylesheet);
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
            negative_prompt: "固定反向提示词",
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
];

const CHAT_SESSION_STORAGE_KEY = "aipa.agent-session.v1";
const PANEL_SIZE_STORAGE_KEY = "aipa.panel-size.v1";
const PANEL_MIN_WIDTH = 320;
const PANEL_MIN_HEIGHT = 360;
const INITIAL_AGENT_MESSAGE = "我是你的创作 Agent。可以持续和我讨论灵感、角色、构图与修改方向；确定方案后，我会把它交给当前工作流。";

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
                plan: message?.plan && typeof message.plan === "object" ? message.plan : null,
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
                lastPlan: raw?.lastPlan && typeof raw.lastPlan === "object" ? raw.lastPlan : null,
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
    chatExpanded: false,
    view: "main",
    tab: "chat",
    mapping: {
        planner: "",
        reviewer: "",
        positive: "",
        negative: "",
        sampler: "",
        latent: "",
        image: "",
    },
    manualRoles: new Set(),
    mappingRestored: false,
    pendingPlannerApply: false,
    pendingReviewerApply: false,
    lastReview: null,
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
    chatSessions: INITIAL_CHAT_STATE.sessions,
    activeChatId: INITIAL_CHAT_STATE.activeId,
    chat: INITIAL_CHAT_STATE.sessions.find((session) => session.id === INITIAL_CHAT_STATE.activeId) || INITIAL_CHAT_STATE.sessions[0],
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
    item.value = value;
    item.callback?.(value);
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
    for (const role of ["positive", "negative", "sampler", "latent", "image"]) {
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
    app.queuePrompt?.(0);
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

function normalizedNodeOutput(output) {
    const result = output?.result;
    const tuple = Array.isArray(result?.[0]) ? result[0] : (Array.isArray(result) ? result : []);
    const aliases = [
        "positive_prompt", "negative_prompt", "sampler_name", "scheduler",
        "steps", "cfg", "width", "height", "denoise", "seed", "reasoning",
    ];
    const normalized = { ...(output || {}) };
    for (const [index, name] of aliases.entries()) {
        if (normalized[name] === undefined && tuple[index] !== undefined) normalized[name] = tuple[index];
    }
    return normalized;
}

function applyAiOutputToWorkflow(output) {
    output = normalizedNodeOutput(output);
    let applied = 0;
    const positive = outputValue(output, "positive_prompt");
    if (typeof positive === "string" && positive.trim() && setWidget(mappingNode("positive"), "text", positive)) applied += 1;
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

function syncFormatFromNode(select, node) {
    const value = widget(node, "prompt_format")?.value;
    if (PROMPT_FORMATS.some((format) => format.value === value)) select.value = value;
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
    if (scoreValue !== null) scoreRing.style.setProperty("--aipa-score-value", `${scoreValue}%`);
    scoreRing.append(el("strong", { textContent: scoreValue === null ? "--" : String(scoreValue) }), el("span", { textContent: "/ 100" }));
    const scoreCopy = el("div", { className: "aipa-score-copy" }, [
        el("strong", { textContent: scoreLabel(scoreValue) }),
        el("span", { textContent: scoreValue === null ? "模型没有返回评分" : "本次生成结果的综合评估" }),
    ]);
    scorePanel.append(scoreRing, scoreCopy);
    area.append(scorePanel, el("div", { className: "aipa-metrics" }, [
        el("span", { className: "aipa-metric", textContent: `置信度 ${confidence}` }),
        el("span", { className: "aipa-metric", textContent: formatLabel(report.prompt_format) }),
        el("span", { className: "aipa-metric aipa-action", textContent: actionLabel(report.action) }),
    ]), summary);
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

function normalizeChatPlan(result) {
    const promptFormat = PROMPT_FORMATS.some((item) => item.value === result?.prompt_format) ? result.prompt_format : "tag";
    const creativeBrief = String(result?.creative_brief || "").trim();
    return {
        reply: String(result?.reply || "已为你整理好一套创作方案。").trim(),
        creativeBrief,
        constraints: String(result?.style_or_constraints || "").trim(),
        promptFormat,
        ready: result?.ready_to_generate === true && Boolean(creativeBrief),
        nextAction: ["chat", "update_plan", "generate"].includes(result?.next_action) ? result.next_action : (creativeBrief ? "update_plan" : "chat"),
    };
}

function buildPanel() {
    const root = el("section", { className: "aipa-panel", ariaLabel: "AI Prompt Assistant" });
    const header = el("header", { className: "aipa-header" });
    const title = el("div", { className: "aipa-title" }, [el("span", { className: "aipa-mark", textContent: "AI" }), el("div", {}, [el("strong", { textContent: "Prompt Assistant" }), el("small", { textContent: "创作工作台" })])]);
    const newChatButton = el("button", { className: "aipa-icon-button aipa-new-chat-button", type: "button", textContent: "新对话", title: "开始新对话并清除本机保存的聊天记录", ariaLabel: "开始新对话" });
    const chatExpandButton = el("button", { className: "aipa-icon-button aipa-chat-expand-button", type: "button", textContent: "展开聊天", title: "进入完整聊天工作台", ariaLabel: "进入完整聊天工作台" });
    const settingsButton = el("button", { className: "aipa-icon-button aipa-settings-button", type: "button", textContent: "设置", title: "打开 API 设置", ariaLabel: "打开 API 设置" });
    const minimize = el("button", { className: "aipa-icon-button", type: "button", textContent: "−", title: "收起窗口", ariaLabel: "收起窗口" });
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
    const chatTab = el("button", { className: "aipa-tab", type: "button", textContent: "AI 对话", role: "tab", ariaLabel: "打开 AI 对话" });
    const plannerTab = el("button", { className: "aipa-tab", type: "button", textContent: "提示词规划", role: "tab" });
    const reviewerTab = el("button", { className: "aipa-tab", type: "button", textContent: "图片评审", role: "tab" });
    tabs.append(chatTab, plannerTab, reviewerTab);
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
    const chatAttachment = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", className: "aipa-image-input", ariaLabel: "上传参考图片" });
    const chatAttachmentButton = el("button", { className: "aipa-secondary aipa-attachment-button", type: "button", textContent: "上传图片", ariaLabel: "上传参考图片" });
    const chatReversePrompt = el("button", { className: "aipa-secondary aipa-reverse-button", type: "button", textContent: "反推提示词", ariaLabel: "根据上传图片反推提示词" });
    const chatAttachmentName = el("span", { className: "aipa-attachment-name", role: "status", ariaLive: "polite" });
    const chatSend = el("button", { className: "aipa-primary", type: "button", textContent: "发送给 AI", ariaLabel: "发送消息给 AI" });
    const chatWritePlan = el("button", { className: "aipa-secondary", type: "button", textContent: "写入创作需求", ariaLabel: "将 AI 方案写入创作需求" });
    const chatGenerate = el("button", { className: "aipa-primary", type: "button", textContent: "交给工作流生成", ariaLabel: "使用 AI 方案生成提示词并排队" });
    const inspirationPrompts = ["我没有想法，帮我设计一张有故事感的二次元壁纸", "给我一个适合手机壁纸的电影感场景"];
    for (const prompt of inspirationPrompts) {
        const suggestion = el("button", { className: "aipa-suggestion", type: "button", textContent: prompt, ariaLabel: `使用灵感：${prompt}` });
        suggestion.onclick = () => { chatInput.value = prompt; chatInput.focus(); update(); };
        chatSuggestions.append(suggestion);
    }
    const chatAttachmentBar = el("div", { className: "aipa-chat-attachment-bar" }, [chatAttachmentButton, chatReversePrompt, chatAttachmentName, chatAttachment]);
    const chatMain = el("div", { className: "aipa-chat-main" });
    chatMain.append(
        el("section", { className: "aipa-chat-intro" }, [el("strong", { textContent: "创作 Agent" }), el("p", { textContent: "持续讨论，确认方案后再交给工作流。" })]),
        chatMessages,
        chatSuggestions,
        label("你的想法", chatInput),
        chatAttachmentBar,
        el("div", { className: "aipa-actions aipa-chat-actions" }, [chatSend]),
        el("div", { className: "aipa-actions aipa-chat-plan-actions" }, [chatWritePlan, chatGenerate]),
    );
    chatWorkspace.append(chatSessions, chatMain);
    chat.append(chatWorkspace);

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

    const reviewer = el("div", { className: "aipa-view" });
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
    const reportHost = el("div");
    reviewer.append(label("评审节点", reviewerControl), label("成图来源", reviewImageSelect), reviewConnection, label("输出提示词格式", reviewerFormat), label("修改要求", request), enableRow, el("div", { className: "aipa-actions" }, [reviewerApply, reviewerLocate]), reportHost);

    const settings = el("div", { className: "aipa-view aipa-settings-view" });
    const settingsHeading = el("div", { className: "aipa-settings-heading" }, [
        el("div", {}, [el("strong", { textContent: "API 与模型" }), el("small", { textContent: "配置后供提示词规划和图片评审使用" })]),
        el("button", { className: "aipa-secondary aipa-back-button", type: "button", textContent: "返回", ariaLabel: "返回工作台" }),
    ]);
    const apiUrlInput = el("input", { type: "url", inputMode: "url", autocomplete: "url", placeholder: "https://api.openai.com/v1" });
    const apiKeyInput = el("input", { type: "password", autocomplete: "new-password", placeholder: "输入 API Key（已配置则留空）" });
    const modelInput = el("input", { type: "text", autocomplete: "off", placeholder: "输入模型名，或先刷新列表", ariaLabel: "输入或选择 AI 模型" });
    modelInput.setAttribute("list", "aipa-model-options");
    const modelOptions = el("datalist", { id: "aipa-model-options" });
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
    const settingsError = el("p", { className: "aipa-settings-error", role: "alert", ariaLive: "polite" });
    const settingsStatus = el("p", { className: "aipa-settings-status", role: "status", ariaLive: "polite" });
    const saveSettingsButton = el("button", { className: "aipa-primary", type: "button", textContent: "保存配置" });
    settings.append(settingsHeading, label("API 地址", apiUrlInput), appendChatCompletionsRow, label("API Key", apiKeyInput), label("模型", modelControl), modelOptions, label("本机出图模型", refreshLocalModelsButton), localModelsStatus, label("请求超时（秒）", timeoutInput), parameterTuningRow, useSystemProxyRow, jsonModeRow, settingsError, settingsStatus, el("div", { className: "aipa-actions" }, [saveSettingsButton]));

    const statusHost = el("p", { className: "aipa-operation-status", role: "status", ariaLive: "polite" });
    body.append(statusHost);

    body.append(chat, planner, reviewer, settings);
    root.append(header, tabs, body, ...resizeBorders, resizeHandle);
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
                    el("strong", { textContent: "已整理为可出图方案" }),
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
        chatReversePrompt.disabled = !attachment || state.chat.sending;
        chatAttachmentButton.disabled = state.chat.sending;
    }

    async function readAttachment(file) {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            setStatus("error", "请选择 PNG、JPG、WEBP 或 GIF 图片。" );
            update();
            return;
        }
        if (file.size > 8 * 1024 * 1024) {
            setStatus("error", "图片不能超过 8 MB。" );
            update();
            return;
        }
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        state.chat.attachment = { name: file.name, dataUrl };
        chatInput.placeholder = "可以补充要求，也可以直接点击“反推提示词”";
        setStatus("success", `已附加图片“${file.name}”，可发送给 AI 或反推提示词。`);
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
        ].join("\n");
    }

    function applyChatPlan(plan) {
        if (!plan?.ready) return false;
        brief.value = plan.creativeBrief;
        constraints.value = plan.constraints;
        plannerFormat.value = plan.promptFormat;
        let plannerNode = mappingNode("planner");
        try {
            if (!plannerNode) plannerNode = addAssistantNode("planner", false);
        } catch (error) {
            setStatus("error", error.message || "无法添加提示词规划节点。" );
            return false;
        }
        const synced = [
            setWidget(plannerNode, "creative_brief", plan.creativeBrief),
            setWidget(plannerNode, "style_or_constraints", plan.constraints),
            setWidget(plannerNode, "prompt_format", plan.promptFormat),
        ].filter(Boolean).length;
        state.generation.signature = "";
        setStatus("success", `AI 方案已写入创作需求和提示词规划节点（已同步 ${synced} 项）。`);
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
        setWidget(node, "creative_brief", brief.value);
        setWidget(node, "style_or_constraints", constraints.value);
        setWidget(node, "prompt_format", plannerFormat.value);
        if (focusNode) selectCanvasNode(node);
        state.pendingPlannerApply = true;
        setStatus("working", `已同步 ${configured} 项用户设置，${source}已提交。`);
        queue();
        return true;
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
        renderChatMessages();
        updateAttachmentUI();
        chat.classList.toggle("is-active", state.view === "main" && state.tab === "chat");
        planner.classList.toggle("is-active", state.view === "main" && state.tab === "planner");
        reviewer.classList.toggle("is-active", state.view === "main" && state.tab === "reviewer");
        settings.classList.toggle("is-active", state.view === "settings");
        tabs.classList.toggle("is-hidden", state.view === "settings");
        chatTab.classList.toggle("is-active", state.tab === "chat");
        plannerTab.classList.toggle("is-active", state.tab === "planner");
        reviewerTab.classList.toggle("is-active", state.tab === "reviewer");
        chatTab.ariaSelected = String(state.tab === "chat");
        plannerTab.ariaSelected = String(state.tab === "planner");
        reviewerTab.ariaSelected = String(state.tab === "reviewer");
        root.classList.toggle("is-collapsed", !state.open);
        root.classList.toggle("is-chat-expanded", state.chatExpanded && state.view === "main" && state.tab === "chat");
        chatExpandButton.textContent = state.chatExpanded ? "收起聊天" : "展开聊天";
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
        const connection = reviewConnectionState();
        reviewConnection.textContent = connection.text;
        reviewConnection.dataset.kind = connection.kind;
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
    };
    reviewerSelect.onchange = () => {
        state.mapping.reviewer = reviewerSelect.value;
        state.manualRoles.add("reviewer");
        persistManualMapping();
        syncFormatFromNode(reviewerFormat, mappingNode("reviewer"));
    };
    plannerAdd.onclick = () => {
        try {
            addAssistantNode("planner");
            setStatus("success", "已添加提示词规划节点。填写创作需求后即可生成提示词。");
        } catch (error) {
            setStatus("error", error.message || "添加提示词规划节点失败。");
        }
        update();
    };
    reviewerAdd.onclick = () => {
        try {
            addAssistantNode("reviewer");
            setStatus("success", "已添加图片评审节点。选择成图来源后即可连接评审。");
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
    chatTab.onclick = () => { state.tab = "chat"; update(); };
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
        state.tab = "chat";
        setStatus("success", state.chatExpanded ? "已进入完整聊天工作台。" : "已返回悬浮窗。" );
        update();
    };
    minimize.onclick = () => { state.open = false; update(); };
    launcher.onclick = () => { state.open = true; update(); };
    plannerLocate.onclick = () => selectCanvasNode(mappingNode("planner"));
    reviewerLocate.onclick = () => selectCanvasNode(mappingNode("reviewer"));
    plannerApply.onclick = () => { submitPlanner(`${PROMPT_FORMATS.find((item) => item.value === plannerFormat.value)?.label || "提示词"}规划`); update(); };

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
                }),
                signal: abortController.signal,
            });
            if (state.chat.activeRequestId !== requestId) return;
            const plan = normalizeChatPlan(result);
            state.chat.memory = String(result.session_memory || state.chat.memory || "").slice(0, 1600);
            state.chat.lastPlan = plan.ready ? plan : null;
            state.chat.messages.push({ role: "assistant", content: plan.reply, plan });
            state.chat.updatedAt = Date.now();
            setStatus("success", plan.ready ? "方案已准备好。可以写入创作需求，或交给工作流生成。" : "Agent 已记录当前对话，可以继续补充或回答它的问题。" );
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
    chatAttachmentButton.onclick = () => chatAttachment.click();
    chatAttachment.onchange = () => { void readAttachment(chatAttachment.files?.[0]); chatAttachment.value = ""; };
    chatReversePrompt.onclick = () => {
        if (!state.chat.attachment || state.chat.sending) return;
        if (!chatInput.value.trim()) chatInput.value = "请根据这张参考图反推适合生图的提示词，详细描述主体、构图、镜头、光线、色彩和风格。";
        void sendChat({ reversePrompt: true });
    };
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

    function setSettingsError(message = "") {
        settingsError.textContent = message;
        settingsError.hidden = !message;
    }

    function renderModels(selected = modelInput.value) {
        const models = [...new Set([...(state.settings.models || []), selected].filter(Boolean))];
        modelOptions.replaceChildren();
        for (const model of models) modelOptions.append(el("option", { value: model }));
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
        settingsStatus.textContent = "正在获取模型列表…";
        setSettingsError("");
        update();
        try {
            const result = await aipaRequest("/aipa/models", { method: "POST", body: JSON.stringify({ api_url: apiUrl, api_key: apiKey }) });
            state.settings.models = Array.isArray(result.models) ? result.models : [];
            renderModels(modelInput.value);
            settingsStatus.textContent = state.settings.models.length ? `已获取 ${state.settings.models.length} 个模型。` : "接口返回的模型列表为空。";
        } catch (error) {
            setSettingsError(error.message || "获取模型列表失败。");
            settingsStatus.textContent = "";
        } finally {
            state.settings.refreshing = false;
            update();
        }
    };

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
            const config = await aipaRequest("/aipa/settings", { method: "POST", body: JSON.stringify({ api_url: apiUrl, api_key: apiKeyInput.value.trim(), model, timeout_seconds: timeoutInput.value, append_chat_completions: appendChatCompletionsInput.checked, allow_parameter_tuning: parameterTuningInput.checked, use_system_proxy: useSystemProxyInput.checked, use_json_mode: jsonModeInput.checked }) });
            state.settings.apiKeySet = Boolean(config.api_key_set);
            state.settings.allowParameterTuning = config.allow_parameter_tuning !== false;
            apiKeyInput.value = "";
            apiKeyInput.placeholder = config.api_key_masked ? `已配置 ${config.api_key_masked}，留空则保留` : "输入 API Key";
            settingsStatus.textContent = `配置已保存到${config.config_storage || "ComfyUI 用户配置目录"}，后续 AI 节点会立即使用新设置。`;
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
    return { update, reportHost, setStatus: (kind, text) => { setStatus(kind, text); update(); } };
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
            api.addEventListener("executed", ({ detail }) => {
                const nodeId = String(detail?.node ?? detail?.node_id ?? "");
                const isPlanner = nodeId === String(state.mapping.planner);
                const isReviewer = nodeId === String(state.mapping.reviewer);
                if (isPlanner && state.pendingPlannerApply) {
                    state.pendingPlannerApply = false;
                    const applied = applyAiOutputToWorkflow(detail?.output);
                    ui.setStatus("success", applied ? `提示词规划完成，已写入 ${applied} 项工作流设置。` : "提示词规划完成，请在工作流映射中选择要写入的节点。");
                } else if (isReviewer && state.pendingReviewerApply) {
                    state.pendingReviewerApply = false;
                    const applied = applyAiOutputToWorkflow(detail?.output);
                    ui.setStatus("success", applied ? `图片评审完成，已写入 ${applied} 项工作流设置，可重新生成。` : "图片评审完成，请在工作流映射中选择要写入的节点。");
                } else if (isPlanner || isReviewer) {
                    ui.setStatus("success", "AI 调用完成，结果已写入节点输出。");
                }
                if (!detail?.output?.ai_review?.length) return;
                try {
                    state.lastReview = JSON.parse(detail.output.ai_review[0]);
                } catch {
                    state.lastReview = { summary: String(detail.output.ai_review[0]) };
                }
                ui.update();
            });
            api.addEventListener("execution_error", ({ detail }) => {
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

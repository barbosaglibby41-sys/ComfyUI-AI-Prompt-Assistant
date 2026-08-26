import base64
import io
import json
import os
from pathlib import Path

import numpy as np
import requests
from PIL import Image

try:
    from aiohttp import web
    from server import PromptServer
except ImportError:  # Allows lightweight module checks outside ComfyUI.
    web = None
    PromptServer = None

import comfy.samplers
import folder_paths
from nodes import common_ksampler


EXTENSION_DIR = Path(__file__).parent
CONFIG_FILE_NAME = "config.json"
DEFAULT_PARAMETERS = {
    "sampler_name": "euler",
    "scheduler": "normal",
    "steps": 28,
    "cfg": 5.0,
    "width": 1024,
    "height": 1024,
    "denoise": 1.0,
}

PROMPT_FORMATS = ("tag", "natural", "structured")
REVIEW_SCORE_FIELDS = ("composition", "prompt_alignment", "subject_clarity", "technical_quality")


def local_generation_model_options():
    """Read local generation weights through ComfyUI's configured model paths."""
    checkpoints = folder_paths.get_filename_list("checkpoints")
    unets = folder_paths.get_filename_list("diffusion_models")
    options = [f"检查点：{name}" for name in checkpoints]
    options.extend(f"UNet：{name}" for name in unets)
    return list(dict.fromkeys(options)) or ["未发现本机出图模型"]


def local_generation_model_input():
    options = local_generation_model_options()
    return (options, {
        "default": options[0],
        "tooltip": "自动读取 models/checkpoints 与 models/unet（含 diffusion_models）中的本机出图模型。",
    })


def sampler_options():
    return list(comfy.samplers.KSampler.SAMPLERS)


def scheduler_options():
    return list(comfy.samplers.KSampler.SCHEDULERS)


def normalize_bool(value, default=True):
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off"}
    return bool(value)


def normalize_prompt_format(value):
    value = str(value or "tag").strip().lower()
    return value if value in PROMPT_FORMATS else "tag"


def config_paths():
    """Prefer a user-owned config path so plugin updates do not replace it."""
    legacy_path = EXTENSION_DIR / CONFIG_FILE_NAME
    get_user_directory = getattr(folder_paths, "get_user_directory", None)
    if not callable(get_user_directory):
        return legacy_path, legacy_path
    try:
        user_directory = Path(get_user_directory())
    except (OSError, TypeError, ValueError):
        return legacy_path, legacy_path
    return user_directory / "ComfyUI-AI-Prompt-Assistant" / CONFIG_FILE_NAME, legacy_path


def read_config_file(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Invalid AI Prompt Assistant config.json: {error}") from error


def non_empty_environment_value(name, fallback):
    """Use an environment value only when no saved value is available."""
    value = os.environ.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else fallback


def saved_value_or_environment(config, key, environment_name, default):
    """Saved settings are user choices; environment values provide first-run defaults."""
    saved = config.get(key)
    if saved is not None and str(saved).strip():
        return saved
    return non_empty_environment_value(environment_name, default)


def load_config():
    config = {}
    user_config_path, legacy_config_path = config_paths()
    config_path = user_config_path if user_config_path.is_file() else legacy_config_path
    if config_path.is_file():
        config = read_config_file(config_path)

    use_json_mode = normalize_bool(saved_value_or_environment(config, "use_json_mode", "COMFY_AI_ASSISTANT_JSON_MODE", True))
    append_chat_completions = normalize_bool(config.get("append_chat_completions", True))
    allow_parameter_tuning = normalize_bool(config.get("allow_parameter_tuning", True))
    return {
        "api_url": str(saved_value_or_environment(config, "api_url", "COMFY_AI_ASSISTANT_API_URL", "")).strip(),
        "api_key": str(saved_value_or_environment(config, "api_key", "COMFY_AI_ASSISTANT_API_KEY", "")).strip(),
        "model": str(saved_value_or_environment(config, "model", "COMFY_AI_ASSISTANT_MODEL", "")).strip(),
        "timeout_seconds": int(saved_value_or_environment(config, "timeout_seconds", "COMFY_AI_ASSISTANT_TIMEOUT", 90)),
        "use_json_mode": bool(use_json_mode),
        "append_chat_completions": append_chat_completions,
        "allow_parameter_tuning": allow_parameter_tuning,
        # Direct connections are more reliable for local/OpenAI-compatible gateways.
        # Users who need a network proxy can explicitly opt back in from settings.
        "use_system_proxy": normalize_bool(config.get("use_system_proxy", False)),
    }


def chat_endpoint(api_url, append_chat_completions=True):
    endpoint = api_url.rstrip("/")
    if endpoint.endswith("/chat/completions") or not append_chat_completions:
        return endpoint
    return f"{endpoint}/chat/completions"


def models_endpoint(api_url):
    endpoint = api_url.rstrip("/")
    if endpoint.endswith("/chat/completions"):
        endpoint = endpoint[: -len("/chat/completions")]
    if endpoint.endswith("/models"):
        return endpoint
    return f"{endpoint}/models"


def parse_model_ids(body):
    """Read model IDs from common OpenAI-compatible response shapes."""
    if isinstance(body, dict):
        raw_models = body.get("data", body.get("models", []))
    else:
        raw_models = body
    if not isinstance(raw_models, list):
        return []
    model_ids = set()
    for item in raw_models:
        if isinstance(item, str) and item.strip():
            model_ids.add(item.strip())
        elif isinstance(item, dict) and item.get("id"):
            model_ids.add(str(item["id"]).strip())
    return sorted(model_ids)


def mask_api_key(api_key):
    if not api_key:
        return ""
    return f"{'*' * 8}{api_key[-4:]}"


def public_config():
    config = load_config()
    return {
        "api_url": config["api_url"],
        "model": config["model"],
        "timeout_seconds": config["timeout_seconds"],
        "use_json_mode": config["use_json_mode"],
        "append_chat_completions": config["append_chat_completions"],
        "allow_parameter_tuning": config["allow_parameter_tuning"],
        "use_system_proxy": config["use_system_proxy"],
        "api_key_set": bool(config["api_key"]),
        "api_key_masked": mask_api_key(config["api_key"]),
        "config_storage": "ComfyUI 用户配置目录",
    }


def save_config(values):
    current = load_config()
    api_url = str(values.get("api_url", current["api_url"])).strip()
    model = str(values.get("model", current["model"])).strip()
    api_key = values.get("api_key")
    if api_key is None or str(api_key).strip() in {"", mask_api_key(current["api_key"])}:
        api_key = current["api_key"]
    else:
        api_key = str(api_key).strip()
    timeout_seconds = clamp_int(values.get("timeout_seconds"), current["timeout_seconds"], 10, 300)
    use_json_mode = normalize_bool(values.get("use_json_mode", current["use_json_mode"]))
    append_chat_completions = normalize_bool(values.get("append_chat_completions", current["append_chat_completions"]))
    allow_parameter_tuning = normalize_bool(values.get("allow_parameter_tuning", current["allow_parameter_tuning"]))
    use_system_proxy = normalize_bool(values.get("use_system_proxy", current["use_system_proxy"]))
    config = {
        "api_url": api_url,
        "api_key": api_key,
        "model": model,
        "timeout_seconds": timeout_seconds,
        "use_json_mode": bool(use_json_mode),
        "append_chat_completions": append_chat_completions,
        "allow_parameter_tuning": allow_parameter_tuning,
        "use_system_proxy": use_system_proxy,
    }
    config_path, _ = config_paths()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(config, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
    return public_config()


def register_api_routes():
    server = getattr(PromptServer, "instance", None) if PromptServer is not None else None
    if web is None or server is None:
        return
    routes = server.routes

    @routes.get("/aipa/settings")
    async def get_settings(request):
        return web.json_response(public_config())

    @routes.post("/aipa/settings")
    async def post_settings(request):
        try:
            values = await request.json()
            if not isinstance(values, dict):
                raise ValueError("Settings payload must be an object.")
            result = save_config(values)
        except (json.JSONDecodeError, ValueError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except OSError as error:
            return web.json_response({"error": f"Could not save AI Prompt Assistant config: {error}"}, status=500)
        return web.json_response(result)

    @routes.post("/aipa/models")
    async def post_models(request):
        try:
            values = await request.json()
        except (json.JSONDecodeError, ValueError):
            values = {}
        values = values if isinstance(values, dict) else {}
        api_url = str(values.get("api_url", "")).strip()
        api_key = str(values.get("api_key", "")).strip()
        if not api_key:
            api_key = load_config()["api_key"]
        if not api_url or not api_key:
            return web.json_response({"error": "请先填写 API 地址和 API Key。"}, status=400)
        try:
            session = requests.Session()
            session.trust_env = load_config()["use_system_proxy"]
            response = session.get(
                models_endpoint(api_url),
                headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
                timeout=max(10, min(load_config()["timeout_seconds"], 300)),
            )
        except requests.RequestException as error:
            return web.json_response({"error": f"模型列表请求失败: {error}"}, status=502)
        if not response.ok:
            detail = response.text[:500].strip()
            if response.status_code == 401:
                message = "API Key 无效或无权访问模型列表（401），请检查 Key 和网关权限。"
            elif response.status_code == 403:
                message = "API 服务拒绝访问模型列表（403），请检查 Key 的权限或来源限制。"
            elif response.status_code == 404:
                message = "API 未提供 /models（404）。请确认地址包含 /v1，或直接手动输入模型名称。"
            elif response.status_code == 405:
                message = "API 不允许 GET /models（405）。请在网关开启 OpenAI 兼容模型列表，或直接手动输入模型名称。"
            else:
                message = f"模型列表请求失败（{response.status_code}）"
            if detail:
                message = f"{message} {detail}"
            return web.json_response({"error": message, "status": response.status_code}, status=502)
        try:
            body = response.json()
            models = parse_model_ids(body)
        except (ValueError, TypeError) as error:
            return web.json_response({"error": f"模型列表响应格式无效: {error}"}, status=502)
        return web.json_response({"models": models})

    @routes.get("/aipa/local-generation-options")
    async def get_local_generation_options(request):
        return web.json_response({
            "models": local_generation_model_options(),
            "samplers": sampler_options(),
            "schedulers": scheduler_options(),
        })

    @routes.post("/aipa/chat")
    async def post_chat(request):
        try:
            values = await request.json()
            if not isinstance(values, dict):
                raise ValueError("Chat payload must be an object.")
            message = str(values.get("message", "")).strip()
            image_data_url = str(values.get("image_data_url", "")).strip()
            reverse_prompt = bool(values.get("reverse_prompt", False))
            if not message and not image_data_url:
                raise ValueError("请先输入想法或让 AI 帮你构思。")
            if len(message) > 4000:
                raise ValueError("单条消息不能超过 4000 个字符。")
            if image_data_url and (not image_data_url.startswith("data:image/") or len(image_data_url) > 12_000_000):
                raise ValueError("图片格式不受支持，或图片过大（请使用 12 MB 以内的常见图片）。")
            history = sanitize_chat_history(values.get("history", []))
            session_memory = str(values.get("session_memory", "")).strip()[:1600]
            workflow_context = str(values.get("workflow_context", "")).strip()[:4000]
            messages = [{"role": "system", "content": chat_instruction()}]
            if session_memory:
                messages.append({"role": "system", "content": f"已确认的会话记忆：\n{session_memory}"})
            if workflow_context:
                messages.append({"role": "system", "content": f"当前 ComfyUI 工作流状态（只读）：\n{workflow_context}"})
            messages.extend(history)
            user_text = message or ("请分析这张图片并反推可用于生图的提示词。" if reverse_prompt else "请分析这张图片并给出创作建议。")
            if reverse_prompt:
                messages.append({"role": "system", "content": "用户上传了参考图。请根据可见内容反推详细的生图提示词，包含主体、构图、镜头、光线、色彩、材质和风格；不要声称知道图片来源，也不要修改用户的固定反向提示词。"})
            if image_data_url:
                messages.append({"role": "user", "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ]})
            else:
                messages.append({"role": "user", "content": user_text})
            result = call_ai(
                messages,
                request_label="AI 对话请求",
            )
            return web.json_response(normalize_chat_result(result))
        except (json.JSONDecodeError, ValueError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except RuntimeError as error:
            return web.json_response({"error": str(error)}, status=502)


register_api_routes()


def extract_json(content):
    if isinstance(content, list):
        parts = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "refusal" or part.get("refusal"):
                raise RuntimeError(f"AI service refused the request: {part.get('refusal', 'unknown reason')}")
            text = part.get("text", part.get("content", ""))
            if isinstance(text, str):
                parts.append(text)
        content = "".join(parts)
    if not isinstance(content, str):
        raise RuntimeError("AI service returned an unsupported response format.")

    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else ""
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    try:
        return json.loads(cleaned.strip())
    except json.JSONDecodeError as error:
        raise RuntimeError("AI service did not return valid JSON. Try the request again.") from error


def call_ai(messages, request_label="AI 请求", timeout_multiplier=1):
    config = load_config()
    missing = [name for name in ("api_url", "api_key", "model") if not config[name]]
    if missing:
        labels = {"api_url": "API 地址", "api_key": "API Key", "model": "大模型"}
        raise RuntimeError(
            "AI 服务未配置。请打开悬浮窗右上角“设置”，填写 API 地址、API Key 和大模型后点击“保存配置”。"
            "无需复制 config.json。缺少：" + "、".join(labels[name] for name in missing)
        )

    payload = {
        "model": config["model"],
        "messages": messages,
        "temperature": 0.35,
    }
    if config["use_json_mode"]:
        payload["response_format"] = {"type": "json_object"}

    timeout_seconds = max(10, min(int(config["timeout_seconds"] * timeout_multiplier), 300))
    session = requests.Session()
    session.trust_env = config["use_system_proxy"]

    def post(request_payload):
        try:
            return session.post(
                chat_endpoint(config["api_url"], config["append_chat_completions"]),
                headers={
                    "Authorization": f"Bearer {config['api_key']}",
                    "Content-Type": "application/json",
                },
                json=request_payload,
                timeout=timeout_seconds,
            )
        except requests.exceptions.Timeout as error:
            route = "系统代理" if config["use_system_proxy"] else "直连"
            raise RuntimeError(
                f"{request_label}超时（{timeout_seconds} 秒，当前使用{route}）。"
                "请在悬浮窗设置中检查 API 地址，或提高请求超时后重试。"
            ) from error
        except requests.RequestException as error:
            raise RuntimeError(f"{request_label}失败: {error}") from error

    response = post(payload)
    # A number of OpenAI-compatible gateways reject response_format. Retry once
    # without it so local and older gateways remain usable.
    if not response.ok and config["use_json_mode"] and response.status_code in {400, 404, 422}:
        payload.pop("response_format", None)
        response = post(payload)

    if not response.ok:
        detail = response.text[:500]
        raise RuntimeError(f"AI Prompt Assistant request failed ({response.status_code}): {detail}")

    try:
        body = response.json()
        message = body["choices"][0]["message"]
        if message.get("refusal"):
            raise RuntimeError(f"AI service refused the request: {message['refusal']}")
        content = message.get("content")
    except (KeyError, IndexError, ValueError, TypeError) as error:
        raise RuntimeError("AI service response did not contain a chat completion.") from error
    return extract_json(content)


def sanitize_chat_history(history):
    if not isinstance(history, list):
        return []
    clean_history = []
    for item in history[-16:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role", "")).strip().lower()
        content = str(item.get("content", "")).strip()
        if role not in {"user", "assistant"} or not content:
            continue
        clean_history.append({"role": role, "content": content[:3000]})
    return clean_history


def chat_instruction():
    return """You are a practical Chinese-speaking creative director inside a ComfyUI image-generation workspace.
Act as a continuing creative agent: remember confirmed decisions, discuss and refine ideas over multiple turns, and use the supplied read-only workflow state when it is relevant. Do not force image generation when the user is brainstorming or asking a question. If their request is vague or they say they have no idea, propose one strong visual concept yourself instead of making them do all the ideation. Preserve explicit requirements and avoid named artists, copyrighted characters, or unsupported claims.
Return only one JSON object with exactly these fields:
{
  "reply": "short Chinese conversational reply",
  "creative_brief": "a complete Chinese image brief ready for image generation, or an empty string while clarifying",
  "style_or_constraints": "Chinese style, composition, lighting, framing, and constraints, or an empty string",
  "prompt_format": "tag, natural, or structured",
  "ready_to_generate": true,
  "next_action": "chat, update_plan, or generate",
  "session_memory": "short Chinese summary of confirmed preferences and decisions for later turns"
}
When the user asks for inspiration or asks to generate, provide a usable creative_brief and style_or_constraints and set ready_to_generate true. When more information is genuinely needed, ask one focused question, keep creative_brief empty, and set ready_to_generate false. Choose tag for most anime/SD workflows, natural for Flux-like models, and structured when the user asks for precise scene control. The user controls the negative prompt and generation parameters separately. Never claim to have changed the workflow: only recommend the next action."""


def normalize_chat_result(result):
    result = result if isinstance(result, dict) else {}
    creative_brief = str(result.get("creative_brief", "")).strip()
    prompt_format = normalize_prompt_format(result.get("prompt_format"))
    ready_to_generate = normalize_bool(result.get("ready_to_generate"), bool(creative_brief)) and bool(creative_brief)
    next_action = str(result.get("next_action", "chat")).strip().lower()
    if next_action not in {"chat", "update_plan", "generate"}:
        next_action = "generate" if ready_to_generate else "chat"
    return {
        "reply": str(result.get("reply", "已为你整理好一套创作方案。")).strip() or "已为你整理好一套创作方案。",
        "creative_brief": creative_brief,
        "style_or_constraints": str(result.get("style_or_constraints", "")).strip(),
        "prompt_format": prompt_format,
        "ready_to_generate": ready_to_generate,
        "next_action": next_action,
        "session_memory": str(result.get("session_memory", "")).strip()[:1600],
    }


def clamp_int(value, default, minimum, maximum):
    try:
        return max(minimum, min(maximum, int(value)))
    except (TypeError, ValueError):
        return default


def clamp_float(value, default, minimum, maximum):
    try:
        return max(minimum, min(maximum, float(value)))
    except (TypeError, ValueError):
        return default


def sanitize_parameters(parameters, fallback):
    parameters = parameters if isinstance(parameters, dict) else {}
    sampler_names = sampler_options()
    schedulers = scheduler_options()

    sampler_name = parameters.get("sampler_name", fallback["sampler_name"])
    scheduler = parameters.get("scheduler", fallback["scheduler"])
    return {
        "sampler_name": sampler_name if sampler_name in sampler_names else fallback["sampler_name"],
        "scheduler": scheduler if scheduler in schedulers else fallback["scheduler"],
        "steps": clamp_int(parameters.get("steps"), fallback["steps"], 1, 80),
        "cfg": clamp_float(parameters.get("cfg"), fallback["cfg"], 0.0, 20.0),
        "width": clamp_int(parameters.get("width"), fallback["width"], 64, 2048) // 8 * 8,
        "height": clamp_int(parameters.get("height"), fallback["height"], 64, 2048) // 8 * 8,
        "denoise": clamp_float(parameters.get("denoise"), fallback["denoise"], 0.0, 1.0),
    }


def planner_instruction(prompt_format, allow_parameter_tuning=True):
    prompt_format = normalize_prompt_format(prompt_format)
    sampler_names = ", ".join(sampler_options())
    schedulers = ", ".join(scheduler_options())
    format_instructions = {
        "tag": "Use concise English comma-separated tags. Put the most important subject and composition tags first; avoid full sentences.",
        "natural": "Use fluent English natural-language sentences with concrete subject, action, environment, lighting, camera, and style details.",
        "structured": "Think in sections (subject, action, environment, composition, lighting, camera, style), then combine them into a readable English prompt. Keep the JSON fields flat and make positive_prompt the final combined prompt.",
    }.get(prompt_format, "Use concise English comma-separated tags.")
    return f"""You are a ComfyUI prompt director. Convert the user's Chinese or English creative brief into practical image-generation prompts.
Return only one JSON object with this exact shape:
{{
  "positive_prompt": "English comma-separated prompt",
  "negative_prompt": "English comma-separated negative prompt, or an empty string when unsuitable",
  "parameters": {{"sampler_name": "...", "scheduler": "...", "steps": 28, "cfg": 5.0, "width": 1024, "height": 1024, "denoise": 1.0}},
  "reasoning": "short Chinese explanation"
}}
Use English for both prompts. Preserve explicit user requirements. Do not invent named artists, copyrighted characters, or unsupported technical claims. Be concise and model-aware.
Prompt format: {prompt_format}. {format_instructions}
Choose sampler_name only from: {sampler_names}
Choose scheduler only from: {schedulers}
Use 1-80 steps, CFG 0-20, dimensions from 64 to 2048 divisible by 8, and denoise 0-1.
{"You may recommend parameter changes when they materially improve the result." if allow_parameter_tuning else "Do not optimize parameters; they are locked by the user and will not be applied."}"""


def image_to_data_url(image):
    tensor = image[0].detach().cpu().numpy()
    pixels = np.clip(tensor * 255.0, 0, 255).astype(np.uint8)
    pil_image = Image.fromarray(pixels).convert("RGB")
    resampling = getattr(Image, "Resampling", Image).LANCZOS
    # Vision APIs do not benefit from a lossless full-resolution upload here.
    # A bounded JPEG greatly reduces proxy/gateway timeouts while retaining
    # enough detail for composition and prompt review.
    pil_image.thumbnail((1024, 1024), resampling)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="JPEG", quality=88, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def result_tuple(result, seed, fallback, allow_parameter_tuning=True, negative_override=None):
    parameters = sanitize_parameters(result.get("parameters"), fallback) if allow_parameter_tuning else fallback
    positive = str(result.get("positive_prompt", "")).strip()
    negative = str(negative_override).strip() if negative_override is not None else str(result.get("negative_prompt", "")).strip()
    if not positive:
        raise RuntimeError("AI service returned an empty positive prompt.")
    reasoning = str(result.get("reasoning", result.get("review", ""))).strip()
    return (
        positive,
        negative,
        parameters["sampler_name"],
        parameters["scheduler"],
        parameters["steps"],
        parameters["cfg"],
        parameters["width"],
        parameters["height"],
        parameters["denoise"],
        seed,
        reasoning,
    )


def prompt_sync_report(output):
    """Expose AI results to the web extension after a node has executed.

    ComfyUI's ``executed`` browser event includes only a node's ``ui`` payload,
    not its normal return sockets. Keeping this payload small and explicit lets
    the extension update the mapped positive prompt widget immediately without
    changing the workflow's output contract.
    """
    names = (
        "positive_prompt", "negative_prompt", "sampler_name", "scheduler",
        "steps", "cfg", "width", "height", "denoise", "seed", "reasoning",
    )
    return json.dumps(dict(zip(names, output)), ensure_ascii=False)


def normalize_review_score(value):
    try:
        return max(0, min(100, round(float(value))))
    except (TypeError, ValueError):
        return None


def review_scores(result):
    raw_scores = result.get("scores", {}) if isinstance(result, dict) else {}
    raw_scores = raw_scores if isinstance(raw_scores, dict) else {}
    scores = {}
    for field in REVIEW_SCORE_FIELDS:
        value = normalize_review_score(raw_scores.get(field))
        if value is not None:
            scores[field] = value
    return scores


def review_report(result, parameters, enabled=True, prompt_format="tag"):
    scores = review_scores(result) if enabled else {}
    overall_score = normalize_review_score(result.get("score")) if enabled else None
    if overall_score is None and scores:
        overall_score = round(sum(scores.values()) / len(scores))
    report = {
        "enabled": enabled,
        "prompt_format": normalize_prompt_format(prompt_format),
        "score": overall_score,
        "scores": scores,
        "confidence": result.get("confidence", None),
        "action": result.get("action", "prompt_only"),
        "summary": str(result.get("summary", result.get("reasoning", ""))).strip(),
        "observations": result.get("observations", []),
        "preserve": result.get("preserve", []),
        "changes": result.get("changes", []),
        "parameters": parameters,
    }
    return json.dumps(report, ensure_ascii=False)


class AIPromptPlanner:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "creative_brief": ("STRING", {"multiline": True, "default": "", "placeholder": "Describe the image you want to create."}),
                "image_model": local_generation_model_input(),
                "prompt_format": (["tag", "natural", "structured"], {"default": "tag"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
            },
            "optional": {
                "style_or_constraints": ("STRING", {"multiline": True, "default": "", "placeholder": "Optional style, aspect ratio, or constraints."}),
                "negative_prompt": ("STRING", {"multiline": True, "default": "", "placeholder": "Your fixed negative prompt. AI will not change this text."}),
                "sampler_name": ("STRING", {"default": DEFAULT_PARAMETERS["sampler_name"]}),
                "scheduler": ("STRING", {"default": DEFAULT_PARAMETERS["scheduler"]}),
                "steps": ("INT", {"default": DEFAULT_PARAMETERS["steps"], "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": DEFAULT_PARAMETERS["cfg"], "min": 0.0, "max": 100.0}),
                "width": ("INT", {"default": DEFAULT_PARAMETERS["width"], "min": 64, "max": 16384}),
                "height": ("INT", {"default": DEFAULT_PARAMETERS["height"], "min": 64, "max": 16384}),
                "denoise": ("FLOAT", {"default": DEFAULT_PARAMETERS["denoise"], "min": 0.0, "max": 1.0}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "INT", "FLOAT", "INT", "INT", "FLOAT", "INT", "STRING")
    RETURN_NAMES = ("positive_prompt", "negative_prompt", "sampler_name", "scheduler", "steps", "cfg", "width", "height", "denoise", "seed", "reasoning")
    FUNCTION = "plan"
    # The floating panel can queue this standalone planning node before it is
    # wired into a complete generation graph.
    OUTPUT_NODE = True
    CATEGORY = "AI 提示词助手"
    DESCRIPTION = "调用已配置的 OpenAI 兼容模型生成正向提示词；反向提示词和出图参数由用户控制。"

    def plan(self, creative_brief, image_model, prompt_format="tag", seed=0, style_or_constraints="", negative_prompt="", **user_parameters):
        if not creative_brief.strip():
            raise ValueError("Creative brief cannot be empty.")
        prompt_format = normalize_prompt_format(prompt_format)
        config = load_config()
        fallback = sanitize_parameters(user_parameters, DEFAULT_PARAMETERS)
        result = call_ai([
            {"role": "system", "content": planner_instruction(prompt_format, config["allow_parameter_tuning"])},
            {"role": "user", "content": f"Image model: {image_model}\nPrompt format: {prompt_format}\nCreative brief: {creative_brief}\nConstraints: {style_or_constraints}"},
        ])
        output = result_tuple(result, seed, fallback, config["allow_parameter_tuning"], negative_prompt)
        return {"result": output, "ui": {"ai_prompt_sync": [prompt_sync_report(output)]}}


class AIImageReviewer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "current_positive_prompt": ("STRING", {"multiline": True, "default": ""}),
                "current_negative_prompt": ("STRING", {"multiline": True, "default": ""}),
                "revision_request": ("STRING", {"multiline": True, "default": "", "placeholder": "For example: preserve composition, make the face more natural and change the coat to red."}),
                "enable_review": ("BOOLEAN", {"default": False, "tooltip": "When disabled, the image is not sent to the AI service and current settings are passed through."}),
                "image_model": local_generation_model_input(),
                "prompt_format": (["tag", "natural", "structured"], {"default": "tag"}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
            },
            "optional": {
                "sampler_name": ("STRING", {"default": DEFAULT_PARAMETERS["sampler_name"]}),
                "scheduler": ("STRING", {"default": DEFAULT_PARAMETERS["scheduler"]}),
                "steps": ("INT", {"default": DEFAULT_PARAMETERS["steps"], "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": DEFAULT_PARAMETERS["cfg"], "min": 0.0, "max": 100.0}),
                "width": ("INT", {"default": DEFAULT_PARAMETERS["width"], "min": 64, "max": 16384}),
                "height": ("INT", {"default": DEFAULT_PARAMETERS["height"], "min": 64, "max": 16384}),
                "denoise": ("FLOAT", {"default": DEFAULT_PARAMETERS["denoise"], "min": 0.0, "max": 1.0}),
            },
        }

    RETURN_TYPES = AIPromptPlanner.RETURN_TYPES
    RETURN_NAMES = AIPromptPlanner.RETURN_NAMES
    FUNCTION = "review"
    OUTPUT_NODE = True
    CATEGORY = "AI 提示词助手"
    DESCRIPTION = "将连接的成图发送给已配置的视觉模型，返回优化后的提示词和采样参数建议。"

    def review(self, image, current_positive_prompt, current_negative_prompt, revision_request, enable_review, image_model, prompt_format="tag", seed=0, **current_parameters):
        if not current_positive_prompt.strip():
            raise ValueError("Current positive prompt cannot be empty.")
        prompt_format = normalize_prompt_format(prompt_format)
        fallback = sanitize_parameters(current_parameters, DEFAULT_PARAMETERS)
        config = load_config()
        review_enabled = bool(enable_review)
        if not review_enabled:
            result = {
                "positive_prompt": current_positive_prompt,
                "negative_prompt": current_negative_prompt,
                "parameters": fallback,
                "reasoning": "Image review is disabled.",
                "summary": "Image review is disabled.",
            }
            output = result_tuple(result, seed, fallback)
            return {
                "result": output,
                "ui": {
                    "ai_prompt_sync": [prompt_sync_report(output)],
                    "ai_review": [review_report(result, fallback, False, prompt_format)],
                },
            }
        instruction = planner_instruction(prompt_format, config["allow_parameter_tuning"]).replace(
            "Convert the user's Chinese or English creative brief into practical image-generation prompts.",
            "Review the connected generated image and revise its prompts and sampling settings. Preserve the current result where the user's revision request says to preserve it."
        )
        user_text = (
            f"Image model: {image_model}\n"
            f"Prompt format: {prompt_format}\n"
            f"Current positive prompt: {current_positive_prompt}\n"
            f"Current negative prompt: {current_negative_prompt}\n"
            f"Current parameters: {json.dumps(fallback)}\n"
            f"Revision request: {revision_request or 'Assess the image and make only high-confidence improvements.'}"
        )
        instruction += """
For review reporting, also include these flat fields:
- score: an overall 0-100 score for the current image before revisions.
- confidence: 0-1 confidence in the assessment.
- scores: an object with composition, prompt_alignment, subject_clarity, and technical_quality, each scored 0-100.
- action: prompt_only, parameters, or inpaint.
- summary, observations (array), preserve (array), and changes (array).
Use the same standards across all scores. Do not invent defects that are not visible in the image."""
        result = call_ai([
            {"role": "system", "content": instruction},
            {"role": "user", "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": image_to_data_url(image)}},
            ]},
        ], request_label="图片评审请求", timeout_multiplier=2)
        parameters = sanitize_parameters(result.get("parameters"), fallback) if config["allow_parameter_tuning"] else fallback
        output = result_tuple(result, seed, fallback, config["allow_parameter_tuning"], current_negative_prompt)
        return {
            "result": output,
            "ui": {
                "ai_prompt_sync": [prompt_sync_report(output)],
                "ai_review": [review_report(result, parameters, True, prompt_format)],
            },
        }


class AIAdaptiveKSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
                "steps": ("INT", {"default": DEFAULT_PARAMETERS["steps"], "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": DEFAULT_PARAMETERS["cfg"], "min": 0.0, "max": 100.0}),
                "sampler_name": ("STRING", {"default": DEFAULT_PARAMETERS["sampler_name"]}),
                "scheduler": ("STRING", {"default": DEFAULT_PARAMETERS["scheduler"]}),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "latent_image": ("LATENT",),
                "denoise": ("FLOAT", {"default": DEFAULT_PARAMETERS["denoise"], "min": 0.0, "max": 1.0}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "sample"
    CATEGORY = "AI 提示词助手"
    DESCRIPTION = "使用 AI 提示词规划或图片评审给出的参数执行本地采样。"

    def sample(self, model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent_image, denoise=1.0):
        parameters = sanitize_parameters(
            {"sampler_name": sampler_name, "scheduler": scheduler, "steps": steps, "cfg": cfg, "denoise": denoise},
            DEFAULT_PARAMETERS,
        )
        return common_ksampler(
            model, seed, parameters["steps"], parameters["cfg"], parameters["sampler_name"],
            parameters["scheduler"], positive, negative, latent_image, denoise=parameters["denoise"],
        )


NODE_CLASS_MAPPINGS = {
    "AIPromptPlanner": AIPromptPlanner,
    "AIImageReviewer": AIImageReviewer,
    "AIAdaptiveKSampler": AIAdaptiveKSampler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AIPromptPlanner": "AI 提示词规划",
    "AIImageReviewer": "AI 图片评审",
    "AIAdaptiveKSampler": "AI 自适应采样器",
}

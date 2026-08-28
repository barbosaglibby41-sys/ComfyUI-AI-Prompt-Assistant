import base64
import asyncio
import binascii
import csv
import io
import json
import os
import re
import time
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
UPSTREAM_RETRY_COUNT = 5
UPSTREAM_RETRY_STATUS_CODES = frozenset({408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529, 598, 599})
UPSTREAM_RETRY_MAX_DELAY_SECONDS = 30
LORA_MANAGER_INSTRUCTION = """When the workflow uses Lora Loader (LoraManager), the generated positive_prompt is written to Prompt (LoraManager). The loader's configured `loras` entries apply the LoRA; its text field and loaded-loras metadata belong to the loader and must not be copied into the image description. Its trigger_words output is already supplied to Prompt (LoraManager). Never insert `<lora:...>` syntax into positive_prompt, and do not duplicate trigger words that are automatically supplied by the loader. If the user explicitly provides a trigger word, preserve it only when needed and avoid repeating it. Keep the selected prompt format intact."""
STYLE_TOKEN_PATTERN = re.compile(
    r"(?<![a-z])(?:3d render(?:ing)?|3d|realistic|photorealistic|hyperrealistic|anime|manga|comic|illustration|digital painting|oil painting|watercolor|cinematic|concept art|game art|low[- ]poly|clay render|plastic render|cel shading|cartoon)(?![a-z])",
    re.IGNORECASE,
)
_WD_TAGGER_CACHE = {"path": "", "session": None, "tags": []}


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


def strip_style_prompt(prompt):
    """Remove style tokens while preserving the surrounding subject and lighting text."""
    parts = re.split(r",", str(prompt or ""))
    cleaned = []
    for part in parts:
        value = STYLE_TOKEN_PATTERN.sub("", part)
        value = re.sub(r"\s{2,}", " ", value).strip(" \t;:-")
        if value:
            cleaned.append(value)
    return ", ".join(cleaned)


def style_prompt_instruction(strip_style):
    if not strip_style:
        return "The user allows visible or explicitly requested art-style and medium descriptors when they are useful."
    return (
        "The user has enabled 'strip style words' because a LoRA should control the visual style. "
        "Do not add or preserve style or medium labels such as 3D, 3D render, realistic, photorealistic, "
        "anime, manga, comic, illustration, digital painting, oil painting, watercolor, cinematic, concept art, "
        "game art, low-poly, clay render, plastic render, cel shading, or cartoon. Remove those descriptors "
        "from generated positive and negative prompts while preserving the subject, identity, pose, action, "
        "composition, camera, lighting, color relationships, materials, and visible details. Never remove an "
        "explicit subject requirement merely because it is visually distinctive."
    )


def resolve_wd_tagger_files(configured_path):
    path = Path(str(configured_path or "").strip()).expanduser()
    if path.is_dir():
        return path / "model.onnx", path / "selected_tags.csv"
    if path.is_file():
        return path, path.with_name("selected_tags.csv")
    return path, path.with_name("selected_tags.csv")


def wd_tagger_status(configured_path):
    model_path, tags_path = resolve_wd_tagger_files(configured_path)
    if not str(configured_path or "").strip():
        return {"available": False, "message": "尚未配置 WD-EVA02 模型路径。"}
    if not model_path.is_file():
        return {"available": False, "message": f"未找到模型文件：{model_path}"}
    if not tags_path.is_file():
        return {"available": False, "message": f"未找到标签文件：{tags_path}"}
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return {"available": False, "message": "当前 ComfyUI Python 环境未安装 onnxruntime。"}
    return {"available": True, "message": "WD-EVA02 模型路径可用。首次反推时会加载模型。"}


def load_wd_tagger(configured_path):
    model_path, tags_path = resolve_wd_tagger_files(configured_path)
    status = wd_tagger_status(configured_path)
    if not status["available"]:
        raise RuntimeError(status["message"])
    cache_key = str(model_path.resolve())
    if _WD_TAGGER_CACHE["path"] == cache_key and _WD_TAGGER_CACHE["session"] is not None:
        return _WD_TAGGER_CACHE["session"], _WD_TAGGER_CACHE["tags"]
    import onnxruntime

    providers = ["CPUExecutionProvider"]
    available = onnxruntime.get_available_providers()
    if "CUDAExecutionProvider" in available:
        providers.insert(0, "CUDAExecutionProvider")
    session = onnxruntime.InferenceSession(str(model_path), providers=providers)
    tags = []
    with tags_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            tags.append({
                "name": str(row.get("name", "")).strip().replace("_", " "),
                "category": str(row.get("category", "")).strip(),
            })
    if not tags:
        raise RuntimeError("selected_tags.csv 中没有可用标签。")
    _WD_TAGGER_CACHE.update({"path": cache_key, "session": session, "tags": tags})
    return session, tags


def wd_tagger_predict(image_data_url, configured_path):
    session, tags = load_wd_tagger(configured_path)
    try:
        _, encoded = str(image_data_url).split(",", 1)
        image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")
    except (ValueError, OSError, binascii.Error) as error:
        raise ValueError("无法读取待反推图片。") from error

    side = max(image.size)
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    input_meta = session.get_inputs()[0]
    shape = input_meta.shape
    channels_first = len(shape) == 4 and str(shape[1]) == "3"
    height_index, width_index = (2, 3) if channels_first else (1, 2)
    height = int(shape[height_index]) if len(shape) > width_index and str(shape[height_index]).isdigit() else 448
    width = int(shape[width_index]) if len(shape) > width_index and str(shape[width_index]).isdigit() else 448
    resized = square.resize((width, height), getattr(Image, "Resampling", Image).BICUBIC)
    pixels = np.asarray(resized)[:, :, ::-1].astype(np.float32)
    if channels_first:
        pixels = np.transpose(pixels, (2, 0, 1))
    if "uint8" in str(input_meta.type).lower():
        pixels = pixels.astype(np.uint8)
    probabilities = session.run(None, {input_meta.name: np.expand_dims(pixels, axis=0)})[0][0]
    results = []
    for index, score in enumerate(probabilities[:len(tags)]):
        tag = tags[index]
        if tag["category"] not in {"0", "4", "general", "character"}:
            continue
        threshold = 0.85 if tag["category"] in {"4", "character"} else 0.35
        if float(score) >= threshold:
            results.append((float(score), tag["name"]))
    results.sort(reverse=True)
    return [name for _, name in results]


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


def normalize_reasoning_effort(value):
    """Only send supported effort values; off keeps compatible APIs unchanged."""
    value = str(value or "off").strip().lower()
    return value if value in {"off", "low", "medium", "high"} else "off"


def load_config():
    config = {}
    user_config_path, legacy_config_path = config_paths()
    config_path = user_config_path if user_config_path.is_file() else legacy_config_path
    if config_path.is_file():
        config = read_config_file(config_path)

    use_json_mode = normalize_bool(saved_value_or_environment(config, "use_json_mode", "COMFY_AI_ASSISTANT_JSON_MODE", True))
    append_chat_completions = normalize_bool(config.get("append_chat_completions", True))
    allow_parameter_tuning = normalize_bool(config.get("allow_parameter_tuning", True))
    reasoning_effort = normalize_reasoning_effort(config.get("reasoning_effort", "off"))
    return {
        "api_url": str(saved_value_or_environment(config, "api_url", "COMFY_AI_ASSISTANT_API_URL", "")).strip(),
        "api_key": str(saved_value_or_environment(config, "api_key", "COMFY_AI_ASSISTANT_API_KEY", "")).strip(),
        "model": str(saved_value_or_environment(config, "model", "COMFY_AI_ASSISTANT_MODEL", "")).strip(),
        "timeout_seconds": int(saved_value_or_environment(config, "timeout_seconds", "COMFY_AI_ASSISTANT_TIMEOUT", 90)),
        "use_json_mode": bool(use_json_mode),
        "append_chat_completions": append_chat_completions,
        "allow_parameter_tuning": allow_parameter_tuning,
        "reasoning_effort": reasoning_effort,
        # Direct connections are more reliable for local/OpenAI-compatible gateways.
        # Users who need a network proxy can explicitly opt back in from settings.
        "use_system_proxy": normalize_bool(config.get("use_system_proxy", False)),
        "wd_tagger_path": str(config.get("wd_tagger_path", "")).strip(),
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


def upstream_retry_delay(response, retry_number):
    """Use a gateway's Retry-After value, otherwise apply bounded backoff."""
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        try:
            if retry_after is not None:
                return max(0, min(float(retry_after), UPSTREAM_RETRY_MAX_DELAY_SECONDS))
        except (TypeError, ValueError):
            pass
    return min(2 ** max(0, retry_number - 1), UPSTREAM_RETRY_MAX_DELAY_SECONDS)


def is_retryable_upstream_response(response):
    return response is not None and response.status_code in UPSTREAM_RETRY_STATUS_CODES


def request_with_upstream_retries(request_fn, request_label):
    """Retry transient upstream failures five times after the initial request."""
    last_error = None
    for attempt in range(UPSTREAM_RETRY_COUNT + 1):
        try:
            response = request_fn()
        except requests.RequestException as error:
            last_error = error
            if attempt >= UPSTREAM_RETRY_COUNT:
                break
            time.sleep(upstream_retry_delay(None, attempt + 1))
            continue

        if not is_retryable_upstream_response(response) or attempt >= UPSTREAM_RETRY_COUNT:
            return response
        time.sleep(upstream_retry_delay(response, attempt + 1))

    raise RuntimeError(
        f"{request_label}在自动重试 {UPSTREAM_RETRY_COUNT} 次后仍失败：{last_error}"
    ) from last_error


def mask_api_key(api_key):
    if not api_key:
        return ""
    return f"{'*' * 8}{api_key[-4:]}"


def public_config():
    config = load_config()
    tagger_status = wd_tagger_status(config["wd_tagger_path"])
    return {
        "api_url": config["api_url"],
        "model": config["model"],
        "timeout_seconds": config["timeout_seconds"],
        "use_json_mode": config["use_json_mode"],
        "append_chat_completions": config["append_chat_completions"],
        "allow_parameter_tuning": config["allow_parameter_tuning"],
        "reasoning_effort": config["reasoning_effort"],
        "use_system_proxy": config["use_system_proxy"],
        "api_key_set": bool(config["api_key"]),
        "api_key_masked": mask_api_key(config["api_key"]),
        "config_storage": "ComfyUI 用户配置目录",
        "wd_tagger_path": config["wd_tagger_path"],
        "wd_tagger_available": tagger_status["available"],
        "wd_tagger_message": tagger_status["message"],
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
    reasoning_effort = normalize_reasoning_effort(values.get("reasoning_effort", current["reasoning_effort"]))
    use_system_proxy = normalize_bool(values.get("use_system_proxy", current["use_system_proxy"]))
    wd_tagger_path = str(values.get("wd_tagger_path", current["wd_tagger_path"])).strip()
    config = {
        "api_url": api_url,
        "api_key": api_key,
        "model": model,
        "timeout_seconds": timeout_seconds,
        "use_json_mode": bool(use_json_mode),
        "append_chat_completions": append_chat_completions,
        "allow_parameter_tuning": allow_parameter_tuning,
        "reasoning_effort": reasoning_effort,
        "use_system_proxy": use_system_proxy,
        "wd_tagger_path": wd_tagger_path,
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
        # Model discovery is a short interactive action. Do not inherit a
        # long generation timeout, otherwise an unreachable replacement API
        # makes the settings screen appear to do nothing for minutes.
        timeout_seconds = clamp_int(values.get("timeout_seconds"), 30, 10, 60)
        use_system_proxy = normalize_bool(values.get("use_system_proxy"), load_config()["use_system_proxy"])
        if not api_key:
            api_key = load_config()["api_key"]
        if not api_url or not api_key:
            return web.json_response({"error": "请先填写 API 地址和 API Key。"}, status=400)
        try:
            session = requests.Session()
            session.trust_env = use_system_proxy
            response = request_with_upstream_retries(
                lambda: session.get(
                    models_endpoint(api_url),
                    headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
                    timeout=timeout_seconds,
                ),
                "模型列表请求",
            )
        except RuntimeError as error:
            return web.json_response({"error": str(error)}, status=502)
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
            if is_retryable_upstream_response(response):
                message = f"{message} 已自动重试 {UPSTREAM_RETRY_COUNT} 次仍未恢复。"
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
            strip_style = normalize_bool(values.get("strip_style"), True)
            if not message and not image_data_url:
                raise ValueError("请先输入想法或让 AI 帮你构思。")
            if len(message) > 4000:
                raise ValueError("单条消息不能超过 4000 个字符。")
            if image_data_url and (not image_data_url.startswith("data:image/") or len(image_data_url) > 12_000_000):
                raise ValueError("图片格式不受支持，或图片过大（请使用 12 MB 以内的常见图片）。")
            history = sanitize_chat_history(values.get("history", []))
            session_memory = str(values.get("session_memory", "")).strip()[:1600]
            workflow_context = str(values.get("workflow_context", "")).strip()[:4000]
            messages = [{"role": "system", "content": chat_instruction(strip_style)}]
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

    @routes.post("/aipa/reverse-prompt")
    async def post_reverse_prompt(request):
        try:
            values = await request.json()
            if not isinstance(values, dict):
                raise ValueError("图片反推请求格式无效。")
            image_data_url = str(values.get("image_data_url", "")).strip()
            if not image_data_url:
                raise ValueError("请先选择或粘贴一张图片。")
            if not image_data_url.startswith("data:image/") or len(image_data_url) > 12_000_000:
                raise ValueError("图片格式不受支持，或图片过大（请使用 12 MB 以内的常见图片）。")
            notes = str(values.get("notes", "")).strip()[:2000]
            prompt_format = normalize_prompt_format(values.get("prompt_format"))
            strip_style = normalize_bool(values.get("strip_style"), True)
            engine = str(values.get("engine", "ai")).strip().lower()
            if engine not in {"ai", "wd_tagger"}:
                engine = "ai"
            # WD-EVA02 is a tagger; natural-language output always goes through
            # the configured vision model as requested by the user.
            if prompt_format == "natural":
                engine = "ai"
            if engine == "wd_tagger":
                config = load_config()
                tags = await asyncio.to_thread(wd_tagger_predict, image_data_url, config["wd_tagger_path"])
                prompt = strip_style_prompt(", ".join(tags)) if strip_style else ", ".join(tags)
                if not prompt:
                    raise RuntimeError("WD-EVA02 没有识别出达到阈值的标签，请更换图片或关闭去除画风词。")
                return web.json_response({
                    "summary": "WD-EVA02 在本地识别出的视觉标签。",
                    "prompt": prompt[:12000],
                    "negative_prompt": "",
                    "details": [f"本地标签器识别到 {len(tags)} 个标签。", "未调用远程 AI 模型。"],
                    "prompt_format": "tag",
                    "engine": "wd_tagger",
                })
            user_text = (
                "请只根据这张图片中实际可见的内容，整理一份适合 ComfyUI 生图的反推结果。\n"
                f"输出形式：{prompt_format}\n"
                f"用户补充要求：{notes or '无，请完整观察图片后自行整理。'}"
            )
            result = call_ai([
                {"role": "system", "content": reverse_prompt_instruction(prompt_format, strip_style)},
                {"role": "user", "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ]},
            ], request_label="图片反推请求", timeout_multiplier=2)
            return web.json_response(normalize_reverse_prompt_result(result, prompt_format, strip_style))
        except (json.JSONDecodeError, ValueError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except RuntimeError as error:
            return web.json_response({"error": f"图片反推失败：{error}"}, status=502)

    @routes.post("/aipa/comic-plan")
    async def post_comic_plan(request):
        try:
            values = await request.json()
            if not isinstance(values, dict):
                raise ValueError("漫画规划请求格式无效。")
            idea = str(values.get("idea", "")).strip()
            if not idea:
                raise ValueError("请先填写漫画想法。")
            if len(idea) > 4000:
                raise ValueError("漫画想法不能超过 4000 个字符。")
            panel_count = clamp_int(values.get("panel_count"), 4, 1, 12)
            prompt_format = normalize_prompt_format(values.get("prompt_format"))
            workflow_context = str(values.get("workflow_context", "")).strip()[:4000]
            messages = [
                {"role": "system", "content": comic_instruction(prompt_format, panel_count)},
                {"role": "user", "content": (
                    f"用户的漫画想法：\n{idea}\n\n"
                    f"当前 ComfyUI 工作流状态（只读）：\n{workflow_context or '未提供'}"
                )},
            ]
            result = call_ai(messages, request_label="漫画分镜规划请求", timeout_multiplier=2)
            return web.json_response(normalize_comic_plan(result, panel_count, prompt_format))
        except (json.JSONDecodeError, ValueError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except RuntimeError as error:
            return web.json_response({"error": str(error)}, status=502)

    @routes.post("/aipa/comic-continue")
    async def post_comic_continue(request):
        try:
            values = await request.json()
            if not isinstance(values, dict):
                raise ValueError("看图续写请求格式无效。")
            previous_image = values.get("previous_image")
            next_panel = values.get("next_panel")
            if not isinstance(previous_image, dict):
                raise ValueError("缺少上一格的成图信息。")
            if not isinstance(next_panel, dict):
                raise ValueError("缺少下一格分镜信息。")
            prompt_format = normalize_prompt_format(values.get("prompt_format"))
            image_data_url = comic_output_image_data_url(previous_image)
            character_bible = str(values.get("character_bible", "")).strip()[:4000]
            visual_bible = str(values.get("visual_bible", "")).strip()[:4000]
            next_panel_context = {
                "index": clamp_int(next_panel.get("index"), 1, 1, 12),
                "beat": str(next_panel.get("beat", "")).strip()[:2000],
                "shot": str(next_panel.get("shot", "")).strip()[:2000],
                "continuity": str(next_panel.get("continuity", "")).strip()[:2000],
                "positive_prompt": str(next_panel.get("positive_prompt", "")).strip(),
            }
            if not next_panel_context["positive_prompt"]:
                raise ValueError("下一格缺少英文正向提示词。")
            messages = [
                {"role": "system", "content": comic_continue_instruction(prompt_format)},
                {"role": "user", "content": [
                    {"type": "text", "text": (
                        "上一格实际成图如下。请据此优化下一格，不要猜测未显示的细节。\n\n"
                        f"角色稳定设定：\n{character_bible or '未提供'}\n\n"
                        f"视觉连续性规则：\n{visual_bible or '未提供'}\n\n"
                        f"下一格既定分镜：\n{json.dumps(next_panel_context, ensure_ascii=False)}"
                    )},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ]},
            ]
            result = call_ai(messages, request_label="漫画看图续写请求", timeout_multiplier=2)
            return web.json_response(normalize_comic_continue_result(result, prompt_format))
        except (json.JSONDecodeError, ValueError, TypeError, OSError) as error:
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
    if config["reasoning_effort"] != "off":
        payload["reasoning_effort"] = config["reasoning_effort"]
    if config["use_json_mode"]:
        payload["response_format"] = {"type": "json_object"}

    timeout_seconds = max(10, min(int(config["timeout_seconds"] * timeout_multiplier), 300))
    session = requests.Session()
    session.trust_env = config["use_system_proxy"]

    def post(request_payload):
        try:
            return request_with_upstream_retries(
                lambda: session.post(
                    chat_endpoint(config["api_url"], config["append_chat_completions"]),
                    headers={
                        "Authorization": f"Bearer {config['api_key']}",
                        "Content-Type": "application/json",
                    },
                    json=request_payload,
                    timeout=timeout_seconds,
                ),
                request_label,
            )
        except RuntimeError as error:
            transport_error = error.__cause__
            if isinstance(transport_error, requests.exceptions.Timeout):
                route = "系统代理" if config["use_system_proxy"] else "直连"
                raise RuntimeError(
                    f"{request_label}在自动重试 {UPSTREAM_RETRY_COUNT} 次后仍超时（{timeout_seconds} 秒，当前使用{route}）。"
                    "请在悬浮窗设置中检查 API 地址，或提高请求超时后重试。"
                ) from error
            raise

    response = post(payload)
    # Some OpenAI-compatible gateways reject optional structured-output or
    # reasoning controls. Retry once without those optional fields.
    if not response.ok and response.status_code in {400, 404, 422}:
        retry_payload = dict(payload)
        retry_payload.pop("response_format", None)
        retry_payload.pop("reasoning_effort", None)
        if retry_payload != payload:
            response = post(retry_payload)

    if not response.ok:
        status_code = response.status_code
        detail = response.text[:500].strip()
        if status_code == 504:
            detail = f"{request_label}的上游网关超时（504）。"
            if "图片" in request_label:
                detail += "请确认当前模型支持图片输入，或更换支持视觉的模型后重试。"
            else:
                detail += "请检查 API 网关状态后重试。"
        elif "<html" in detail.lower() or "text/html" in response.headers.get("content-type", "").lower():
            detail = "上游服务没有返回可读的模型结果，请检查 API 网关后重试。"
        if is_retryable_upstream_response(response):
            detail = f"{detail} 已自动重试 {UPSTREAM_RETRY_COUNT} 次仍未恢复。"
        raise RuntimeError(f"AI Prompt Assistant request failed ({status_code}): {detail}")

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


def chat_instruction(strip_style=True):
    return """You are a practical Chinese-speaking creative director inside a ComfyUI image-generation workspace.
Act as a continuing creative agent: remember confirmed decisions, distinguish confirmed choices from suggestions, discuss and refine ideas over multiple turns, and use the supplied read-only workflow state when it is relevant. Do not force image generation when the user is brainstorming or asking a question. If their request is vague or they say they have no idea, propose one strong visual concept yourself instead of making them do all the ideation. Preserve explicit requirements and avoid named artists, copyrighted characters, or unsupported claims.
Return only one JSON object with exactly these fields:
{
  "reply": "short Chinese conversational reply",
  "creative_title": "short Chinese title for the current creative direction",
  "concept_summary": "short Chinese summary of the current strongest concept",
  "creative_decisions": ["confirmed or strongly recommended creative decision"],
  "open_questions": ["one focused question only when a decision is genuinely needed"],
  "creative_brief": "a complete Chinese image brief ready for image generation, or an empty string while clarifying",
  "style_or_constraints": "Chinese style, composition, lighting, framing, and constraints, or an empty string",
  "prompt_format": "tag, natural, or structured",
  "ready_to_generate": true,
  "next_action": "chat, update_plan, or generate",
  "session_memory": "short Chinese summary of confirmed preferences and decisions for later turns"
}
When the user asks for inspiration or asks to generate, provide a usable creative_title, concept_summary, creative_decisions, creative_brief and style_or_constraints, then set ready_to_generate true. When more information is genuinely needed, ask exactly one focused open_questions item, keep creative_brief empty, and set ready_to_generate false. Do not add open_questions merely to be conversational once a usable brief is ready. Choose tag for most anime/SD workflows, natural for Flux-like models, and structured when the user asks for precise scene control. The user controls the negative prompt and generation parameters separately. {style_instruction} Never claim to have changed the workflow: only recommend the next action.""".replace("{style_instruction}", style_prompt_instruction(strip_style))


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
        "creative_title": str(result.get("creative_title", "")).strip()[:80],
        "concept_summary": str(result.get("concept_summary", "")).strip()[:500],
        "creative_decisions": [str(item).strip()[:300] for item in result.get("creative_decisions", []) if str(item).strip()][:5] if isinstance(result.get("creative_decisions"), list) else [],
        "open_questions": [str(item).strip()[:300] for item in result.get("open_questions", []) if str(item).strip()][:2] if isinstance(result.get("open_questions"), list) else [],
        "creative_brief": creative_brief,
        "style_or_constraints": str(result.get("style_or_constraints", "")).strip(),
        "prompt_format": prompt_format,
        "ready_to_generate": ready_to_generate,
        "next_action": next_action,
        "session_memory": str(result.get("session_memory", "")).strip()[:1600],
    }


def reverse_prompt_instruction(prompt_format="tag", strip_style=True):
    prompt_format = normalize_prompt_format(prompt_format)
    format_instruction = (
        "Write a complete, richly detailed English natural-language description in coherent sentences."
        if prompt_format == "natural"
        else "Write a detailed English comma-separated tag prompt with meaningful, concrete phrases."
    )
    return """You are a visual analyst and ComfyUI prompt director. Inspect the supplied image carefully and turn only its visible evidence into a practical image-generation prompt.
Return only one strict JSON object with exactly this shape:
{
  "summary": "short Chinese description of what is visibly in the image",
  "prompt": "detailed English positive prompt ready for ComfyUI",
  "negative_prompt": "useful English negative prompt, or an empty string",
  "details": ["主体与动作", "构图与镜头", "光线与色彩", "材质与风格"]
}
Rules:
- Describe visible subjects, pose or action, setting, composition, perspective, camera or lens impression, lighting, colors, materials, and texture.
- The prompt field must be English, concrete, self-contained, and immediately usable for image generation. {format_instruction}
- The summary and details fields must be concise Chinese. Keep details to four to eight useful observations.
- Do not guess the source, author, model, photographer, hidden context, identity, copyright, or details outside the frame.
- Do not use named artists, copyrighted characters, franchise names, or unsupported technical claims.
- Never include sampler, scheduler, steps, CFG, seed, image dimensions, or workflow instructions in the prompt.
- If text in the image is not clearly readable, describe it as visible text or signage rather than inventing its words.
{style_instruction}
""".replace("{format_instruction}", format_instruction).replace("{style_instruction}", style_prompt_instruction(strip_style))


def normalize_reverse_prompt_result(result, prompt_format="tag", strip_style=True):
    result = result if isinstance(result, dict) else {}
    prompt = str(result.get("prompt", result.get("positive_prompt", result.get("positivePrompt", "")))).strip()
    if not prompt:
        raise RuntimeError("AI 没有返回可用的正向提示词，请确认当前模型支持图片输入后重试。")
    if strip_style:
        prompt = strip_style_prompt(prompt)
    if not prompt:
        raise RuntimeError("去除画风词后没有剩余的正向提示词，请关闭该选项或补充主体要求后重试。")
    negative_prompt = str(result.get("negative_prompt", result.get("negativePrompt", ""))).strip()
    if strip_style:
        negative_prompt = strip_style_prompt(negative_prompt)
    raw_details = result.get("details", [])
    details = [str(item).strip()[:500] for item in raw_details if str(item).strip()] if isinstance(raw_details, list) else []
    return {
        "summary": str(result.get("summary", result.get("image_summary", ""))).strip()[:1000],
        "prompt": prompt[:12000],
        "negative_prompt": negative_prompt[:6000],
        "details": details[:8],
        "prompt_format": normalize_prompt_format(prompt_format),
    }


def comic_instruction(prompt_format, panel_count):
    prompt_format = normalize_prompt_format(prompt_format)
    format_instruction = {
        "tag": "Each positive_prompt must be an exhaustive, high-density English comma-separated tag prompt. Do not shorten it for brevity: include stable character identity, appearance, hair, expression, outfit, accessories, pose, action, setting, time, atmosphere, composition, perspective, camera, lighting, color, materials, textures, rendering details, and meaningful quality descriptors. Put identity and composition first. Avoid sentences, duplicate filler, contradictions, and empty keyword spam.",
        "natural": "Each positive_prompt must be a complete, richly detailed English natural-language image description. Do not shorten it for brevity: describe stable character identity, physical appearance, wardrobe, accessories, expression, pose, action, setting, time, atmosphere, composition, camera perspective, lighting, color script, materials, textures, rendering, and meaningful quality details. Use as much precise detail as needed, without repetitive filler or contradictions.",
        "structured": "Each positive_prompt must be a complete, high-detail English prompt ordered as subject, appearance, wardrobe, action, setting, composition, lighting, camera, materials, and style. Do not shorten it for brevity; keep every detail concrete, non-repetitive, and useful for generation.",
    }[prompt_format]
    return f"""You are a Chinese-speaking comic director for a ComfyUI image-generation workflow.
Turn one user idea into a coherent short comic that is rendered one panel at a time. Make decisive creative choices when the idea is vague. Keep recurring people, outfits, props, lighting, era, art direction, and story progression consistent. Do not use named artists, copyrighted characters, or franchise names.
Return only one strict JSON object with exactly this shape:
{{
  "title": "Chinese comic title",
  "logline": "Chinese one-sentence story summary",
  "character_bible": "Chinese stable character description, including appearance, clothing, accessories, and what must remain unchanged",
  "visual_bible": "Chinese stable art direction, color script, setting, framing, and continuity rules",
  "panels": [
    {{"index": 1, "beat": "Chinese story beat", "shot": "Chinese shot description", "continuity": "Chinese continuity requirement", "positive_prompt": "final English image-generation prompt"}}
  ]
}}
You must return exactly {panel_count} panels in chronological order. Every positive_prompt must already include all stable character and visual details needed to generate that panel independently, plus the panel-specific action and shot. Never put instructions, placeholders, Chinese text, or negative prompts in positive_prompt. Prompt format: {prompt_format}. {format_instruction}
{LORA_MANAGER_INSTRUCTION}"""


def normalize_comic_plan(result, panel_count, prompt_format):
    result = result if isinstance(result, dict) else {}
    raw_panels = result.get("panels")
    if not isinstance(raw_panels, list) or len(raw_panels) != panel_count:
        raise ValueError(f"AI 返回的分镜数量不正确，需要 {panel_count} 格。请重试。")
    panels = []
    for position, raw in enumerate(raw_panels, start=1):
        raw = raw if isinstance(raw, dict) else {}
        prompt = strip_lora_syntax(raw.get("positive_prompt", ""))
        if not prompt:
            raise ValueError(f"AI 返回的第 {position} 格缺少英文正向提示词。请重试。")
        panels.append({
            "index": position,
            "beat": str(raw.get("beat", "")).strip() or f"第 {position} 格剧情",
            "shot": str(raw.get("shot", "")).strip() or "镜头待补充",
            "continuity": str(raw.get("continuity", "")).strip() or "保持角色与画风一致",
            "positive_prompt": prompt,
        })
    return {
        "title": str(result.get("title", "未命名漫画")).strip() or "未命名漫画",
        "logline": str(result.get("logline", "")).strip(),
        "character_bible": str(result.get("character_bible", "")).strip(),
        "visual_bible": str(result.get("visual_bible", "")).strip(),
        "prompt_format": normalize_prompt_format(prompt_format),
        "panels": panels,
    }


def comic_continue_instruction(prompt_format):
    prompt_format = normalize_prompt_format(prompt_format)
    format_instruction = {
        "tag": "Use an exhaustive, high-density English comma-separated tag prompt. Preserve every visible recurring trait, clothing detail, prop, setting cue, composition, camera, lighting, color, material, and rendering detail needed for continuity. Do not shorten for brevity; avoid duplicated filler and contradictions.",
        "natural": "Use a complete, richly detailed English natural-language image description. Preserve every visible recurring trait, wardrobe detail, prop, setting cue, composition, camera, lighting, color, material, and rendering detail needed for continuity. Do not shorten for brevity; avoid repeated filler and contradictions.",
        "structured": "Use a complete, high-detail English prompt ordered as subject, appearance, wardrobe, action, setting, composition, lighting, camera, materials, and style. Do not shorten for brevity; keep every detail concrete and useful for continuity.",
    }[prompt_format]
    return f"""You are a Chinese-speaking comic continuity director for a ComfyUI image-generation workflow.
You receive the actual previous comic panel as an image and the already-written plan for the next panel. Improve only the next panel's English positive prompt so it follows from the visible previous image while preserving the supplied character bible, visual bible, narrative beat, shot, and any user edits already in the planned prompt. Do not change the story beat into a different event. Do not add a negative prompt, sampler, scheduler, size, CFG, steps, seed, or any other generation parameter. Do not use named artists, copyrighted characters, or franchise names.
Return only one strict JSON object with exactly this shape:
{{
  "positive_prompt": "final English image-generation prompt for the next panel",
  "continuity_note": "short Chinese note about what was carried into the next panel"
}}
The positive_prompt must be English only, self-contained, and immediately usable for image generation. Prompt format: {prompt_format}. {format_instruction}
{LORA_MANAGER_INSTRUCTION}"""


def strip_lora_syntax(value):
    """Keep loader directives out of text sent to Prompt (LoraManager)."""
    prompt = str(value or "")
    prompt = re.sub(r"<lora:[^>]+>", "", prompt, flags=re.IGNORECASE)
    prompt = re.sub(r"\s*,\s*,+", ", ", prompt)
    prompt = re.sub(r"\s{2,}", " ", prompt)
    return prompt.strip(" ,")


def normalize_comic_continue_result(result, prompt_format):
    result = result if isinstance(result, dict) else {}
    prompt = strip_lora_syntax(result.get("positive_prompt", ""))
    if not prompt:
        raise ValueError("AI 未返回下一格的英文正向提示词。")
    return {
        "positive_prompt": prompt,
        "continuity_note": str(result.get("continuity_note", "")).strip()[:1000],
        "prompt_format": normalize_prompt_format(prompt_format),
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


def planner_instruction(prompt_format, allow_parameter_tuning=True, strip_style=True):
    prompt_format = normalize_prompt_format(prompt_format)
    sampler_names = ", ".join(sampler_options())
    schedulers = ", ".join(scheduler_options())
    format_instructions = {
        "tag": "Use an exhaustive, production-quality English comma-separated tag prompt. Do not reduce prompt length for brevity. Cover subject identity and physical traits, hair, face, expression, body language, outfit, accessories, action, environment, time, atmosphere, composition, perspective, camera/lens, lighting, color palette, materials, textures, rendering and meaningful quality details. Put subject identity and composition first; avoid full sentences, duplicate filler, conflicting terms, and empty keyword spam.",
        "natural": "Use a complete, richly detailed English natural-language image description, not a shortened tag list. Do not reduce prompt length for brevity. Cover subject identity and physical traits, hair, face, expression, body language, outfit, accessories, action, environment, time, atmosphere, composition, perspective, camera/lens, lighting, color palette, materials, textures, rendering and meaningful quality details. Write one coherent, directly usable description without repetitive filler or contradictions.",
        "structured": "Think in complete sections (subject identity and appearance, wardrobe, action, environment, composition, lighting, camera, materials, rendering and style), then combine them into one detailed English prompt. Do not reduce prompt length for brevity. Keep the JSON fields flat, make positive_prompt directly usable, and avoid repetitive filler or contradictions.",
    }.get(prompt_format, "Use an exhaustive, production-quality English comma-separated tag prompt without shortening it for brevity.")
    return f"""You are a ComfyUI prompt director. Convert the user's Chinese or English creative brief into practical image-generation prompts.
Return only one JSON object with this exact shape:
{{
  "positive_prompt": "English comma-separated prompt",
  "negative_prompt": "English comma-separated negative prompt, or an empty string when unsuitable",
  "parameters": {{"sampler_name": "...", "scheduler": "...", "steps": 28, "cfg": 5.0, "width": 1024, "height": 1024, "denoise": 1.0}},
  "reasoning": "short Chinese explanation"
}}
Use English for both prompts. Preserve every explicit user requirement. The positive_prompt has no plugin-imposed length target: include all concrete details needed for a high-quality result, and never abbreviate it merely to be concise. Do not invent named artists, copyrighted characters, or unsupported technical claims. Prefer meaningful specificity over repeated generic quality words.
Prompt format: {prompt_format}. {format_instructions}
Choose sampler_name only from: {sampler_names}
Choose scheduler only from: {schedulers}
Use 1-80 steps, CFG 0-20, dimensions from 64 to 2048 divisible by 8, and denoise 0-1.
{"You may recommend parameter changes when they materially improve the result." if allow_parameter_tuning else "Do not optimize parameters; they are locked by the user and will not be applied."}
{style_prompt_instruction(strip_style)}
{LORA_MANAGER_INSTRUCTION}"""


def pil_to_data_url(pil_image):
    pil_image = pil_image.convert("RGB")
    resampling = getattr(Image, "Resampling", Image).LANCZOS
    # Vision APIs do not benefit from a lossless full-resolution upload here.
    # A bounded JPEG greatly reduces proxy/gateway timeouts while retaining
    # enough detail for composition and prompt review.
    pil_image.thumbnail((1024, 1024), resampling)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="JPEG", quality=88, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def image_to_data_url(image):
    tensor = image[0].detach().cpu().numpy()
    pixels = np.clip(tensor * 255.0, 0, 255).astype(np.uint8)
    return pil_to_data_url(Image.fromarray(pixels))


def comic_output_image_data_url(image_info):
    """Load a ComfyUI output or temporary preview image within its safe root."""
    image_type = str(image_info.get("type", "output")).strip().lower()
    if image_type not in {"output", "temp"}:
        raise ValueError("看图续写只支持 ComfyUI 的 output 或 temp 图片。")
    filename = str(image_info.get("filename", "")).strip()
    subfolder = str(image_info.get("subfolder", "")).strip()
    if not filename:
        raise ValueError("成图文件名不能为空。")
    relative_path = Path(subfolder) / Path(filename)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError("成图路径无效。")
    root_getter = folder_paths.get_temp_directory if image_type == "temp" else folder_paths.get_output_directory
    image_root = Path(root_getter()).resolve()
    image_path = (image_root / relative_path).resolve()
    try:
        image_path.relative_to(image_root)
    except ValueError as error:
        raise ValueError("成图路径不在 ComfyUI 图片目录中。") from error
    if not image_path.is_file():
        directory_name = "temp" if image_type == "temp" else "output"
        raise ValueError(f"找不到上一格成图，请确认 ComfyUI {directory_name} 目录中的文件仍存在。")
    try:
        with Image.open(image_path) as opened_image:
            return pil_to_data_url(opened_image)
    except (OSError, ValueError) as error:
        raise ValueError("无法读取上一格成图。") from error


def result_tuple(result, seed, fallback, allow_parameter_tuning=True, negative_override=None, strip_style=False):
    parameters = sanitize_parameters(result.get("parameters"), fallback) if allow_parameter_tuning else fallback
    positive = strip_lora_syntax(result.get("positive_prompt", ""))
    if strip_style:
        positive = strip_style_prompt(positive)
    negative = str(negative_override).strip() if negative_override is not None else str(result.get("negative_prompt", "")).strip()
    if strip_style and negative_override is None:
        negative = strip_style_prompt(negative)
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


def normalize_review_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1", "satisfied"}
    return bool(value) if value is not None else None


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
    satisfied = normalize_review_bool(result.get("satisfied")) if enabled else None
    report = {
        "enabled": enabled,
        "prompt_format": normalize_prompt_format(prompt_format),
        "score": overall_score,
        "scores": scores,
        "confidence": result.get("confidence", None),
        "satisfied": satisfied,
        "stop_reason": str(result.get("stop_reason", "")).strip(),
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
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
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
                "lora_context": ("STRING", {"multiline": True, "default": "", "placeholder": "Optional LoraManager context."}),
                "strip_style": ("BOOLEAN", {"default": True, "tooltip": "Remove art-style words so the LoRA controls the visual style."}),
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

    def plan(self, creative_brief, image_model, prompt_format="tag", seed=0, style_or_constraints="", negative_prompt="", lora_context="", strip_style=True, **user_parameters):
        if not creative_brief.strip():
            raise ValueError("Creative brief cannot be empty.")
        prompt_format = normalize_prompt_format(prompt_format)
        config = load_config()
        fallback = sanitize_parameters(user_parameters, DEFAULT_PARAMETERS)
        result = call_ai([
            {"role": "system", "content": planner_instruction(prompt_format, config["allow_parameter_tuning"], normalize_bool(strip_style, True))},
            {"role": "user", "content": f"Image model: {image_model}\nPrompt format: {prompt_format}\nCreative brief: {creative_brief}\nConstraints: {style_or_constraints}\nLoRA Manager context:\n{lora_context or 'No LoraManager node was detected.'}"},
        ])
        output = result_tuple(
            result,
            seed,
            fallback,
            config["allow_parameter_tuning"],
            negative_prompt,
            normalize_bool(strip_style, True),
        )
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
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
            },
            "optional": {
                "sampler_name": ("STRING", {"default": DEFAULT_PARAMETERS["sampler_name"]}),
                "scheduler": ("STRING", {"default": DEFAULT_PARAMETERS["scheduler"]}),
                "steps": ("INT", {"default": DEFAULT_PARAMETERS["steps"], "min": 1, "max": 10000}),
                "cfg": ("FLOAT", {"default": DEFAULT_PARAMETERS["cfg"], "min": 0.0, "max": 100.0}),
                "width": ("INT", {"default": DEFAULT_PARAMETERS["width"], "min": 64, "max": 16384}),
                "height": ("INT", {"default": DEFAULT_PARAMETERS["height"], "min": 64, "max": 16384}),
                "denoise": ("FLOAT", {"default": DEFAULT_PARAMETERS["denoise"], "min": 0.0, "max": 1.0}),
                "lora_context": ("STRING", {"multiline": True, "default": "", "placeholder": "Optional LoraManager context."}),
            },
        }

    RETURN_TYPES = AIPromptPlanner.RETURN_TYPES
    RETURN_NAMES = AIPromptPlanner.RETURN_NAMES
    FUNCTION = "review"
    OUTPUT_NODE = True
    CATEGORY = "AI 提示词助手"
    DESCRIPTION = "将连接的成图发送给已配置的视觉模型，返回优化后的提示词和采样参数建议。"

    def review(self, image, current_positive_prompt, current_negative_prompt, revision_request, enable_review, image_model, prompt_format="tag", seed=0, lora_context="", **current_parameters):
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
        instruction = planner_instruction(prompt_format, config["allow_parameter_tuning"], False).replace(
            "Convert the user's Chinese or English creative brief into practical image-generation prompts.",
            "Review the connected generated image and revise its prompts and sampling settings. Preserve the current result where the user's revision request says to preserve it."
        )
        user_text = (
            f"Image model: {image_model}\n"
            f"Prompt format: {prompt_format}\n"
            f"Current positive prompt: {current_positive_prompt}\n"
            f"Current negative prompt: {current_negative_prompt}\n"
            f"Current parameters: {json.dumps(fallback)}\n"
            f"LoRA Manager context:\n{lora_context or 'No LoraManager node was detected.'}\n"
            f"Revision request: {revision_request or 'Assess the image and make only high-confidence improvements.'}"
        )
        instruction += """
For review reporting, also include these flat fields:
- score: an overall 0-100 score for the current image before revisions.
- confidence: 0-1 confidence in the assessment.
- scores: an object with composition, prompt_alignment, subject_clarity, and technical_quality, each scored 0-100.
- satisfied: true only when the image already meets the user's request and no meaningful revision is needed; otherwise false.
- stop_reason: a short Chinese explanation of why the review loop may stop or should continue.
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
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
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

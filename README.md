# ComfyUI AI Prompt Assistant

This extension adds two nodes under `AI Prompt Assistant`:

- `AI Prompt Planner` turns a creative brief into a positive prompt. The negative prompt and generation settings remain under your control.
- `AI Image Reviewer` sends a generated image and your revision request to a vision-capable model, then returns a revised prompt and settings for the next run.

## Configuration

无需复制或手动创建 `config.json`。安装插件后，打开悬浮窗右上角的“设置”，填写 API 地址和 API Key，点击“刷新模型列表”后从可搜索列表选择模型，再点击“保存配置”。插件会自动将配置保存到 ComfyUI 用户配置目录，不会写入工作流，也不会随插件更新被覆盖。默认会将 API 地址自动补全为 `/chat/completions`；如果服务商已给出完整的自定义请求地址，可以关闭该选项。模型列表获取失败时，也可以直接在模型框手动输入模型名称。设置页只显示 API Key 的掩码；留空 API Key 保存时会保留已经保存的 Key。

设置页提供“允许 AI 在完成后覆盖出图参数”开关。关闭后，采样器、步数、CFG、画幅和降噪会保留用户在悬浮窗“出图参数”中填写的值。该区域可随时“读取工作流”或“应用到工作流”，并同步采样器、Latent 与两个 AI 节点。固定反向提示词也只由用户填写，规划和评审均不会改写它。图片评审是否上传图片仅由评审页或节点中的“启用 AI 图片评审”控制，默认关闭。

两个 AI 节点的“出图模型”会自动读取本机 `models/checkpoints` 和 `models/unet`（也包含 `models/diffusion_models`）中的权重，并在下拉框中标记来源。复制新模型文件后，可以在悬浮窗“设置”中点击“刷新本机出图模型”更新已经打开的节点。采样器和调度器不是模型文件，插件会读取当前 ComfyUI 已注册的可用列表作为下拉选项，因此只会显示这台机器实际可运行的名称。

模型刷新请求兼容 OpenAI 风格的 `GET <API 地址>/models`，并读取返回的 `data[].id`。如果服务商没有提供 `/models`，可以手动把模型写入 `config.json` 的 `model` 字段后再打开设置页保存其他选项。

图片评审会将图片压缩为最大边 1024px 的 JPEG 后发送，以降低网关超时风险；评审请求会使用普通提示词请求的两倍超时（最多 300 秒）。插件默认直连 API 地址。只有服务商确实需要代理时，才在设置页打开“通过系统代理访问 AI 服务”。

Alternatively set these environment variables before starting ComfyUI:

```powershell
$env:COMFY_AI_ASSISTANT_API_URL = "https://api.openai.com/v1"
$env:COMFY_AI_ASSISTANT_API_KEY = "your-api-key"
$env:COMFY_AI_ASSISTANT_MODEL = "gpt-4.1-mini"
$env:COMFY_AI_ASSISTANT_JSON_MODE = "true"
```

Environment variables provide the initial default when no saved setting exists. Once a value is saved in the Settings page, the saved value takes precedence so API endpoints and models can be switched without restarting ComfyUI. The service receives the creative brief for `AI Prompt Planner`. `AI Image Reviewer` also uploads the connected image, current prompts, and revision request to that service. Do not connect private images unless you accept that transfer.

通过设置页保存的 API Key 只写入 ComfyUI 用户配置目录，不会写入工作流 metadata、前端日志或模型列表响应。已保存的设置优先于环境变量，因此可随时在设置页切换 API 地址、Key 或模型，并立即生效。环境变量只在首次尚未保存对应设置时作为默认值使用。

Changes saved in the Settings page take effect for the next AI request. Restarting ComfyUI is only needed after installing or updating the plugin.

`use_json_mode` asks the Chat Completions endpoint to return a JSON object. It
is enabled by default and automatically retried without `response_format` when
an older OpenAI-compatible gateway rejects that option. Set it to `false` for
gateways that do not accept JSON mode.

## Prompt formats

Both AI nodes expose `prompt_format` and the floating assistant can change it
before queuing a run:

- `tag`: concise English comma-separated tags, usually a good default for
  SDXL and anime checkpoints.
- `natural`: fluent English sentences, useful for Flux and models that follow
  natural-language descriptions well.
- `structured`: a readable prompt assembled from subject, action, environment,
  composition, lighting, camera, and style sections.

The API still returns the same stable fields (`positive_prompt`,
`negative_prompt`, `parameters`, and `reasoning`) regardless of the selected
format, so existing downstream connections continue to work.

## Image review score

When image review is enabled, the reviewer returns an overall score out of 100, confidence, and four visible quality dimensions: composition, prompt alignment, subject clarity, and technical quality. The floating panel shows the score, rating level, dimension bars, and the AI's observations and suggested changes. Scores are assessments of the current generated image, not a guarantee of a future generation result.

## AI 创作 Agent

悬浮窗的 `AI 对话` 是一个持续创作会话，而不是一次性“文字转提示词”按钮。你可以一直与它讨论灵感、角色、构图、配色和修改方向；它会记住已经确认的偏好，并在每次回复时只读当前工作流的提示词、固定反向提示词、模型、采样器、画幅与成图来源。

当方案尚未确定时，Agent 会继续聊天或提出一个聚焦问题，这时不会启用出图操作。只有它给出完整创作方案后，才会显示可用的 `写入创作需求` 与 `交给工作流生成`。前者会把方案同步到悬浮窗和画布中的 `AI Prompt Planner` 节点，但不会切换页面或排队；后者才会提交提示词规划任务。两者都不会修改你的固定反向提示词，也不会未经点击直接排队出图。

对话记录与已确认的简短记忆保存在当前浏览器的 ComfyUI 页面本地，刷新页面后可以继续聊天。右上角的 `新对话` 会创建一个新会话，不会清除旧记录；每个会话的消息、已确认记忆和已整理方案完全独立，不会串到其他对话。切换会话也不会改动画布、工作流或 API 配置。

点击标题栏的 `展开聊天` 可以进入完整聊天工作台：左侧显示对话记录，右侧持续滚动并固定输入区，适合长时间连续讨论；点击同一位置的 `收起聊天` 可返回悬浮窗。聊天工作台不会改变节点画布的布局。

聊天输入区可以点击 `上传图片` 附加 PNG、JPG、WEBP 或 GIF 图片（最大 8 MB）。填写你的要求后点击 `发送给 AI`，或直接点击 `反推提示词`，让支持视觉输入的大模型根据参考图整理主体、构图、镜头、光线、色彩和风格。图片只会在本次发送时上传至你在设置页配置的 AI 服务，不会写入工作流或浏览器对话存储；请不要上传不愿发送给该服务的私密图片。

## Workflow

The floating panel is the recommended entry point. It does not require searching the node menu first:

1. Open `AI 对话`. Describe an idea, a feeling, or simply say `我没有想法`. Continue the conversation until the Agent returns a complete `创作需求` and `风格与约束` plan.
2. Click `写入创作需求` to inspect or adjust that plan in `提示词规划`; click `交给工作流生成` to create a planning node if needed, copy the plan into it, and queue prompt planning immediately. The chat does not change your fixed negative prompt.
3. In `提示词规划`, the panel detects the positive/negative `CLIP Text Encode`, sampler, latent size, and decoded image source. Check these in `工作流节点映射`; use `重新识别` or select a different node only when the detected mapping is wrong.
4. Generate the image as usual. Open `图片评审`, click `添加` beside `评审节点`, leave `成图来源` on the detected `VAE Decode`-like node, write the desired changes, enable image review, then click `连接成图并评审`.
5. The assistant connects `IMAGE -> AI Image Reviewer`, copies the current prompts and available sampler settings into the reviewer, and shows the score and changes after completion. The source must be an IMAGE-producing node such as `VAE Decode`, not `Save Image`.

`AI Prompt Planner` can be queued on its own from the panel. It writes its completed prompts and parameters back to the mapped workflow widgets. To use typed node links instead, connect its positive and negative outputs to two `CLIP Text Encode` nodes, its width and height outputs to `Empty Latent Image`, and its sampling outputs to `AI Adaptive KSampler`.

`AI Adaptive KSampler` is intentionally separate from the standard KSampler. This lets the AI-supplied sampler and scheduler values flow through typed string connections without modifying ComfyUI's core sampler node.

## Workflow mapping

The floating assistant scans the current canvas and suggests mappings for positive prompt, negative prompt, sampler, latent size, and a connectable `IMAGE` source. It prioritizes decoded image outputs that are already feeding Save Image or Preview Image. `连接成图并评审` is the only action that changes a graph link; it connects the selected image source to the reviewer and can replace an existing image link on that reviewer.

Each mapping can be selected manually and located on the canvas. Manual choices are stored in the workflow's `extra.aiPromptAssistantMapping` metadata. Use `重新识别` to discard manual choices and scan the current workflow again.

The planner and reviewer only choose sampler names and schedulers available in this local ComfyUI installation. They cannot download models, change files, or install extensions.

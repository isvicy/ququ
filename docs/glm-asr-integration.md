# GLM-ASR-Nano 集成文档

## 一、集成过程

### 1.1 模型选型

在评估了多个语音识别模型后，选择了智谱开源的 **GLM-ASR-Nano-2512**：

| 模型 | 参数量 | 特点 | 选择理由 |
|------|--------|------|----------|
| FunASR (Paraformer) | ~220M | 阿里开源，中文优化 | 原有方案 |
| GLM-ASR-Nano | 1.5B | 智谱开源，中英混合优化 | 更好的中英混合识别 |
| Whisper | 多版本 | OpenAI，多语言 | 中文效果一般 |

### 1.2 核心依赖

```toml
# pyproject.toml
dependencies = [
    "torch>=2.1.0",
    "torchaudio>=2.1.0",
    "transformers==4.51.3",  # GLM-ASR 要求的特定版本
    "librosa>=0.11.0",       # 音频加载
]
```

**关键约束**：`transformers==4.51.3` 是硬性要求，因为新版本移除了 `WhisperFlashAttention2` 类。

### 1.3 服务器实现

创建 `glm_asr_server.py` 作为独立的 Python 服务进程：

```
┌─────────────────────────────────────────────────────────┐
│                    Electron 主进程                       │
│  ┌─────────────────────────────────────────────────┐   │
│  │              glmAsrManager.js                    │   │
│  │  - spawn Python 子进程                           │   │
│  │  - stdin/stdout JSON 通信                        │   │
│  │  - 管理模型生命周期                               │   │
│  └─────────────────────────────────────────────────┘   │
│                         │                               │
│                    stdin/stdout                         │
│                         │                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │              glm_asr_server.py                   │   │
│  │  - 持久化模型在 GPU 内存                          │   │
│  │  - 处理转录请求                                   │   │
│  │  - 返回 JSON 结果                                │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 1.4 通信协议

Node.js 与 Python 通过 JSON 进行通信：

**请求示例**：
```json
{"action": "transcribe", "audio_path": "/tmp/audio.wav", "options": {}}
```

**响应示例**：
```json
{"success": true, "text": "识别结果", "duration": 3.5, "language": "auto"}
```

### 1.5 NixOS 适配

NixOS 的 CUDA 库位于特殊路径，需要额外配置：

```javascript
// glmAsrManager.js - buildPythonEnvironment()
const nixosCudaLib = '/run/opengl-driver/lib';
if (fs.existsSync(nixosCudaLib)) {
  env.LD_LIBRARY_PATH = `${nixosCudaLib}:${env.LD_LIBRARY_PATH}`;
}
```

同时提供 `.envrc` 和 `shell.nix` 供开发使用。

---

## 二、架构设计

### 2.1 工厂模式

使用 **工厂模式** 统一管理多个 ASR 引擎：

```
┌─────────────────────────────────────────────────────────┐
│                  ASRManagerFactory                       │
│  ┌─────────────────────────────────────────────────┐   │
│  │  createManager(engine)                           │   │
│  │    ├─ "funasr"  → FunASRManager                 │   │
│  │    └─ "glm-asr" → GLMASRManager                 │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

```javascript
// main.js
const asrManagerFactory = new ASRManagerFactory(logger);
const asrEngineSetting = databaseManager.getSetting('asr_engine') || 'funasr';
asrManager = asrManagerFactory.createManager(asrEngineSetting);
```

### 2.2 统一接口

两个 Manager 实现相同的接口，确保上层代码无需修改：

```typescript
interface ASRManager {
  // 核心方法
  transcribeAudio(audioBlob, options): Promise<TranscriptionResult>
  checkStatus(): Promise<StatusResult>

  // 生命周期
  initializeAtStartup(): Promise<void>
  restartServer(): Promise<Result>

  // 兼容属性
  modelsInitialized: boolean
  serverReady: boolean

  // 模型管理
  checkModelFiles(): Promise<ModelFilesResult>
  downloadModels(progressCallback): Promise<Result>
}
```

### 2.3 模块关系

```
src/helpers/
├── asrManagerFactory.js    # 工厂：根据设置创建对应 Manager
├── funasrManager.js        # FunASR 引擎管理器
├── glmAsrManager.js        # GLM-ASR 引擎管理器
└── ipcHandlers.js          # IPC 处理：透明调用当前 Manager

main.js
├── 读取 asr_engine 设置
├── 通过工厂创建 Manager
└── 注入到 ipcHandlers

settings.jsx
└── ASR 引擎选择 UI（需重启生效）
```

### 2.4 配置存储

引擎选择保存在 SQLite 数据库：

```javascript
// 读取
const engine = databaseManager.getSetting('asr_engine') || 'funasr';

// 保存（通过设置页面）
databaseManager.setSetting('asr_engine', 'glm-asr');
```

### 2.5 模型加载策略

| 引擎 | 模型位置 | 加载时机 |
|------|----------|----------|
| FunASR | 本地缓存 | 应用启动时预加载 |
| GLM-ASR | HuggingFace Hub | 首次使用时自动下载并缓存 |

GLM-ASR 模型缓存路径：`~/.cache/huggingface/hub/models--zai-org--GLM-ASR-Nano-2512/`

### 2.6 性能对比

在 RTX 4090 上的测试结果：

| 指标 | FunASR | GLM-ASR-Nano |
|------|--------|--------------|
| 模型加载 | ~5s | ~2s |
| 首次推理 | ~1s | ~2s |
| 后续推理 | ~0.5s | ~1s |
| 显存占用 | ~2GB | ~4GB |
| 中英混合 | 一般 | 优秀 |

---

## 三、扩展指南

### 3.1 添加新引擎

1. 创建 `src/helpers/newEngineManager.js`，实现 ASRManager 接口
2. 在 `asrManagerFactory.js` 添加新引擎的创建逻辑
3. 在 `settings.jsx` 添加 UI 选项
4. 更新 `pyproject.toml` 添加依赖

### 3.2 切换引擎

用户可在设置页面选择引擎，修改后需重启应用生效。

---

## 四、故障排查

### 4.1 常见问题

**Q: transformers 版本不兼容**
```
ImportError: cannot import name 'WhisperFlashAttention2'
```
A: 确保使用 `transformers==4.51.3`

**Q: CUDA 不可用**
```
torch.cuda.is_available() returns False
```
A: NixOS 用户需运行 `direnv allow` 或 `nix-shell`

**Q: 模型下载失败**
A: 检查网络连接，HuggingFace 可能需要代理

### 4.2 日志位置

- Electron 日志：控制台输出
- GLM-ASR 服务器日志：`~/.config/ququ/logs/glm_asr_server.log`

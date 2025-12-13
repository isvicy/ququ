# GLM-ASR 优化调研报告

本文档记录了针对 GLM-ASR 的两项优化调研：Flash Attention 2 和流式识别。

---

## 一、Flash Attention 2 调研

### 1.1 背景

Flash Attention 2 是一种优化的注意力计算实现，理论上可以减少内存占用并提升长序列处理速度。调研目标是确认 GLM-ASR 是否能受益于 Flash Attention 2。

### 1.2 GLM-ASR 模型架构

```
GlmasrModel
├── model: LlamaModel          # LLM 骨干网络
│   ├── embed_tokens
│   ├── layers: ModuleList     # 28 层 Transformer
│   ├── norm
│   └── rotary_emb
├── lm_head: Linear
└── audio_encoder: AudioMLPAdapter
    └── whisper: WhisperSpecialEncoder
```

GLM-ASR 使用组合配置（`is_composition=True`），包含嵌套的 `lm_config`（LlamaConfig）和 `whisper_config`（WhisperConfig）。

### 1.3 兼容性问题

**问题**：当通过 `attn_implementation='flash_attention_2'` 加载模型时，该参数只设置在主 `GlmasrConfig` 上，不会传递到嵌套的 `lm_config`。

**原因**：`GlmasrModel.__init__` 调用 `super().__init__(config.lm_config)`，使用的是没有设置 `_attn_implementation` 的嵌套配置。

**解决方案**：可以在模型加载后手动修改 attention 配置：

```python
# 加载模型后强制启用 Flash Attention 2
for layer in model.model.layers:
    layer.self_attn.config._attn_implementation = 'flash_attention_2'
```

### 1.4 性能测试

测试环境：RTX 4090, CUDA 12.8, PyTorch 2.9, transformers 4.51.3

#### 纯 LLM 推理测试

| 序列长度 | SDPA (ms) | Flash Attention 2 (ms) | 加速比 |
|---------|-----------|------------------------|--------|
| 64      | 7.02      | 8.75                   | 0.80x  |
| 256     | 10.11     | 11.34                  | 0.89x  |
| 512     | 15.22     | 15.77                  | 0.96x  |
| 1024    | 26.87     | 27.26                  | 0.99x  |

#### 实际转录场景测试

| 音频长度 | SDPA (ms) | Flash Attention 2 (ms) | 加速比 |
|---------|-----------|------------------------|--------|
| 5s      | 31.6      | 33.1                   | 0.95x  |
| 10s     | 32.0      | 34.2                   | 0.94x  |
| 20s     | 94.8      | 101.7                  | 0.93x  |
| 30s     | 39.6      | 40.2                   | 0.98x  |

### 1.5 结论

**SDPA 在当前场景下性能更优**，原因：

1. **PyTorch SDPA 高度优化**：RTX 4090 的 Tensor Core 对 `torch.nn.functional.scaled_dot_product_attention` 有良好支持
2. **序列长度不够长**：ASR 场景的序列长度通常 < 1000 tokens，Flash Attention 2 的内存效率优势无法体现
3. **Flash Attention 启动开销**：对于短序列，Flash Attention 的初始化开销反而拖累性能
4. **Flash Attention 优势场景**：主要在 8K+ token 的超长序列和显存受限的情况

**建议**：保持当前默认的 SDPA 实现，无需切换到 Flash Attention 2。

---

## 二、流式识别调研

### 2.1 背景

流式识别（Streaming ASR）允许在用户说话过程中实时显示转录结果，而非等待录音结束后一次性识别。调研目标是评估为 GLM-ASR 实现流式识别的可行性和必要性。

### 2.2 GLM-ASR 原生支持情况

根据 [GLM-ASR GitHub](https://github.com/zai-org/GLM-ASR) 和 [HuggingFace](https://huggingface.co/zai-org/GLM-ASR-Nano-2512) 的文档：

- **仅支持批量推理**，没有原生的流式 API
- 计划支持 vLLM 和 SGLang 等推理框架（可能带来流式能力）

### 2.3 Whisper 类模型的流式识别挑战

| 挑战 | 说明 |
|-----|------|
| 固定窗口限制 | Whisper/GLM-ASR 训练时使用 30 秒窗口，无法直接处理实时流 |
| 词边界问题 | 简单按时间切分会在单词中间断开，导致识别错误 |
| 延迟 vs 准确性权衡 | 等待更多音频可提高准确性，但增加用户感知延迟 |
| 上下文丢失 | 分段处理会丢失跨段的语义上下文 |

### 2.4 业界流式识别方案

#### 2.4.1 whisper_streaming 方案

来源：[ufal/whisper_streaming](https://github.com/ufal/whisper_streaming)

**核心思想**：LocalAgreement-n 策略

```
如果连续 n 次更新（每次有新音频块）对前缀转录结果一致，则确认该前缀。
```

**实现要点**：
- 使用滑动窗口而非固定窗口处理音频
- 在已确认句子的时间戳处滚动缓冲区
- 利用 Whisper 的标点符号检测确定句子边界
- 达成 3.3 秒延迟的长文本转录

#### 2.4.2 Whispy 方案

来源：[arxiv 2405.03484](https://arxiv.org/html/2405.03484v1)

**核心思想**：基于 Levenshtein 距离的确认算法

```
当重叠音频区域的多次转录结果相似度超过阈值时，确认稳定部分。
```

**实现要点**：
- 处理短音频块，累积到滑动缓冲区
- 使用字符串距离算法提取最准确的转录建议
- 减少计算成本，保持可接受的时延

#### 2.4.3 VAD + 分段方案

使用语音活动检测（VAD）智能切分音频：

```
麦克风 → Silero VAD → 检测语音边界 → 按句子/短语切分 → 批量转录
```

推荐 VAD：[Silero VAD](https://github.com/snakers4/silero-vad)
- 延迟 < 1ms（单 CPU 线程）
- 支持 8kHz / 16kHz
- MIT 协议，无依赖

### 2.5 流式识别架构设计

如果需要实现流式识别，建议采用以下架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                     流式识别架构设计                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────┐   ┌──────────┐   ┌─────────────┐   ┌───────────┐ │
│  │  麦克风  │ → │ Silero   │ → │ 音频缓冲区   │ → │ GLM-ASR  │ │
│  │  输入   │   │   VAD    │   │ (滑动窗口)   │   │  推理    │ │
│  └─────────┘   └──────────┘   └─────────────┘   └───────────┘ │
│                     │                                 │        │
│                     │ 检测语音开始/结束                  │        │
│                     ▼                                 ▼        │
│              ┌──────────────────────────────────────────┐      │
│              │        LocalAgreement 确认机制            │      │
│              │  · 连续 n 次结果一致才确认输出             │      │
│              │  · 使用 Levenshtein 距离比较              │      │
│              └──────────────────────────────────────────┘      │
│                                │                               │
│                                ▼                               │
│                         ┌──────────┐                          │
│                         │ 实时输出  │                          │
│                         │ (部分结果)│                          │
│                         └──────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

### 2.6 实现工作量评估

| 阶段 | 任务 | 复杂度 | 预计工时 |
|-----|------|--------|---------|
| 1 | Python 侧集成 Silero VAD | 中 | 2-3 天 |
| 2 | 实现滑动窗口音频缓冲 | 中 | 2-3 天 |
| 3 | 实现 LocalAgreement 确认机制 | 中 | 3-4 天 |
| 4 | 前端实时显示部分结果 | 低 | 1-2 天 |
| 5 | WebSocket/IPC 双向通信改造 | 高 | 3-5 天 |
| 6 | 测试与调优 | 中 | 2-3 天 |

**总计**：约 2-3 周

### 2.7 当前系统分析

当前 ququ 的录音流程（`useRecording.js`）：

```javascript
// 当前：录完再识别
mediaRecorder.start(1000)  // 每秒收集 chunk
↓ 用户停止录音
合并所有 chunks → 转换 WAV → 一次性发送 → 等待转录结果

// 流式改造后
mediaRecorder.start(500)  // 每 0.5 秒收集
↓ 实时处理
VAD 检测 → 累积缓冲 → 部分转录 → 确认后输出 → 前端实时显示
```

### 2.8 结论与建议

#### 当前性能已足够优秀

| 指标 | 当前值 |
|-----|--------|
| 30s 音频推理 | ~40ms |
| 端到端延迟主要来源 | AI 文本优化（~1-2s） |
| 用户感知延迟 | 录音结束后 2-3s 内出结果 |

#### 流式识别的收益有限

1. **推理不是瓶颈**：40ms 的推理时间意味着即使实现流式，也只能节省约 40ms
2. **主要延迟来自 AI 优化**：如需减少延迟，应优先考虑优化 AI 文本处理流程
3. **架构改动较大**：需要重构前后端通信机制

#### 建议

| 时间段 | 建议 |
|-------|------|
| **短期** | 保持当前批量识别架构，优化 AI 文本处理流程 |
| **中期** | 如用户反馈强烈需要实时反馈，考虑先实现"录音时显示音量波形"等视觉反馈 |
| **长期** | 等待 GLM-ASR 官方支持 vLLM/SGLang 后，评估其流式能力 |

---

## 参考资料

- [GLM-ASR GitHub](https://github.com/zai-org/GLM-ASR)
- [GLM-ASR HuggingFace](https://huggingface.co/zai-org/GLM-ASR-Nano-2512)
- [whisper_streaming](https://github.com/ufal/whisper_streaming)
- [Silero VAD](https://github.com/snakers4/silero-vad)
- [Whispy: Adapting STT Whisper Models to Real-Time](https://arxiv.org/html/2405.03484v1)
- [WhisperX + Silero-VAD 实现](https://medium.com/@aidenkoh/how-to-implement-high-speed-voice-recognition-in-chatbot-systems-with-whisperx-silero-vad-cdd45ea30904)

---

*调研日期：2025-12-14*

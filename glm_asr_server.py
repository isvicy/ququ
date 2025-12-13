#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GLM-ASR-Nano 模型服务器
保持模型在内存中，通过 stdin/stdout 进行通信
支持 GPU 加速，针对中英混合场景优化
"""

import sys
import json
import os
import logging
import traceback
import signal
import tempfile
from pathlib import Path

# 获取日志文件路径
def get_log_path():
    if "ELECTRON_USER_DATA" in os.environ:
        log_dir = os.path.join(os.environ["ELECTRON_USER_DATA"], "logs")
    else:
        log_dir = os.path.join(tempfile.gettempdir(), "ququ_logs")
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, "glm_asr_server.log")


log_file_path = get_log_path()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(log_file_path, encoding="utf-8"),
        logging.StreamHandler(sys.stderr),  # 日志输出到 stderr，避免干扰 stdout 的 JSON 通信
    ],
)
logger = logging.getLogger(__name__)
logger.info(f"GLM-ASR 服务器日志文件: {log_file_path}")

# Whisper 特征提取器配置
WHISPER_FEAT_CFG = {
    "chunk_length": 30,
    "feature_extractor_type": "WhisperFeatureExtractor",
    "feature_size": 128,
    "hop_length": 160,
    "n_fft": 400,
    "n_samples": 480000,
    "nb_max_frames": 3000,
    "padding_side": "right",
    "padding_value": 0.0,
    "processor_class": "WhisperProcessor",
    "return_attention_mask": False,
    "sampling_rate": 16000,
}


class GLMASRServer:
    def __init__(self, model_path=None, device=None):
        self.model = None
        self.tokenizer = None
        self.feature_extractor = None
        self.config = None
        self.initialized = False
        self.running = True
        self.transcription_count = 0
        self.total_audio_duration = 0.0

        # 模型路径，默认从 HuggingFace 下载
        self.model_path = model_path or "zai-org/GLM-ASR-Nano-2512"

        # 设备选择：优先使用 CUDA
        if device:
            self.device = device
        else:
            import torch
            self.device = "cuda" if torch.cuda.is_available() else "cpu"

        logger.info(f"GLM-ASR 将使用设备: {self.device}")

        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)

    def _signal_handler(self, signum, frame):
        logger.info(f"收到信号 {signum}，准备退出...")
        self.running = False

    def _get_audio_token_length(self, seconds, merge_factor=2):
        """计算音频 token 长度"""
        def get_T_after_cnn(L_in, dilation=1):
            for padding, kernel_size, stride in [(1, 3, 1), (1, 3, 2)]:
                L_out = L_in + 2 * padding - dilation * (kernel_size - 1) - 1
                L_out = 1 + L_out // stride
                L_in = L_out
            return L_out

        mel_len = int(seconds * 100)
        audio_len_after_cnn = get_T_after_cnn(mel_len)
        audio_token_num = (audio_len_after_cnn - merge_factor) // merge_factor + 1
        audio_token_num = min(audio_token_num, 1500 // merge_factor)
        return audio_token_num

    def initialize(self):
        """初始化 GLM-ASR 模型"""
        if self.initialized:
            return {"success": True, "message": "模型已初始化"}

        try:
            import torch
            import torchaudio
            from transformers import (
                AutoConfig,
                AutoModelForCausalLM,
                AutoTokenizer,
                WhisperFeatureExtractor,
            )

            logger.info(f"正在加载 GLM-ASR 模型: {self.model_path}")
            logger.info(f"使用设备: {self.device}")

            # 加载 tokenizer
            logger.info("加载 tokenizer...")
            self.tokenizer = AutoTokenizer.from_pretrained(
                self.model_path,
                trust_remote_code=True
            )

            # 加载特征提取器
            logger.info("加载特征提取器...")
            self.feature_extractor = WhisperFeatureExtractor(**WHISPER_FEAT_CFG)

            # 加载模型配置
            logger.info("加载模型配置...")
            self.config = AutoConfig.from_pretrained(
                self.model_path,
                trust_remote_code=True
            )

            # 加载模型
            logger.info("加载模型权重（这可能需要几分钟）...")
            self.model = AutoModelForCausalLM.from_pretrained(
                self.model_path,
                config=self.config,
                torch_dtype=torch.bfloat16,
                trust_remote_code=True,
            ).to(self.device)
            self.model.eval()

            self.initialized = True

            # 获取 GPU 信息
            gpu_info = ""
            if self.device.startswith("cuda"):
                gpu_name = torch.cuda.get_device_name(0)
                gpu_memory = torch.cuda.get_device_properties(0).total_memory / 1024**3
                gpu_info = f" (GPU: {gpu_name}, {gpu_memory:.1f}GB)"

            logger.info(f"GLM-ASR 模型初始化完成{gpu_info}")
            return {
                "success": True,
                "message": f"GLM-ASR 模型初始化成功{gpu_info}",
                "device": self.device,
            }

        except ImportError as e:
            error_msg = f"缺少依赖: {str(e)}，请安装: pip install torch torchaudio transformers"
            logger.error(error_msg)
            return {"success": False, "error": error_msg, "type": "import_error"}

        except Exception as e:
            error_msg = f"GLM-ASR 模型初始化失败: {str(e)}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            return {"success": False, "error": error_msg, "type": "init_error"}

    def _build_prompt(self, audio_path, chunk_seconds=30):
        """构建模型输入"""
        import torch
        import torchaudio

        audio_path = Path(audio_path)
        wav, sr = torchaudio.load(str(audio_path))
        wav = wav[:1, :]  # 转为单声道

        # 重采样到 16kHz
        if sr != self.feature_extractor.sampling_rate:
            wav = torchaudio.transforms.Resample(
                sr, self.feature_extractor.sampling_rate
            )(wav)

        tokens = []
        tokens += self.tokenizer.encode("<|user|>")
        tokens += self.tokenizer.encode("\n")

        audios = []
        audio_offsets = []
        audio_length = []
        chunk_size = chunk_seconds * self.feature_extractor.sampling_rate

        for start in range(0, wav.shape[1], chunk_size):
            chunk = wav[:, start : start + chunk_size]
            mel = self.feature_extractor(
                chunk.numpy(),
                sampling_rate=self.feature_extractor.sampling_rate,
                return_tensors="pt",
                padding="max_length",
            )["input_features"]
            audios.append(mel)

            seconds = chunk.shape[1] / self.feature_extractor.sampling_rate
            num_tokens = self._get_audio_token_length(
                seconds, self.config.merge_factor
            )
            tokens += self.tokenizer.encode("<|begin_of_audio|>")
            audio_offsets.append(len(tokens))
            tokens += [0] * num_tokens
            tokens += self.tokenizer.encode("<|end_of_audio|>")
            audio_length.append(num_tokens)

        if not audios:
            raise ValueError("音频内容为空或加载失败")

        tokens += self.tokenizer.encode("<|user|>")
        tokens += self.tokenizer.encode("\nPlease transcribe this audio into text")
        tokens += self.tokenizer.encode("<|assistant|>")
        tokens += self.tokenizer.encode("\n")

        import torch
        batch = {
            "input_ids": torch.tensor([tokens], dtype=torch.long),
            "audios": torch.cat(audios, dim=0),
            "audio_offsets": [audio_offsets],
            "audio_length": [audio_length],
            "attention_mask": torch.ones(1, len(tokens), dtype=torch.long),
        }
        return batch, wav.shape[1] / self.feature_extractor.sampling_rate

    def transcribe_audio(self, audio_path, options=None):
        """转录音频文件"""
        if not self.initialized:
            init_result = self.initialize()
            if not init_result["success"]:
                return init_result

        try:
            import torch

            if not os.path.exists(audio_path):
                return {"success": False, "error": f"音频文件不存在: {audio_path}"}

            logger.info(f"开始转录音频文件: {audio_path}")

            # 构建输入
            batch, duration = self._build_prompt(audio_path)

            # 准备模型输入
            tokens = batch["input_ids"].to(self.device)
            attention_mask = batch["attention_mask"].to(self.device)
            audios = batch["audios"].to(self.device).to(torch.bfloat16)
            prompt_len = tokens.size(1)

            model_inputs = {
                "inputs": tokens,
                "attention_mask": attention_mask,
                "audios": audios,
                "audio_offsets": batch["audio_offsets"],
                "audio_length": batch["audio_length"],
            }

            # 设置最大生成长度
            max_new_tokens = options.get("max_new_tokens", 256) if options else 256

            # 执行推理
            with torch.inference_mode():
                generated = self.model.generate(
                    **model_inputs,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                )

            # 解码结果
            transcript_ids = generated[0, prompt_len:].cpu().tolist()
            transcript = self.tokenizer.decode(
                transcript_ids, skip_special_tokens=True
            ).strip()

            self.transcription_count += 1
            self.total_audio_duration += duration

            result = {
                "success": True,
                "text": transcript,
                "raw_text": transcript,
                "duration": duration,
                "language": "auto",  # GLM-ASR 自动检测语言
                "model_type": "glm-asr-nano",
            }

            # 定期清理 GPU 缓存
            if self.transcription_count % 10 == 0:
                self._cleanup_memory()
                logger.info(f"已完成 {self.transcription_count} 次转录，执行内存清理")

            logger.info(f"转录完成: {transcript[:100]}...")
            return result

        except Exception as e:
            error_msg = f"音频转录失败: {str(e)}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            return {"success": False, "error": error_msg, "type": "transcription_error"}

    def _cleanup_memory(self):
        """清理内存和 GPU 缓存"""
        try:
            import gc
            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            logger.info("内存清理完成")
        except Exception as e:
            logger.warning(f"内存清理失败: {str(e)}")

    def check_status(self):
        """检查服务状态"""
        try:
            import torch

            status = {
                "success": True,
                "initialized": self.initialized,
                "model_path": self.model_path,
                "device": self.device,
                "cuda_available": torch.cuda.is_available(),
            }

            if torch.cuda.is_available():
                status["gpu_name"] = torch.cuda.get_device_name(0)
                status["gpu_memory_total"] = f"{torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f}GB"
                if self.initialized:
                    status["gpu_memory_used"] = f"{torch.cuda.memory_allocated(0) / 1024**3:.2f}GB"

            return status
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "initialized": self.initialized,
            }

    def get_performance_stats(self):
        """获取性能统计"""
        return {
            "transcription_count": self.transcription_count,
            "total_audio_duration": round(self.total_audio_duration, 2),
            "average_duration": round(
                self.total_audio_duration / max(1, self.transcription_count), 2
            ),
            "initialized": self.initialized,
            "device": self.device,
        }

    def run(self):
        """运行服务器主循环"""
        logger.info("GLM-ASR 服务器启动")

        # 启动时初始化模型
        init_result = self.initialize()
        print(json.dumps(init_result, ensure_ascii=False))
        sys.stdout.flush()

        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:
                    break

                line = line.strip()
                if not line:
                    continue

                try:
                    command = json.loads(line)
                except json.JSONDecodeError:
                    result = {"success": False, "error": "无效的 JSON 命令"}
                    print(json.dumps(result, ensure_ascii=False))
                    sys.stdout.flush()
                    continue

                # 处理命令
                if command.get("action") == "transcribe":
                    audio_path = command.get("audio_path")
                    options = command.get("options", {})
                    result = self.transcribe_audio(audio_path, options)
                elif command.get("action") == "status":
                    result = self.check_status()
                elif command.get("action") == "stats":
                    result = {"success": True, "stats": self.get_performance_stats()}
                elif command.get("action") == "cleanup":
                    self._cleanup_memory()
                    result = {"success": True, "message": "内存清理完成"}
                elif command.get("action") == "exit":
                    result = {"success": True, "message": "服务器退出"}
                    print(json.dumps(result, ensure_ascii=False))
                    sys.stdout.flush()
                    break
                else:
                    result = {
                        "success": False,
                        "error": f"未知命令: {command.get('action')}",
                    }

                print(json.dumps(result, ensure_ascii=False))
                sys.stdout.flush()

            except KeyboardInterrupt:
                break
            except Exception as e:
                error_result = {
                    "success": False,
                    "error": str(e),
                    "traceback": traceback.format_exc(),
                }
                print(json.dumps(error_result, ensure_ascii=False))
                sys.stdout.flush()

        logger.info("GLM-ASR 服务器退出")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="GLM-ASR-Nano 语音识别服务器")
    parser.add_argument(
        "--model-path",
        type=str,
        default="zai-org/GLM-ASR-Nano-2512",
        help="模型路径或 HuggingFace 模型 ID",
    )
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="运行设备 (cuda/cpu)，默认自动检测",
    )
    args = parser.parse_args()

    server = GLMASRServer(model_path=args.model_path, device=args.device)
    server.run()

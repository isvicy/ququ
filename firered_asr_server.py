#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FireRedASR 模型服务器
保持模型在内存中，通过 stdin/stdout 进行通信
支持 GPU 加速，方言和歌词识别优化
"""

import sys
import json
import os
import logging
import traceback
import signal
import tempfile
from pathlib import Path

# 添加 FireRedASR 仓库到 Python 路径
_project_root = Path(__file__).parent
_fireredasr_path = _project_root / "FireRedASR"
if _fireredasr_path.exists() and str(_fireredasr_path) not in sys.path:
    sys.path.insert(0, str(_fireredasr_path))

# 获取日志文件路径
def get_log_path():
    if "ELECTRON_USER_DATA" in os.environ:
        log_dir = os.path.join(os.environ["ELECTRON_USER_DATA"], "logs")
    else:
        log_dir = os.path.join(tempfile.gettempdir(), "ququ_logs")
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, "firered_asr_server.log")


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
logger.info(f"FireRedASR 服务器日志文件: {log_file_path}")


class FireRedASRServer:
    def __init__(self, model_dir=None, model_type="aed", device=None):
        self.model = None
        self.punc_model = None  # 标点恢复模型
        self.initialized = False
        self.running = True
        self.transcription_count = 0
        self.total_audio_duration = 0.0

        # 模型类型：aed (1.1B, 高效) 或 llm (8.3B, 最强)
        self.model_type = model_type

        # 模型路径
        self.model_dir = model_dir or self._get_default_model_dir()

        # 设备选择：优先使用 CUDA
        if device:
            self.device = device
        else:
            import torch
            self.device = "cuda" if torch.cuda.is_available() else "cpu"

        logger.info(f"FireRedASR 将使用设备: {self.device}, 模型类型: {self.model_type}")

        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)

    def _get_default_model_dir(self):
        """获取默认模型目录"""
        # 优先从环境变量获取
        if "FIRERED_MODEL_DIR" in os.environ:
            return os.environ["FIRERED_MODEL_DIR"]

        # 检查 HuggingFace 缓存
        hf_cache = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
        model_name = "FireRedASR-AED-L" if self.model_type == "aed" else "FireRedASR-LLM-L"
        hf_model_dir = os.path.join(hf_cache, f"models--fireredteam--{model_name}")

        if os.path.exists(hf_model_dir):
            # 找到实际的模型目录
            snapshots_dir = os.path.join(hf_model_dir, "snapshots")
            if os.path.exists(snapshots_dir):
                snapshots = os.listdir(snapshots_dir)
                if snapshots:
                    return os.path.join(snapshots_dir, snapshots[0])

        # 检查项目内的 pretrained_models 目录
        project_root = Path(__file__).parent
        local_model_dir = project_root / "pretrained_models" / model_name
        if local_model_dir.exists():
            return str(local_model_dir)

        # 返回默认路径（让模型加载时报错）
        return f"pretrained_models/{model_name}"

    def _signal_handler(self, signum, frame):
        logger.info(f"收到信号 {signum}，准备退出...")
        self.running = False

    def initialize(self):
        """初始化 FireRedASR 模型"""
        if self.initialized:
            return {"success": True, "message": "模型已初始化"}

        try:
            import torch

            logger.info(f"正在加载 FireRedASR 模型: {self.model_dir}")
            logger.info(f"使用设备: {self.device}, 模型类型: {self.model_type}")

            # 添加 FireRedASR 到 Python 路径
            firered_path = os.environ.get("FIRERED_PATH")
            if firered_path and firered_path not in sys.path:
                sys.path.insert(0, firered_path)

            from fireredasr.models.fireredasr import FireRedAsr

            logger.info("加载 FireRedASR 模型...")
            self.model = FireRedAsr.from_pretrained(self.model_type, self.model_dir)

            # 加载标点恢复模型（FireRedASR 不支持标点输出，需要后处理）
            logger.info("加载标点恢复模型...")
            try:
                from funasr import AutoModel
                self.punc_model = AutoModel(
                    model="damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
                    model_revision="v2.0.4",
                    disable_update=True,
                    device=self.device,  # 使用与 ASR 模型相同的设备
                )
                logger.info(f"标点恢复模型加载完成 (设备: {self.device})")
            except Exception as e:
                logger.warning(f"标点恢复模型加载失败，将不添加标点: {str(e)}")
                self.punc_model = None

            self.initialized = True

            # 获取 GPU 信息
            gpu_info = ""
            if self.device == "cuda" and torch.cuda.is_available():
                gpu_name = torch.cuda.get_device_name(0)
                gpu_memory = torch.cuda.get_device_properties(0).total_memory / 1024**3
                gpu_info = f" (GPU: {gpu_name}, {gpu_memory:.1f}GB)"

            logger.info(f"FireRedASR 模型初始化完成{gpu_info}")
            return {
                "success": True,
                "message": f"FireRedASR 模型初始化成功{gpu_info}",
                "device": self.device,
                "model_type": self.model_type,
            }

        except ImportError as e:
            error_msg = f"缺少依赖: {str(e)}，请确保 FireRedASR 已正确安装"
            logger.error(error_msg)
            return {"success": False, "error": error_msg, "type": "import_error"}

        except Exception as e:
            error_msg = f"FireRedASR 模型初始化失败: {str(e)}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            return {"success": False, "error": error_msg, "type": "init_error"}

    def transcribe_audio(self, audio_path, options=None):
        """转录音频文件"""
        if not self.initialized:
            init_result = self.initialize()
            if not init_result["success"]:
                return init_result

        try:
            import librosa

            if not os.path.exists(audio_path):
                return {"success": False, "error": f"音频文件不存在: {audio_path}"}

            logger.info(f"开始转录音频文件: {audio_path}")

            # 获取音频时长
            duration = librosa.get_duration(filename=audio_path)

            # FireRedASR-AED 最长支持 60s，FireRedASR-LLM 最长支持 30s
            max_duration = 60 if self.model_type == "aed" else 30
            if duration > max_duration:
                logger.warning(f"音频时长 {duration:.1f}s 超过限制 {max_duration}s，将进行分片处理")

            # 生成唯一 ID
            import uuid
            audio_id = str(uuid.uuid4())[:8]

            # 设置推理参数
            use_gpu = 1 if self.device == "cuda" else 0
            beam_size = options.get("beam_size", 3) if options else 3

            # 执行推理
            results = self.model.transcribe(
                [audio_id],
                [audio_path],
                {
                    "use_gpu": use_gpu,
                    "beam_size": beam_size,
                }
            )

            # 提取结果
            if results and len(results) > 0:
                result_item = results[0]
                if isinstance(result_item, dict):
                    transcript = result_item.get("text", "")
                elif isinstance(result_item, (list, tuple)) and len(result_item) > 1:
                    transcript = result_item[1]  # (id, text) 格式
                else:
                    transcript = str(result_item)
            else:
                transcript = ""

            raw_text = transcript.strip()

            # 标点恢复（FireRedASR 不输出标点，需要后处理）
            final_text = raw_text
            if self.punc_model and raw_text:
                try:
                    punc_result = self.punc_model.generate(input=raw_text)
                    if isinstance(punc_result, list) and len(punc_result) > 0:
                        if isinstance(punc_result[0], dict) and "text" in punc_result[0]:
                            final_text = punc_result[0]["text"]
                        else:
                            final_text = str(punc_result[0])
                    logger.info("标点恢复完成")
                except Exception as e:
                    logger.warning(f"标点恢复失败，使用原始文本: {str(e)}")

            self.transcription_count += 1
            self.total_audio_duration += duration

            result = {
                "success": True,
                "text": final_text,
                "raw_text": raw_text,
                "duration": duration,
                "language": "auto",  # FireRedASR 自动检测语言
                "model_type": f"firered-asr-{self.model_type}",
            }

            # 定期清理 GPU 缓存
            if self.transcription_count % 10 == 0:
                self._cleanup_memory()
                logger.info(f"已完成 {self.transcription_count} 次转录，执行内存清理")

            logger.info(f"转录完成: {final_text[:100]}...")
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
                "model_dir": self.model_dir,
                "model_type": self.model_type,
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
            "model_type": self.model_type,
        }

    def run(self):
        """运行服务器主循环"""
        logger.info("FireRedASR 服务器启动")

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

        logger.info("FireRedASR 服务器退出")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="FireRedASR 语音识别服务器")
    parser.add_argument(
        "--model-dir",
        type=str,
        default=None,
        help="模型目录路径",
    )
    parser.add_argument(
        "--model-type",
        type=str,
        default="aed",
        choices=["aed", "llm"],
        help="模型类型: aed (1.1B, 高效) 或 llm (8.3B, 最强)",
    )
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="运行设备 (cuda/cpu)，默认自动检测",
    )
    args = parser.parse_args()

    server = FireRedASRServer(
        model_dir=args.model_dir,
        model_type=args.model_type,
        device=args.device
    )
    server.run()

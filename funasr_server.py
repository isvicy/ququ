#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FunASR模型服务器
保持模型在内存中，通过stdin/stdout进行通信
支持 Fun-ASR-Nano-2512 新模型
"""

import sys
import json
import os
import logging
import traceback
import signal
import contextlib
import io
import argparse
import glob
from pathlib import Path

# 添加 Fun-ASR 仓库到 Python 路径
_project_root = Path(__file__).parent
_funasr_repo_path = _project_root / "Fun-ASR"
if _funasr_repo_path.exists() and str(_funasr_repo_path) not in sys.path:
    sys.path.insert(0, str(_funasr_repo_path))

# 设置日志
import tempfile
import os


# 获取日志文件路径
def get_log_path():
    # 尝试从环境变量获取用户数据目录
    if "ELECTRON_USER_DATA" in os.environ:
        log_dir = os.path.join(os.environ["ELECTRON_USER_DATA"], "logs")
    else:
        # 回退到临时目录
        log_dir = os.path.join(tempfile.gettempdir(), "ququ_logs")

    # 确保日志目录存在
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, "funasr_server.log")


log_file_path = get_log_path()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(log_file_path, encoding="utf-8"),
        logging.StreamHandler(),  # 同时输出到控制台
    ],
)
logger = logging.getLogger(__name__)

# 记录日志文件位置
logger.info(f"FunASR服务器日志文件: {log_file_path}")


import threading

# 线程锁用于 stdout 重定向
_stdout_lock = threading.Lock()

@contextlib.contextmanager
def suppress_stdout():
    """
    上下文管理器：临时重定向stdout到devnull，避免FunASR库的非JSON输出干扰IPC通信
    线程安全版本
    """
    with _stdout_lock:
        old_stdout = sys.stdout
        devnull = open(os.devnull, "w")
        try:
            sys.stdout = devnull
            yield
        finally:
            sys.stdout = old_stdout
            devnull.close()


class FunASRServer:
    def __init__(self, damo_root=None):
        self.asr_model = None
        self.vad_model = None
        self.initialized = False
        self.running = True
        self.transcription_count = 0
        self.total_audio_duration = 0.0

        # 外部传入的 damo 根目录（例如 /Volumes/APFS/AI/models/damo）
        self.damo_root = damo_root or os.environ.get("DAMO_ROOT")

        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)
        self._setup_runtime_environment()

    def _setup_runtime_environment(self):
        """设置运行时环境变量以优化性能"""
        try:
            import os

            # 设置线程数优化
            os.environ["OMP_NUM_THREADS"] = "4"
            logger.info("运行时环境变量设置完成")
        except Exception as e:
            logger.warning(f"环境设置失败: {str(e)}")

    def _signal_handler(self, signum, frame):
        """处理退出信号"""
        logger.info(f"收到信号 {signum}，准备退出...")
        self.running = False

    def _has_cuda(self):
        """检查是否有可用的 CUDA GPU"""
        try:
            import torch
            return torch.cuda.is_available()
        except ImportError:
            return False

    def _load_asr_model(self):
        """加载ASR模型（在子线程中运行，不使用 suppress_stdout）"""
        try:
            device = "cuda" if self._has_cuda() else "cpu"
            logger.info(f"开始加载ASR模型... (设备: {device})")
            from funasr import AutoModel

            # Fun-ASR-Nano-2512 新模型
            model_py_path = str(_funasr_repo_path / "model.py")
            self.asr_model = AutoModel(
                model="FunAudioLLM/Fun-ASR-Nano-2512",
                trust_remote_code=True,
                remote_code=model_py_path,
                disable_update=True,
                device=device,
            )
            logger.info(f"ASR模型加载完成 (设备: {device})")
            return True
        except Exception as e:
            logger.error(f"ASR模型加载失败: {str(e)}")
            return False

    def _load_vad_model(self):
        """加载VAD模型（在子线程中运行，不使用 suppress_stdout）"""
        try:
            logger.info("开始加载VAD模型...")
            from funasr import AutoModel

            self.vad_model = AutoModel(
                model="damo/speech_fsmn_vad_zh-cn-16k-common-pytorch",
                model_revision="v2.0.4",
                disable_update=True,
                device="cpu",
            )
            logger.info("VAD模型加载完成")
            return True
        except Exception as e:
            logger.error(f"VAD模型加载失败: {str(e)}")
            return False

    def initialize(self):
        """并行初始化FunASR模型"""
        if self.initialized:
            return {"success": True, "message": "模型已初始化"}

        try:
            import threading
            import time

            logger.info("正在并行初始化FunASR模型...")
            start_time = time.time()

            # 创建加载结果存储
            results = {}

            def load_model_thread(model_name, load_func):
                """模型加载线程包装函数"""
                thread_start = time.time()
                results[model_name] = load_func()
                thread_time = time.time() - thread_start
                logger.info(f"{model_name}模型加载线程耗时: {thread_time:.2f}秒")

            # 创建并启动两个并行线程（Fun-ASR-Nano-2512 已自带标点，不需要 punc 模型）
            threads = [
                threading.Thread(
                    target=load_model_thread, args=("asr", self._load_asr_model)
                ),
                threading.Thread(
                    target=load_model_thread, args=("vad", self._load_vad_model)
                ),
            ]

            # 启动所有线程
            for thread in threads:
                thread.start()

            # 等待所有线程完成，设置超时
            for thread in threads:
                thread.join(timeout=300)  # 5分钟超时
                if thread.is_alive():
                    logger.error(f"模型加载线程超时")
                    return {
                        "success": False,
                        "error": "模型加载超时",
                        "type": "timeout_error",
                    }

            # 检查加载结果
            failed_models = [name for name, success in results.items() if not success]

            if failed_models:
                error_msg = f"以下模型加载失败: {', '.join(failed_models)}"
                logger.error(error_msg)
                return {"success": False, "error": error_msg, "type": "init_error"}

            total_time = time.time() - start_time
            self.initialized = True
            logger.info(
                f"所有FunASR模型并行初始化完成，总耗时: {total_time:.2f}秒"
            )
            return {
                "success": True,
                "message": f"FunASR模型并行初始化成功，耗时: {total_time:.2f}秒",
            }

        except ImportError as e:
            error_msg = "FunASR未安装，请先安装FunASR: pip install funasr"
            logger.error(error_msg)
            return {"success": False, "error": error_msg, "type": "import_error"}

        except Exception as e:
            error_msg = f"FunASR模型初始化失败: {str(e)}"
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
            # 检查音频文件是否存在
            if not os.path.exists(audio_path):
                return {"success": False, "error": f"音频文件不存在: {audio_path}"}

            logger.info(f"开始转录音频文件: {audio_path}")

            # 设置默认选项
            # Fun-ASR-Nano-2512 模型已经自带标点输出，不需要额外的 punc 模型
            default_options = {
                "batch_size_s": 60,
                "hotword": "",
                "use_vad": True,
                "language": "zh",
            }

            if options:
                default_options.update(options)

            # 执行语音识别
            if default_options["use_vad"]:
                vad_result = self.vad_model.generate(
                    input=audio_path, batch_size_s=default_options["batch_size_s"]
                )
                logger.info("VAD处理完成")

            # 执行ASR识别
            asr_result = self.asr_model.generate(
                input=audio_path,
                batch_size_s=default_options["batch_size_s"],
                hotword=default_options["hotword"],
                cache={},
            )

            # 提取识别文本
            if isinstance(asr_result, list) and len(asr_result) > 0:
                if isinstance(asr_result[0], dict) and "text" in asr_result[0]:
                    raw_text = asr_result[0]["text"]
                else:
                    raw_text = str(asr_result[0])
            else:
                raw_text = str(asr_result)

            logger.info(f"ASR识别完成，文本: {raw_text[:100]}...")

            duration = self._get_audio_duration(audio_path)
            self.transcription_count += 1

            result = {
                "success": True,
                "text": raw_text,
                "confidence": (
                    getattr(asr_result[0], "confidence", 0.0)
                    if isinstance(asr_result, list)
                    else 0.0
                ),
                "duration": duration,
                "language": "zh-CN",
                "model_type": "pytorch",
            }

            # 生产环境：每10次转录后进行内存清理
            if self.transcription_count % 10 == 0:
                self._cleanup_memory()
                logger.info(f"已完成 {self.transcription_count} 次转录，执行内存清理")

            logger.info(f"转录完成: {raw_text[:100]}...")
            return result

        except Exception as e:
            error_msg = f"音频转录失败: {str(e)}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            return {"success": False, "error": error_msg, "type": "transcription_error"}

    def _get_audio_duration(self, audio_path):
        """获取音频时长"""
        try:
            import librosa

            duration = librosa.get_duration(filename=audio_path)
            self.total_audio_duration += duration  # 累计音频时长
            return duration
        except:
            return 0.0

    def _cleanup_memory(self):
        """生产环境内存清理"""
        try:
            import gc

            gc.collect()
            logger.info("内存清理完成")
        except Exception as e:
            logger.warning(f"内存清理失败: {str(e)}")

    def get_performance_stats(self):
        """获取性能统计信息"""
        return {
            "transcription_count": self.transcription_count,
            "total_audio_duration": round(self.total_audio_duration, 2),
            "average_duration": round(
                self.total_audio_duration / max(1, self.transcription_count), 2
            ),
            "initialized": self.initialized,
            "models_loaded": {
                "asr": self.asr_model is not None,
                "vad": self.vad_model is not None,
            },
        }

    def check_status(self):
        """检查FunASR状态"""
        try:
            import funasr

            return {
                "success": True,
                "installed": True,
                "initialized": self.initialized,
                "version": getattr(funasr, "__version__", "unknown"),
                "models": {
                    "asr": self.asr_model is not None,
                    "vad": self.vad_model is not None,
                },
            }
        except ImportError:
            return {
                "success": False,
                "installed": False,
                "initialized": False,
                "error": "FunASR未安装",
            }

    def run(self):
        """运行服务器主循环"""
        logger.info("FunASR服务器启动")

        # 解析 ModelScope 模型缓存根目录（不含组织名）
        def _default_models_root():
            root = os.environ.get("MODELSCOPE_CACHE")
            if root:
                # 兼容多种布局
                candidates = [
                    os.path.join(root, "hub", "models"),
                    os.path.join(root, "models"),
                    root,
                ]
                for c in candidates:
                    if os.path.isdir(c):
                        return c
            # 默认回到用户主目录的 modelscope/hub/models
            home_dir = os.path.expanduser("~")
            return os.path.join(home_dir, ".cache", "modelscope", "hub", "models")

        cache_path = self.damo_root if self.damo_root else _default_models_root()
        logger.info(f"使用的模型根目录: {cache_path}")

        # 模型列表：Fun-ASR-Nano-2512 已自带标点，不需要 punc 模型
        repos = [
            "FunAudioLLM/Fun-ASR-Nano-2512",
            "damo/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        ]

        def _repo_ready(repo_dir):
            # 目录存在且包含任意常见权重/配置文件即认为已就绪
            if not os.path.isdir(repo_dir):
                return False
            patterns = [
                "model.pt", "pytorch_model.bin", "*.onnx",
                "config.json", "configuration.json", "model.yaml", "vocab*"
            ]
            for pat in patterns:
                if glob.glob(os.path.join(repo_dir, pat)):
                    return True
            return False

        missing = []
        for r in repos:
            rd = os.path.join(cache_path, r)
            if not _repo_ready(rd):
                missing.append(r)

        if not missing:
            logger.info("模型文件存在，开始初始化")
            init_result = self.initialize()
        else:
            logger.info(f"模型文件不存在或不完整：{', '.join(missing)}，跳过初始化")
            init_result = {
                "success": False,
                "error": "模型文件未下载，请先下载模型",
                "type": "models_not_downloaded"
            }
        print(json.dumps(init_result, ensure_ascii=False))
        sys.stdout.flush()

        while self.running:
            try:
                # 读取命令
                line = sys.stdin.readline()
                if not line:
                    break

                line = line.strip()
                if not line:
                    continue

                try:
                    command = json.loads(line)
                except json.JSONDecodeError:
                    result = {"success": False, "error": "无效的JSON命令"}
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

                # 输出结果
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

        logger.info("FunASR服务器退出")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--damo-root", type=str, default=None,
                        help="ModelScope 模型缓存根目录，例如 ~/.cache/modelscope/hub/models")
    args = parser.parse_args()

    server = FunASRServer(damo_root=args.damo_root)
    server.run()
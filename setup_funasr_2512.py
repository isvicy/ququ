#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fun-ASR-Nano-2512 自动安装脚本
下载模型文件
"""

import sys
import json
import os
from pathlib import Path


def output_progress(stage, message, progress=0, error=None):
    """输出进度信息（JSON 格式，供 Electron 解析）"""
    status = {
        "stage": stage,
        "message": message,
        "progress": progress,
    }
    if error:
        status["error"] = error
    print(json.dumps(status, ensure_ascii=False))
    sys.stdout.flush()


def get_project_root():
    """获取项目根目录"""
    return Path(__file__).parent


def download_model():
    """下载 Fun-ASR-Nano-2512 模型"""
    output_progress("download", "正在下载 Fun-ASR-Nano-2512 模型...", 10)

    try:
        from funasr import AutoModel

        output_progress("download", "初始化模型下载...", 20)

        # 使用本地优化过的 model.py
        project_root = get_project_root()
        model_py_path = str(project_root / "funasr_model.py")

        if not os.path.exists(model_py_path):
            output_progress("download", "funasr_model.py 不存在", 0, "模型代码文件缺失")
            return False

        output_progress("download", "正在下载模型文件（约 2GB）...", 30)

        # 这会触发模型下载
        model = AutoModel(
            model="FunAudioLLM/Fun-ASR-Nano-2512",
            trust_remote_code=True,
            remote_code=model_py_path,
            device="cpu",  # 仅下载，使用 CPU
        )

        output_progress("download", "模型下载完成", 100)
        return True

    except Exception as e:
        output_progress("download", "模型下载失败", 0, str(e))
        return False


def verify_installation(project_root):
    """验证安装是否成功"""
    output_progress("verify", "验证安装...", 50)

    model_py = project_root / "funasr_model.py"

    # 检查模型缓存
    ms_cache = Path.home() / ".cache" / "modelscope" / "hub" / "models"
    model_dir = ms_cache / "FunAudioLLM" / "Fun-ASR-Nano-2512"
    model_file = model_dir / "model.pt"

    issues = []

    if not model_py.exists():
        issues.append("funasr_model.py 不存在")

    if not model_file.exists():
        issues.append("模型文件未下载")

    if issues:
        output_progress("verify", "安装验证失败", 0, "; ".join(issues))
        return False

    output_progress("verify", "安装验证通过", 100)
    return True


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="Fun-ASR-Nano-2512 自动安装")
    parser.add_argument("--skip-model", action="store_true", help="跳过模型下载")
    args = parser.parse_args()

    project_root = get_project_root()

    output_progress("start", "开始 Fun-ASR-Nano-2512 安装", 0)

    # 下载模型
    if not args.skip_model:
        success = download_model()
        if not success:
            print(json.dumps({
                "success": False,
                "error": "模型下载失败",
                "hint": "请检查网络连接或手动下载模型"
            }))
            sys.exit(1)

    # 验证安装
    if verify_installation(project_root):
        result = {
            "success": True,
            "message": "Fun-ASR-Nano-2512 安装完成",
        }
    else:
        result = {
            "success": False,
            "error": "安装验证失败",
        }

    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["success"] else 1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(json.dumps({"success": False, "error": "用户取消"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

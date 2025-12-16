#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fun-ASR-Nano-2512 自动安装脚本
克隆仓库并下载模型
"""

import sys
import json
import os
import subprocess
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


def check_git():
    """检查 git 是否可用"""
    try:
        result = subprocess.run(["git", "--version"], capture_output=True, text=True)
        return result.returncode == 0
    except FileNotFoundError:
        return False


def clone_funasr_repo(project_root):
    """克隆 Fun-ASR 仓库"""
    repo_path = project_root / "Fun-ASR"
    repo_url = "https://github.com/FunAudioLLM/Fun-ASR.git"

    if repo_path.exists() and (repo_path / "model.py").exists():
        output_progress("clone", "Fun-ASR 仓库已存在，跳过克隆", 100)
        return True, repo_path

    output_progress("clone", "正在克隆 Fun-ASR 仓库...", 10)

    try:
        # 如果目录存在但不完整，删除它
        if repo_path.exists():
            import shutil
            shutil.rmtree(repo_path)

        result = subprocess.run(
            ["git", "clone", "--depth", "1", repo_url, str(repo_path)],
            capture_output=True,
            text=True,
            timeout=300,
        )

        if result.returncode == 0:
            output_progress("clone", "Fun-ASR 仓库克隆完成", 100)
            return True, repo_path
        else:
            output_progress("clone", "克隆失败", 0, result.stderr)
            return False, None
    except subprocess.TimeoutExpired:
        output_progress("clone", "克隆超时", 0, "操作超时，请检查网络连接")
        return False, None
    except Exception as e:
        output_progress("clone", "克隆失败", 0, str(e))
        return False, None


def download_model():
    """下载 Fun-ASR-Nano-2512 模型"""
    output_progress("download", "正在下载 Fun-ASR-Nano-2512 模型...", 10)

    try:
        # 使用 funasr AutoModel 触发下载
        from funasr import AutoModel

        output_progress("download", "初始化模型下载...", 20)

        # 获取 model.py 路径
        project_root = get_project_root()
        model_py_path = str(project_root / "Fun-ASR" / "model.py")

        if not os.path.exists(model_py_path):
            output_progress("download", "model.py 不存在", 0, "请先克隆 Fun-ASR 仓库")
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

    repo_path = project_root / "Fun-ASR"
    model_py = repo_path / "model.py"

    # 检查模型缓存
    import os
    ms_cache = Path.home() / ".cache" / "modelscope" / "hub" / "models"
    model_dir = ms_cache / "FunAudioLLM" / "Fun-ASR-Nano-2512"
    model_file = model_dir / "model.pt"

    issues = []

    if not model_py.exists():
        issues.append("Fun-ASR 仓库未克隆或 model.py 不存在")

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
    parser.add_argument("--skip-clone", action="store_true", help="跳过仓库克隆")
    parser.add_argument("--skip-model", action="store_true", help="跳过模型下载")
    args = parser.parse_args()

    project_root = get_project_root()

    output_progress("start", "开始 Fun-ASR-Nano-2512 安装", 0)

    # 1. 检查 git
    if not args.skip_clone and not check_git():
        output_progress("error", "git 未安装", 0, "请先安装 git")
        print(json.dumps({"success": False, "error": "git 未安装"}))
        sys.exit(1)

    # 2. 克隆仓库
    if not args.skip_clone:
        success, repo_path = clone_funasr_repo(project_root)
        if not success:
            print(json.dumps({"success": False, "error": "仓库克隆失败"}))
            sys.exit(1)

    # 3. 下载模型
    if not args.skip_model:
        success = download_model()
        if not success:
            print(json.dumps({
                "success": False,
                "error": "模型下载失败",
                "hint": "请检查网络连接或手动下载模型"
            }))
            sys.exit(1)

    # 4. 验证安装
    if verify_installation(project_root):
        result = {
            "success": True,
            "message": "Fun-ASR-Nano-2512 安装完成",
            "repo_path": str(project_root / "Fun-ASR"),
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

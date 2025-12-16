#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FireRedASR 自动安装脚本
自动克隆仓库、安装依赖、下载模型
"""

import sys
import json
import os
import subprocess
import shutil
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


def clone_firered_repo(project_root):
    """克隆 FireRedASR 仓库"""
    repo_path = project_root / "FireRedASR"
    repo_url = "https://github.com/FireRedTeam/FireRedASR.git"

    if repo_path.exists():
        output_progress("clone", "FireRedASR 仓库已存在，跳过克隆", 100)
        return True, repo_path

    output_progress("clone", "正在克隆 FireRedASR 仓库...", 10)

    try:
        result = subprocess.run(
            ["git", "clone", "--depth", "1", repo_url, str(repo_path)],
            capture_output=True,
            text=True,
            timeout=300,  # 5 分钟超时
        )

        if result.returncode == 0:
            output_progress("clone", "FireRedASR 仓库克隆完成", 100)
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


def download_model_with_hf_hub(model_id, local_dir):
    """使用 huggingface_hub 下载模型"""
    try:
        from huggingface_hub import snapshot_download

        output_progress("download", f"正在下载模型 {model_id}...", 20)

        # 使用 snapshot_download 下载整个模型目录
        downloaded_path = snapshot_download(
            repo_id=model_id,
            local_dir=local_dir,
            local_dir_use_symlinks=False,
            resume_download=True,
        )

        output_progress("download", f"模型 {model_id} 下载完成", 100)
        return True, downloaded_path
    except ImportError:
        output_progress("download", "缺少 huggingface_hub", 0, "请安装: pip install huggingface_hub")
        return False, None
    except Exception as e:
        output_progress("download", f"模型下载失败", 0, str(e))
        return False, None


def download_model_with_git_lfs(model_id, local_dir):
    """使用 git lfs 下载模型（备选方案）"""
    model_url = f"https://huggingface.co/{model_id}"

    output_progress("download", f"使用 git lfs 下载模型 {model_id}...", 10)

    try:
        # 检查 git lfs
        subprocess.run(["git", "lfs", "version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        output_progress("download", "git lfs 未安装", 0, "请安装 git lfs: git lfs install")
        return False, None

    try:
        result = subprocess.run(
            ["git", "clone", model_url, str(local_dir)],
            capture_output=True,
            text=True,
            timeout=1800,  # 30 分钟超时（模型较大）
        )

        if result.returncode == 0:
            output_progress("download", f"模型 {model_id} 下载完成", 100)
            return True, local_dir
        else:
            output_progress("download", "下载失败", 0, result.stderr)
            return False, None
    except subprocess.TimeoutExpired:
        output_progress("download", "下载超时", 0, "模型较大，请手动下载")
        return False, None
    except Exception as e:
        output_progress("download", "下载失败", 0, str(e))
        return False, None


def download_model(model_type, project_root):
    """下载 FireRedASR 模型"""
    models_dir = project_root / "pretrained_models"
    models_dir.mkdir(exist_ok=True)

    if model_type == "aed":
        model_id = "fireredteam/FireRedASR-AED-L"
        model_name = "FireRedASR-AED-L"
    else:
        model_id = "fireredteam/FireRedASR-LLM-L"
        model_name = "FireRedASR-LLM-L"

    local_dir = models_dir / model_name

    # 检查模型是否已存在
    if local_dir.exists() and any(local_dir.iterdir()):
        output_progress("download", f"模型 {model_name} 已存在", 100)
        return True, local_dir

    # 优先尝试 huggingface_hub
    success, path = download_model_with_hf_hub(model_id, str(local_dir))

    if not success:
        # 备选：使用 git lfs
        output_progress("download", "尝试使用 git lfs 下载...", 5)
        success, path = download_model_with_git_lfs(model_id, local_dir)

    return success, path


def install_dependencies(repo_path):
    """安装 FireRedASR Python 依赖"""
    requirements_file = repo_path / "requirements.txt"

    if not requirements_file.exists():
        output_progress("deps", "未找到 requirements.txt", 0, "请检查 FireRedASR 仓库是否完整")
        return False

    output_progress("deps", "正在安装 FireRedASR 依赖...", 10)

    project_root = get_project_root()

    try:
        # 优先使用 uv（更快）
        result = subprocess.run(
            ["uv", "pip", "install", "-r", str(requirements_file)],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(project_root),
        )

        if result.returncode == 0:
            output_progress("deps", "FireRedASR 依赖安装完成", 100)
            return True
        else:
            # 如果 uv 失败，尝试使用 pip
            output_progress("deps", "尝试使用 pip 安装...", 50)
            venv_python = project_root / ".venv" / "bin" / "python"
            python_path = str(venv_python) if venv_python.exists() else sys.executable

            result2 = subprocess.run(
                [python_path, "-m", "pip", "install", "-r", str(requirements_file)],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result2.returncode == 0:
                output_progress("deps", "FireRedASR 依赖安装完成", 100)
                return True
            else:
                output_progress("deps", "安装失败", 0, result2.stderr or result.stderr)
                return False
    except FileNotFoundError:
        # uv 不存在，直接尝试 pip
        output_progress("deps", "uv 未找到，尝试 pip...", 30)
        try:
            venv_python = project_root / ".venv" / "bin" / "python"
            python_path = str(venv_python) if venv_python.exists() else sys.executable

            result = subprocess.run(
                [python_path, "-m", "pip", "install", "-r", str(requirements_file)],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode == 0:
                output_progress("deps", "FireRedASR 依赖安装完成", 100)
                return True
            else:
                output_progress("deps", "安装失败", 0, result.stderr)
                return False
        except Exception as e:
            output_progress("deps", "安装失败", 0, str(e))
            return False
    except subprocess.TimeoutExpired:
        output_progress("deps", "安装超时", 0, "依赖安装操作超时")
        return False
    except Exception as e:
        output_progress("deps", "安装失败", 0, str(e))
        return False


def verify_installation(project_root):
    """验证安装是否成功"""
    output_progress("verify", "验证安装...", 30)

    repo_path = project_root / "FireRedASR"
    model_path = project_root / "pretrained_models" / "FireRedASR-AED-L"

    issues = []

    if not repo_path.exists():
        issues.append("FireRedASR 仓库未克隆")

    if not model_path.exists():
        issues.append("模型未下载")

    # 检查关键文件
    firered_module = repo_path / "fireredasr"
    if repo_path.exists() and not firered_module.exists():
        issues.append("FireRedASR 模块结构异常")

    # 验证 Python 包可以导入
    output_progress("verify", "验证 Python 包...", 60)
    try:
        import fireredasr
        output_progress("verify", "fireredasr 模块导入成功", 80)
    except ImportError as e:
        issues.append(f"fireredasr 模块无法导入: {e}")

    if issues:
        output_progress("verify", "安装验证失败", 0, "; ".join(issues))
        return False

    output_progress("verify", "安装验证通过", 100)
    return True


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description="FireRedASR 自动安装")
    parser.add_argument(
        "--model-type",
        type=str,
        default="aed",
        choices=["aed", "llm"],
        help="模型类型: aed (1.1B, 推荐) 或 llm (8.3B, 需要更多显存)",
    )
    parser.add_argument(
        "--skip-clone",
        action="store_true",
        help="跳过仓库克隆",
    )
    parser.add_argument(
        "--skip-model",
        action="store_true",
        help="跳过模型下载",
    )
    args = parser.parse_args()

    project_root = get_project_root()

    output_progress("start", "开始 FireRedASR 安装", 0)

    # 1. 检查 git
    if not check_git():
        output_progress("error", "git 未安装", 0, "请先安装 git")
        print(json.dumps({"success": False, "error": "git 未安装"}))
        sys.exit(1)

    # 2. 克隆仓库
    repo_path = project_root / "FireRedASR"
    if not args.skip_clone:
        success, repo_path = clone_firered_repo(project_root)
        if not success:
            print(json.dumps({"success": False, "error": "仓库克隆失败"}))
            sys.exit(1)

    # 3. 安装 Python 包
    if repo_path and repo_path.exists():
        success = install_dependencies(repo_path)
        if not success:
            print(json.dumps({"success": False, "error": "Python 包安装失败"}))
            sys.exit(1)

    # 4. 下载模型
    if not args.skip_model:
        success, model_path = download_model(args.model_type, project_root)
        if not success:
            print(json.dumps({
                "success": False,
                "error": "模型下载失败",
                "hint": f"请手动从 https://huggingface.co/fireredteam/FireRedASR-AED-L 下载模型到 {project_root}/pretrained_models/FireRedASR-AED-L"
            }))
            sys.exit(1)

    # 5. 验证安装
    if verify_installation(project_root):
        result = {
            "success": True,
            "message": "FireRedASR 安装完成",
            "repo_path": str(project_root / "FireRedASR"),
            "model_path": str(project_root / "pretrained_models" / f"FireRedASR-{'AED' if args.model_type == 'aed' else 'LLM'}-L"),
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

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FireRedASR 自动安装脚本
验证 pip 包已安装（模型会在首次运行时自动从 ModelScope 下载）
"""

import sys
import json


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


def verify_installation():
    """验证安装是否成功"""
    output_progress("verify", "验证 fireredasr 包...", 30)

    try:
        from fireredasr.models.fireredasr import FireRedAsr
        output_progress("verify", "fireredasr 模块导入成功", 100)
        return True
    except ImportError as e:
        output_progress("verify", "fireredasr 模块无法导入", 0, str(e))
        return False


def main():
    """主函数"""
    output_progress("start", "检查 FireRedASR 安装", 0)

    if verify_installation():
        result = {
            "success": True,
            "message": "FireRedASR 已安装，模型将在首次运行时自动下载",
        }
    else:
        result = {
            "success": False,
            "error": "fireredasr 未安装，请运行: uv sync",
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

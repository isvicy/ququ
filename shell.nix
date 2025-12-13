{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    # Node.js 和 Electron 开发
    nodejs_20

    # Python 和 uv
    python311
    uv
  ];

  shellHook = ''
    # 暴露 CUDA 运行时库（NixOS 特有路径）
    if [[ -d "/run/opengl-driver/lib" ]]; then
      export LD_LIBRARY_PATH="/run/opengl-driver/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi

    echo "ququ 开发环境已加载"
    echo "  - LD_LIBRARY_PATH 已配置 CUDA 库"
    echo "  - 运行 'uv sync' 安装 Python 依赖"
  '';
}

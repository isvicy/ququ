const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

/**
 * GLM-ASR-Nano 管理器
 * 使用智谱开源的 GLM-ASR-Nano-2512 模型进行语音识别
 * 支持 GPU 加速，针对中英混合场景优化
 */
class GLMASRManager {
  constructor(logger = null) {
    this.logger = logger || console;
    this.pythonCmd = null;
    this.isInitialized = false;
    this.serverProcess = null;
    this.serverReady = false;
    this.initializationPromise = null;
    this.transcriptionCount = 0;

    // 模型配置
    this.modelPath = "zai-org/GLM-ASR-Nano-2512";
    this.device = null; // 自动检测
  }

  getGLMASRServerPath() {
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "glm_asr_server.py");
    } else {
      return path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "glm_asr_server.py"
      );
    }
  }

  getSystemPythonPath() {
    // GLM-ASR 需要较新的 torch，使用系统 Python 或独立虚拟环境
    const projectRoot = path.join(__dirname, "..", "..");

    const possiblePaths = [
      // 优先使用项目的 GLM-ASR 虚拟环境
      path.join(projectRoot, ".venv-glm", "bin", "python"),
      path.join(projectRoot, ".venv-glm", "bin", "python3"),
      // 回退到系统 Python
      "python3",
      "python",
      "/usr/bin/python3",
      "/usr/local/bin/python3",
    ];

    for (const pythonPath of possiblePaths) {
      if (pythonPath.startsWith("/") || pythonPath.startsWith(".")) {
        if (fs.existsSync(pythonPath)) {
          return pythonPath;
        }
      } else {
        // 对于非绝对路径，假设它在 PATH 中
        return pythonPath;
      }
    }

    return "python3";
  }

  buildPythonEnvironment() {
    const env = {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      ELECTRON_USER_DATA: require('electron').app.getPath('userData'),
    };

    // 清除可能干扰的环境变量
    delete env.PYTHONHOME;
    delete env.PYTHONPATH;
    delete env.VIRTUAL_ENV;

    return env;
  }

  async findPythonExecutable() {
    if (this.pythonCmd) {
      return this.pythonCmd;
    }

    const pythonPath = this.getSystemPythonPath();

    // 验证 Python 和依赖
    try {
      const version = await this.getPythonVersion(pythonPath);
      if (version && version.major === 3 && version.minor >= 10) {
        this.pythonCmd = pythonPath;
        this.logger.info && this.logger.info('GLM-ASR 使用 Python:', pythonPath);
        return pythonPath;
      }
    } catch (error) {
      this.logger.error && this.logger.error('Python 验证失败:', error);
    }

    throw new Error("未找到合适的 Python 3.10+，GLM-ASR 需要 Python 3.10 或更高版本");
  }

  async getPythonVersion(pythonPath) {
    return new Promise((resolve) => {
      const testProcess = spawn(pythonPath, ["--version"]);
      let output = "";

      testProcess.stdout.on("data", (data) => output += data);
      testProcess.stderr.on("data", (data) => output += data);

      testProcess.on("close", (code) => {
        if (code === 0) {
          const match = output.match(/Python (\d+)\.(\d+)/i);
          resolve(match ? { major: +match[1], minor: +match[2] } : null);
        } else {
          resolve(null);
        }
      });

      testProcess.on("error", () => resolve(null));
    });
  }

  async checkGLMASRInstallation() {
    try {
      const pythonCmd = await this.findPythonExecutable();
      const env = this.buildPythonEnvironment();

      return new Promise((resolve) => {
        const checkProcess = spawn(pythonCmd, [
          "-c",
          'import torch; import transformers; print("OK")',
        ], { env });

        let output = "";
        let errorOutput = "";

        checkProcess.stdout.on("data", (data) => output += data.toString());
        checkProcess.stderr.on("data", (data) => errorOutput += data.toString());

        checkProcess.on("close", (code) => {
          if (code === 0 && output.includes("OK")) {
            resolve({ installed: true, working: true });
          } else {
            resolve({
              installed: false,
              working: false,
              error: errorOutput || "依赖检查失败"
            });
          }
        });

        checkProcess.on("error", (error) => {
          resolve({ installed: false, working: false, error: error.message });
        });
      });
    } catch (error) {
      return { installed: false, working: false, error: error.message };
    }
  }

  async checkModelFiles() {
    // GLM-ASR 模型会自动从 HuggingFace 下载
    // 检查是否已缓存
    const cacheDir = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
    const modelDir = path.join(cacheDir, 'models--zai-org--GLM-ASR-Nano-2512');

    const exists = fs.existsSync(modelDir);

    return {
      success: true,
      models_downloaded: exists,
      missing_models: exists ? [] : ["glm-asr-nano"],
      details: {
        "glm-asr-nano": {
          exists,
          path: modelDir,
          note: exists ? "模型已缓存" : "模型将在首次使用时自动下载"
        }
      }
    };
  }

  async initializeAtStartup() {
    try {
      this.logger.info && this.logger.info('GLM-ASR 管理器启动初始化开始');

      const pythonCmd = await this.findPythonExecutable();
      this.logger.info && this.logger.info('Python 可执行文件:', pythonCmd);

      const installStatus = await this.checkGLMASRInstallation();
      this.logger.info && this.logger.info('GLM-ASR 依赖状态:', installStatus);

      this.isInitialized = true;

      // 预启动服务器
      if (installStatus.installed) {
        this.preInitializeModels();
      }

      this.logger.info && this.logger.info('GLM-ASR 管理器启动初始化完成');
    } catch (error) {
      this.logger.warn && this.logger.warn('GLM-ASR 启动初始化失败:', error);
      this.isInitialized = true;
    }
  }

  async preInitializeModels() {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._startGLMASRServer();
    return this.initializationPromise;
  }

  async _startGLMASRServer() {
    try {
      this.logger.info && this.logger.info('启动 GLM-ASR 服务器...');

      const status = await this.checkGLMASRInstallation();
      if (!status.installed) {
        this.logger.warn && this.logger.warn('GLM-ASR 依赖未安装，跳过服务器启动');
        return;
      }

      const pythonCmd = await this.findPythonExecutable();
      const serverPath = this.getGLMASRServerPath();

      this.logger.info && this.logger.info('GLM-ASR 服务器配置:', {
        pythonCmd,
        serverPath,
        serverExists: fs.existsSync(serverPath)
      });

      if (!fs.existsSync(serverPath)) {
        this.logger.error && this.logger.error('GLM-ASR 服务器脚本未找到');
        return;
      }

      const pythonEnv = this.buildPythonEnvironment();

      return new Promise((resolve) => {
        const args = [serverPath];

        // 如果指定了设备，添加参数
        if (this.device) {
          args.push('--device', this.device);
        }

        this.serverProcess = spawn(pythonCmd, args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: pythonEnv
        });

        let initResponseReceived = false;

        this.serverProcess.stdout.on("data", (data) => {
          const lines = data.toString().split('\n').filter(line => line.trim());

          for (const line of lines) {
            try {
              const result = JSON.parse(line);

              if (!initResponseReceived) {
                initResponseReceived = true;
                if (result.success) {
                  this.serverReady = true;
                  this.logger.info && this.logger.info('GLM-ASR 服务器启动成功', result);
                } else {
                  this.logger.error && this.logger.error('GLM-ASR 服务器初始化失败', result);
                }
                resolve();
              }
            } catch (parseError) {
              // 忽略非 JSON 输出
            }
          }
        });

        this.serverProcess.stderr.on("data", (data) => {
          const errorOutput = data.toString();
          // 只记录非进度信息的错误
          if (!errorOutput.includes('Downloading') && !errorOutput.includes('Loading')) {
            this.logger.debug && this.logger.debug('GLM-ASR stderr:', errorOutput);
          }
        });

        this.serverProcess.on("close", (code) => {
          this.logger.warn && this.logger.warn('GLM-ASR 服务器进程退出:', code);
          this.serverProcess = null;
          this.serverReady = false;

          if (!initResponseReceived) {
            resolve();
          }
        });

        this.serverProcess.on("error", (error) => {
          this.logger.error && this.logger.error('GLM-ASR 服务器进程错误:', error);
          this.serverProcess = null;
          this.serverReady = false;

          if (!initResponseReceived) {
            resolve();
          }
        });

        // GLM-ASR 首次加载模型可能需要较长时间
        setTimeout(() => {
          if (!initResponseReceived) {
            this.logger.warn && this.logger.warn('GLM-ASR 服务器启动超时（可能正在下载模型）');
            // 不杀死进程，让它继续下载
          }
        }, 300000); // 5 分钟超时
      });
    } catch (error) {
      this.logger.error && this.logger.error('启动 GLM-ASR 服务器异常:', error);
    }
  }

  async _sendServerCommand(command) {
    if (!this.serverProcess || !this.serverReady) {
      throw new Error('GLM-ASR 服务器未就绪');
    }

    return new Promise((resolve, reject) => {
      let responseReceived = false;

      const onData = (data) => {
        if (responseReceived) return;

        const lines = data.toString().split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const result = JSON.parse(line);
            responseReceived = true;
            this.serverProcess.stdout.removeListener('data', onData);
            resolve(result);
            return;
          } catch (parseError) {
            // 忽略非 JSON 输出
          }
        }
      };

      this.serverProcess.stdout.on('data', onData);
      this.serverProcess.stdin.write(JSON.stringify(command) + '\n');

      setTimeout(() => {
        if (!responseReceived) {
          responseReceived = true;
          this.serverProcess.stdout.removeListener('data', onData);
          reject(new Error('服务器响应超时'));
        }
      }, 120000); // 2 分钟超时（GLM-ASR 推理可能较慢）
    });
  }

  async _stopGLMASRServer() {
    if (this.serverProcess) {
      try {
        await this._sendServerCommand({ action: 'exit' });
      } catch (error) {
        this.serverProcess.kill();
      }

      this.serverProcess = null;
      this.serverReady = false;
    }
  }

  async transcribeAudio(audioBlob, options = {}) {
    const status = await this.checkGLMASRInstallation();
    if (!status.installed) {
      throw new Error("GLM-ASR 依赖未安装。请先安装依赖。");
    }

    if (!this.serverReady && this.initializationPromise) {
      this.logger.info && this.logger.info('等待 GLM-ASR 服务器就绪...');
      await this.initializationPromise;
    }

    const tempAudioPath = await this.createTempAudioFile(audioBlob);

    try {
      if (!this.serverReady) {
        throw new Error('GLM-ASR 服务器未就绪，请稍后重试');
      }

      this.logger.info && this.logger.info('使用 GLM-ASR 进行转录');
      const result = await this._sendServerCommand({
        action: 'transcribe',
        audio_path: tempAudioPath,
        options: options
      });

      if (!result.success) {
        throw new Error(result.error || '转录失败');
      }

      this.transcriptionCount++;

      return {
        success: true,
        text: result.text.trim(),
        raw_text: result.raw_text,
        confidence: result.confidence || 0.0,
        language: result.language || "auto"
      };
    } catch (error) {
      throw error;
    } finally {
      await this.cleanupTempFile(tempAudioPath);
    }
  }

  async createTempAudioFile(audioBlob) {
    const tempDir = os.tmpdir();
    const filename = `glm_asr_audio_${crypto.randomUUID()}.wav`;
    const tempAudioPath = path.join(tempDir, filename);

    let buffer;
    if (audioBlob instanceof ArrayBuffer) {
      buffer = Buffer.from(audioBlob);
    } else if (audioBlob instanceof Uint8Array) {
      buffer = Buffer.from(audioBlob);
    } else if (typeof audioBlob === "string") {
      buffer = Buffer.from(audioBlob, "base64");
    } else if (audioBlob && audioBlob.buffer) {
      buffer = Buffer.from(audioBlob.buffer);
    } else {
      throw new Error(`不支持的音频数据类型: ${typeof audioBlob}`);
    }

    await fs.promises.writeFile(tempAudioPath, buffer);

    const stats = await fs.promises.stat(tempAudioPath);
    if (stats.size === 0) {
      throw new Error("音频文件为空");
    }

    return tempAudioPath;
  }

  async cleanupTempFile(tempAudioPath) {
    try {
      await fs.promises.unlink(tempAudioPath);
    } catch (cleanupError) {
      // 忽略清理错误
    }
  }

  async checkStatus() {
    try {
      if (this.serverReady) {
        return await this._sendServerCommand({ action: 'status' });
      } else {
        const installStatus = await this.checkGLMASRInstallation();
        const modelStatus = await this.checkModelFiles();

        return {
          success: installStatus.installed,
          error: installStatus.installed ? "GLM-ASR 服务器正在启动中..." : "GLM-ASR 依赖未安装",
          installed: installStatus.installed,
          models_downloaded: modelStatus.models_downloaded,
          initializing: this.initializationPromise !== null,
          engine: "glm-asr-nano"
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        installed: false,
        engine: "glm-asr-nano"
      };
    }
  }

  async restartServer() {
    try {
      this.logger.info && this.logger.info('重启 GLM-ASR 服务器...');

      if (this.serverProcess) {
        await this._stopGLMASRServer();
      }

      this.serverReady = false;
      this.initializationPromise = null;

      this.initializationPromise = this._startGLMASRServer();
      await this.initializationPromise;

      return { success: true, message: 'GLM-ASR 服务器重启成功' };
    } catch (error) {
      this.logger.error && this.logger.error('重启 GLM-ASR 服务器失败:', error);
      return { success: false, error: error.message };
    }
  }

  // 兼容 FunASRManager 的接口
  async downloadModels(progressCallback = null) {
    // GLM-ASR 模型在首次使用时自动下载
    if (progressCallback) {
      progressCallback({ stage: "GLM-ASR 模型将在首次使用时自动下载", progress: 100 });
    }
    return { success: true, message: "GLM-ASR 模型将在首次使用时自动从 HuggingFace 下载" };
  }

  async getDownloadProgress() {
    const modelStatus = await this.checkModelFiles();
    return {
      success: true,
      overall_progress: modelStatus.models_downloaded ? 100 : 0,
      models: {
        "glm-asr-nano": {
          progress: modelStatus.models_downloaded ? 100 : 0,
          downloaded: modelStatus.models_downloaded ? 1 : 0,
          total: 1
        }
      }
    };
  }

  // ============ 兼容 FunASRManager 接口的方法 ============

  /**
   * 检查 Python 安装状态（兼容 FunASRManager）
   */
  async checkPythonInstallation() {
    try {
      const pythonCmd = await this.findPythonExecutable();
      return { installed: true, path: pythonCmd };
    } catch (error) {
      return { installed: false, error: error.message };
    }
  }

  /**
   * 安装 Python（GLM-ASR 不需要嵌入式 Python）
   */
  async installPython(progressCallback = null) {
    if (progressCallback) {
      progressCallback({ stage: "GLM-ASR 使用系统 Python", percentage: 100 });
    }
    return {
      success: true,
      message: "GLM-ASR 使用系统 Python 3.10+，无需单独安装"
    };
  }

  /**
   * 检查 FunASR 安装状态（兼容接口，实际检查 GLM-ASR）
   */
  async checkFunASRInstallation() {
    return await this.checkGLMASRInstallation();
  }

  /**
   * 安装 FunASR（兼容接口，GLM-ASR 依赖已通过 uv sync 安装）
   */
  async installFunASR(progressCallback = null) {
    if (progressCallback) {
      progressCallback({ stage: "GLM-ASR 依赖检查", percentage: 50 });
    }

    // 检查依赖是否已安装
    const status = await this.checkGLMASRInstallation();

    if (progressCallback) {
      progressCallback({ stage: status.installed ? "依赖已就绪" : "请运行 uv sync", percentage: 100 });
    }

    if (status.installed) {
      return { success: true, message: "GLM-ASR 依赖已安装" };
    } else {
      return {
        success: false,
        message: "请运行 uv sync 安装依赖",
        error: status.error
      };
    }
  }
}

module.exports = GLMASRManager;

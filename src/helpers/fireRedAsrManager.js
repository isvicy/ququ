const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

/**
 * FireRedASR 管理器
 * 使用小红书开源的 FireRedASR 模型进行语音识别
 * 支持 GPU 加速，针对方言和歌词识别优化
 */
class FireRedASRManager {
  constructor(logger = null) {
    this.logger = logger || console;
    this.pythonCmd = null;
    this.isInitialized = false;
    this.serverProcess = null;
    this.serverReady = false;
    this.initializationPromise = null;
    this.transcriptionCount = 0;

    // 模型配置
    this.modelType = "aed"; // aed (1.1B) 或 llm (8.3B)
    this.device = null; // 自动检测
  }

  // 兼容 FunASRManager 的 modelsInitialized 属性
  get modelsInitialized() {
    return this.serverReady;
  }

  getFireRedASRServerPath() {
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "firered_asr_server.py");
    } else {
      return path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "firered_asr_server.py"
      );
    }
  }

  getSystemPythonPath() {
    // FireRedASR 需要较新的 torch，优先使用 uv 创建的虚拟环境
    const projectRoot = path.join(__dirname, "..", "..");

    const possiblePaths = [
      // 优先使用 uv 创建的虚拟环境
      path.join(projectRoot, ".venv", "bin", "python"),
      path.join(projectRoot, ".venv", "bin", "python3"),
      // 回退到系统 Python
      "python3",
      "python",
      "/usr/bin/python3",
      "/usr/local/bin/python3",
    ];

    for (const pythonPath of possiblePaths) {
      if (pythonPath.startsWith("/")) {
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

    // FireRedASR 通过 pip 安装，不需要设置额外路径

    // NixOS CUDA 支持：添加 CUDA 运行时库路径
    const nixosCudaLib = '/run/opengl-driver/lib';
    if (fs.existsSync(nixosCudaLib)) {
      env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
        ? `${nixosCudaLib}:${env.LD_LIBRARY_PATH}`
        : nixosCudaLib;
    }

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
        this.logger.info && this.logger.info('FireRedASR 使用 Python:', pythonPath);
        return pythonPath;
      }
    } catch (error) {
      this.logger.error && this.logger.error('Python 验证失败:', error);
    }

    throw new Error("未找到合适的 Python 3.10+，FireRedASR 需要 Python 3.10 或更高版本");
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

  async checkFireRedASRInstallation() {
    try {
      const pythonCmd = await this.findPythonExecutable();
      const env = this.buildPythonEnvironment();

      return new Promise((resolve) => {
        const checkProcess = spawn(pythonCmd, [
          "-c",
          'import torch; from fireredasr.models.fireredasr import FireRedAsr; print("OK")',
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
    // pip 包使用 ModelScope 缓存
    const msCache = path.join(os.homedir(), '.cache', 'modelscope', 'hub');
    const modelName = this.modelType === "aed" ? "FireRedASR-AED-L" : "FireRedASR-LLM-L";
    const msModelDir = path.join(msCache, `pengzhendong/FireRedASR-${this.modelType.toUpperCase()}-L`);

    const modelExists = fs.existsSync(msModelDir);

    return {
      success: true,
      models_downloaded: modelExists,
      missing_models: modelExists ? [] : [modelName],
      details: {
        [modelName]: {
          exists: modelExists,
          modelscope_path: msModelDir,
          note: modelExists
            ? "模型已缓存 (ModelScope)"
            : "模型未下载，首次启动时自动下载"
        }
      }
    };
  }

  async initializeAtStartup() {
    try {
      this.logger.info && this.logger.info('FireRedASR 管理器启动初始化开始');

      const pythonCmd = await this.findPythonExecutable();
      this.logger.info && this.logger.info('Python 可执行文件:', pythonCmd);

      const installStatus = await this.checkFireRedASRInstallation();
      this.logger.info && this.logger.info('FireRedASR 依赖状态:', installStatus);

      this.isInitialized = true;

      // 预启动服务器
      if (installStatus.installed) {
        this.preInitializeModels();
      }

      this.logger.info && this.logger.info('FireRedASR 管理器启动初始化完成');
    } catch (error) {
      this.logger.warn && this.logger.warn('FireRedASR 启动初始化失败:', error);
      this.isInitialized = true;
    }
  }

  async preInitializeModels() {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._startFireRedASRServer();
    return this.initializationPromise;
  }

  async _startFireRedASRServer() {
    try {
      this.logger.info && this.logger.info('启动 FireRedASR 服务器...');

      const status = await this.checkFireRedASRInstallation();
      if (!status.installed) {
        this.logger.warn && this.logger.warn('FireRedASR 依赖未安装，跳过服务器启动');
        return;
      }

      const pythonCmd = await this.findPythonExecutable();
      const serverPath = this.getFireRedASRServerPath();

      this.logger.info && this.logger.info('FireRedASR 服务器配置:', {
        pythonCmd,
        serverPath,
        serverExists: fs.existsSync(serverPath)
      });

      if (!fs.existsSync(serverPath)) {
        this.logger.error && this.logger.error('FireRedASR 服务器脚本未找到');
        return;
      }

      const pythonEnv = this.buildPythonEnvironment();

      return new Promise((resolve) => {
        const args = [serverPath, '--model-type', this.modelType];

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
                  this.logger.info && this.logger.info('FireRedASR 服务器启动成功', result);
                } else {
                  this.logger.error && this.logger.error('FireRedASR 服务器初始化失败', result);
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
            this.logger.debug && this.logger.debug('FireRedASR stderr:', errorOutput);
          }
        });

        this.serverProcess.on("close", (code) => {
          this.logger.warn && this.logger.warn('FireRedASR 服务器进程退出:', code);
          this.serverProcess = null;
          this.serverReady = false;

          if (!initResponseReceived) {
            resolve();
          }
        });

        this.serverProcess.on("error", (error) => {
          this.logger.error && this.logger.error('FireRedASR 服务器进程错误:', error);
          this.serverProcess = null;
          this.serverReady = false;

          if (!initResponseReceived) {
            resolve();
          }
        });

        // FireRedASR 首次加载模型可能需要较长时间
        setTimeout(() => {
          if (!initResponseReceived) {
            this.logger.warn && this.logger.warn('FireRedASR 服务器启动超时（可能正在下载模型）');
            // 不杀死进程，让它继续下载
          }
        }, 300000); // 5 分钟超时
      });
    } catch (error) {
      this.logger.error && this.logger.error('启动 FireRedASR 服务器异常:', error);
    }
  }

  async _sendServerCommand(command) {
    if (!this.serverProcess || !this.serverReady) {
      throw new Error('FireRedASR 服务器未就绪');
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
      }, 120000); // 2 分钟超时
    });
  }

  async _stopFireRedASRServer() {
    if (this.serverProcess) {
      const proc = this.serverProcess;
      this.serverProcess = null;
      this.serverReady = false;

      try {
        // 先尝试发送退出命令
        this._sendServerCommand({ action: 'exit' }).catch(() => {});

        // 等待进程退出，最多 5 秒（FireRedASR 模型较大，需要更长时间）
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            // 超时，强制杀死
            try {
              proc.kill('SIGKILL');
            } catch (e) {}
            resolve();
          }, 5000);

          proc.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });

          // 先尝试 SIGTERM
          try {
            proc.kill('SIGTERM');
          } catch (e) {}
        });

        this.logger.info && this.logger.info('FireRedASR 服务器已停止');
      } catch (error) {
        this.logger.warn && this.logger.warn('停止 FireRedASR 服务器时出错:', error);
        // 确保进程被杀死
        try {
          proc.kill('SIGKILL');
        } catch (e) {}
      }
    }
  }

  async transcribeAudio(audioBlob, options = {}) {
    const status = await this.checkFireRedASRInstallation();
    if (!status.installed) {
      throw new Error("FireRedASR 依赖未安装。请先安装依赖。");
    }

    if (!this.serverReady && this.initializationPromise) {
      this.logger.info && this.logger.info('等待 FireRedASR 服务器就绪...');
      await this.initializationPromise;
    }

    const tempAudioPath = await this.createTempAudioFile(audioBlob);

    try {
      if (!this.serverReady) {
        throw new Error('FireRedASR 服务器未就绪，请稍后重试');
      }

      this.logger.info && this.logger.info('使用 FireRedASR 进行转录');
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
    const filename = `firered_asr_audio_${crypto.randomUUID()}.wav`;
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
        const installStatus = await this.checkFireRedASRInstallation();
        const modelStatus = await this.checkModelFiles();

        return {
          success: installStatus.installed,
          error: installStatus.installed ? "FireRedASR 服务器正在启动中..." : "FireRedASR 依赖未安装",
          installed: installStatus.installed,
          models_downloaded: modelStatus.models_downloaded,
          initializing: this.initializationPromise !== null,
          engine: `firered-asr-${this.modelType}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        installed: false,
        engine: `firered-asr-${this.modelType}`
      };
    }
  }

  async restartServer() {
    try {
      this.logger.info && this.logger.info('重启 FireRedASR 服务器...');

      if (this.serverProcess) {
        await this._stopFireRedASRServer();
      }

      this.serverReady = false;
      this.initializationPromise = null;

      this.initializationPromise = this._startFireRedASRServer();
      await this.initializationPromise;

      return { success: true, message: 'FireRedASR 服务器重启成功' };
    } catch (error) {
      this.logger.error && this.logger.error('重启 FireRedASR 服务器失败:', error);
      return { success: false, error: error.message };
    }
  }

  // 获取安装脚本路径
  getSetupScriptPath() {
    if (process.env.NODE_ENV === "development") {
      return path.join(__dirname, "..", "..", "setup_firered_asr.py");
    } else {
      return path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "setup_firered_asr.py"
      );
    }
  }

  // 兼容 FunASRManager 的接口
  async downloadModels(progressCallback = null) {
    const pythonCmd = await this.findPythonExecutable();
    const setupScript = this.getSetupScriptPath();
    const env = this.buildPythonEnvironment();

    if (!fs.existsSync(setupScript)) {
      if (progressCallback) {
        progressCallback({ stage: "error", message: "安装脚本未找到", progress: 0 });
      }
      return { success: false, error: "安装脚本未找到" };
    }

    return new Promise((resolve) => {
      if (progressCallback) {
        progressCallback({ stage: "start", message: "开始安装 FireRedASR", progress: 0 });
      }

      const setupProcess = spawn(pythonCmd, [setupScript, "--model-type", this.modelType], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let lastResult = null;

      setupProcess.stdout.on("data", (data) => {
        const lines = data.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
          try {
            const status = JSON.parse(line);
            lastResult = status;

            if (progressCallback) {
              progressCallback({
                stage: status.stage || "downloading",
                message: status.message || "",
                progress: status.progress || 0,
                error: status.error,
              });
            }

            this.logger.info && this.logger.info('FireRedASR 安装进度:', status);
          } catch (e) {
            // 忽略非 JSON 输出
          }
        }
      });

      setupProcess.stderr.on("data", (data) => {
        this.logger.debug && this.logger.debug('FireRedASR 安装 stderr:', data.toString());
      });

      setupProcess.on("close", (code) => {
        if (code === 0 && lastResult && lastResult.success) {
          if (progressCallback) {
            progressCallback({ stage: "completed", message: "安装完成", progress: 100 });
          }
          resolve({
            success: true,
            message: "FireRedASR 安装完成",
            repo_path: lastResult.repo_path,
            model_path: lastResult.model_path,
          });
        } else {
          const error = lastResult?.error || `安装失败 (exit code: ${code})`;
          if (progressCallback) {
            progressCallback({ stage: "error", message: error, progress: 0 });
          }
          resolve({ success: false, error });
        }
      });

      setupProcess.on("error", (error) => {
        if (progressCallback) {
          progressCallback({ stage: "error", message: error.message, progress: 0 });
        }
        resolve({ success: false, error: error.message });
      });
    });
  }

  async getDownloadProgress() {
    const modelStatus = await this.checkModelFiles();
    return {
      success: true,
      overall_progress: modelStatus.models_downloaded ? 100 : 0,
      models: {
        "firered-asr": {
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
   * 安装 Python（FireRedASR 不需要嵌入式 Python）
   */
  async installPython(progressCallback = null) {
    if (progressCallback) {
      progressCallback({ stage: "FireRedASR 使用系统 Python", percentage: 100 });
    }
    return {
      success: true,
      message: "FireRedASR 使用系统 Python 3.10+，无需单独安装"
    };
  }

  /**
   * 检查 FunASR 安装状态（兼容接口，实际检查 FireRedASR）
   */
  async checkFunASRInstallation() {
    return await this.checkFireRedASRInstallation();
  }

  /**
   * 安装 FunASR（兼容接口）
   */
  async installFunASR(progressCallback = null) {
    if (progressCallback) {
      progressCallback({ stage: "FireRedASR 依赖检查", percentage: 50 });
    }

    const status = await this.checkFireRedASRInstallation();

    if (progressCallback) {
      progressCallback({ stage: status.installed ? "依赖已就绪" : "请安装 FireRedASR", percentage: 100 });
    }

    if (status.installed) {
      return { success: true, message: "FireRedASR 依赖已安装" };
    } else {
      return {
        success: false,
        message: "请安装 FireRedASR: pip install fireredasr",
        error: status.error
      };
    }
  }
}

module.exports = FireRedASRManager;

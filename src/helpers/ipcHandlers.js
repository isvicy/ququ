const { ipcMain } = require("electron");

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.funasrManager = managers.funasrManager;
    this.asrManagerFactory = managers.asrManagerFactory; // ASR 管理器工厂，支持热切换
    this.windowManager = managers.windowManager;
    this.hotkeyManager = managers.hotkeyManager;
    this.windowContextManager = managers.windowContextManager;
    this.logger = managers.logger;

    // 跟踪F2热键注册状态
    this.f2RegisteredSenders = new Set();

    this.setupHandlers();
  }

  /**
   * 获取当前活动的 ASR 管理器
   * 优先使用工厂的当前管理器，支持热切换
   */
  getActiveASRManager() {
    if (this.asrManagerFactory) {
      return this.asrManagerFactory.getManager();
    }
    return this.funasrManager;
  }

  setupHandlers() {
    // 环境和配置相关
    ipcMain.handle("get-config", () => {
      return this.environmentManager.exportConfig();
    });

    ipcMain.handle("validate-environment", () => {
      return this.environmentManager.validateEnvironment();
    });

    // 录音相关
    ipcMain.handle("start-recording", async () => {
      // TODO: 实现录音开始功能
      return { success: true };
    });

    ipcMain.handle("stop-recording", async () => {
      // TODO: 实现录音停止功能
      return { success: true };
    });

    // Python 和 FunASR 相关
    ipcMain.handle("check-python", async () => {
      return await this.funasrManager.checkPythonInstallation();
    });

    ipcMain.handle("install-python", async (event, progressCallback) => {
      return await this.funasrManager.installPython((progress) => {
        event.sender.send("python-install-progress", progress);
      });
    });

    ipcMain.handle("check-funasr", async () => {
      return await this.funasrManager.checkFunASRInstallation();
    });

    ipcMain.handle("check-funasr-status", async () => {
      const status = await this.funasrManager.checkStatus();
      
      // 添加模型初始化状态信息
      return {
        ...status,
        models_initialized: this.funasrManager.modelsInitialized,
        server_ready: this.funasrManager.serverReady,
        is_initializing: this.funasrManager.initializationPromise !== null
      };
    });

    ipcMain.handle("install-funasr", async (event) => {
      return await this.funasrManager.installFunASR((progress) => {
        event.sender.send("funasr-install-progress", progress);
      });
    });

    ipcMain.handle("funasr-status", async () => {
      return await this.funasrManager.checkStatus();
    });

    // 模型文件管理
    ipcMain.handle("check-model-files", async () => {
      return await this.funasrManager.checkModelFiles();
    });

    ipcMain.handle("get-download-progress", async () => {
      return await this.funasrManager.getDownloadProgress();
    });

    ipcMain.handle("download-models", async (event) => {
      return await this.funasrManager.downloadModels((progress) => {
        event.sender.send("model-download-progress", progress);
      });
    });

    // FireRedASR 专用安装接口
    ipcMain.handle("install-firered-asr", async (event) => {
      const { spawn } = require("child_process");
      const path = require("path");
      const fs = require("fs");

      // 获取 Python 路径
      const projectRoot = path.join(__dirname, "..", "..");
      const pythonPaths = [
        path.join(projectRoot, ".venv", "bin", "python"),
        path.join(projectRoot, ".venv", "bin", "python3"),
        "python3",
        "python",
      ];

      let pythonCmd = "python3";
      for (const p of pythonPaths) {
        if (p.startsWith("/") || p.startsWith(".")) {
          if (fs.existsSync(p)) {
            pythonCmd = p;
            break;
          }
        } else {
          pythonCmd = p;
          break;
        }
      }

      // 获取安装脚本路径
      const setupScript = process.env.NODE_ENV === "development"
        ? path.join(projectRoot, "setup_firered_asr.py")
        : path.join(process.resourcesPath, "app.asar.unpacked", "setup_firered_asr.py");

      if (!fs.existsSync(setupScript)) {
        return { success: false, error: "安装脚本未找到" };
      }

      return new Promise((resolve) => {
        const setupProcess = spawn(pythonCmd, [setupScript, "--model-type", "aed"], {
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONIOENCODING: "utf-8",
            PYTHONUNBUFFERED: "1",
          },
        });

        let lastResult = null;

        setupProcess.stdout.on("data", (data) => {
          const lines = data.toString().split("\n").filter((line) => line.trim());
          for (const line of lines) {
            try {
              const status = JSON.parse(line);
              lastResult = status;
              event.sender.send("firered-install-progress", status);
              this.logger.info && this.logger.info("FireRedASR 安装进度:", status);
            } catch (e) {
              // 忽略非 JSON 输出
            }
          }
        });

        setupProcess.stderr.on("data", (data) => {
          this.logger.debug && this.logger.debug("FireRedASR 安装 stderr:", data.toString());
        });

        setupProcess.on("close", (code) => {
          if (code === 0 && lastResult && lastResult.success) {
            resolve({
              success: true,
              message: "FireRedASR 安装完成",
              repo_path: lastResult.repo_path,
              model_path: lastResult.model_path,
            });
          } else {
            resolve({
              success: false,
              error: lastResult?.error || `安装失败 (exit code: ${code})`,
            });
          }
        });

        setupProcess.on("error", (error) => {
          resolve({ success: false, error: error.message });
        });
      });
    });

    // 检查 FireRedASR 安装状态
    ipcMain.handle("check-firered-asr-status", async () => {
      const path = require("path");
      const fs = require("fs");
      const os = require("os");

      // pip 包使用 ModelScope 缓存
      const msCache = path.join(os.homedir(), ".cache", "modelscope", "hub", "models");
      const msModelDir = path.join(msCache, "pengzhendong", "FireRedASR-AED-L");

      const modelExists = fs.existsSync(msModelDir);

      return {
        success: true,
        installed: modelExists,
        models_downloaded: modelExists,
        details: {
          model: { exists: modelExists, modelscope_path: msModelDir },
        },
      };
    });

    // FunASR 专用安装接口 (Fun-ASR-Nano-2512)
    ipcMain.handle("install-funasr-models", async (event) => {
      const { spawn } = require("child_process");
      const path = require("path");
      const fs = require("fs");

      const projectRoot = path.join(__dirname, "..", "..");
      const pythonPaths = [
        path.join(projectRoot, ".venv", "bin", "python"),
        path.join(projectRoot, ".venv", "bin", "python3"),
        "python3",
        "python",
      ];

      let pythonCmd = "python3";
      for (const p of pythonPaths) {
        if (p.startsWith("/") && fs.existsSync(p)) {
          pythonCmd = p;
          break;
        }
      }

      // 使用 Fun-ASR-Nano-2512 专用安装脚本
      const setupScript = path.join(projectRoot, "setup_funasr_2512.py");
      if (!fs.existsSync(setupScript)) {
        return { success: false, error: "setup_funasr_2512.py 不存在" };
      }

      return new Promise((resolve) => {
        const setupProcess = spawn(pythonCmd, [setupScript], {
          cwd: projectRoot,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
            PYTHONIOENCODING: "utf-8",
          },
        });

        let lastResult = null;

        setupProcess.stdout.on("data", (data) => {
          const lines = data.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const progress = JSON.parse(line);
              lastResult = progress;
              event.sender.send("funasr-model-download-progress", progress);
              this.logger.info && this.logger.info("FunASR 2512 安装进度:", progress);
            } catch (e) {
              // 非 JSON 输出忽略
            }
          }
        });

        setupProcess.stderr.on("data", (data) => {
          this.logger.debug && this.logger.debug("FunASR 2512 安装 stderr:", data.toString());
        });

        setupProcess.on("close", (code) => {
          if (code === 0 && lastResult && lastResult.success) {
            resolve({
              success: true,
              message: "Fun-ASR-Nano-2512 安装完成",
              repo_path: lastResult.repo_path,
            });
          } else {
            resolve({
              success: false,
              error: lastResult?.error || `安装失败 (exit code: ${code})`,
            });
          }
        });

        setupProcess.on("error", (error) => {
          resolve({ success: false, error: error.message });
        });
      });
    });

    // 检查 FunASR 模型状态
    ipcMain.handle("check-funasr-model-status", async () => {
      const path = require("path");
      const fs = require("fs");
      const os = require("os");

      const projectRoot = path.join(__dirname, "..", "..");

      // 检查 funasr_model.py 是否存在
      const modelPyPath = path.join(projectRoot, "funasr_model.py");
      const modelPyExists = fs.existsSync(modelPyPath);

      // FunASR 模型缓存位置 (ModelScope)
      const msCache = path.join(os.homedir(), ".cache", "modelscope", "hub", "models");

      // 新模型: FunAudioLLM/Fun-ASR-Nano-2512
      const asrModelDir = path.join(msCache, "FunAudioLLM", "Fun-ASR-Nano-2512");
      const asrModelFile = path.join(asrModelDir, "model.pt");

      // VAD 模型
      const vadModelDir = path.join(msCache, "damo", "speech_fsmn_vad_zh-cn-16k-common-pytorch");

      // Punc 模型
      const puncModelDir = path.join(msCache, "damo", "punc_ct-transformer_zh-cn-common-vocab272727-pytorch");

      const asrExists = fs.existsSync(asrModelFile);
      const vadExists = fs.existsSync(vadModelDir);
      const puncExists = fs.existsSync(puncModelDir);

      // 需要 funasr_model.py + ASR 模型才算安装完成
      const allInstalled = modelPyExists && asrExists;

      return {
        success: true,
        installed: allInstalled,
        models_downloaded: asrExists,
        model_py_exists: modelPyExists,
        details: {
          model_py: { exists: modelPyExists, path: modelPyPath },
          asr: { exists: asrExists, path: asrModelDir, name: "Fun-ASR-Nano-2512" },
          vad: { exists: vadExists, path: vadModelDir, name: "speech_fsmn_vad" },
          punc: { exists: puncExists, path: puncModelDir, name: "punc_ct-transformer" },
        },
      };
    });

    // AI文本处理
    ipcMain.handle("process-text", async (event, text, mode = 'optimize') => {
      return await this.processTextWithAI(text, mode);
    });

    ipcMain.handle("check-ai-status", async (event, testConfig = null) => {
      return await this.checkAIStatus(testConfig);
    });

    // 窗口上下文相关
    ipcMain.handle("get-window-context", async () => {
      if (!this.windowContextManager) {
        return {
          supported: false,
          type: 'general',
          icon: '🎤',
          label: '通用',
          appId: null,
          title: null
        };
      }
      return await this.windowContextManager.getCurrentContext();
    });

    ipcMain.handle("is-window-context-supported", () => {
      return this.windowContextManager?.isSupported() || false;
    });

    // 音频转录相关 - 使用当前活动的 ASR 管理器
    ipcMain.handle("transcribe-audio", async (event, audioData, options) => {
      const manager = this.getActiveASRManager();
      return await manager.transcribeAudio(audioData, options);
    });

    // ASR 引擎热切换
    ipcMain.handle("switch-asr-engine", async (event, newEngine) => {
      if (!this.asrManagerFactory) {
        return { success: false, error: "ASR 管理器工厂未初始化" };
      }

      this.logger.info && this.logger.info(`收到切换 ASR 引擎请求: ${newEngine}`);

      // 发送切换开始事件
      event.sender.send("asr-engine-switch-progress", {
        stage: "starting",
        message: `正在切换到 ${newEngine}...`,
        progress: 10
      });

      try {
        const result = await this.asrManagerFactory.switchEngine(newEngine);

        if (result.success) {
          // 保存设置
          await this.databaseManager.setSetting('asr_engine', newEngine);

          event.sender.send("asr-engine-switch-progress", {
            stage: "complete",
            message: result.message,
            progress: 100
          });
        } else {
          event.sender.send("asr-engine-switch-progress", {
            stage: "error",
            message: result.message,
            progress: 0
          });
        }

        return result;
      } catch (error) {
        this.logger.error && this.logger.error("切换 ASR 引擎失败:", error);
        event.sender.send("asr-engine-switch-progress", {
          stage: "error",
          message: error.message,
          progress: 0
        });
        return { success: false, error: error.message };
      }
    });

    // 获取当前 ASR 引擎信息
    ipcMain.handle("get-current-asr-engine", () => {
      if (this.asrManagerFactory) {
        return {
          success: true,
          engine: this.asrManagerFactory.getEngineName(),
          isSwitching: this.asrManagerFactory.isSwitchingEngine()
        };
      }
      return { success: false, error: "ASR 管理器工厂未初始化" };
    });

    // 数据库相关
    ipcMain.handle("save-transcription", (event, data) => {
      return this.databaseManager.saveTranscription(data);
    });

    ipcMain.handle("get-transcriptions", (event, limit, offset) => {
      return this.databaseManager.getTranscriptions(limit, offset);
    });

    ipcMain.handle("get-transcription", (event, id) => {
      return this.databaseManager.getTranscriptionById(id);
    });

    ipcMain.handle("delete-transcription", (event, id) => {
      return this.databaseManager.deleteTranscription(id);
    });

    ipcMain.handle("search-transcriptions", (event, query, limit) => {
      return this.databaseManager.searchTranscriptions(query, limit);
    });

    ipcMain.handle("get-transcription-stats", () => {
      return this.databaseManager.getTranscriptionStats();
    });

    ipcMain.handle("clear-all-transcriptions", () => {
      return this.databaseManager.clearAllTranscriptions();
    });

    // 设置相关
    ipcMain.handle("get-setting", (event, key, defaultValue) => {
      return this.databaseManager.getSetting(key, defaultValue);
    });

    ipcMain.handle("set-setting", (event, key, value) => {
      return this.databaseManager.setSetting(key, value);
    });

    ipcMain.handle("get-all-settings", () => {
      return this.databaseManager.getAllSettings();
    });

    ipcMain.handle("get-settings", () => {
      return this.databaseManager.getAllSettings();
    });

    ipcMain.handle("save-setting", (event, key, value) => {
      return this.databaseManager.setSetting(key, value);
    });

    ipcMain.handle("reset-settings", () => {
      // TODO: 实现重置设置功能
      return this.databaseManager.resetSettings();
    });

    // 剪贴板相关
    ipcMain.handle("copy-text", async (event, text) => {
      try {
        return await this.clipboardManager.copyText(text);
      } catch (error) {
        this.logger.error("复制文本失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("paste-text", async (event, text) => {
      return this.clipboardManager.pasteText(text);
    });

    ipcMain.handle("insert-text-directly", async (event, text) => {
      try {
        return await this.clipboardManager.insertTextDirectly(text);
      } catch (error) {
        this.logger.error("直接插入文本失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("enable-macos-accessibility", async () => {
      try {
        if (process.platform === "darwin") {
          const result = await this.clipboardManager.enableMacOSAccessibility();
          return { success: result };
        }
        return { success: true, message: "非 macOS 平台，无需设置" };
      } catch (error) {
        this.logger.error("启用 macOS accessibility 失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("read-clipboard", async () => {
      try {
        const text = await this.clipboardManager.readClipboard();
        return { success: true, text };
      } catch (error) {
        this.logger.error("读取剪贴板失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      try {
        return await this.clipboardManager.writeClipboard(text);
      } catch (error) {
        this.logger.error("写入剪贴板失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-clipboard-history", () => {
      // TODO: 实现剪贴板历史功能
      return [];
    });

    ipcMain.handle("clear-clipboard-history", () => {
      // TODO: 实现清除剪贴板历史功能
      return true;
    });

    // 窗口管理相关
    ipcMain.handle("hide-window", () => {
      if (this.windowManager.mainWindow) {
        this.windowManager.mainWindow.hide();
      }
      return true;
    });

    ipcMain.handle("show-window", () => {
      if (this.windowManager.mainWindow) {
        this.windowManager.mainWindow.show();
      }
      return true;
    });

    ipcMain.handle("minimize-window", () => {
      if (this.windowManager.mainWindow) {
        this.windowManager.mainWindow.minimize();
      }
      return true;
    });

    ipcMain.handle("close-window", () => {
      if (this.windowManager.mainWindow) {
        this.windowManager.mainWindow.close();
      }
      return true;
    });

    ipcMain.handle("show-control-panel", () => {
      this.windowManager.showControlPanel();
      return true;
    });

    ipcMain.handle("hide-control-panel", () => {
      this.windowManager.hideControlPanel();
      return true;
    });

    ipcMain.handle("open-control-panel", () => {
      this.windowManager.showControlPanel();
      return true;
    });

    ipcMain.handle("close-control-panel", () => {
      this.windowManager.hideControlPanel();
      return true;
    });

    ipcMain.handle("open-history-window", () => {
      this.windowManager.showHistoryWindow();
      return true;
    });

    ipcMain.handle("close-history-window", () => {
      this.windowManager.closeHistoryWindow();
      return true;
    });

    ipcMain.handle("hide-history-window", () => {
      this.windowManager.hideHistoryWindow();
      return true;
    });

    ipcMain.handle("open-settings-window", () => {
      this.windowManager.showSettingsWindow();
      return true;
    });

    ipcMain.handle("close-settings-window", () => {
      this.windowManager.closeSettingsWindow();
      return true;
    });

    ipcMain.handle("hide-settings-window", () => {
      this.windowManager.hideSettingsWindow();
      return true;
    });

    // 录音状态指示器
    ipcMain.handle("show-indicator", async (event, state) => {
      await this.windowManager.showIndicator(state);
      return true;
    });

    ipcMain.handle("hide-indicator", () => {
      this.windowManager.hideIndicator();
      return true;
    });

    ipcMain.handle("update-indicator-state", (event, state) => {
      this.windowManager.updateIndicatorState(state);
      return true;
    });

    ipcMain.handle("close-app", () => {
      require("electron").app.quit();
    });

    // 热键管理 - 添加发送者跟踪机制
    this.hotkeyRegisteredSenders = new Set(); // 跟踪已注册热键的发送者
    
    ipcMain.handle("register-hotkey", (event, hotkey) => {
      try {
        if (this.hotkeyManager) {
          const senderId = event.sender.id;
          
          // 检查是否已经为这个发送者注册过热键
          if (this.hotkeyRegisteredSenders.has(senderId)) {
            this.logger.info(`发送者 ${senderId} 已注册过热键，跳过重复注册`);
            return { success: true };
          }
          
          const success = this.hotkeyManager.registerHotkey(hotkey, () => {
            // 只发送热键触发事件到主窗口，避免重复触发
            this.logger.info(`热键 ${hotkey} 被触发，发送事件到主窗口`);
            if (this.windowManager && this.windowManager.mainWindow && !this.windowManager.mainWindow.isDestroyed()) {
              this.windowManager.mainWindow.webContents.send("hotkey-triggered", { hotkey });
            }
          });
          
          if (success) {
            // 添加发送者到跟踪列表
            this.hotkeyRegisteredSenders.add(senderId);
            
            // 监听窗口关闭事件，清理注册记录
            event.sender.on('destroyed', () => {
              this.hotkeyRegisteredSenders.delete(senderId);
              this.logger.info(`清理发送者 ${senderId} 的热键注册记录`);
            });
            
            this.logger.info(`热键 ${hotkey} 注册成功，发送者: ${senderId}`);
          } else {
            this.logger.error(`热键 ${hotkey} 注册失败`);
          }
          
          return { success };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("注册热键失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("unregister-hotkey", (event, hotkey) => {
      try {
        if (this.hotkeyManager) {
          const success = this.hotkeyManager.unregisterHotkey(hotkey);
          return { success };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("注销热键失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-current-hotkey", () => {
      try {
        if (this.hotkeyManager) {
          const hotkeys = this.hotkeyManager.getRegisteredHotkeys();
          // 返回第一个非F2的热键，或默认热键
          const mainHotkey = hotkeys.find(key => key !== 'F2') || "CommandOrControl+Shift+Space";
          return mainHotkey;
        }
        return "CommandOrControl+Shift+Space";
      } catch (error) {
        this.logger.error("获取当前热键失败:", error);
        return "CommandOrControl+Shift+Space";
      }
    });

    // F2热键管理
    ipcMain.handle("register-f2-hotkey", (event) => {
      try {
        const senderId = event.sender.id;
        
        // 检查是否已经为这个发送者注册过F2热键
        if (this.f2RegisteredSenders.has(senderId)) {
          this.logger.info(`F2热键已为发送者 ${senderId} 注册过，跳过重复注册`);
          return { success: true };
        }
        
        if (this.hotkeyManager) {
          // 只有在没有任何发送者注册时才注册热键
          const isFirstRegistration = this.f2RegisteredSenders.size === 0;
          
          if (isFirstRegistration) {
            const success = this.hotkeyManager.registerF2DoubleClick((data) => {
              // 发送F2双击事件到所有注册的渲染进程
              this.logger.info("发送F2双击事件到渲染进程:", data);
              this.f2RegisteredSenders.forEach(id => {
                const window = require("electron").BrowserWindow.getAllWindows().find(w => w.webContents.id === id);
                if (window && !window.isDestroyed()) {
                  window.webContents.send("f2-double-click", data);
                }
              });
            });
            
            if (!success) {
              return { success: false, error: "F2热键注册失败" };
            }
          }
          
          // 添加发送者到跟踪列表
          this.f2RegisteredSenders.add(senderId);
          
          // 监听窗口关闭事件，清理注册记录
          event.sender.on('destroyed', () => {
            this.f2RegisteredSenders.delete(senderId);
            this.logger.info(`清理发送者 ${senderId} 的F2热键注册记录`);

            // 如果没有发送者了，注销热键
            if (this.f2RegisteredSenders.size === 0) {
              this.hotkeyManager.unregisterHotkey('F2');
              this.logger.info('所有发送者都已注销，注销F2热键');
            }
          });
          
          return { success: true };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("注册F2热键失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("unregister-f2-hotkey", (event) => {
      try {
        const senderId = event.sender.id;
        
        if (this.hotkeyManager && this.f2RegisteredSenders.has(senderId)) {
          this.f2RegisteredSenders.delete(senderId);
          
          // 如果没有其他发送者注册F2热键，则注销热键
          if (this.f2RegisteredSenders.size === 0) {
            const success = this.hotkeyManager.unregisterHotkey('F2');
            this.logger.info('所有发送者都已注销，注销F2热键');
            return { success };
          } else {
            this.logger.info(`发送者 ${senderId} 已注销，但还有其他发送者注册了F2热键`);
            return { success: true };
          }
        }
        return { success: false, error: "热键管理器未初始化或未注册" };
      } catch (error) {
        this.logger.error("注销F2热键失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("set-recording-state", (event, isRecording) => {
      try {
        if (this.hotkeyManager) {
          this.hotkeyManager.setRecordingState(isRecording);
          return { success: true };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("设置录音状态失败:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-recording-state", () => {
      try {
        if (this.hotkeyManager) {
          const isRecording = this.hotkeyManager.getRecordingState();
          return { success: true, isRecording };
        }
        return { success: false, error: "热键管理器未初始化" };
      } catch (error) {
        this.logger.error("获取录音状态失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 文件操作
    ipcMain.handle("export-transcriptions", (event, format) => {
      // TODO: 实现导出转录功能
      return { success: true, path: "" };
    });

    ipcMain.handle("import-settings", () => {
      // TODO: 实现导入设置功能
      return { success: true };
    });

    ipcMain.handle("export-settings", () => {
      // TODO: 实现导出设置功能
      return { success: true, path: "" };
    });

    // 文件系统相关
    ipcMain.handle("show-item-in-folder", (event, fullPath) => {
      require("electron").shell.showItemInFolder(fullPath);
    });

    ipcMain.handle("open-external", (event, url) => {
      require("electron").shell.openExternal(url);
    });

    // 系统信息
    ipcMain.handle("get-system-info", () => {
      return {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron
      };
    });

    ipcMain.handle("check-permissions", async () => {
      try {
        // 检查辅助功能权限
        const hasAccessibility = await this.clipboardManager.checkAccessibilityPermissions();
        
        return {
          microphone: true, // 麦克风权限由前端检查
          accessibility: hasAccessibility
        };
      } catch (error) {
        this.logger.error("检查权限失败:", error);
        return {
          microphone: false,
          accessibility: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("request-permissions", async () => {
      try {
        // 对于辅助功能权限，我们只能引导用户手动授予
        // 这里可以打开系统设置页面
        if (process.platform === "darwin") {
          this.clipboardManager.openSystemSettings();
        }
        return { success: true };
      } catch (error) {
        this.logger.error("请求权限失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 测试辅助功能权限
    ipcMain.handle("test-accessibility-permission", async () => {
      try {
        // 使用测试文本检查权限
        await this.clipboardManager.pasteText("蛐蛐权限测试");
        return { success: true, message: "辅助功能权限测试成功" };
      } catch (error) {
        this.logger.error("辅助功能权限测试失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 打开系统权限设置
    ipcMain.handle("open-system-permissions", () => {
      try {
        if (process.platform === "darwin") {
          this.clipboardManager.openSystemSettings();
          return { success: true };
        } else {
          return { success: false, error: "当前平台不支持自动打开权限设置" };
        }
      } catch (error) {
        this.logger.error("打开系统权限设置失败:", error);
        return { success: false, error: error.message };
      }
    });

    // 应用信息
    ipcMain.handle("get-app-version", () => {
      return require("electron").app.getVersion();
    });

    ipcMain.handle("get-app-path", (event, name) => {
      return require("electron").app.getPath(name);
    });

    ipcMain.handle("check-for-updates", () => {
      // TODO: 实现更新检查功能
      return { hasUpdate: false };
    });

    // 调试和日志
    ipcMain.handle("log", (event, level, message, data) => {
      this.logger[level](`[渲染进程] ${message}`, data || "");
      return true;
    });

    ipcMain.handle("get-debug-info", () => {
      return {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appVersion: require("electron").app.getVersion()
      };
    });

    // 保持向后兼容性
    ipcMain.handle("log-message", (event, level, message, data) => {
      this.logger[level](`[渲染进程] ${message}`, data || "");
      return true;
    });

    // 中文特定功能
    ipcMain.handle("detect-language", (event, text) => {
      // TODO: 实现语言检测功能
      return { language: "zh-CN", confidence: 0.95 };
    });

    ipcMain.handle("segment-chinese", (event, text) => {
      // TODO: 实现中文分词功能
      return { segments: text.split("") };
    });

    ipcMain.handle("add-punctuation", (event, text) => {
      // TODO: 实现标点符号添加功能
      return { text: text };
    });

    // 音频处理
    ipcMain.handle("convert-audio-format", (event, audioData, targetFormat) => {
      // TODO: 实现音频格式转换功能
      return { success: true, data: audioData };
    });

    ipcMain.handle("enhance-audio", (event, audioData) => {
      // TODO: 实现音频增强功能
      return { success: true, data: audioData };
    });

    // 模型管理 - 更新为实际功能
    ipcMain.handle("download-model", async (event, modelName) => {
      // 使用统一的模型下载功能
      return await this.funasrManager.downloadModels((progress) => {
        event.sender.send("model-download-progress", progress);
      });
    });

    ipcMain.handle("get-available-models", () => {
      // 返回FunASR支持的模型列表
      return {
        models: [
          {
            name: "paraformer-large",
            displayName: "Paraformer Large (ASR)",
            type: "asr",
            size: "840MB",
            description: "大型中文语音识别模型"
          },
          {
            name: "fsmn-vad",
            displayName: "FSMN VAD",
            type: "vad",
            size: "1.6MB",
            description: "语音活动检测模型"
          },
          {
            name: "ct-transformer-punc",
            displayName: "CT Transformer (标点)",
            type: "punc",
            size: "278MB",
            description: "标点符号恢复模型"
          }
        ]
      };
    });

    ipcMain.handle("get-current-model", async () => {
      const status = await this.funasrManager.checkStatus();
      return {
        model: "paraformer-large",
        status: status.models_downloaded ? "ready" : "not_downloaded",
        details: status
      };
    });

    ipcMain.handle("switch-model", (event, modelName) => {
      // FunASR目前使用固定模型组合，暂不支持切换
      return {
        success: false,
        error: "FunASR使用固定模型组合，暂不支持切换单个模型"
      };
    });

    // 性能监控
    ipcMain.handle("get-performance-stats", () => {
      // TODO: 实现性能统计功能
      return { stats: {} };
    });

    ipcMain.handle("clear-performance-stats", () => {
      // TODO: 实现清除性能统计功能
      return { success: true };
    });

    // 错误报告
    ipcMain.handle("report-error", (event, error) => {
      this.logger.error("渲染进程错误:", error);
      // TODO: 实现错误报告功能
      return true;
    });

    // 开发工具
    if (process.env.NODE_ENV === "development") {
      ipcMain.handle("open-dev-tools", (event) => {
        const window = require("electron").BrowserWindow.fromWebContents(event.sender);
        if (window) {
          window.webContents.openDevTools();
        }
      });

      ipcMain.handle("reload-window", (event) => {
        const window = require("electron").BrowserWindow.fromWebContents(event.sender);
        if (window) {
          window.reload();
        }
      });
    }

    // 日志和调试相关
    ipcMain.handle("get-app-logs", (event, lines = 100) => {
      try {
        if (this.logger && this.logger.getRecentLogs) {
          return {
            success: true,
            logs: this.logger.getRecentLogs(lines)
          };
        }
        return {
          success: false,
          error: "日志管理器不可用"
        };
      } catch (error) {
        this.logger.error("获取应用日志失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("get-funasr-logs", (event, lines = 100) => {
      try {
        if (this.logger && this.logger.getFunASRLogs) {
          return {
            success: true,
            logs: this.logger.getFunASRLogs(lines)
          };
        }
        return {
          success: false,
          error: "日志管理器不可用"
        };
      } catch (error) {
        this.logger.error("获取FunASR日志失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("get-log-file-path", () => {
      try {
        if (this.logger && this.logger.getLogFilePath) {
          return {
            success: true,
            appLogPath: this.logger.getLogFilePath(),
            funasrLogPath: this.logger.getFunASRLogFilePath()
          };
        }
        return {
          success: false,
          error: "日志管理器不可用"
        };
      } catch (error) {
        this.logger.error("获取日志文件路径失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("open-log-file", (event, logType = 'app') => {
      try {
        if (this.logger) {
          const logPath = logType === 'funasr'
            ? this.logger.getFunASRLogFilePath()
            : this.logger.getLogFilePath();
          
          require("electron").shell.showItemInFolder(logPath);
          return { success: true };
        }
        return {
          success: false,
          error: "日志管理器不可用"
        };
      } catch (error) {
        this.logger.error("打开日志文件失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("get-system-debug-info", () => {
      try {
        const debugInfo = {
          system: {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            electronVersion: process.versions.electron,
            appVersion: require("electron").app.getVersion()
          },
          environment: {
            NODE_ENV: process.env.NODE_ENV,
            PATH: process.env.PATH,
            PYTHON_PATH: process.env.PYTHON_PATH,
            AI_API_KEY: '通过控制面板设置',
            AI_BASE_URL: '通过控制面板设置',
            AI_MODEL: '通过控制面板设置'
          },
          funasrStatus: {
            isInitialized: this.funasrManager.isInitialized,
            modelsInitialized: this.funasrManager.modelsInitialized,
            serverReady: this.funasrManager.serverReady,
            pythonCmd: this.funasrManager.pythonCmd
          }
        };

        if (this.logger && this.logger.getSystemInfo) {
          debugInfo.loggerInfo = this.logger.getSystemInfo();
        }

        return {
          success: true,
          debugInfo
        };
      } catch (error) {
        this.logger.error("获取系统调试信息失败:", error);
        return {
          success: false,
          error: error.message
        };
      }
    });

    ipcMain.handle("test-python-environment", async () => {
      try {
        this.logger && this.logger.info && this.logger.info('开始测试Python环境');
        
        const pythonCmd = await this.funasrManager.findPythonExecutable();
        const funasrStatus = await this.funasrManager.checkFunASRInstallation();
        
        const testResult = {
          success: true,
          pythonCmd,
          funasrStatus,
          timestamp: new Date().toISOString()
        };

        this.logger && this.logger.info && this.logger.info('Python环境测试完成', testResult);
        
        return testResult;
      } catch (error) {
        const errorResult = {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };

        this.logger && this.logger.error && this.logger.error('Python环境测试失败', errorResult);
        
        return errorResult;
      }
    });

    ipcMain.handle("restart-funasr-server", async () => {
      try {
        this.logger && this.logger.info && this.logger.info('手动重启FunASR服务器');
        
        // 使用新的restartServer方法
        const result = await this.funasrManager.restartServer();
        
        return result;
      } catch (error) {
        this.logger && this.logger.error && this.logger.error('重启FunASR服务器失败', error);
        return {
          success: false,
          error: error.message
        };
      }
    });
  }

  // 默认 system prompt
  _getDefaultPrompt() {
    return `清理语音转录文本。根据内容特征自行判断处理力度。

规则：
- 移除填充词（呃、嗯、那个、就是说）
- 处理重复和自我修正
- 修正明显错字
- 保留语气词（啊、呀、呢、吧）
- 列表内容用换行和编号格式化
- 长内容在话题转换处分段

示例：

输入：我想买一个新的手鸡
输出：我想买一个新的手机

输入：今天天气蛮不错的呀
输出：今天天气蛮不错的呀

输入：呃那个我觉得可以
输出：我觉得可以

输入：会议定在周三，呃不对，是周四下午三点
输出：会议定在周四下午三点

输入：首先要准备材料然后要搅拌最后要烘烤
输出：
1. 首先要准备材料
2. 然后要搅拌
3. 最后要烘烤

输入：呃我想说三点第一个就是那个关于预算的问题然后第二个是时间安排最后就是人员分配
输出：
我想说三点：

1. 关于预算的问题
2. 时间安排
3. 人员分配

直接输出结果。

原文：{text}`;
  }

  // 构建上下文提示（直接告诉模型窗口信息，让模型自己判断）
  _buildContextHint(context) {
    if (!context || !context.appId) {
      return '';
    }

    const windowInfo = context.title
      ? `${context.appId} - ${context.title}`
      : context.appId;

    return `
当前使用场景：用户正在「${windowInfo}」窗口中。
请根据这个场景调整优化策略，例如：
- 终端/命令行：保留命令、参数、路径格式
- 代码编辑器：保留技术术语、变量名格式（camelCase/snake_case）
- 浏览器：根据网页内容判断，技术文档保留术语，社交媒体保留口语
- 聊天软件：保留口语化表达和情感语气
- 写作工具：使用规范书面语`;
  }

  // 构建优化 prompt（支持用户自定义和上下文感知）
  async _buildOptimizePrompt(text, context = null) {
    const customPrompt = await this.databaseManager.getSetting('ai_system_prompt');
    let promptTemplate = customPrompt || this._getDefaultPrompt();

    // 如果有上下文信息，添加窗口信息让模型自己判断
    if (context && context.appId) {
      const contextHint = this._buildContextHint(context);
      // 在 "直接输出结果。" 之前插入上下文提示
      promptTemplate = promptTemplate.replace(
        '直接输出结果。',
        `${contextHint}

直接输出结果。`
      );
    }

    return promptTemplate.replace('{text}', text);
  }

  // AI文本处理方法
  async processTextWithAI(text, mode = 'optimize', context = null) {
    try {
      // 从数据库设置中获取API密钥
      const apiKey = await this.databaseManager.getSetting('ai_api_key');
      if (!apiKey) {
        return {
          success: false,
          error: '请先在设置页面配置AI API密钥'
        };
      }

      // 如果没有传入上下文，尝试获取当前窗口上下文
      if (!context && this.windowContextManager) {
        try {
          context = await this.windowContextManager.getCurrentContext();
        } catch (e) {
          this.logger?.warn('获取窗口上下文失败', e);
        }
      }

      // 根据 mode 选择 prompt
      let prompt;
      if (mode === 'optimize') {
        prompt = await this._buildOptimizePrompt(text, context);
      } else if (mode === 'summarize') {
        prompt = `请总结以下文本的主要内容，提取关键信息，直接输出结果：\n\n${text}`;
      } else if (mode === 'format') {
        prompt = `请将以下文本进行格式化，添加适当的段落分隔和标点，直接输出结果：\n\n${text}`;
      } else if (mode === 'correct') {
        prompt = `请纠正以下文本中的语法错误、错别字和语音识别错误，保持原意不变，直接输出结果：\n\n${text}`;
      } else {
        prompt = await this._buildOptimizePrompt(text, context);
      }

      const baseUrl = await this.databaseManager.getSetting('ai_base_url') || 'https://api.openai.com/v1';
      const model = await this.databaseManager.getSetting('ai_model') || 'gpt-3.5-turbo';
      const temperature = await this.databaseManager.getSetting('ai_temperature') ?? 0.1;

      const requestData = {
        model: model,
        messages: [
          {
            role: 'system',
            content: prompt
          }
        ],
        temperature: temperature,
        max_tokens: Math.min(Math.max(text.length * 2, 500), 4000),
        stream: false
      };

      this.logger.info('AI文本处理请求:', {
        baseUrl,
        model,
        mode,
        context: context ? { type: context.type, appId: context.appId } : null,
        inputText: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        requestData
      });

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData = { error: response.statusText };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || response.statusText };
        }
        throw new Error(errorData.error?.message || errorData.error || `API error: ${response.status}`);
      }

      const data = await response.json();

      this.logger.info('AI文本处理响应:', {
        status: response.status,
        data: data,
        usage: data.usage
      });

      if (data.choices && data.choices.length > 0) {
        const result = {
          success: true,
          text: data.choices[0].message.content.trim(),
          usage: data.usage,
          model: model
        };
        
        this.logger.info('AI文本处理结果:', {
          originalText: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
          optimizedText: result.text.substring(0, 100) + (result.text.length > 100 ? '...' : ''),
          usage: result.usage
        });
        
        return result;
      } else {
        this.logger.error('AI API返回数据格式错误:', response.data);
        return {
          success: false,
          error: 'AI API返回数据格式错误'
        };
      }
    } catch (error) {
      this.logger.error('AI文本处理失败:', error);
      
      let errorMessage = '文本处理失败';
      if (error.response) {
        // API错误响应
        if (error.response.status === 401) {
          errorMessage = 'API密钥无效，请检查配置';
        } else if (error.response.status === 429) {
          errorMessage = 'API调用频率超限，请稍后重试';
        } else if (error.response.status === 500) {
          errorMessage = 'AI服务器错误，请稍后重试';
        } else {
          errorMessage = `API错误: ${error.response.status}`;
        }
      } else if (error.code === 'ECONNABORTED') {
        errorMessage = '请求超时，请检查网络连接';
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = '无法连接到AI服务器，请检查网络';
      } else {
        errorMessage = error.message || '未知错误';
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  // 检查AI状态
  async checkAIStatus(testConfig = null) {
    try {
      this.logger.info('开始测试AI配置...', testConfig ? '使用临时配置' : '使用已保存配置');
      
      // 如果提供了测试配置，使用测试配置；否则使用已保存的配置
      let apiKey, baseUrl, model;
      
      if (testConfig) {
        apiKey = testConfig.ai_api_key;
        baseUrl = testConfig.ai_base_url || 'https://api.openai.com/v1';
        model = testConfig.ai_model || 'gpt-3.5-turbo';
        this.logger.info('使用临时测试配置:', { baseUrl, model, apiKeyLength: apiKey?.length || 0 });
      } else {
        apiKey = await this.databaseManager.getSetting('ai_api_key');
        baseUrl = await this.databaseManager.getSetting('ai_base_url') || 'https://api.openai.com/v1';
        model = await this.databaseManager.getSetting('ai_model') || 'gpt-3.5-turbo';
        this.logger.info('使用已保存配置:', { baseUrl, model, apiKeyLength: apiKey?.length || 0 });
      }
      
      if (!apiKey) {
        this.logger.warn('AI测试失败: 未配置API密钥');
        return {
          available: false,
          error: '未配置API密钥',
          details: '请输入AI API密钥'
        };
      }
      
      this.logger.info('AI配置信息:', {
        baseUrl: baseUrl,
        model: model,
        apiKeyLength: apiKey.length
      });
      
      // 发送一个更有意义的测试请求
      const testMessage = '请回复"测试成功"来确认AI服务正常工作';
      const requestData = {
        model: model,
        messages: [
          {
            role: 'user',
            content: testMessage
          }
        ],
        max_tokens: 50,
        temperature: 0.1
      };

      this.logger.info('发送AI测试请求:', requestData);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData)
      });

      this.logger.info('AI API响应状态:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('AI API错误响应:', errorText);
        
        let errorData = { error: response.statusText };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || response.statusText };
        }
        
        let errorMessage = errorData.error?.message || errorData.error || `HTTP ${response.status}`;
        if (response.status === 401) {
          errorMessage = 'API密钥无效或已过期';
        } else if (response.status === 403) {
          errorMessage = 'API密钥权限不足';
        } else if (response.status === 429) {
          errorMessage = 'API调用频率超限';
        } else if (response.status === 500) {
          errorMessage = 'AI服务器内部错误';
        }
        
        throw new Error(errorMessage);
      }

      const data = await response.json();
      this.logger.info('AI API成功响应:', data);

      if (!data.choices || data.choices.length === 0) {
        throw new Error('AI API返回格式异常：缺少choices字段');
      }

      const aiResponse = data.choices[0].message?.content || '';
      this.logger.info('AI回复内容:', aiResponse);

      return {
        available: true,
        model: model,
        status: 'connected',
        response: aiResponse,
        usage: data.usage,
        details: `成功连接到 ${model}，响应时间正常`
      };
    } catch (error) {
      this.logger.error('AI配置测试失败:', error);
      
      let errorMessage = '连接失败';
      if (error.message.includes('401')) {
        errorMessage = 'API密钥无效';
      } else if (error.message.includes('403')) {
        errorMessage = 'API密钥权限不足';
      } else if (error.message.includes('429')) {
        errorMessage = 'API调用频率超限';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = '无法连接到AI服务器，请检查网络和Base URL';
      } else if (error.message.includes('ECONNREFUSED')) {
        errorMessage = '连接被拒绝，请检查Base URL是否正确';
      } else if (error.message.includes('timeout')) {
        errorMessage = '请求超时，请检查网络连接';
      } else {
        errorMessage = error.message || '未知错误';
      }

      return {
        available: false,
        error: errorMessage,
        details: `测试失败原因: ${error.message}`
      };
    }
  }

  // 清理处理器
  removeAllHandlers() {
    ipcMain.removeAllListeners();
  }
}

module.exports = IPCHandlers;
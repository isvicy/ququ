const FunASRManager = require("./funasrManager");
const FireRedASRManager = require("./fireRedAsrManager");

/**
 * ASR 管理器工厂
 * 根据设置创建相应的 ASR 管理器实例
 * 支持热切换引擎
 */
class ASRManagerFactory {
  constructor(logger = null) {
    this.logger = logger || console;
    this.currentManager = null;
    this.currentEngine = null;
    this.isSwitching = false;
  }

  /**
   * 创建 ASR 管理器
   * @param {string} engine - "funasr" 或 "firered-asr"
   * @returns {FunASRManager|FireRedASRManager}
   */
  createManager(engine = "funasr") {
    this.logger.info && this.logger.info(`创建 ASR 管理器: ${engine}`);

    if (engine === "firered-asr") {
      this.currentManager = new FireRedASRManager(this.logger);
      this.currentEngine = "firered-asr";
    } else {
      // 默认使用 FunASR
      this.currentManager = new FunASRManager(this.logger);
      this.currentEngine = "funasr";
    }

    return this.currentManager;
  }

  /**
   * 获取当前管理器
   */
  getManager() {
    return this.currentManager;
  }

  /**
   * 获取当前引擎名称
   */
  getEngineName() {
    return this.currentEngine;
  }

  /**
   * 检查是否正在切换引擎
   */
  isSwitchingEngine() {
    return this.isSwitching;
  }

  /**
   * 热切换 ASR 引擎
   * @param {string} newEngine - 新引擎名称
   * @returns {Promise<{success: boolean, message: string, engine?: string}>}
   */
  async switchEngine(newEngine) {
    if (newEngine === this.currentEngine) {
      return { success: true, message: "已经在使用该引擎", engine: this.currentEngine };
    }

    if (this.isSwitching) {
      return { success: false, message: "正在切换引擎中，请稍候" };
    }

    this.isSwitching = true;
    const oldEngine = this.currentEngine;

    try {
      this.logger.info && this.logger.info(`热切换 ASR 引擎: ${oldEngine} -> ${newEngine}`);

      // 1. 停止当前管理器的服务器
      if (this.currentManager) {
        this.logger.info && this.logger.info(`停止当前 ${oldEngine} 服务器...`);
        try {
          if (typeof this.currentManager._stopFunASRServer === 'function') {
            await this.currentManager._stopFunASRServer();
          } else if (typeof this.currentManager._stopFireRedASRServer === 'function') {
            await this.currentManager._stopFireRedASRServer();
          } else if (typeof this.currentManager.stopServer === 'function') {
            await this.currentManager.stopServer();
          }
        } catch (error) {
          this.logger.warn && this.logger.warn("停止当前 ASR 服务器时出错:", error);
          // 继续切换，不阻塞
        }
      }

      // 2. 创建新管理器
      this.logger.info && this.logger.info(`创建新 ${newEngine} 管理器...`);
      this.createManager(newEngine);

      // 3. 初始化并启动新服务器
      this.logger.info && this.logger.info(`初始化 ${newEngine} 服务器...`);
      await this.currentManager.initializeAtStartup();

      // 4. 等待服务器真正启动完成
      this.logger.info && this.logger.info(`等待 ${newEngine} 服务器启动...`);
      if (this.currentManager.initializationPromise) {
        await this.currentManager.initializationPromise;
      }

      // 5. 轮询检查服务器是否就绪（最多等待 60 秒）
      const maxWaitTime = 60000; // 60 秒
      const pollInterval = 500; // 每 500ms 检查一次
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        if (this.currentManager.serverReady) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      // 6. 检查是否成功初始化
      const status = await this.currentManager.checkStatus();
      this.logger.info && this.logger.info(`${newEngine} 状态检查结果:`, status);

      if (!status.success) {
        throw new Error(status.error || `${newEngine} 初始化失败`);
      }

      // 确认服务器已就绪
      if (!this.currentManager.serverReady) {
        throw new Error(`${newEngine} 服务器启动超时`);
      }

      this.logger.info && this.logger.info(`成功切换到 ${newEngine}`);
      return {
        success: true,
        message: `已成功切换到 ${newEngine}`,
        engine: newEngine
      };

    } catch (error) {
      this.logger.error && this.logger.error(`切换引擎失败: ${error.message}`);

      // 尝试回退到旧引擎
      try {
        this.logger.info && this.logger.info(`尝试回退到 ${oldEngine}...`);
        this.createManager(oldEngine);
        await this.currentManager.initializeAtStartup();
        // 等待旧引擎启动
        if (this.currentManager.initializationPromise) {
          await this.currentManager.initializationPromise;
        }
      } catch (rollbackError) {
        this.logger.error && this.logger.error(`回退失败: ${rollbackError.message}`);
      }

      return {
        success: false,
        message: `切换到 ${newEngine} 失败: ${error.message}`,
        engine: this.currentEngine
      };
    } finally {
      this.isSwitching = false;
    }
  }
}

module.exports = ASRManagerFactory;

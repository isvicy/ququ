const FunASRManager = require("./funasrManager");
const GLMASRManager = require("./glmAsrManager");

/**
 * ASR 管理器工厂
 * 根据设置创建相应的 ASR 管理器实例
 */
class ASRManagerFactory {
  constructor(logger = null) {
    this.logger = logger || console;
    this.currentManager = null;
    this.currentEngine = null;
  }

  /**
   * 创建 ASR 管理器
   * @param {string} engine - "funasr" 或 "glm-asr"
   * @returns {FunASRManager|GLMASRManager}
   */
  createManager(engine = "funasr") {
    this.logger.info && this.logger.info(`创建 ASR 管理器: ${engine}`);

    if (engine === "glm-asr") {
      this.currentManager = new GLMASRManager(this.logger);
      this.currentEngine = "glm-asr";
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
   * 切换 ASR 引擎（需要重启应用生效）
   */
  async switchEngine(newEngine) {
    if (newEngine === this.currentEngine) {
      return { success: true, message: "已经在使用该引擎" };
    }

    this.logger.info && this.logger.info(`切换 ASR 引擎: ${this.currentEngine} -> ${newEngine}`);

    // 停止当前管理器的服务器
    if (this.currentManager) {
      try {
        if (this.currentManager._stopFunASRServer) {
          await this.currentManager._stopFunASRServer();
        } else if (this.currentManager._stopGLMASRServer) {
          await this.currentManager._stopGLMASRServer();
        }
      } catch (error) {
        this.logger.warn && this.logger.warn("停止当前 ASR 服务器时出错:", error);
      }
    }

    // 创建新管理器
    this.createManager(newEngine);

    return {
      success: true,
      message: `已切换到 ${newEngine}，请重启应用以完全生效`,
      engine: newEngine
    };
  }
}

module.exports = ASRManagerFactory;

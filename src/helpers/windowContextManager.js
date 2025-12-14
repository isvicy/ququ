/**
 * WindowContextManager - 窗口上下文感知管理器
 *
 * 用于获取当前焦点窗口的信息，以便根据上下文调整 AI 优化策略。
 * 目前仅支持 Niri compositor，其他环境会优雅降级。
 */

const { execFile } = require('child_process');

class WindowContextManager {
  constructor(logger) {
    this.logger = logger;
    this.niriSocket = process.env.NIRI_SOCKET;
    this.isNiriAvailable = !!this.niriSocket;

    if (this.isNiriAvailable) {
      this.logger?.info('WindowContextManager: 检测到 Niri 环境，启用窗口上下文感知');
    } else {
      this.logger?.info('WindowContextManager: 非 Niri 环境，窗口上下文感知已禁用');
    }
  }

  /**
   * 检查是否支持窗口上下文感知
   */
  isSupported() {
    return this.isNiriAvailable;
  }

  /**
   * 获取当前焦点窗口信息
   * @returns {Promise<Object|null>} 窗口信息或 null
   */
  async getFocusedWindow() {
    if (!this.isNiriAvailable) {
      return null;
    }

    return new Promise((resolve) => {
      execFile('niri', ['msg', '--json', 'focused-window'], { timeout: 1000 }, (error, stdout) => {
        if (error) {
          this.logger?.warn('WindowContextManager: 获取窗口信息失败', error.message);
          resolve(null);
          return;
        }

        try {
          const window = JSON.parse(stdout);
          resolve(window);
        } catch (e) {
          this.logger?.error('WindowContextManager: 解析窗口信息失败', e);
          resolve(null);
        }
      });
    });
  }

  /**
   * 获取当前窗口上下文
   * @returns {Promise<Object>} 上下文信息
   */
  async getCurrentContext() {
    const window = await this.getFocusedWindow();

    if (!window) {
      return {
        supported: this.isNiriAvailable,
        appId: null,
        title: null
      };
    }

    const context = {
      supported: true,
      appId: window.app_id,
      title: window.title
    };

    this.logger?.info('WindowContextManager: 当前上下文', { appId: window.app_id, title: window.title });

    return context;
  }
}

module.exports = { WindowContextManager };

/**
 * WindowContextManager - 窗口上下文感知管理器
 *
 * 用于获取当前焦点窗口的信息，以便根据上下文调整 AI 优化策略。
 * 目前仅支持 Niri compositor，其他环境会优雅降级。
 */

const { execFile } = require('child_process');

// 上下文类型定义
const CONTEXT_TYPES = {
  CODING: 'coding',
  TERMINAL: 'terminal',
  BROWSER: 'browser',
  COMMUNICATION: 'communication',
  WRITING: 'writing',
  GENERAL: 'general'
};

// 上下文配置：app_id 模式 -> 上下文类型
const CONTEXT_PATTERNS = {
  // 编程工具
  coding: ['code', 'vscode', 'vscodium', 'vim', 'nvim', 'neovim', 'emacs', 'idea', 'pycharm', 'webstorm', 'goland', 'clion', 'android-studio', 'sublime', 'atom', 'zed'],
  // 终端
  terminal: ['kitty', 'alacritty', 'wezterm', 'foot', 'gnome-terminal', 'konsole', 'xterm', 'urxvt', 'terminator', 'tilix', 'hyper'],
  // 浏览器
  browser: ['firefox', 'chrome', 'chromium', 'brave', 'edge', 'safari', 'vivaldi', 'opera', 'zen-browser', 'librewolf'],
  // 通讯工具
  communication: ['telegram', 'discord', 'slack', 'teams', 'wechat', 'qq', 'signal', 'element', 'thunderbird', 'mailspring'],
  // 写作工具
  writing: ['obsidian', 'notion', 'typora', 'mark-text', 'joplin', 'logseq', 'libreoffice', 'wps', 'word', 'docs']
};

// 上下文图标 (用于 UI 显示)
const CONTEXT_ICONS = {
  coding: '💻',
  terminal: '⌨️',
  browser: '🌐',
  communication: '💬',
  writing: '📝',
  general: '🎤'
};

// 上下文显示名称
const CONTEXT_LABELS = {
  coding: '编程',
  terminal: '终端',
  browser: '浏览器',
  communication: '聊天',
  writing: '写作',
  general: '通用'
};

class WindowContextManager {
  constructor(logger) {
    this.logger = logger;
    this.niriSocket = process.env.NIRI_SOCKET;
    this.isNiriAvailable = !!this.niriSocket;
    this.lastContext = null;

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
      execFile('niri', ['msg', '--json', 'focused-window'], { timeout: 1000 }, (error, stdout, stderr) => {
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
   * 根据 app_id 判断上下文类型
   * @param {string} appId - 应用 ID
   * @returns {string} 上下文类型
   */
  getContextType(appId) {
    if (!appId) return CONTEXT_TYPES.GENERAL;

    const lowerAppId = appId.toLowerCase();

    for (const [type, patterns] of Object.entries(CONTEXT_PATTERNS)) {
      for (const pattern of patterns) {
        if (lowerAppId.includes(pattern)) {
          return type;
        }
      }
    }

    return CONTEXT_TYPES.GENERAL;
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
        type: CONTEXT_TYPES.GENERAL,
        icon: CONTEXT_ICONS.general,
        label: CONTEXT_LABELS.general,
        appId: null,
        title: null
      };
    }

    const type = this.getContextType(window.app_id);

    const context = {
      supported: true,
      type,
      icon: CONTEXT_ICONS[type],
      label: CONTEXT_LABELS[type],
      appId: window.app_id,
      title: window.title
    };

    this.lastContext = context;
    this.logger?.info('WindowContextManager: 当前上下文', { type, appId: window.app_id });

    return context;
  }

  /**
   * 获取上下文类型列表（用于设置 UI）
   */
  static getContextTypes() {
    return Object.entries(CONTEXT_LABELS).map(([type, label]) => ({
      type,
      label,
      icon: CONTEXT_ICONS[type]
    }));
  }

  /**
   * 获取上下文图标
   */
  static getIcon(type) {
    return CONTEXT_ICONS[type] || CONTEXT_ICONS.general;
  }

  /**
   * 获取上下文标签
   */
  static getLabel(type) {
    return CONTEXT_LABELS[type] || CONTEXT_LABELS.general;
  }
}

module.exports = {
  WindowContextManager,
  CONTEXT_TYPES,
  CONTEXT_ICONS,
  CONTEXT_LABELS
};

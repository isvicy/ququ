const { BrowserWindow, screen } = require("electron");
const path = require("path");

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.historyWindow = null;
    this.settingsWindow = null;
    this.indicatorWindow = null;
  }

  async createMainWindow(options = {}) {
    if (this.mainWindow) {
      this.mainWindow.focus();
      return this.mainWindow;
    }

    const startHidden = options.startHidden || false;

    this.mainWindow = new BrowserWindow({
      width: 400,
      height: 500,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      movable: true,
      show: !startHidden, // 如果启动时隐藏，则不显示窗口
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.mainWindow.loadURL("http://localhost:5173");
    } else {
      await this.mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    }

    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  async createControlPanelWindow() {
    if (this.controlPanelWindow) {
      this.controlPanelWindow.focus();
      return this.controlPanelWindow;
    }

    this.controlPanelWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.controlPanelWindow.loadURL("http://localhost:5173?panel=control");
    } else {
      await this.controlPanelWindow.loadFile(
        path.join(__dirname, "..", "dist", "index.html"),
        { query: { panel: "control" } }
      );
    }

    this.controlPanelWindow.on("closed", () => {
      this.controlPanelWindow = null;
    });

    return this.controlPanelWindow;
  }

  async createHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.focus();
      return this.historyWindow;
    }

    this.historyWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      title: "转录历史 - 蛐蛐",
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.historyWindow.loadURL("http://localhost:5173/history.html");
    } else {
      await this.historyWindow.loadFile(
        path.join(__dirname, "..", "dist", "history.html")
      );
    }

    this.historyWindow.on("closed", () => {
      this.historyWindow = null;
    });

    return this.historyWindow;
  }

  async createSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.focus();
      return this.settingsWindow;
    }

    this.settingsWindow = new BrowserWindow({
      width: 700,
      height: 600,
      show: false,
      title: "设置 - 蛐蛐",
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.settingsWindow.loadURL("http://localhost:5173?page=settings");
    } else {
      await this.settingsWindow.loadFile(
        path.join(__dirname, "..", "dist", "settings.html")
      );
    }

    this.settingsWindow.on("closed", () => {
      this.settingsWindow = null;
    });

    return this.settingsWindow;
  }

  showControlPanel() {
    if (this.controlPanelWindow) {
      this.controlPanelWindow.show();
      this.controlPanelWindow.focus();
    } else {
      this.createControlPanelWindow().then(() => {
        this.controlPanelWindow.show();
      });
    }
  }

  hideControlPanel() {
    if (this.controlPanelWindow) {
      this.controlPanelWindow.hide();
    }
  }

  showHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.show();
      this.historyWindow.focus();
      this.historyWindow.setAlwaysOnTop(true);
    } else {
      this.createHistoryWindow().then(() => {
        this.historyWindow.show();
        this.historyWindow.focus();
        this.historyWindow.setAlwaysOnTop(true);
      });
    }
  }

  hideHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.hide();
    }
  }

  closeHistoryWindow() {
    if (this.historyWindow) {
      this.historyWindow.close();
    }
  }

  showSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.show();
      this.settingsWindow.focus();
      this.settingsWindow.setAlwaysOnTop(true);
    } else {
      this.createSettingsWindow().then(() => {
        this.settingsWindow.show();
        this.settingsWindow.focus();
        this.settingsWindow.setAlwaysOnTop(true);
      });
    }
  }

  hideSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.hide();
    }
  }

  closeSettingsWindow() {
    if (this.settingsWindow) {
      this.settingsWindow.close();
    }
  }

  closeAllWindows() {
    if (this.mainWindow) {
      this.mainWindow.close();
    }
    if (this.controlPanelWindow) {
      this.controlPanelWindow.close();
    }
    if (this.historyWindow) {
      this.historyWindow.close();
    }
    if (this.settingsWindow) {
      this.settingsWindow.close();
    }
    if (this.indicatorWindow) {
      this.indicatorWindow.close();
    }
  }

  // 录音状态指示器窗口
  async createIndicatorWindow() {
    if (this.indicatorWindow) {
      return this.indicatorWindow;
    }

    // 获取主显示器工作区域
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workArea;

    // 指示器窗口尺寸（紧凑细长条）
    const indicatorWidth = 80;
    const indicatorHeight = 28;

    // 位置：屏幕底部居中，距离底部 30px
    const x = Math.round(workArea.x + (workArea.width - indicatorWidth) / 2);
    const y = workArea.y + workArea.height - indicatorHeight - 30;

    // 检测是否为 Wayland
    const isWayland = process.env.XDG_SESSION_TYPE === 'wayland' ||
                      process.env.WAYLAND_DISPLAY != null;

    this.indicatorWindow = new BrowserWindow({
      width: indicatorWidth,
      height: indicatorHeight,
      x: x,
      y: y,
      title: "ququ-indicator", // 用于 niri 窗口规则匹配
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "..", "preload.js"),
      },
    });

    // Wayland 下窗口位置可能需要在创建后设置
    if (isWayland) {
      this.indicatorWindow.setPosition(x, y);
    }

    // 加载指示器页面
    const isDev = process.env.NODE_ENV === "development";

    if (isDev) {
      await this.indicatorWindow.loadURL("http://localhost:5173/indicator.html");
    } else {
      await this.indicatorWindow.loadFile(
        path.join(__dirname, "..", "dist", "indicator.html")
      );
    }

    this.indicatorWindow.on("closed", () => {
      this.indicatorWindow = null;
    });

    return this.indicatorWindow;
  }

  async showIndicator(state = "recording") {
    if (!this.indicatorWindow) {
      await this.createIndicatorWindow();
    }

    // 发送状态到指示器窗口
    if (this.indicatorWindow && !this.indicatorWindow.isDestroyed()) {
      this.indicatorWindow.webContents.send("indicator-state", state);
      // 使用 showInactive() 避免抢占焦点
      this.indicatorWindow.showInactive();
    }
  }

  hideIndicator() {
    if (this.indicatorWindow && !this.indicatorWindow.isDestroyed()) {
      this.indicatorWindow.hide();
    }
  }

  updateIndicatorState(state) {
    if (this.indicatorWindow && !this.indicatorWindow.isDestroyed()) {
      this.indicatorWindow.webContents.send("indicator-state", state);
    }
  }

  updateIndicatorContext(context) {
    if (this.indicatorWindow && !this.indicatorWindow.isDestroyed()) {
      this.indicatorWindow.webContents.send("indicator-context", context);
    }
  }
}

module.exports = WindowManager;
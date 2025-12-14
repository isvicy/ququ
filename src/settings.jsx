import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { toast, Toaster } from "sonner";
import { Settings, Save, Eye, EyeOff, X, Loader2, TestTube, CheckCircle, XCircle, Mic, Shield, Monitor, AudioWaveform } from "lucide-react";
import { usePermissions } from "./hooks/usePermissions";
import PermissionCard from "./components/ui/permission-card";

const SettingsPage = () => {
  // 默认 system prompt
  const DEFAULT_SYSTEM_PROMPT = `清理语音转录文本。根据内容特征自行判断处理力度。

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

  const [settings, setSettings] = useState({
    ai_api_key: "",
    ai_base_url: "https://api.openai.com/v1",
    ai_model: "gpt-3.5-turbo",
    ai_temperature: 0.1,
    ai_system_prompt: "",  // 空表示使用默认值
    enable_ai_optimization: true,
    start_minimized: false,
    asr_engine: "funasr"
  });

  const [customModel, setCustomModel] = useState(false);
  const [platform, setPlatform] = useState('');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // 权限管理
  const showAlert = (alert) => {
    toast(alert.title, {
      description: alert.description,
      duration: 4000,
    });
  };

  const {
    micPermissionGranted,
    accessibilityPermissionGranted,
    requestMicPermission,
    testAccessibilityPermission,
  } = usePermissions(showAlert);

  // 加载设置
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      if (window.electronAPI) {
        const allSettings = await window.electronAPI.getAllSettings();
        const loadedSettings = {
          ai_api_key: allSettings.ai_api_key || "",
          ai_base_url: allSettings.ai_base_url || "https://api.openai.com/v1",
          ai_model: allSettings.ai_model || "gpt-3.5-turbo",
          ai_temperature: allSettings.ai_temperature ?? 0.1,
          ai_system_prompt: allSettings.ai_system_prompt || "",
          enable_ai_optimization: allSettings.enable_ai_optimization !== false,
          start_minimized: allSettings.start_minimized || false,
          asr_engine: allSettings.asr_engine || "funasr"
        };
        setSettings(prev => ({ ...prev, ...loadedSettings }));

        // 检查是否使用自定义模型
        const predefinedModels = ["gpt-3.5-turbo", "gpt-4", "gpt-4-turbo", "gpt-4o", "gpt-4o-mini", "qwen3-30b-a3b-instruct-2507"];
        setCustomModel(!predefinedModels.includes(loadedSettings.ai_model));

        // 获取平台信息
        const systemInfo = await window.electronAPI.getSystemInfo();
        setPlatform(systemInfo.platform);
      }
    } catch (error) {
      console.error("加载设置失败:", error);
      toast.error("加载设置失败");
    } finally {
      setLoading(false);
    }
  };

  // 保存设置
  const saveSettings = async () => {
    try {
      setSaving(true);
      if (window.electronAPI) {
        // 保存每个设置项
        await window.electronAPI.setSetting('ai_api_key', settings.ai_api_key);
        await window.electronAPI.setSetting('ai_base_url', settings.ai_base_url);
        await window.electronAPI.setSetting('ai_model', settings.ai_model);
        await window.electronAPI.setSetting('ai_temperature', settings.ai_temperature);
        await window.electronAPI.setSetting('ai_system_prompt', settings.ai_system_prompt);
        await window.electronAPI.setSetting('enable_ai_optimization', settings.enable_ai_optimization);
        await window.electronAPI.setSetting('start_minimized', settings.start_minimized);
        await window.electronAPI.setSetting('asr_engine', settings.asr_engine);

        toast.success("设置保存成功");
      }
    } catch (error) {
      console.error("保存设置失败:", error);
      toast.error("保存设置失败");
    } finally {
      setSaving(false);
    }
  };

  // 处理输入变化
  const handleInputChange = (key, value) => {
    setSettings(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // 应用推荐配置
  const applyRecommendedConfig = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ai_model: "qwen3-30b-a3b-instruct-2507"
    }));
    setCustomModel(true);
    toast.info("已应用阿里云推荐配置");
  };

  // 重置为OpenAI配置
  const resetToOpenAI = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "https://api.openai.com/v1",
      ai_model: "gpt-3.5-turbo"
    }));
    setCustomModel(false);
    toast.info("已重置为OpenAI配置");
  };

  // 测试AI配置
  const testAIConfiguration = async () => {
    try {
      setTesting(true);
      setTestResult(null);
      
      // 验证当前输入的配置
      if (!settings.ai_api_key.trim()) {
        setTestResult({
          available: false,
          error: '请先输入API密钥',
          details: 'API密钥不能为空'
        });
        toast.error("配置不完整", {
          description: "请先输入API密钥"
        });
        return;
      }
      
      if (window.electronAPI) {
        // 使用当前页面的配置进行测试，而不是已保存的配置
        const testConfig = {
          ai_api_key: settings.ai_api_key.trim(),
          ai_base_url: settings.ai_base_url.trim() || 'https://api.openai.com/v1',
          ai_model: settings.ai_model.trim() || 'gpt-3.5-turbo'
        };
        
        const result = await window.electronAPI.checkAIStatus(testConfig);
        setTestResult(result);
        
        if (result.available) {
          toast.success("AI配置测试成功！", {
            description: `模型: ${result.model || '未知'} - 连接正常`
          });
        } else {
          toast.error("AI配置测试失败", {
            description: result.error || "未知错误"
          });
        }
      }
    } catch (error) {
      console.error("测试AI配置失败:", error);
      setTestResult({
        available: false,
        error: error.message || "测试失败"
      });
      toast.error("测试失败", {
        description: error.message || "未知错误"
      });
    } finally {
      setTesting(false);
    }
  };

  // 关闭窗口
  const handleClose = () => {
    if (window.electronAPI) {
      window.electronAPI.hideSettingsWindow();
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
        <div className="flex items-center space-x-3">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          <span className="text-gray-700 dark:text-gray-300">加载设置中...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex flex-col">
      {/* 标题栏 - 固定 */}
      <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Settings className="w-5 h-5 text-blue-600" />
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 chinese-title">设置</h1>
          </div>
          <button
            onClick={handleClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          </button>
        </div>
      </div>

      {/* 主要内容 - 可滚动 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-2xl mx-auto p-6 pb-8">
          {/* 权限管理部分 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  权限管理
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  测试和管理应用权限，确保麦克风和辅助功能正常工作。
                </p>
              </div>
              
              <div className="space-y-2">
                <PermissionCard
                  icon={Mic}
                  title="麦克风权限"
                  description="录制语音所需的权限"
                  granted={micPermissionGranted}
                  onRequest={requestMicPermission}
                  buttonText="测试麦克风"
                />

                <PermissionCard
                  icon={Shield}
                  title="辅助功能权限"
                  description="自动粘贴文本所需的权限"
                  granted={accessibilityPermissionGranted}
                  onRequest={testAccessibilityPermission}
                  buttonText="测试权限"
                />
              </div>
            </div>
          </div>

          {/* 启动设置部分 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  启动设置
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  配置应用的启动行为。
                </p>
              </div>

              <div className="space-y-4">
                {/* 启动时最小化到托盘 */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <Monitor className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                    <div>
                      <label htmlFor="start-minimized-toggle" className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        启动时最小化到托盘
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        应用启动后隐藏主窗口，仅显示托盘图标
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.start_minimized}
                    onClick={() => handleInputChange('start_minimized', !settings.start_minimized)}
                    className={`${
                      settings.start_minimized ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                    } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.start_minimized ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>

                {/* 提示信息 */}
                <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg">
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    💡 <strong>提示：</strong>如需开机自动启动，请在窗口管理器配置中添加启动项。
                    {platform === 'linux' && (
                      <span className="block mt-1 text-blue-600 dark:text-blue-400">
                        niri 用户可在配置文件中添加：<code className="bg-blue-100 dark:bg-blue-800 px-1 rounded">spawn-at-startup "ququ"</code>
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* 语音识别引擎设置 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  语音识别引擎
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  选择用于语音转文字的识别引擎。切换引擎后需要重启应用生效。
                </p>
              </div>

              <div className="space-y-3">
                {/* FunASR 选项 */}
                <label
                  className={`flex items-start space-x-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                    settings.asr_engine === 'funasr'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="asr_engine"
                    value="funasr"
                    checked={settings.asr_engine === 'funasr'}
                    onChange={(e) => handleInputChange('asr_engine', e.target.value)}
                    className="mt-1 w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                  />
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">FunASR (Paraformer)</span>
                      <span className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded">默认</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      阿里达摩院开源模型，中文识别准确，资源占用较低，支持 CPU 运行
                    </p>
                  </div>
                </label>

                {/* GLM-ASR 选项 */}
                <label
                  className={`flex items-start space-x-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                    settings.asr_engine === 'glm-asr'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="asr_engine"
                    value="glm-asr"
                    checked={settings.asr_engine === 'glm-asr'}
                    onChange={(e) => handleInputChange('asr_engine', e.target.value)}
                    className="mt-1 w-4 h-4 text-blue-600 border-gray-300 focus:ring-blue-500"
                  />
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">GLM-ASR-Nano</span>
                      <span className="px-1.5 py-0.5 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded">推荐</span>
                      <span className="px-1.5 py-0.5 text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 rounded">GPU</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      智谱 2024.12 开源，1.5B 参数，中英混合识别最优，需要 GPU 和较新的 PyTorch
                    </p>
                    <div className="mt-2 p-2 bg-amber-50 dark:bg-amber-900/20 rounded text-xs text-amber-700 dark:text-amber-300">
                      ⚠️ 首次使用时模型会自动下载（约 3GB），需要 NVIDIA GPU
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* AI配置部分 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  AI配置
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                 配置AI模型以优化和增强语音识别结果。如果API Key无效或未填写，优化功能将自动禁用。
               </p>
              </div>

             <div className="space-y-4">
               {/* AI优化开关 */}
               <div className="flex items-center justify-between pt-4">
                 <label htmlFor="ai-optimization-toggle" className="text-sm font-medium text-gray-800 dark:text-gray-200">
                   启用AI文本优化
                 </label>
                 <button
                   type="button"
                   role="switch"
                   aria-checked={settings.enable_ai_optimization}
                   onClick={() => handleInputChange('enable_ai_optimization', !settings.enable_ai_optimization)}
                   className={`${
                     settings.enable_ai_optimization ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                   } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                 >
                   <span
                     aria-hidden="true"
                     className={`${
                       settings.enable_ai_optimization ? 'translate-x-4' : 'translate-x-0'
                     } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                   />
                 </button>
               </div>

               {/* API Key */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    API Key *
                  </label>
                  <div className="relative">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={settings.ai_api_key}
                      onChange={(e) => handleInputChange('ai_api_key', e.target.value)}
                      placeholder="请输入您的AI API Key"
                      className="w-full px-3 py-2 pr-10 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    用于AI文本优化功能的API密钥
                  </p>
                </div>

                {/* Base URL */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    API Base URL
                  </label>
                  <input
                    type="url"
                    value={settings.ai_base_url}
                    onChange={(e) => handleInputChange('ai_base_url', e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    AI服务的API端点地址，支持OpenAI兼容的API
                  </p>
                </div>

                {/* Model */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                      AI模型
                    </label>
                    <div className="flex items-center space-x-2">
                      <button
                        type="button"
                        onClick={applyRecommendedConfig}
                        className="text-xs px-2 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                      >
                        阿里云推荐
                      </button>
                      <button
                        type="button"
                        onClick={resetToOpenAI}
                        className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
                      >
                        OpenAI
                      </button>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <input
                        type="radio"
                        id="predefined-model"
                        name="model-type"
                        checked={!customModel}
                        onChange={() => setCustomModel(false)}
                        className="w-3 h-3 text-blue-600 border-gray-300 focus:ring-blue-500"
                      />
                      <label htmlFor="predefined-model" className="text-xs text-gray-700 dark:text-gray-300">
                        预定义模型
                      </label>
                    </div>
                    
                    {!customModel && (
                      <select
                        value={settings.ai_model}
                        onChange={(e) => handleInputChange('ai_model', e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      >
                        <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                        <option value="gpt-4">GPT-4</option>
                        <option value="gpt-4-turbo">GPT-4 Turbo</option>
                        <option value="gpt-4o">GPT-4o</option>
                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                        <option value="qwen3-30b-a3b-instruct-2507">Qwen3-30B (推荐)</option>
                      </select>
                    )}
                    
                    <div className="flex items-center space-x-2">
                      <input
                        type="radio"
                        id="custom-model"
                        name="model-type"
                        checked={customModel}
                        onChange={() => setCustomModel(true)}
                        className="w-3 h-3 text-blue-600 border-gray-300 focus:ring-blue-500"
                      />
                      <label htmlFor="custom-model" className="text-xs text-gray-700 dark:text-gray-300">
                        自定义模型
                      </label>
                    </div>
                    
                    {customModel && (
                      <input
                        type="text"
                        value={settings.ai_model}
                        onChange={(e) => handleInputChange('ai_model', e.target.value)}
                        placeholder="输入自定义模型名称，如：qwen3-30b-a3b-instruct-2507"
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    )}
                  </div>
                  
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    选择用于文本优化的AI模型。推荐使用阿里云Qwen3模型获得更好的中文处理效果。
                  </p>
                </div>

                {/* Temperature */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Temperature
                    <span className="text-xs text-gray-500 ml-2">
                      (越低输出越稳定，推荐 0.1-0.3)
                    </span>
                  </label>
                  <div className="flex items-center space-x-3">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={settings.ai_temperature}
                      onChange={(e) => handleInputChange('ai_temperature', parseFloat(e.target.value))}
                      className="flex-1 h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
                    />
                    <span className="text-sm font-mono w-10 text-center text-gray-700 dark:text-gray-300">
                      {settings.ai_temperature.toFixed(1)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    控制 AI 输出的随机性。不同模型的最佳值可能不同，建议测试后调整。
                  </p>
                </div>

                {/* System Prompt */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                      System Prompt
                    </label>
                    <button
                      type="button"
                      onClick={() => handleInputChange('ai_system_prompt', '')}
                      className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                    >
                      恢复默认
                    </button>
                  </div>
                  <textarea
                    value={settings.ai_system_prompt || DEFAULT_SYSTEM_PROMPT}
                    onChange={(e) => handleInputChange('ai_system_prompt', e.target.value)}
                    placeholder={DEFAULT_SYSTEM_PROMPT}
                    rows={12}
                    className="w-full px-3 py-2 text-xs font-mono border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 resize-y"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    自定义 AI 文本优化的 prompt。使用 <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{'{text}'}</code> 作为原文占位符。留空或点击"恢复默认"使用内置 prompt。
                  </p>
                </div>
              </div>

              {/* 测试结果显示 */}
              {testResult && (
                <div className={`mt-4 p-3 rounded-lg border ${
                  testResult.available
                    ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
                    : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                }`}>
                  <div className="flex items-center space-x-2">
                    {testResult.available ? (
                      <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
                    )}
                    <span className={`font-medium ${
                      testResult.available
                        ? 'text-green-800 dark:text-green-200'
                        : 'text-red-800 dark:text-red-200'
                    }`}>
                      {testResult.available ? 'AI配置测试成功' : 'AI配置测试失败'}
                    </span>
                  </div>
                  
                  {testResult.available && (
                    <div className="mt-2 space-y-1">
                      {testResult.model && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          <strong>模型:</strong> {testResult.model}
                        </p>
                      )}
                      {testResult.details && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          <strong>状态:</strong> {testResult.details}
                        </p>
                      )}
                      {testResult.response && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          <strong>AI回复:</strong> {testResult.response}
                        </p>
                      )}
                      {testResult.usage && (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          Token使用: {testResult.usage.total_tokens || 'N/A'}
                        </p>
                      )}
                    </div>
                  )}
                  
                  {!testResult.available && (
                    <div className="mt-2 space-y-1">
                      {testResult.error && (
                        <p className="text-xs text-red-700 dark:text-red-300">
                          <strong>错误:</strong> {testResult.error}
                        </p>
                      )}
                      {testResult.details && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                          {testResult.details}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex flex-col">
                  <button
                    onClick={testAIConfiguration}
                    disabled={testing}
                    className="flex items-center space-x-2 px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {testing ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <TestTube className="w-3 h-3" />
                    )}
                    <span>{testing ? "测试中..." : "测试配置"}</span>
                  </button>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    测试当前编辑的配置（无需保存）
                  </p>
                </div>
                
                <button
                  onClick={saveSettings}
                  disabled={saving || !settings.ai_api_key}
                  className="flex items-center space-x-2 px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  <span>{saving ? "保存中..." : "保存设置"}</span>
                </button>
              </div>
            </div>
          </div>

          {/* 其他设置部分 */}
          <div className="mt-4 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700">
            <div className="p-4">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title mb-3">
                关于蛐蛐
              </h2>
              <div className="bg-gradient-to-r from-blue-50 to-green-50 dark:from-blue-900/20 dark:to-green-900/20 p-3 rounded-lg">
                <p className="text-xs text-gray-700 dark:text-gray-300 mb-1">
                  🎤 <strong>蛐蛐 (QuQu)</strong> - 基于FunASR和AI的中文语音转文字应用
                </p>
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  • 高精度中文语音识别<br/>
                  • AI智能文本优化<br/>
                  • 实时语音处理<br/>
                  • 隐私保护设计
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// 导出组件供App.jsx使用
export { SettingsPage };

// 如果是直接访问settings.html，则渲染应用
if (document.getElementById("settings-root")) {
  const root = ReactDOM.createRoot(document.getElementById("settings-root"));
  root.render(<SettingsPage />);
}
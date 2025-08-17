// AI 回答完成提醒器 (Gemini & ChatGPT 整合版)

// --- Service Worker 保活机制 ---
let keepAliveInterval;

function keepServiceWorkerAlive() {
  // 每25秒执行一次保活操作，避免Service Worker休眠
  keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {
      // 简单的API调用来保持Service Worker活跃
    });
  }, 25000);
}

// 创建offscreen文档用于播放音频
async function createOffscreenDocument() {
  try {
    // 先检查是否已经存在offscreen文档
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (existingContexts.length > 0) {
      console.log('Offscreen document 已存在');
      return;
    }
    
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: '播放通知提示音'
    });
    console.log('Offscreen document 创建成功');
  } catch (error) {
    console.error('创建 offscreen document 失败:', error);
  }
}

// 播放通知声音
async function playNotificationSound() {
  try {
    // 获取用户设置
    const settings = await chrome.storage.sync.get({
      soundVolume: 0.8
    });
    
    // 确保offscreen文档已创建
    await createOffscreenDocument();
    
    // 等待一小段时间确保offscreen文档完全加载
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 始终播放内置音效
    const soundFile = 'streaming-complete.mp3';
    
    // 向offscreen文档发送消息
    await chrome.runtime.sendMessage({
      action: 'playSound',
      soundFile: soundFile,
      volume: settings.soundVolume
    });
    console.log('音频播放消息发送成功:', soundFile);
  } catch (error) {
    console.error('播放通知声音失败:', error);
    // 如果offscreen方式失败，尝试直接播放
    try {
      const audio = new Audio(chrome.runtime.getURL(`audio/streaming-complete.mp3`));
      audio.volume = settings.soundVolume ?? 0.8;
      await audio.play();
      console.log('使用直接方式播放音频成功');
    } catch (fallbackError) {
      console.error('直接播放音频也失败:', fallbackError);
    }
  }
}

// 启动保活机制
keepServiceWorkerAlive();

// 创建offscreen文档
createOffscreenDocument();

// 监听来自选项页面的测试音频请求
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'testSound') {
    playTestSound(message.soundFile, message.soundType, message.volume);
    sendResponse({ success: true });
  }
});

// 播放测试音频
async function playTestSound(soundFile, soundType, volume) {
  try {
    // 构建通知消息
    let message = `正在播放测试音效，音量: ${Math.round(volume * 100)}%`;
    if (volume === 0) {
      message = "音量已设为静音 (0%)";
    } else if (volume === 1) {
      message = "音量已设为最大 (100%)";
    }
    
    // 显示测试通知
    const testNotificationId = 'test_notification_' + Date.now();
    chrome.notifications.create(testNotificationId, {
      type: "basic",
      iconUrl: "icon128.png",
      title: "🔊 音效测试",
      message: message,
      priority: 1,
      silent: true  // 使用自定义音效
    });
    
    // 确保offscreen文档已创建
    await createOffscreenDocument();
    
    // 等待一小段时间确保offscreen文档完全加载
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 向offscreen文档发送消息
    await chrome.runtime.sendMessage({
      action: 'playSound',
      soundFile: soundFile,
      volume: volume
    });
    console.log('测试音频播放消息发送成功:', soundFile);
    
    // 3秒后自动清除测试通知
    setTimeout(() => {
      chrome.notifications.clear(testNotificationId);
    }, 3000);
  } catch (error) {
    console.error('播放测试音频失败:', error);
    // 如果offscreen方式失败，尝试直接播放
    try {
      const audio = new Audio(chrome.runtime.getURL(`audio/streaming-complete.mp3`));
      audio.volume = volume ?? 0.8;
      await audio.play();
      console.log('使用直接方式播放测试音频成功');
      
      // 即使是备用方式，也显示通知
      const fallbackNotificationId = 'test_notification_fallback_' + Date.now();
      chrome.notifications.create(fallbackNotificationId, {
        type: "basic",
        iconUrl: "icon128.png",
        title: "🔊 音效测试",
        message: `正在播放测试音效（备用方式），音量: ${Math.round(volume * 100)}%`,
        priority: 1,
        silent: true
      });
      
      setTimeout(() => {
        chrome.notifications.clear(fallbackNotificationId);
      }, 3000);
    } catch (fallbackError) {
      console.error('直接播放测试音频也失败:', fallbackError);
      
      // 显示错误通知
      chrome.notifications.create('test_error_' + Date.now(), {
        type: "basic",
        iconUrl: "icon128.png",
        title: "❌ 音效测试失败",
        message: "无法播放测试音效，请检查扩展权限",
        priority: 2
      });
    }
  }
}

// --- Gemini 相关配置 ---
const GEMINI_HOST = "gemini.google.com";
const GEMINI_GENERATE_PATH_RE = /\/((?:Stream)?Generate(?:Content|Answer)?(?:V2)?|v\d+(?:beta)?\/.*:(?:generateContent|streamGenerateContent))/i;

// --- ChatGPT 相关配置 ---
const CHATGPT_HOST = "chatgpt.com";
const CHATGPT_SSE_PATH = "/backend-api/f/conversation";
const CHATGPT_REPORT_PATH = "/backend-api/lat/r"; // 完成时的延迟报告请求

// --- 通用配置与状态管理 ---
const allUrls = [`https://*.${GEMINI_HOST}/*`, `https://*.${CHATGPT_HOST}/*`];
const filter = { urls: allUrls, types: ["xmlhttprequest"] };

// 用于记录 ChatGPT 的请求状态
const chatGPTRequests = new Map();
// 用于实现通知的节流/去抖
const lastNotifyAt = new Map();
// 长时间请求的备用检测
const longRunningRequests = new Map();
// 记录最后一次生成开始的时间
const lastGenerationStart = new Map();

// --- 持久化状态管理 ---
async function savePersistentState() {
  try {
    const state = {
      chatGPTRequests: Array.from(chatGPTRequests.entries()),
      longRunningRequests: Array.from(longRunningRequests.entries()).map(([tabId, data]) => [
        tabId, 
        { ...data, timeoutId: null } // 不保存timeout ID
      ]),
      lastGenerationStart: Array.from(lastGenerationStart.entries()),
      lastNotifyAt: Array.from(lastNotifyAt.entries()),
      timestamp: Date.now()
    };
    await chrome.storage.local.set({ notifierState: state });
  } catch (e) {
    console.error('保存状态失败:', e);
  }
}

async function loadPersistentState() {
  try {
    const result = await chrome.storage.local.get(['notifierState']);
    if (result.notifierState) {
      const state = result.notifierState;
      const now = Date.now();
      
      // 只恢复最近1小时内的状态
      if (now - state.timestamp < 60 * 60 * 1000) {
        // 恢复状态
        state.chatGPTRequests?.forEach(([key, value]) => chatGPTRequests.set(key, value));
        state.longRunningRequests?.forEach(([key, value]) => {
          // 重新设置超时
          if (value.startTime && now - value.startTime < 45 * 60 * 1000) {
            const remaining = 45 * 60 * 1000 - (now - value.startTime);
            const timeoutId = setTimeout(() => {
              chatGPTRequests.delete(value.requestId);
              longRunningRequests.delete(key);
            }, remaining);
            longRunningRequests.set(key, { ...value, timeoutId });
          }
        });
        state.lastGenerationStart?.forEach(([key, value]) => {
          // 只恢复1小时内的记录
          if (now - value < 60 * 60 * 1000) {
            lastGenerationStart.set(key, value);
          }
        });
        state.lastNotifyAt?.forEach(([key, value]) => lastNotifyAt.set(key, value));
        
        console.log('已恢复持久化状态');
      }
    }
  } catch (e) {
    console.error('加载状态失败:', e);
  }
}

// 启动时恢复状态
loadPersistentState();

// 定期保存状态
setInterval(savePersistentState, 30000); // 每30秒保存一次

// --- 通用工具函数 ---
// 为长时间任务设置持久化检测
function setupPersistentDetection(requestId, tabId) {
  // 设置45分钟的超长检测时间
  const timeoutId = setTimeout(() => {
    // 超时后强制清理
    chatGPTRequests.delete(requestId);
    longRunningRequests.delete(tabId);
    savePersistentState(); // 保存状态变化
  }, 45 * 60 * 1000); // 45分钟超时保护
  
  // 保存超时ID用于清理
  longRunningRequests.set(tabId, { 
    requestId, 
    timeoutId,
    startTime: Date.now()
  });
  
  // 立即保存状态
  savePersistentState();
}

function isThrottled(tabId, ms) {
  const now = Date.now();
  const last = lastNotifyAt.get(tabId) || 0;
  if (now - last < ms) return true;
  lastNotifyAt.set(tabId, now);
  return false;
}

// 全局通知ID管理
let currentNotificationId = null;

async function sendNotification(title, message, platform = 'unknown') {
  try {
    // 检查平台是否启用
    const settings = await chrome.storage.sync.get({
      geminiEnabled: true,
      chatgptEnabled: true
    });
    
    // 根据消息标题判断平台并检查是否启用
    const isGemini = title.includes('Gemini');
    const isChatGPT = title.includes('ChatGPT');
    
    if (isGemini && !settings.geminiEnabled) return;
    if (isChatGPT && !settings.chatgptEnabled) return;
    
    // 如果有旧通知，先清除它
    if (currentNotificationId) {
      chrome.notifications.clear(currentNotificationId);
    }
    
    // 生成新的通知ID
    currentNotificationId = 'ai_notification_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    chrome.notifications.create(currentNotificationId, {
      type: "basic",
      iconUrl: "icon128.png",
      title: title,
      message: message,
      priority: 1,
      silent: true  // 始终静音，使用自定义音效
    });
    
    // 播放自定义声音提醒
    playNotificationSound();
    
    // 8秒后自动清除通知
    setTimeout(() => {
      if (currentNotificationId) {
        chrome.notifications.clear(currentNotificationId);
        currentNotificationId = null;
      }
    }, 8000);
  } catch (e) {
    console.error("发送通知失败:", e);
  }
}

// 监听通知被用户手动关闭的事件
chrome.notifications.onClosed.addListener((notificationId, byUser) => {
  if (notificationId === currentNotificationId) {
    currentNotificationId = null;
  }
});


// --- 监听器逻辑 ---

// 1. ChatGPT: onBeforeRequest - 捕获潜在的 SSE 请求
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.method !== 'POST') return;
  try {
    const url = new URL(details.url);
    if (url.hostname === CHATGPT_HOST && url.pathname === CHATGPT_SSE_PATH) {
      chatGPTRequests.set(details.requestId, { 
        tabId: details.tabId, 
        isStream: false,
        startTime: Date.now()
      });
      // 记录生成开始时间，保持60分钟
      lastGenerationStart.set(details.tabId, Date.now());
      savePersistentState(); // 保存状态变化
      setTimeout(() => {
        lastGenerationStart.delete(details.tabId);
        savePersistentState(); // 保存状态变化
      }, 60 * 60 * 1000); // 60分钟后清理
    }
  } catch {}
}, { urls: [`https://*.${CHATGPT_HOST}/*`], types: ["xmlhttprequest"] });

// 2. ChatGPT: onHeadersReceived - 确认是否为 SSE 流
chrome.webRequest.onHeadersReceived.addListener((details) => {
  const req = chatGPTRequests.get(details.requestId);
  if (!req) return;

  const isEventStream = details.responseHeaders.some(h =>
    h.name.toLowerCase() === 'content-type' && (h.value || '').includes('text/event-stream')
  );

  if (isEventStream) {
    req.isStream = true;
    // 为长时间任务设置持久化检测
    setupPersistentDetection(details.requestId, req.tabId);
  } else {
    // 如果不是 SSE 流，则从监控中移除
    chatGPTRequests.delete(details.requestId);
  }
}, { urls: [`https://*.${CHATGPT_HOST}/*`], types: ["xmlhttprequest"] }, ["responseHeaders"]);

// 3. 通用: onCompleted - 处理所有完成的请求
chrome.webRequest.onCompleted.addListener((details) => {
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return; // 无效的 URL，直接忽略
  }

  // --- Gemini 逻辑 ---
  if (url.hostname === GEMINI_HOST && details.method === "POST") {
    if (GEMINI_GENERATE_PATH_RE.test(url.pathname)) {
      if (!isThrottled(details.tabId, 2000)) { // 2秒节流
        sendNotification("Gemini 生成完成", "当前页面的回答已生成完成。");
      }
    }
    return; // 处理完 Gemini 的逻辑就结束
  }

  // --- ChatGPT 逻辑 ---
  const chatGPTReq = chatGPTRequests.get(details.requestId);
  if (chatGPTReq && chatGPTReq.isStream) {
     if (!isThrottled(details.tabId, 4000)) { // 4秒去抖
        sendNotification("ChatGPT 生成完成", "检测到 ChatGPT 的生成流已结束。");
     }
     // 清理所有相关记录
     chatGPTRequests.delete(details.requestId);
     const longReq = longRunningRequests.get(details.tabId);
     if (longReq && longReq.requestId === details.requestId) {
       clearTimeout(longReq.timeoutId);
       longRunningRequests.delete(details.tabId);
     }
     savePersistentState(); // 保存状态变化
     return;
  }
  
  // --- ChatGPT Lat/R请求检测（长时间任务完成信号） ---
  if (url.hostname === CHATGPT_HOST && url.pathname === CHATGPT_REPORT_PATH) {
    console.log('[ChatGPT Notifier] 检测到lat/r请求，tabId:', details.tabId);
    
    // 获取最近的生成开始时间
    const lastStart = lastGenerationStart.get(details.tabId);
    const now = Date.now();
    
    // 打印调试信息
    console.log('[ChatGPT Notifier] lastStart:', lastStart, 'now:', now, 'diff:', lastStart ? now - lastStart : 'N/A');
    
    // 检查是否有活跃的ChatGPT生成任务
    const hasActiveChatGPT = Array.from(chatGPTRequests.values()).some(req => req.tabId === details.tabId);
    const hasLongRunning = longRunningRequests.has(details.tabId);
    
    console.log('[ChatGPT Notifier] hasActiveChatGPT:', hasActiveChatGPT, 'hasLongRunning:', hasLongRunning);
    
    // 简化逻辑：有生成记录就通知（至少要10秒避免太快的误报）
    if (lastStart && (now - lastStart > 10000)) {
      if (!isThrottled(details.tabId, 4000)) {
        sendNotification("ChatGPT 生成完成", "检测到延迟报告请求，任务已完成。");
      }
      // 清理所有记录
      for (const [requestId, req] of chatGPTRequests.entries()) {
        if (req.tabId === details.tabId) {
          chatGPTRequests.delete(requestId);
        }
      }
      const longReq = longRunningRequests.get(details.tabId);
      if (longReq) {
        clearTimeout(longReq.timeoutId);
        longRunningRequests.delete(details.tabId);
      }
      lastGenerationStart.delete(details.tabId);
      savePersistentState(); // 保存状态变化
    } else {
      console.log('[ChatGPT Notifier] 忽略lat/r请求 - 条件不满足');
    }
    return;
  }
}, filter);


// 4. 通用: onErrorOccurred - 请求出错时清理
chrome.webRequest.onErrorOccurred.addListener((details) => {
  // 主要为 ChatGPT 清理记录
  if (chatGPTRequests.has(details.requestId)) {
    chatGPTRequests.delete(details.requestId);
    // 同时清理长时间请求记录
    const longReq = longRunningRequests.get(details.tabId);
    if (longReq && longReq.requestId === details.requestId) {
      clearTimeout(longReq.timeoutId);
      longRunningRequests.delete(details.tabId);
    }
  }
}, filter);


// 4. 通用: onErrorOccurred - 请求出错时清理
// AI 回答完成提醒器 - 可扩展架构版
// ============================================================
// 添加新平台只需在 PLATFORMS 数组中添加配置对象即可
// ============================================================

// ===========================================
// 第一部分：平台配置（添加新平台请修改这里）
// ===========================================

/**
 * 平台配置说明：
 * - id: 平台唯一标识符（用于内部状态管理）
 * - name: 平台显示名称（用于通知标题）
 * - enabledKey: chrome.storage.sync 中的开关键名
 * - hosts: 需要监听的域名数组（支持通配符如 '*.example.com'）
 * - match: 请求匹配规则
 *   - method: HTTP 方法（'POST', 'GET' 等）
 *   - pathPattern: 路径匹配正则表达式，或字符串（精确匹配）
 *   - urlPattern: 完整 URL 匹配正则（用于跨域请求如 AI Studio）
 * - detection: 检测类型配置
 *   - type: 'request-complete' | 'sse-stream'
 *     - request-complete: 请求完成即通知（适用于普通 API）
 *     - sse-stream: SSE 流结束才通知（适用于流式传输）
 *   - trackStart: 是否记录开始时间（用于 followup 检测）
 * - streamEvents: SSE 流内事件配置（可选，需要 content script 支持）
 *   - reasoningEnd: 思考完成事件配置
 *     - enabledKey: 启用开关键名
 *     - notify: 通知配置
 * - followup: 备用完成信号配置（可选，用于长任务）
 *   - pathPattern: 备用信号的路径匹配
 *   - minDelayMs: 最小延迟时间（避免误报）
 * - notify: 通知配置
 *   - title: 通知标题
 *   - message: 通知内容
 *   - targetUrl: 点击通知后打开的 URL
 * - throttleMs: 节流时间（毫秒），同一标签页在此时间内不重复通知
 */

const PLATFORMS = [
  {
    id: 'gemini',
    name: 'Gemini',
    enabledKey: 'geminiEnabled',
    hosts: ['gemini.google.com'],
    match: {
      method: 'POST',
      pathPattern: /\/((?:Stream)?Generate(?:Content|Answer)?(?:V2)?|v\d+(?:beta)?\/.*:(?:generateContent|streamGenerateContent))/i
    },
    detection: { type: 'request-complete' },
    notify: {
      title: 'Gemini 生成完成',
      message: '当前页面的回答已生成完成。',
      targetUrl: 'https://gemini.google.com/app'
    },
    throttleMs: 2000
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    enabledKey: 'chatgptEnabled',
    hosts: ['chatgpt.com'],
    match: {
      method: 'POST',
      pathPattern: '/backend-api/f/conversation'
    },
    detection: {
      type: 'sse-stream',
      trackStart: true
    },
    // SSE 流内事件检测（需要 content script 支持）
    streamEvents: {
      reasoningEnd: {
        enabledKey: 'chatgptReasoningEndEnabled',
        notify: {
          title: 'ChatGPT 思考完成',
          message: '思考阶段已结束，正在生成回答...',
          targetUrl: 'https://chatgpt.com/'
        },
        throttleMs: 2000
      }
    },
    followup: {
      pathPattern: '/backend-api/lat/r',
      minDelayMs: 10000
    },
    notify: {
      title: 'ChatGPT 生成完成',
      message: '检测到 ChatGPT 的生成流已结束。',
      targetUrl: 'https://chatgpt.com/'
    },
    throttleMs: 4000
  },
  {
    id: 'aistudio',
    name: 'AI Studio',
    enabledKey: 'aistudioEnabled',
    hosts: ['aistudio.google.com', '*.clients6.google.com'],
    match: {
      method: 'POST',
      urlPattern: /^https:\/\/[\w.-]*clients6\.google\.com\/\$rpc\/google\.internal\.alkali\.applications\.makersuite\.v1\.MakerSuiteService\/(CreatePrompt|UpdatePrompt)$/
    },
    detection: { type: 'request-complete' },
    notify: {
      title: 'AI Studio 生成完成',
      message: 'AI Studio 的回答已生成完成。',
      targetUrl: 'https://aistudio.google.com/'
    },
    throttleMs: 2000
  }
];

// ===========================================
// 第二部分：常量与状态管理
// ===========================================

const DEFAULT_VOLUME = 1;
const MAX_VOLUME = 1.5;
const LONG_RUNNING_TIMEOUT_MS = 45 * 60 * 1000; // 45 分钟
const STATE_EXPIRY_MS = 60 * 60 * 1000; // 1 小时
const STATE_SAVE_INTERVAL_MS = 30000; // 30 秒

// 统一状态存储
const requestState = new Map();      // requestId -> { platformId, tabId, isStream, startTime }
const lastNotifyAt = new Map();      // `${platformId}:${tabId}` -> timestamp
const lastStartAt = new Map();       // `${platformId}:${tabId}` -> timestamp
const longRunningTimeouts = new Map(); // `${platformId}:${tabId}` -> { requestId, timeoutId, startTime }

// 通知状态
let currentNotificationId = null;
let currentNotificationTarget = null;
const testNotifications = new Map();

// ===========================================
// 第三部分：工具函数
// ===========================================

function stateKey(platformId, tabId) {
  return `${platformId}:${tabId ?? 'unknown'}`;
}

function clampVolume(value) {
  const numeric = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(numeric)) return DEFAULT_VOLUME;
  return Math.min(Math.max(numeric, 0), MAX_VOLUME);
}

function buildUrlFilters() {
  const urlSet = new Set();
  for (const platform of PLATFORMS) {
    for (const host of platform.hosts) {
      if (host.startsWith('*.')) {
        urlSet.add(`https://${host}/*`);
      } else {
        urlSet.add(`https://*.${host}/*`);
        urlSet.add(`https://${host}/*`);
      }
    }
  }
  return Array.from(urlSet);
}

function matchPath(pathname, pattern) {
  if (typeof pattern === 'string') {
    return pathname === pattern;
  }
  if (pattern instanceof RegExp) {
    return pattern.test(pathname);
  }
  return false;
}

function findPlatformForRequest(details, detectionTypeFilter = null) {
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }

  for (const platform of PLATFORMS) {
    // 检测类型过滤
    if (detectionTypeFilter && platform.detection.type !== detectionTypeFilter) {
      continue;
    }

    // 检查方法
    if (platform.match.method && details.method !== platform.match.method) {
      continue;
    }

    // 检查 URL 模式（用于跨域请求）
    if (platform.match.urlPattern) {
      if (platform.match.urlPattern.test(details.url)) {
        return platform;
      }
      continue;
    }

    // 检查域名
    const hostMatch = platform.hosts.some(host => {
      if (host.startsWith('*.')) {
        return url.hostname.endsWith(host.slice(1)) || url.hostname === host.slice(2);
      }
      return url.hostname === host;
    });
    if (!hostMatch) continue;

    // 检查路径
    if (platform.match.pathPattern) {
      if (matchPath(url.pathname, platform.match.pathPattern)) {
        return platform;
      }
    }
  }

  return null;
}

function findPlatformForFollowup(details) {
  let url;
  try {
    url = new URL(details.url);
  } catch {
    return null;
  }

  for (const platform of PLATFORMS) {
    if (!platform.followup) continue;

    // 检查域名
    const hostMatch = platform.hosts.some(host => {
      if (host.startsWith('*.')) {
        return url.hostname.endsWith(host.slice(1)) || url.hostname === host.slice(2);
      }
      return url.hostname === host;
    });
    if (!hostMatch) continue;

    // 检查 followup 路径
    if (matchPath(url.pathname, platform.followup.pathPattern)) {
      return platform;
    }
  }

  return null;
}

// ===========================================
// 第四部分：节流与状态清理
// ===========================================

function isThrottled(platformId, tabId, ms) {
  const key = stateKey(platformId, tabId);
  const now = Date.now();
  const last = lastNotifyAt.get(key) || 0;
  if (now - last < ms) return true;
  lastNotifyAt.set(key, now);
  return false;
}

function cleanupRequest(requestId, tabId, platformId = null) {
  const req = requestState.get(requestId);
  if (req) {
    platformId = platformId || req.platformId;
    requestState.delete(requestId);
  }

  if (platformId && tabId !== undefined) {
    const key = stateKey(platformId, tabId);
    const longReq = longRunningTimeouts.get(key);
    if (longReq && longReq.requestId === requestId) {
      clearTimeout(longReq.timeoutId);
      longRunningTimeouts.delete(key);
    }
  }

  debouncedSave();
}

function cleanupTab(platformId, tabId) {
  const key = stateKey(platformId, tabId);

  // 清理该 tab 相关的所有请求
  for (const [requestId, req] of requestState.entries()) {
    if (req.platformId === platformId && req.tabId === tabId) {
      requestState.delete(requestId);
    }
  }

  // 清理长时间运行记录
  const longReq = longRunningTimeouts.get(key);
  if (longReq) {
    clearTimeout(longReq.timeoutId);
    longRunningTimeouts.delete(key);
  }

  // 清理开始时间记录
  lastStartAt.delete(key);

  debouncedSave();
}

function setupLongRunningTimeout(requestId, tabId, platformId) {
  const key = stateKey(platformId, tabId);

  const timeoutId = setTimeout(() => {
    requestState.delete(requestId);
    longRunningTimeouts.delete(key);
    debouncedSave();
  }, LONG_RUNNING_TIMEOUT_MS);

  longRunningTimeouts.set(key, {
    requestId,
    timeoutId,
    startTime: Date.now()
  });

  debouncedSave();
}

// ===========================================
// 第五部分：状态持久化（带防抖）
// ===========================================

let saveTimeoutId = null;

function debouncedSave() {
  if (saveTimeoutId) return;
  saveTimeoutId = setTimeout(() => {
    saveTimeoutId = null;
    savePersistentState();
  }, 1000);
}

async function savePersistentState() {
  try {
    const state = {
      requestState: Array.from(requestState.entries()),
      longRunningTimeouts: Array.from(longRunningTimeouts.entries()).map(([key, data]) => [
        key,
        { requestId: data.requestId, startTime: data.startTime }
      ]),
      lastStartAt: Array.from(lastStartAt.entries()),
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
    if (!result.notifierState) return;

    const state = result.notifierState;
    const now = Date.now();

    // 只恢复最近 1 小时内的状态
    if (now - state.timestamp >= STATE_EXPIRY_MS) return;

    // 恢复请求状态
    state.requestState?.forEach(([key, value]) => requestState.set(key, value));

    // 恢复长时间运行记录（重建超时）
    state.longRunningTimeouts?.forEach(([key, value]) => {
      if (value.startTime && now - value.startTime < LONG_RUNNING_TIMEOUT_MS) {
        const remaining = LONG_RUNNING_TIMEOUT_MS - (now - value.startTime);
        const timeoutId = setTimeout(() => {
          requestState.delete(value.requestId);
          longRunningTimeouts.delete(key);
          debouncedSave();
        }, remaining);
        longRunningTimeouts.set(key, { ...value, timeoutId });
      }
    });

    // 恢复开始时间（过滤过期的）
    state.lastStartAt?.forEach(([key, value]) => {
      if (now - value < STATE_EXPIRY_MS) {
        lastStartAt.set(key, value);
      }
    });

    // 恢复通知时间
    state.lastNotifyAt?.forEach(([key, value]) => lastNotifyAt.set(key, value));

    console.log('已恢复持久化状态');
  } catch (e) {
    console.error('加载状态失败:', e);
  }
}

// 定期保存状态
setInterval(savePersistentState, STATE_SAVE_INTERVAL_MS);

// ===========================================
// 第六部分：Offscreen 文档管理
// ===========================================

let offscreenReady = false;

async function ensureOffscreenDocument() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: '播放通知提示音'
      });
      // 新创建的文档需要等待加载
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    offscreenReady = true;
  } catch (error) {
    console.error('创建 offscreen 文档失败:', error);
    offscreenReady = false;
    throw error;
  }
}

// ===========================================
// 第七部分：音频播放
// ===========================================

// 发送播放消息（带重试）
async function sendPlayMessage(volume, retryCount = 0) {
  const MAX_RETRIES = 2;

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'playSound',
      volume: volume
    });

    // 检查 offscreen 返回的结果
    if (response && !response.success) {
      console.warn('[Background] Offscreen 播放失败:', response.error);
      // 如果 offscreen 内部失败，重置状态以便下次重建
      if (retryCount < MAX_RETRIES) {
        offscreenReady = false;
        await ensureOffscreenDocument();
        return sendPlayMessage(volume, retryCount + 1);
      }
    }
  } catch (error) {
    const errorMsg = error?.message || String(error);

    // 如果是 "receiving end does not exist" 错误，尝试重建 offscreen
    if (errorMsg.includes('Receiving end does not exist') && retryCount < MAX_RETRIES) {
      console.warn(`[Background] 播放消息失败，重试 ${retryCount + 1}/${MAX_RETRIES}`);
      offscreenReady = false;
      await ensureOffscreenDocument();
      return sendPlayMessage(volume, retryCount + 1);
    }

    throw error;
  }
}

async function playNotificationSound() {
  try {
    const settings = await chrome.storage.sync.get({ soundVolume: DEFAULT_VOLUME });
    const volume = clampVolume(settings.soundVolume);

    if (volume === 0) {
      console.log('[Background] 音量为 0，跳过播放');
      return;
    }

    if (!offscreenReady) {
      await ensureOffscreenDocument();
    }

    await sendPlayMessage(volume);
  } catch (error) {
    console.error('[Background] 播放通知声音失败:', error);
  }
}

async function playTestSound(soundFile, soundType, volume) {
  try {
    // 清除旧的测试通知
    for (const [notificationId, info] of testNotifications.entries()) {
      clearTimeout(info.timerId);
      chrome.notifications.clear(notificationId);
      testNotifications.delete(notificationId);
    }

    const normalizedVolume = clampVolume(volume);
    const percent = Math.round(normalizedVolume * 100);
    let message = `正在播放测试音效，音量：${percent}%`;
    if (normalizedVolume === 0) {
      message = '音量已设为静音 (0%)';
    } else if (Math.abs(normalizedVolume - MAX_VOLUME) < 0.001) {
      message = `音量已设为最大 (${Math.round(MAX_VOLUME * 100)}%)`;
    } else if (Math.abs(normalizedVolume - DEFAULT_VOLUME) < 0.001) {
      message = `音量已设为默认值 (${Math.round(DEFAULT_VOLUME * 100)}%)`;
    }

    const testNotificationId = `test_${Date.now()}`;

    chrome.notifications.create(testNotificationId, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: '🔊 音效测试',
      message: message,
      silent: true
    }, (notificationId) => {
      if (notificationId) {
        const timerId = setTimeout(() => {
          chrome.notifications.clear(notificationId);
          testNotifications.delete(notificationId);
        }, 3000);

        testNotifications.set(notificationId, {
          timerId: timerId,
          timestamp: Date.now()
        });
      }
    });

    if (!offscreenReady) {
      await ensureOffscreenDocument();
    }

    await sendPlayMessage(normalizedVolume);
  } catch (error) {
    console.error('[Background] 测试功能出错:', error);
  }
}

// ===========================================
// 第八部分：通知系统
// ===========================================

async function sendNotification(platform, options = {}) {
  try {
    // 检查平台是否启用
    const settings = await chrome.storage.sync.get({ [platform.enabledKey]: true });
    if (!settings[platform.enabledKey]) return;

    const { title, message, targetUrl } = platform.notify;

    // 清除旧通知
    if (currentNotificationId) {
      chrome.notifications.clear(currentNotificationId);
      currentNotificationTarget = null;
    }

    // 生成新通知 ID
    currentNotificationId = 'ai_notification_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    const normalizedTabId = typeof options.tabId === 'number' && options.tabId >= 0 ? options.tabId : undefined;
    const normalizedUrl = options.targetUrl || targetUrl;

    if (normalizedTabId !== undefined || normalizedUrl) {
      currentNotificationTarget = {
        tabId: normalizedTabId,
        targetUrl: normalizedUrl
      };
    } else {
      currentNotificationTarget = null;
    }

    chrome.notifications.create(currentNotificationId, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: title,
      message: message,
      priority: 1,
      silent: true
    });

    playNotificationSound();

    // 8 秒后自动清除通知
    setTimeout(() => {
      if (currentNotificationId) {
        chrome.notifications.clear(currentNotificationId);
        currentNotificationId = null;
        currentNotificationTarget = null;
      }
    }, 8000);
  } catch (e) {
    console.error('发送通知失败:', e);
  }
}

// 通知事件监听
chrome.notifications.onClosed.addListener((notificationId, byUser) => {
  if (notificationId === currentNotificationId) {
    currentNotificationId = null;
    currentNotificationTarget = null;
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== currentNotificationId) return;

  const target = currentNotificationTarget;
  currentNotificationId = null;
  currentNotificationTarget = null;
  chrome.notifications.clear(notificationId);

  if (!target) return;

  const { tabId, targetUrl } = target;
  if (typeof tabId === 'number') {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        if (targetUrl) chrome.tabs.create({ url: targetUrl });
        return;
      }

      if (typeof tab.windowId === 'number') {
        chrome.windows.update(tab.windowId, { focused: true }, () => {
          if (chrome.runtime.lastError) { /* 忽略 */ }
        });
      }
      chrome.tabs.update(tabId, { active: true });
    });
    return;
  }

  if (targetUrl) {
    chrome.tabs.create({ url: targetUrl });
  }
});

// ===========================================
// 第九部分：Service Worker 保活
// ===========================================

function keepServiceWorkerAlive() {
  chrome.alarms.create('notifier-keep-alive', { periodInMinutes: 0.4 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'notifier-keep-alive') {
    chrome.runtime.getPlatformInfo(() => { /* 保活 ping */ });
  }
});

// ===========================================
// 第十部分：请求监听器
// ===========================================

const webRequestFilter = {
  urls: buildUrlFilters(),
  types: ['xmlhttprequest']
};

// 监听器 1: onBeforeRequest - 捕获 SSE 流请求的开始
chrome.webRequest.onBeforeRequest.addListener((details) => {
  const platform = findPlatformForRequest(details, 'sse-stream');
  if (!platform) return;

  requestState.set(details.requestId, {
    platformId: platform.id,
    tabId: details.tabId,
    isStream: false,
    startTime: Date.now()
  });

  if (platform.detection.trackStart) {
    const key = stateKey(platform.id, details.tabId);
    lastStartAt.set(key, Date.now());

    // 1 小时后自动清理开始时间记录
    setTimeout(() => {
      lastStartAt.delete(key);
      debouncedSave();
    }, STATE_EXPIRY_MS);
  }

  debouncedSave();
}, webRequestFilter);

// 监听器 2: onHeadersReceived - 确认是否为 SSE 流
chrome.webRequest.onHeadersReceived.addListener((details) => {
  const req = requestState.get(details.requestId);
  if (!req) return;

  const isEventStream = details.responseHeaders?.some(h =>
    h.name.toLowerCase() === 'content-type' && (h.value || '').includes('text/event-stream')
  );

  if (isEventStream) {
    req.isStream = true;
    setupLongRunningTimeout(details.requestId, req.tabId, req.platformId);
  } else {
    // 不是 SSE 流，清理请求状态
    requestState.delete(details.requestId);
    // 同时清理 lastStartAt（避免 followup 误报）
    const platform = PLATFORMS.find(p => p.id === req.platformId);
    if (platform?.detection.trackStart) {
      lastStartAt.delete(stateKey(req.platformId, req.tabId));
    }
  }
}, webRequestFilter, ['responseHeaders']);

// 监听器 3: onCompleted - 处理请求完成
chrome.webRequest.onCompleted.addListener((details) => {
  // 首先检查是否有 SSE 流请求状态
  const req = requestState.get(details.requestId);
  if (req) {
    if (req.isStream) {
      // SSE 流完成，发送通知
      const platform = PLATFORMS.find(p => p.id === req.platformId);
      if (platform && !isThrottled(platform.id, details.tabId, platform.throttleMs)) {
        sendNotification(platform, { tabId: details.tabId });
      }
    }
    // 无论 isStream 是否为 true，都要清理请求状态（防止泄漏）
    cleanupRequest(details.requestId, details.tabId, req.platformId);
    return;
  }

  // 检查是否匹配 followup 请求（如 ChatGPT 的 lat/r）
  const followupPlatform = findPlatformForFollowup(details);
  if (followupPlatform) {
    const key = stateKey(followupPlatform.id, details.tabId);
    const startTime = lastStartAt.get(key);
    const now = Date.now();

    if (startTime && (now - startTime > followupPlatform.followup.minDelayMs)) {
      if (!isThrottled(followupPlatform.id, details.tabId, followupPlatform.throttleMs)) {
        sendNotification(followupPlatform, { tabId: details.tabId });
      }
      cleanupTab(followupPlatform.id, details.tabId);
    }
    return;
  }

  // 检查是否匹配普通请求完成
  const platform = findPlatformForRequest(details, 'request-complete');
  if (platform && !isThrottled(platform.id, details.tabId, platform.throttleMs)) {
    sendNotification(platform, { tabId: details.tabId });
  }
}, webRequestFilter);

// 监听器 4: onErrorOccurred - 请求出错时清理
chrome.webRequest.onErrorOccurred.addListener((details) => {
  cleanupRequest(details.requestId, details.tabId);
}, webRequestFilter);

// ===========================================
// 第十一部分：消息处理
// ===========================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 注意：playSound 消息由 offscreen 文档处理，这里不要处理它
  // 否则会导致消息端口提前关闭

  if (message.action === 'testSound') {
    playTestSound(message.soundFile, message.soundType, message.volume);
    sendResponse({ success: true });
    return true; // 表示会异步响应
  }

  // 处理来自 content script 的 SSE 流事件
  if (message.action === 'chatgptStreamEvent') {
    handleStreamEvent(message, sender);
    sendResponse({ success: true });
    return true; // 表示会异步响应
  }

  // 未处理的消息，不返回值让其他监听器（如 offscreen）处理
});

// ===========================================
// 第十二部分：SSE 流事件处理
// ===========================================

// 处理来自 content script 的 SSE 流事件
async function handleStreamEvent(message, sender) {
  const { eventType, eventData, url } = message;
  const tabId = sender.tab?.id;

  // 根据 URL 确定平台
  let platform = null;
  try {
    const urlObj = new URL(url);
    platform = PLATFORMS.find(p =>
      p.hosts.some(host => {
        if (host.startsWith('*.')) {
          return urlObj.hostname.endsWith(host.slice(1)) || urlObj.hostname === host.slice(2);
        }
        return urlObj.hostname === host;
      })
    );
  } catch (e) {
    return;
  }

  if (!platform || !platform.streamEvents) return;

  // 处理思考完成事件
  if (eventType === 'reasoning_end' && platform.streamEvents.reasoningEnd) {
    const config = platform.streamEvents.reasoningEnd;

    // 检查主开关是否启用
    const mainSettings = await chrome.storage.sync.get({ [platform.enabledKey]: true });
    if (!mainSettings[platform.enabledKey]) return;

    // 检查子功能是否启用
    const settings = await chrome.storage.sync.get({ [config.enabledKey]: true });
    if (!settings[config.enabledKey]) return;

    // 节流检查
    const throttleKey = `${platform.id}:reasoning:${tabId}`;
    if (isThrottledByKey(throttleKey, config.throttleMs || 2000)) return;

    // 发送通知
    const durationText = eventData.durationSec ? `（思考了 ${eventData.durationSec} 秒）` : '';
    await sendNotificationDirect({
      title: config.notify.title,
      message: config.notify.message + durationText,
      targetUrl: config.notify.targetUrl,
      tabId
    });
  }
}

// 直接发送通知（不通过平台配置）
async function sendNotificationDirect(options) {
  const { title, message, targetUrl, tabId } = options;

  // 清除旧通知
  if (currentNotificationId) {
    chrome.notifications.clear(currentNotificationId);
    currentNotificationTarget = null;
  }

  // 生成新通知 ID
  currentNotificationId = 'ai_notification_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  const normalizedTabId = typeof tabId === 'number' && tabId >= 0 ? tabId : undefined;

  if (normalizedTabId !== undefined || targetUrl) {
    currentNotificationTarget = {
      tabId: normalizedTabId,
      targetUrl
    };
  } else {
    currentNotificationTarget = null;
  }

  chrome.notifications.create(currentNotificationId, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
    priority: 1,
    silent: true
  });

  playNotificationSound();

  // 8 秒后自动清除通知
  setTimeout(() => {
    if (currentNotificationId) {
      chrome.notifications.clear(currentNotificationId);
      currentNotificationId = null;
      currentNotificationTarget = null;
    }
  }, 8000);
}

// 独立的节流函数（用于流事件）
function isThrottledByKey(key, ms) {
  const now = Date.now();
  const last = lastNotifyAt.get(key) || 0;
  if (now - last < ms) return true;
  lastNotifyAt.set(key, now);
  return false;
}

// ===========================================
// 第十二部分：初始化
// ===========================================

async function initialize() {
  await loadPersistentState();
  await ensureOffscreenDocument();
  keepServiceWorkerAlive();
  console.log('AI 回答完成提醒器已启动，监控平台:', PLATFORMS.map(p => p.name).join(', '));
}

initialize();

// Content Script - 注入页面脚本并转发消息到 background
(function() {
  'use strict';

  // 注入 page script 到页面上下文
  function injectPageScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('pageHook.js');
    script.onload = function() {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // 监听来自 page script 的消息
  window.addEventListener('message', (event) => {
    // 只处理来自同源的消息
    if (event.source !== window) return;

    const message = event.data;
    if (!message || message.source !== 'chatgpt-reasoning-tap') return;

    // 转发到 background script
    chrome.runtime.sendMessage({
      action: 'chatgptStreamEvent',
      eventType: message.type,
      eventData: message.data,
      timestamp: message.timestamp,
      url: window.location.href
    }).catch(err => {
      // 忽略扩展上下文失效的错误
      if (!err.message?.includes('Extension context invalidated')) {
        console.error('[ChatGPT-Content] Send message error:', err);
      }
    });
  });

  // 页面加载完成后注入
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectPageScript);
  } else {
    injectPageScript();
  }
})();

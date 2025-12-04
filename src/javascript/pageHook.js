// ChatGPT SSE 流解析器 - 注入到页面上下文
// 用于检测"思考完成"和"开始输出"事件
(function() {
  'use strict';

  // 防止重复注入
  if (window.__chatgptReasoningTapInjected) return;
  window.__chatgptReasoningTapInjected = true;

  const DEBUG = false;
  const log = (...args) => DEBUG && console.log('[ChatGPT-Tap]', ...args);

  // 事件发送函数
  function emit(type, data = {}) {
    window.postMessage({
      source: 'chatgpt-reasoning-tap',
      type,
      data,
      timestamp: Date.now()
    }, '*');
    log('Emitted:', type, data);
  }

  // SSE 流解析器
  class SSEParser {
    constructor(onEvent) {
      this.buffer = '';
      this.onEvent = onEvent;
      this.decoder = new TextDecoder();
      this.state = {
        isReasoning: false,
        reasoningStartTime: null,
        hasEmittedReasoningEnd: false
      };
    }

    feed(chunk) {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      this.processBuffer();
    }

    processBuffer() {
      // 支持 LF 和 CRLF 两种换行格式
      // 先统一将 \r\n 替换为 \n
      this.buffer = this.buffer.replace(/\r\n/g, '\n');

      let idx;
      while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
        const message = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        this.parseMessage(message);
      }
    }

    parseMessage(message) {
      // 跳过 ping 消息
      if (message.startsWith(': ping')) return;

      // 处理 event: 行
      let eventType = null;
      const lines = message.split('\n');
      let dataLine = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLine = line.slice(5).trim();
        }
      }

      if (!dataLine || dataLine === '[DONE]') return;

      try {
        const obj = JSON.parse(dataLine);
        this.handleParsedData(obj, eventType);
      } catch (e) {
        // 可能是多行 data，尝试合并
        const fullData = lines
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim())
          .join('');
        if (fullData && fullData !== '[DONE]') {
          try {
            const obj = JSON.parse(fullData);
            this.handleParsedData(obj, eventType);
          } catch (e2) {
            log('Parse error:', e2.message);
          }
        }
      }
    }

    handleParsedData(obj, eventType) {
      // 处理嵌套结构 - ChatGPT 的 delta 事件
      const data = obj.v?.message || obj.message || obj;
      const metadata = data.metadata || {};
      const contentType = data.content?.content_type;
      const reasoningStatus = metadata.reasoning_status;

      log('Parsed:', { contentType, reasoningStatus, eventType, marker: obj.marker });

      // 检测思考开始
      if (reasoningStatus === 'is_reasoning' && !this.state.isReasoning) {
        this.state.isReasoning = true;
        this.state.reasoningStartTime = Date.now();
        this.state.hasEmittedReasoningEnd = false;
        emit('reasoning_start', {
          messageId: data.id,
          model: metadata.model_slug
        });
      }

      // 检测思考结束
      if (reasoningStatus === 'reasoning_ended' && !this.state.hasEmittedReasoningEnd) {
        this.state.hasEmittedReasoningEnd = true;
        const duration = this.state.reasoningStartTime
          ? Math.round((Date.now() - this.state.reasoningStartTime) / 1000)
          : metadata.finished_duration_sec || 0;
        emit('reasoning_end', {
          messageId: data.id,
          durationSec: duration,
          model: metadata.model_slug
        });
      }

      // 检测开始输出（第一个用户可见 token）
      if (obj.marker === 'user_visible_token' && obj.event === 'first') {
        emit('first_token', {
          messageId: obj.message_id,
          conversationId: obj.conversation_id
        });
        // 重置状态，准备下一轮
        this.state.isReasoning = false;
        this.state.reasoningStartTime = null;
      }

      // 检测 cot_token（思考 token 开始）
      if (obj.marker === 'cot_token' && obj.event === 'first') {
        emit('cot_token_start', {
          messageId: obj.message_id
        });
      }

      // 检测最终通道开始输出
      if (data.channel === 'final' && contentType === 'text' && data.status === 'in_progress') {
        emit('final_output_start', {
          messageId: data.id
        });
      }
    }

    finish() {
      // 处理剩余缓冲区
      if (this.buffer.trim()) {
        this.parseMessage(this.buffer);
      }
    }
  }

  // 劫持 fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);

    // 只处理 ChatGPT 对话 API 的 SSE 响应
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (!url) return response;

    const isConversationAPI = url.includes('/backend-api/f/conversation') ||
                               url.includes('/backend-api/conversation');
    const contentType = response.headers.get('content-type') || '';
    const isSSE = contentType.includes('text/event-stream');

    if (!isConversationAPI || !isSSE || !response.body) {
      return response;
    }

    log('Intercepted SSE stream:', url);

    try {
      // 克隆流：一份给原始消费者，一份用于解析
      const [originalStream, tapStream] = response.body.tee();

      // 异步解析 tap 流
      const parser = new SSEParser((type, data) => emit(type, data));

      (async () => {
        try {
          const reader = tapStream.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              parser.finish();
              break;
            }
            parser.feed(value);
          }
        } catch (e) {
          log('Stream read error:', e);
        }
      })();

      // 创建新的 Response，保留原始元数据
      const newResponse = new Response(originalStream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText
      });

      // 尝试保留 url 和 redirected 属性（某些浏览器可能不支持）
      try {
        Object.defineProperties(newResponse, {
          url: { value: response.url, writable: false },
          redirected: { value: response.redirected, writable: false },
          type: { value: response.type, writable: false }
        });
      } catch (e) {
        // 忽略属性设置失败
      }

      return newResponse;
    } catch (e) {
      log('Tee error:', e);
      return response;
    }
  };

  log('ChatGPT reasoning tap installed');
})();

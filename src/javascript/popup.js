// 简化的 Popup 菜单脚本
document.addEventListener('DOMContentLoaded', async () => {
  const geminiEnabled = document.getElementById('geminiEnabled');
  const chatgptEnabled = document.getElementById('chatgptEnabled');
  const aistudioEnabled = document.getElementById('aistudioEnabled');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeValue = document.getElementById('volumeValue');
  const testButton = document.getElementById('testButton');

  const DEFAULT_VOLUME = 1;
  const MAX_VOLUME = 1.5;

  const clampVolume = (value) => {
    const numeric = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isNaN(numeric)) return DEFAULT_VOLUME;
    return Math.min(Math.max(numeric, 0), MAX_VOLUME);
  };

  let settings = {};

  // 加载设置
  await loadSettings();

  // 使用 requestAnimationFrame 确保 DOM 更新完成后再添加动画
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // 显示界面并启用动画
      document.body.classList.add('loaded');
    });
  });

  // 监听开关变化
  geminiEnabled.addEventListener('change', saveSettings);
  chatgptEnabled.addEventListener('change', saveSettings);
  if (aistudioEnabled) {
    aistudioEnabled.addEventListener('change', saveSettings);
  }

  // 监听音量变化
  volumeSlider.addEventListener('input', () => {
    const clampedVolume = clampVolume(volumeSlider.value);
    console.log('音量滑块变化:', clampedVolume);
    volumeSlider.value = clampedVolume;
    volumeValue.textContent = Math.round(clampedVolume * 100) + '%';
    saveSettings();
  });

  // 测试按钮 - 支持快速连续点击
  let testClickCount = 0;
  testButton.addEventListener('click', async () => {
    testClickCount++;
    const currentCount = testClickCount;
    console.log(`测试按钮点击 #${currentCount}`);

    // 立即执行，不等待
    testSound(currentCount).catch(err => {
      console.error(`测试 #${currentCount} 失败:`, err);
    });
  });

  async function loadSettings() {
    try {
      settings = await chrome.storage.sync.get({
        geminiEnabled: true,
        chatgptEnabled: true,
        aistudioEnabled: true,
        soundVolume: DEFAULT_VOLUME
      });

      // 直接设置状态，此时界面还是隐藏状态
      geminiEnabled.checked = settings.geminiEnabled;
      chatgptEnabled.checked = settings.chatgptEnabled;
      if (aistudioEnabled) {
        aistudioEnabled.checked = settings.aistudioEnabled;
      }

      const sanitizedVolume = clampVolume(settings.soundVolume);
      settings.soundVolume = sanitizedVolume;
      volumeSlider.value = sanitizedVolume;
      volumeValue.textContent = Math.round(sanitizedVolume * 100) + '%';

    } catch (error) {
      console.error('加载设置失败:', error);
    }
  }

  async function saveSettings() {
    try {
      settings.geminiEnabled = geminiEnabled.checked;
      settings.chatgptEnabled = chatgptEnabled.checked;
      if (aistudioEnabled) {
        settings.aistudioEnabled = aistudioEnabled.checked;
      }
      settings.soundVolume = clampVolume(volumeSlider.value);

      await chrome.storage.sync.set(settings);
    } catch (error) {
      console.error('保存设置失败:', error);
    }
  }

  async function testSound(clickId) {
    try {
      const volume = clampVolume(volumeSlider.value);
      console.log(`测试音频音量 #${clickId}:`, volume);

      // 立即发送消息，不等待响应
      chrome.runtime.sendMessage({
        action: 'testSound',
        soundFile: 'streaming-complete.mp3',
        soundType: 'custom',
        volume: volume,
        clickId: clickId
      }).catch(err => {
        console.error(`发送测试消息失败 #${clickId}:`, err);
      });

      console.log(`测试消息已发送 #${clickId}`);
    } catch (error) {
      console.error(`测试音频失败 #${clickId}:`, error);
    }
  }
});

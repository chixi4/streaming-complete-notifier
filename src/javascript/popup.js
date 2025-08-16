// 简化的 Popup 菜单脚本
document.addEventListener('DOMContentLoaded', async () => {
  const geminiEnabled = document.getElementById('geminiEnabled');
  const chatgptEnabled = document.getElementById('chatgptEnabled');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeValue = document.getElementById('volumeValue');
  const testButton = document.getElementById('testButton');
  
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
  
  // 监听音量变化
  volumeSlider.addEventListener('input', () => {
    const volume = parseFloat(volumeSlider.value);
    volumeValue.textContent = Math.round(volume * 100) + '%';
    saveSettings();
  });
  
  // 测试按钮
  testButton.addEventListener('click', testSound);
  
  async function loadSettings() {
    try {
      settings = await chrome.storage.sync.get({
        geminiEnabled: true,
        chatgptEnabled: true,
        soundVolume: 0.8
      });
      
      // 直接设置状态，此时界面还是隐藏的
      geminiEnabled.checked = settings.geminiEnabled;
      chatgptEnabled.checked = settings.chatgptEnabled;
      volumeSlider.value = settings.soundVolume;
      volumeValue.textContent = Math.round(settings.soundVolume * 100) + '%';
      
    } catch (error) {
      console.error('加载设置失败:', error);
    }
  }
  
  async function saveSettings() {
    try {
      settings.geminiEnabled = geminiEnabled.checked;
      settings.chatgptEnabled = chatgptEnabled.checked;
      settings.soundVolume = parseFloat(volumeSlider.value);
      
      await chrome.storage.sync.set(settings);
    } catch (error) {
      console.error('保存设置失败:', error);
    }
  }
  
  async function testSound() {
    try {
      const volume = parseFloat(volumeSlider.value);
      
      await chrome.runtime.sendMessage({
        action: 'testSound',
        soundFile: 'streaming-complete.mp3',
        soundType: 'custom',
        volume: volume
      });
    } catch (error) {
      console.error('测试音频失败:', error);
    }
  }
});
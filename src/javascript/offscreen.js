// Offscreen 音频播放器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'playSound') {
    // 使用 ?? 而不是 || 来避免将0视为falsy
    playNotificationSound(message.soundFile, message.volume ?? 0.8);
    sendResponse({ success: true });
  }
});

async function playNotificationSound(soundFile, volume = 0.8) {
  try {
    console.log('Offscreen: 尝试播放音频', soundFile, 'volume:', volume);
    console.log('Offscreen: 音量类型:', typeof volume, '音量值:', volume);
    
    // 确保音量在有效范围内
    volume = Math.max(0, Math.min(1, volume));
    console.log('Offscreen: 调整后音量:', volume);
    
    // 检查soundFile是否有效
    if (!soundFile) {
      throw new Error('soundFile is null or undefined');
    }
    
    // 如果是自定义音频文件URL（base64）
    if (soundFile.startsWith('blob:') || soundFile.startsWith('data:')) {
      const audio = new Audio(soundFile);
      audio.volume = volume;
      console.log('Offscreen: 设置自定义音频音量为:', audio.volume);
      await audio.play();
      console.log('Offscreen: 播放自定义音频成功');
      return;
    }
    
    // 默认使用扩展内置音频
    const audioUrl = chrome.runtime.getURL(`audio/${soundFile}`);
    console.log('Offscreen: 音频URL:', audioUrl);
    
    const audio = new Audio(audioUrl);
    audio.volume = volume;
    console.log('Offscreen: 设置内置音频音量为:', audio.volume);
    
    await audio.play();
    console.log('Offscreen: 播放内置音频成功:', soundFile);
  } catch (error) {
    console.error('Offscreen: 播放音频失败:', error);
    
    // 如果自定义音频失败，尝试播放默认音频
    if (soundFile !== 'streaming-complete.mp3') {
      try {
        const defaultAudio = new Audio(chrome.runtime.getURL('audio/streaming-complete.mp3'));
        defaultAudio.volume = Math.max(0, Math.min(1, volume ?? 0.8));
        console.log('Offscreen: 设置默认音频音量为:', defaultAudio.volume);
        await defaultAudio.play();
        console.log('Offscreen: 播放默认音频成功');
      } catch (fallbackError) {
        console.error('Offscreen: 播放默认音频也失败:', fallbackError);
      }
    }
  }
}
// Offscreen 音频播放器
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'playSound') {
    playNotificationSound(message.soundFile, message.volume || 0.8);
    sendResponse({ success: true });
  }
});

async function playNotificationSound(soundFile, volume = 0.8) {
  try {
    console.log('Offscreen: 尝试播放音频', soundFile, 'volume:', volume);
    
    // 检查soundFile是否有效
    if (!soundFile) {
      throw new Error('soundFile is null or undefined');
    }
    
    // 如果是自定义音频文件URL（base64）
    if (soundFile.startsWith('blob:') || soundFile.startsWith('data:')) {
      const audio = new Audio(soundFile);
      audio.volume = volume;
      await audio.play();
      console.log('Offscreen: 播放自定义音频成功');
      return;
    }
    
    // 默认使用扩展内置音频
    const audioUrl = chrome.runtime.getURL(`audio/${soundFile}`);
    console.log('Offscreen: 音频URL:', audioUrl);
    
    const audio = new Audio(audioUrl);
    audio.volume = volume;
    
    await audio.play();
    console.log('Offscreen: 播放内置音频成功:', soundFile);
  } catch (error) {
    console.error('Offscreen: 播放音频失败:', error);
    
    // 如果自定义音频失败，尝试播放默认音频
    if (soundFile !== 'streaming-complete.mp3') {
      try {
        const defaultAudio = new Audio(chrome.runtime.getURL('audio/streaming-complete.mp3'));
        defaultAudio.volume = volume;
        await defaultAudio.play();
        console.log('Offscreen: 播放默认音频成功');
      } catch (fallbackError) {
        console.error('Offscreen: 播放默认音频也失败:', fallbackError);
      }
    }
  }
}
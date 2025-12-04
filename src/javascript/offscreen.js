// Offscreen 音频播放模块
// 音量范围：0% - 150%
// 0% = 静音
// 100% = 原始音量
// 150% = 压缩后增益至 ~0dB

const DEFAULT_VOLUME = 1;      // 100%
const MAX_VOLUME = 1.5;        // 150%

// 音频上下文和缓存
let audioContext = null;
let audioBufferCache = null;  // { buffer, peakLevel }

// 音量钳制
function clampVolume(value) {
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(num)) return DEFAULT_VOLUME;
  return Math.min(Math.max(num, 0), MAX_VOLUME);
}

// 分析音频峰值（用于计算增益上限）
function analyzePeakLevel(buffer) {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
  }
  return Math.max(peak, 0.001); // 避免除零
}

// 确保 AudioContext 可用
async function getAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
    audioBufferCache = null; // 上下文变化时清除缓存
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  return audioContext;
}

// 加载音频文件（带缓存）
async function loadAudioBuffer(url) {
  const ctx = await getAudioContext();

  // 使用缓存
  if (audioBufferCache) {
    return audioBufferCache;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`加载音频失败: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = await ctx.decodeAudioData(arrayBuffer);
  const peakLevel = analyzePeakLevel(buffer);

  audioBufferCache = { buffer, peakLevel };
  return audioBufferCache;
}

// 计算播放增益（对数曲线，符合人耳感知）
// volume: 0 ~ 1.5
// peakLevel: 音频原始峰值
function calculateGain(volume, peakLevel) {
  if (volume <= 0) return 0;

  // 0% ~ 100%: 对数曲线
  // 使用公式: gain = volume^2 (近似对数感知)
  // 这样 50% 滑块位置 ≈ 25% 实际增益，听感上是"一半音量"
  if (volume <= 1) {
    return volume * volume;
  }

  // 100% ~ 150%: 从原始音量向 0dB（峰值归一化）渐进
  // 当 volume = 1.5 时，增益 = 1 / peakLevel（使峰值达到 0dB）
  const maxGain = 1 / peakLevel;
  const t = (volume - 1) / (MAX_VOLUME - 1); // 0 ~ 1
  // 100% 时增益 = 1，150% 时增益 = maxGain
  return 1 + t * (maxGain - 1);
}

// 播放音频（Web Audio API）
async function playWithWebAudio(volume) {
  const ctx = await getAudioContext();
  const url = chrome.runtime.getURL('audio/streaming-complete.mp3');
  const { buffer, peakLevel } = await loadAudioBuffer(url);

  const gain = calculateGain(volume, peakLevel);

  // 创建节点
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gainNode = ctx.createGain();
  gainNode.gain.value = gain;

  // 当 volume > 1 时使用动态压缩器防止削波
  if (volume > 1) {
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;  // 开始压缩的阈值
    compressor.knee.value = 6;        // 软拐点
    compressor.ratio.value = 8;       // 压缩比
    compressor.attack.value = 0.003;  // 快速响应
    compressor.release.value = 0.1;   // 快速释放

    // 补偿增益：压缩器会衰减信号，需要补偿回来
    // 补偿量随音量线性增加，150% 时约 1.5x
    const makeupGain = ctx.createGain();
    const t = (volume - 1) / (MAX_VOLUME - 1); // 0 ~ 1
    makeupGain.gain.value = 1 + t * 0.5; // 1.0 ~ 1.5

    source.connect(gainNode).connect(compressor).connect(makeupGain).connect(ctx.destination);
  } else {
    source.connect(gainNode).connect(ctx.destination);
  }

  return new Promise((resolve, reject) => {
    source.onended = resolve;
    source.onerror = reject;
    source.start(0);
  });
}

// 备用播放方案（HTML Audio 元素）
async function playWithAudioElement(volume) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(chrome.runtime.getURL('audio/streaming-complete.mp3'));
    // HTML Audio 只支持 0~1 音量，超过 100% 时使用 1
    audio.volume = Math.min(volume, 1);
    audio.onended = () => {
      audio.remove();
      resolve();
    };
    audio.onerror = (e) => {
      audio.remove();
      reject(e);
    };
    audio.play().catch(reject);
  });
}

// 主播放函数
async function playSound(volume) {
  const normalizedVolume = clampVolume(volume);

  console.log('[Offscreen] 播放音频, 音量:', Math.round(normalizedVolume * 100) + '%');

  if (normalizedVolume === 0) {
    console.log('[Offscreen] 音量为 0，跳过播放');
    return Promise.resolve(); // 确保返回 Promise
  }

  try {
    await playWithWebAudio(normalizedVolume);
    console.log('[Offscreen] Web Audio 播放完成');
  } catch (error) {
    console.warn('[Offscreen] Web Audio 失败，尝试备用方案:', error.message);
    // 重置上下文以便下次重试
    audioContext = null;
    audioBufferCache = null;

    try {
      await playWithAudioElement(normalizedVolume);
      console.log('[Offscreen] Audio Element 播放完成 (音量上限 100%)');
    } catch (fallbackError) {
      console.error('[Offscreen] 所有播放方式均失败:', fallbackError);
      throw fallbackError;
    }
  }
}

// 消息监听
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'playSound') {
    playSound(message.volume)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }
});

console.log('[Offscreen] 音频播放模块已加载');

// Offscreen 音频播放
const DEFAULT_VOLUME = 1;
const MAX_VOLUME = 1.5;
const MAX_ZERO_DB_GAIN = 6; // 防止过度增益导致失真

const audioBufferCache = new Map();
let audioContext = null;
let currentContextId = 0;

const clampVolume = (value) => {
  const numeric = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(numeric)) return DEFAULT_VOLUME;
  return Math.min(Math.max(numeric, 0), MAX_VOLUME);
};

const mapVolumeToGain = (volume, zeroDbGain = 1) => {
  const clamped = clampVolume(volume);
  if (clamped <= 1) {
    return clamped;
  }

  const normalized = (clamped - 1) / (MAX_VOLUME - 1);
  return 1 + normalized * (zeroDbGain - 1);
};

const analyzeBufferPeak = (buffer) => {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      const absSample = Math.abs(samples[i]);
      if (absSample > peak) {
        peak = absSample;
      }
    }
  }
  return peak;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'playSound') {
    const targetVolume = clampVolume(message.volume ?? DEFAULT_VOLUME);
    playNotificationSound(message.soundFile, targetVolume, message.timestamp)
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('Offscreen: 播放音频失败:', error);
        sendResponse({ success: false, error: error?.message });
      });
    return true;
  }
  return false;
});

async function ensureAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
    currentContextId += 1;
    audioBufferCache.clear();
  }
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch (error) {
      console.warn('Offscreen: 无法恢复 AudioContext，使用备用方案', error);
      throw error;
    }
  }
  return audioContext;
}

async function loadAudioBuffer(url, cacheKey) {
  const context = await ensureAudioContext();
  if (cacheKey && audioBufferCache.has(cacheKey)) {
    const cached = audioBufferCache.get(cacheKey);
    if (cached && cached.contextId === currentContextId) {
      return cached;
    }
    audioBufferCache.delete(cacheKey);
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`无法加载音频资源: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = await context.decodeAudioData(arrayBuffer);
  const peak = Math.max(analyzeBufferPeak(buffer), 1e-4);
  const zeroDbGain = Math.min(MAX_ZERO_DB_GAIN, 1 / peak);
  const metadata = { buffer, peak, zeroDbGain, contextId: currentContextId };
  if (cacheKey) {
    audioBufferCache.set(cacheKey, metadata);
  }
  return metadata;
}

function createCompressor(context) {
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -6;
  compressor.knee.value = 10;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  return compressor;
}

async function playBufferWithGain(buffer, gainValue) {
  const context = await ensureAudioContext();
  const source = context.createBufferSource();
  source.buffer = buffer;

  const gainNode = context.createGain();
  gainNode.gain.value = gainValue;

  const compressor = createCompressor(context);
  source.connect(gainNode).connect(compressor).connect(context.destination);

  return new Promise((resolve, reject) => {
    source.addEventListener('ended', resolve, { once: true });
    source.addEventListener('error', reject, { once: true });
    try {
      source.start(0);
    } catch (error) {
      reject(error);
    }
  });
}

async function playNotificationSound(soundFile, volume = DEFAULT_VOLUME, timestamp, allowRetry = true) {
  const normalizedVolume = clampVolume(volume);
  let playbackGain = mapVolumeToGain(normalizedVolume, 1);
  console.log('Offscreen: 准备播放音频', soundFile, '滑块值:', normalizedVolume, 'timestamp:', timestamp);

  try {
    const isCustomSource = typeof soundFile === 'string' && (soundFile.startsWith('blob:') || soundFile.startsWith('data:'));
    const resolvedUrl = isCustomSource ? soundFile : chrome.runtime.getURL(`audio/${soundFile}`);
    const cacheKey = isCustomSource ? null : resolvedUrl;
    const audioData = await loadAudioBuffer(resolvedUrl, cacheKey);
    playbackGain = mapVolumeToGain(normalizedVolume, audioData.zeroDbGain);
    await playBufferWithGain(audioData.buffer, playbackGain);
    console.log('Offscreen: Web Audio 播放完成，实际增益:', playbackGain.toFixed(2), '峰值:', audioData.peak.toFixed(4));
  } catch (error) {
    if (allowRetry) {
      console.warn('Offscreen: Web Audio 播放失败，重建 AudioContext 后重试', error);
      audioContext = null;
      audioBufferCache.clear();
      return playNotificationSound(soundFile, normalizedVolume, timestamp, false);
    }

    console.error('Offscreen: Web Audio 播放失败，改用 <audio>', error);
    const fallbackUrl = typeof soundFile === 'string' && !soundFile.startsWith('blob:') && !soundFile.startsWith('data:')
      ? chrome.runtime.getURL(`audio/${soundFile}`)
      : soundFile;
    await playWithAudioElement(fallbackUrl, playbackGain);
  }

}

async function playWithAudioElement(url, gainValue) {
  return new Promise((resolve, reject) => {
    try {
      const audio = new Audio(url);
      audio.volume = Math.min(gainValue, 1);
      audio.addEventListener('ended', () => {
        audio.remove();
        resolve();
      }, { once: true });
      audio.addEventListener('error', (event) => {
        audio.remove();
        reject(event.error || new Error('Audio element 播放失败'));
      }, { once: true });
      audio.play().catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

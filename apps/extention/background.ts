let port: chrome.runtime.Port | null = null;
let isCapturing = false;

function isYouTubeUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("https://www.youtube.com/") || url.startsWith("https://youtu.be/");
}

function logCurrentTab(tabId: number) {
  chrome.tabs.get(tabId, (tab) => {
    const url = tab.url;
    const isYouTube = isYouTubeUrl(url);
    console.log("current tab:", { tabId, url, isYouTube });
  });
}

function connectHost() {
  if (port) return;

  port = chrome.runtime.connectNative("yt_live_translator_host");

  port.onMessage.addListener((msg) => {
    const type = msg && msg.type ? msg.type : "(no type)";
    if (type === "pong") {
      console.log("pong received:", msg.at ?? "(no timestamp)");
      return;
    }
    if (type === "asr-partial") {
      console.log("asr partial (host)", msg.text ?? "(no text)");
      return;
    }
    if (type === "asr-final") {
      console.log("asr final (host)", msg.text ?? "(no text)");
      return;
    }
    console.log("from host", type);
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.log("host disconnected", err ? err.message : "(no lastError)");
    port = null;
  });

  // 少し遅らせてping（タイミング問題回避）
  setTimeout(() => {
    try {
      port?.postMessage({ type: "ping", at: new Date().toISOString() });
      console.log("sent ping");
    } catch (e) {
      console.log("postMessage failed", e);
    }
  }, 200);
}

// 起動ごとに動く
chrome.runtime.onStartup.addListener(() => {
  console.log("startup");
  connectHost();
});

// Service workerが起動したタイミングでも接続（確実）
connectHost();

chrome.tabs.onActivated.addListener((activeInfo) => {
  logCurrentTab(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    logCurrentTab(tabId);
  }
});

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    console.log("offscreen api not available");
    return;
  }
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) {
    await chrome.offscreen.closeDocument();
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture tab audio for ASR and keep playback audible."
  });
}

async function startAudioCapture(tabId: number, url: string | undefined) {
  if (!isYouTubeUrl(url)) {
    console.log("capture skipped: not a YouTube tab", { tabId, url });
    return;
  }
  await ensureOffscreenDocument();
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    chrome.runtime.sendMessage({ type: "start-capture", streamId });
    isCapturing = true;
    console.log("capture start requested", { tabId });
    unmuteTabIfCaptured(tabId);
  } catch (e) {
    console.log("capture start failed", e);
  }
}

function stopAudioCapture() {
  if (!isCapturing) return;
  chrome.runtime.sendMessage({ type: "stop-capture" });
  isCapturing = false;
  console.log("capture stop requested");
  sendAudioStop();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "ui-start-capture") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.id) {
        console.log("capture skipped: no active tab");
        return;
      }
      startAudioCapture(tab.id, tab.url);
    });
    return;
  }
  if (msg.type === "ui-stop-capture") {
    stopAudioCapture();
    return;
  }
  if (msg.type === "audio-chunk") {
    if (!port) {
      console.log("audio chunk dropped: no native host connection");
      return;
    }
    port.postMessage({
      type: "audio-chunk",
      sampleRate: msg.sampleRate,
      pcmBase64: msg.pcmBase64
    });
    return;
  }
  if (msg.type === "audio-stats") {
    console.log("audio stats", { chunks: msg.chunks, sampleRate: msg.sampleRate, level: msg.level });
    return;
  }
  if (msg.type === "audio-playback-started") {
    console.log("audio playback started");
    return;
  }
  if (msg.type === "audio-playback-error") {
    console.log("audio playback error", msg.message ?? "(no message)");
    return;
  }
  if (msg.type === "audio-context-ready") {
    console.log("audio context ready", { sampleRate: msg.sampleRate });
    return;
  }
  if (msg.type === "capture-started") {
    console.log("capture started", { trackCount: msg.trackCount });
    if (port) {
      port.postMessage({ type: "audio-start", at: new Date().toISOString() });
    }
  }
  if (msg.type === "capture-error") {
    console.log("capture error", msg.message ?? "(no message)");
    isCapturing = false;
  }
  if (msg.type === "audio-error") {
    console.log("audio error", msg.message ?? "(no message)");
  }
  if (msg.type === "asr-warning") {
    console.log("asr warning", msg.message ?? "(no message)");
  }
  if (msg.type === "asr-started") {
    console.log("asr started");
  }
  if (msg.type === "asr-partial") {
    console.log("asr partial", msg.text ?? "(no text)");
    if (msg.translated) {
      console.log("asr partial translated", msg.translated);
    }
  }
  if (msg.type === "asr-final") {
    console.log("asr final", msg.text ?? "(no text)");
    if (msg.translated) {
      console.log("asr final translated", msg.translated);
    }
  }
  if (msg.type === "asr-error") {
    console.log("asr error", msg.message ?? "(no message)");
  }
});

function sendAudioStop() {
  if (port) {
    port.postMessage({ type: "audio-stop", at: new Date().toISOString() });
  }
}

function unmuteTabIfCaptured(tabId: number) {
  chrome.tabs.get(tabId, (tab) => {
    const mutedInfo = tab.mutedInfo;
    if (!mutedInfo || !mutedInfo.muted) return;
    if (mutedInfo.reason !== "capture") return;
    chrome.tabs.update(tabId, { muted: false });
  });
}

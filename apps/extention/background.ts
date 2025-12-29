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
    console.log("from host (raw):", msg);
    if (msg && msg.type === "pong") {
      console.log("pong received:", msg.at ?? "(no timestamp)");
    }
    try {
      console.log("from host (json):", JSON.stringify(msg));
    } catch {}
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
  if (hasDoc) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for ASR checks."
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
  } catch (e) {
    console.log("capture start failed", e);
  }
}

function stopAudioCapture() {
  if (!isCapturing) return;
  chrome.runtime.sendMessage({ type: "stop-capture" });
  isCapturing = false;
  console.log("capture stop requested");
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
  if (msg.type === "capture-started") {
    console.log("capture started", { trackCount: msg.trackCount });
  }
  if (msg.type === "capture-error") {
    console.log("capture error", msg.message ?? "(no message)");
    isCapturing = false;
  }
  if (msg.type === "asr-warning") {
    console.log("asr warning", msg.message ?? "(no message)");
  }
  if (msg.type === "asr-started") {
    console.log("asr started");
  }
  if (msg.type === "asr-partial") {
    console.log("asr partial", msg.text ?? "(no text)");
  }
  if (msg.type === "asr-final") {
    console.log("asr final", msg.text ?? "(no text)");
  }
  if (msg.type === "asr-error") {
    console.log("asr error", msg.message ?? "(no message)");
  }
});

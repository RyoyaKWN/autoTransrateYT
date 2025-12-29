let port: chrome.runtime.Port | null = null;

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

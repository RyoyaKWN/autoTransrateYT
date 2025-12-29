let port: chrome.runtime.Port | null = null;

function connectHost() {
  if (port) return;

  port = chrome.runtime.connectNative("yt_live_translator_host");

  port.onMessage.addListener((msg) => {
  console.log("from host (raw):", msg);
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

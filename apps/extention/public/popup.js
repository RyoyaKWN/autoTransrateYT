const logEl = document.getElementById("log");
const startCaptureBtn = document.getElementById("startCapture");
const stopCaptureBtn = document.getElementById("stopCapture");
const openAsrBtn = document.getElementById("openAsr");

function log(message) {
  if (!logEl) return;
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.textContent = `${line}\n${logEl.textContent}`;
}

function openAsrTab() {
  const url = chrome.runtime.getURL("asr.html");
  chrome.tabs.create({ url });
  log("ASR tab opened");
}

startCaptureBtn?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ui-start-capture" });
  log("capture start requested");
});

stopCaptureBtn?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "ui-stop-capture" });
  log("capture stop requested");
});

openAsrBtn?.addEventListener("click", () => {
  openAsrTab();
});

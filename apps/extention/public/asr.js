const logEl = document.getElementById("log");
const startAsrBtn = document.getElementById("startAsr");
const stopAsrBtn = document.getElementById("stopAsr");

let recognition = null;
let micStream = null;

function log(message) {
  if (!logEl) return;
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.textContent = `${line}\n${logEl.textContent}`;
}

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function stopRecognition() {
  if (!recognition) return;
  try {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.stop();
  } catch {}
  recognition = null;
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  log("ASR stopped");
}

async function ensureMicPermission() {
  if (micStream) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    log("Microphone permission granted");
    return true;
  } catch (e) {
    const message = e && e.name ? e.name : String(e);
    log(`microphone permission error: ${message}`);
    chrome.runtime.sendMessage({ type: "asr-error", message });
    return false;
  }
}

function startRecognition() {
  const SpeechRecognition = getSpeechRecognition();
  if (!SpeechRecognition) {
    log("SpeechRecognition not available");
    chrome.runtime.sendMessage({ type: "asr-error", message: "SpeechRecognition not available" });
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    const lastIndex = event.results.length - 1;
    const result = event.results[lastIndex];
    if (!result || result.length === 0) return;
    const text = result[0].transcript;
    const messageType = result.isFinal ? "asr-final" : "asr-partial";
    chrome.runtime.sendMessage({ type: messageType, text });
    log(`${messageType}: ${text}`);
  };

  recognition.onerror = (event) => {
    chrome.runtime.sendMessage({ type: "asr-error", message: event.error || "unknown error" });
    log(`asr error: ${event.error || "unknown error"}`);
  };

  recognition.onend = () => {
    log("ASR ended");
  };

  try {
    recognition.start();
    chrome.runtime.sendMessage({ type: "asr-started" });
    log("ASR started (microphone)");
  } catch (e) {
    chrome.runtime.sendMessage({ type: "asr-error", message: String(e) });
    log(`asr error: ${String(e)}`);
  }
}

startAsrBtn?.addEventListener("click", async () => {
  const ok = await ensureMicPermission();
  if (!ok) return;
  startRecognition();
});

stopAsrBtn?.addEventListener("click", () => {
  stopRecognition();
});

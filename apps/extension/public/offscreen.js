let currentStream = null;
let audioContext = null;
let processor = null;
let sourceNode = null;
let chunkCount = 0;
let audioElement = null;

const TARGET_SAMPLE_RATE = 16000;
const PROCESSOR_BUFFER_SIZE = 4096;

function stopCapture() {
  if (!currentStream) return;
  currentStream.getTracks().forEach((track) => track.stop());
  currentStream = null;
  chunkCount = 0;
  if (audioElement) {
    audioElement.pause();
    audioElement.srcObject = null;
    audioElement = null;
  }
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  console.log("tab audio capture stopped");
}

async function startCapture(streamId) {
  stopCapture();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    currentStream = stream;
    const tracks = stream.getAudioTracks();
    const track = tracks[0];
    console.log("tab audio capture started", {
      trackCount: tracks.length,
      settings: track && track.getSettings ? track.getSettings() : undefined
    });
    chrome.runtime.sendMessage({ type: "capture-started", trackCount: tracks.length });
    setupAudioProcessing(stream);
    startPlayback(stream);
  } catch (e) {
    console.log("capture failed", e);
    chrome.runtime.sendMessage({ type: "capture-error", message: String(e) });
  }
}

function setupAudioProcessing(stream) {
  try {
    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch (e) {
    console.log("AudioContext create failed", e);
    chrome.runtime.sendMessage({ type: "audio-error", message: "AudioContext create failed" });
    return;
  }

  sourceNode = audioContext.createMediaStreamSource(stream);
  processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  audioContext.resume().then(() => {
    console.log("audio context resumed", { sampleRate: audioContext.sampleRate });
    chrome.runtime.sendMessage({
      type: "audio-context-ready",
      sampleRate: audioContext.sampleRate
    });
  });
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const level = computeRms(input);
    const pcm16 = floatTo16BitPCM(input);
    const base64 = arrayBufferToBase64(pcm16.buffer);
    chrome.runtime.sendMessage({
      type: "audio-chunk",
      sampleRate: audioContext.sampleRate,
      pcmBase64: base64
    });
    chunkCount += 1;
    if (chunkCount % 50 === 0) {
      chrome.runtime.sendMessage({
        type: "audio-stats",
        chunks: chunkCount,
        sampleRate: audioContext.sampleRate,
        level
      });
    }
  };
  sourceNode.connect(processor);
  processor.connect(audioContext.destination);
}

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    let sample = float32Array[i];
    if (sample > 1) sample = 1;
    if (sample < -1) sample = -1;
    view.setInt16(i * 2, sample * 0x7fff, true);
  }
  return new Int16Array(buffer);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function computeRms(input) {
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    sum += input[i] * input[i];
  }
  return Math.sqrt(sum / input.length);
}

function startPlayback(stream) {
  try {
    audioElement = new Audio();
    audioElement.autoplay = true;
    audioElement.srcObject = stream;
    audioElement.muted = false;
    audioElement.volume = 1.0;
    audioElement.play().then(() => {
      console.log("tab audio playback started");
      chrome.runtime.sendMessage({ type: "audio-playback-started" });
    }).catch((e) => {
      console.log("audio playback failed", e);
      chrome.runtime.sendMessage({ type: "audio-playback-error", message: String(e) });
    });
  } catch (e) {
    chrome.runtime.sendMessage({ type: "audio-playback-error", message: String(e) });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "start-capture") {
    startCapture(msg.streamId);
  }
  if (msg.type === "stop-capture") {
    stopCapture();
  }
});

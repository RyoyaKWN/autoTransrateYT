let currentStream = null;

function stopCapture() {
  if (!currentStream) return;
  currentStream.getTracks().forEach((track) => track.stop());
  currentStream = null;
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
  } catch (e) {
    console.log("capture failed", e);
    chrome.runtime.sendMessage({ type: "capture-error", message: String(e) });
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

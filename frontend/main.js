// --- Main Application Logic (Voice-Only Focus) ---

const statusDiv = document.getElementById("status");
const authSection = document.getElementById("auth-section");
const appSection = document.getElementById("app-section");
const sessionEndSection = document.getElementById("session-end-section");
const restartBtn = document.getElementById("restartBtn");
const micBtn = document.getElementById("micBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const textInput = document.getElementById("textInput");
const sendBtn = document.getElementById("sendBtn");
const connectBtn = document.getElementById("connectBtn");
const chatLog = document.getElementById("chat-log");
const voiceIndicator = document.getElementById("voice-indicator");

let currentGeminiMessageDiv = null;
let currentUserMessageDiv = null;

const mediaHandler = new MediaHandler();
const geminiClient = new GeminiClient({
  onOpen: () => {
    statusDiv.textContent = "Connected";
    statusDiv.className = "status connected";
    authSection.classList.add("hidden");
    appSection.classList.remove("hidden");

    // Automatically trigger mic initialization upon seamless link connection
    startMicrophoneStream();
  },
  onMessage: (event) => {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);
        handleJsonMessage(msg);
      } catch (e) {
        console.error("Parse error:", e);
      }
    } else {
      mediaHandler.playAudio(event.data);
    }
  },
  onClose: (e) => {
    console.log("WS Closed:", e);
    statusDiv.textContent = "Disconnected";
    statusDiv.className = "status disconnected";
    showSessionEnd();
  },
  onError: (e) => {
    console.error("WS Error:", e);
    statusDiv.textContent = "Connection Error";
    statusDiv.className = "status error";
  },
});

function handleJsonMessage(msg) {
  if (msg.type === "interrupted") {
    // 1. Instantly kill the audio playback so she stops talking immediately
    mediaHandler.stopAudioPlayback();
    
    // 2. Clear out the unfinished message text block so it doesn't linger or mix with the new response
    if (currentGeminiMessageDiv) {
      currentGeminiMessageDiv.textContent += "... [Interrupted]";
    }
    
    // 3. Hard-reset the message state trackers to shift focus to your new query
    currentGeminiMessageDiv = null;
    currentUserMessageDiv = null;
    
    if (voiceIndicator) voiceIndicator.textContent = "Listening to your new request...";
    console.log("🔄 Cancelled previous generation. Shifting completely to new task.");

  } else if (msg.type === "turn_complete") {
    if (voiceIndicator) voiceIndicator.textContent = "Agent Idle / Listening...";
    currentGeminiMessageDiv = null;
    currentUserMessageDiv = null;
    
  } else if (msg.type === "user") {
    if (currentUserMessageDiv) {
      currentUserMessageDiv.textContent += msg.text;
      chatLog.scrollTop = chatLog.scrollHeight;
    } else {
      currentUserMessageDiv = appendMessage("user", msg.text);
    }
    
  } else if (msg.type === "gemini") {
    if (voiceIndicator) voiceIndicator.textContent = "Agent Speaking...";
    if (currentGeminiMessageDiv) {
      currentGeminiMessageDiv.textContent += msg.text;
      chatLog.scrollTop = chatLog.scrollHeight;
    } else {
      currentGeminiMessageDiv = appendMessage("gemini", msg.text);
    }
    
  } else if (msg.type === "tool_call") {
    appendMessage("system", `Executing flight search: ${JSON.stringify(msg.args)}`);
  }
}

function appendMessage(type, text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${type}`;
  msgDiv.textContent = text;
  chatLog.appendChild(msgDiv);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msgDiv;
}

// Connect Button Handler
connectBtn.onclick = async () => {
  statusDiv.textContent = "Connecting...";
  connectBtn.disabled = true;

  try {
    // Initialize audio context on user gesture
    await mediaHandler.initializeAudio();
    geminiClient.connect();
  } catch (error) {
    console.error("Connection error:", error);
    statusDiv.textContent = "Connection Failed: " + error.message;
    statusDiv.className = "status error";
    connectBtn.disabled = false;
  }
};

// UI Controls
disconnectBtn.onclick = () => {
  geminiClient.disconnect();
};

async function startMicrophoneStream() {
  try {
    await mediaHandler.startAudio((data) => {
      if (geminiClient.isConnected()) {
        geminiClient.send(data);
      }
    });
    micBtn.textContent = "Stop Mic";
    if (voiceIndicator) voiceIndicator.textContent = "Voice Link Active";
  } catch (e) {
    console.error("Could not start audio capture", e);
    alert("Could not start microphone streaming loop.");
  }
}

micBtn.onclick = async () => {
  if (mediaHandler.isRecording) {
    mediaHandler.stopAudio();
    micBtn.textContent = "Start Mic";
    if (voiceIndicator) voiceIndicator.textContent = "Voice Muted";
  } else {
    await startMicrophoneStream();
  }
};

sendBtn.onclick = sendText;
textInput.onkeypress = (e) => {
  if (e.key === "Enter") sendText();
};

function sendText() {
  const text = textInput.value;
  if (text && geminiClient.isConnected()) {
    geminiClient.sendText(text);
    appendMessage("user", text);
    textInput.value = "";
  }
}

function resetUI() {
  authSection.classList.remove("hidden");
  appSection.classList.add("hidden");
  sessionEndSection.classList.add("hidden");

  mediaHandler.stopAudio();
  mediaHandler.stopAudioPlayback(); // <--- ADD THIS: Clears left-over sounds
  
  micBtn.textContent = "Start Mic";
  if (voiceIndicator) voiceIndicator.textContent = "Voice Link Idle";
  chatLog.innerHTML = "";
  connectBtn.disabled = false;
}

function showSessionEnd() {
  appSection.classList.add("hidden");
  sessionEndSection.classList.remove("hidden");
  
  mediaHandler.stopAudio();         // Stops mic recording loop
  mediaHandler.stopAudioPlayback(); // <--- ADD THIS: Shuts up the current playing voice instantly!
}
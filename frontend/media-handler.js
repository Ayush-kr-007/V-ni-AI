let socket = null;
let audioContext = null;
let mediaStream = null;
let processor = null;

// Track the precise time the next audio chunk should start playing
let nextPlayTime = 0; 

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusLabel = document.getElementById('status');
const logsDiv = document.getElementById('logs');

function log(message) {
    const p = document.createElement('p');
    p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logsDiv.appendChild(p);
    logsDiv.scrollTop = logsDiv.scrollHeight;
    console.log(message);
}

function updateStatus(status) {
    statusLabel.textContent = status.toUpperCase();
    statusLabel.className = `status-${status.toLowerCase()}`;
}

startBtn.addEventListener('click', async () => {
    log("Start button clicked. Requesting microphone access...");
    
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        // Reset the audio timeline tracking on fresh startup
        nextPlayTime = audioContext.currentTime;

        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        log("Microphone access granted.");

        const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        const wsUrl = `${protocol}${window.location.host}/ws`;
        log(`Connecting to WebSocket at ${wsUrl}...`);
        
        socket = new WebSocket(wsUrl);
        socket.binaryType = "arraybuffer";

        socket.onopen = () => {
            log("WebSocket connection established successfully!");
            updateStatus("connected");
            startBtn.disabled = true;
            stopBtn.disabled = false;
            
            startAudioRecording();
        };

        socket.onmessage = async (event) => {
            if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
                const arrayBuffer = (event.data instanceof Blob) 
                    ? await event.data.arrayBuffer() 
                    : event.data;
                
                playReceivedAudio(arrayBuffer);
                return;
            }

            try {
                const data = JSON.parse(event.data);
                log(`Received event from backend: ${data.type || 'message'}`);

                if (data.audio) {
                    const binaryString = window.atob(data.audio);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    playReceivedAudio(bytes.buffer);
                }

                if (data.text) {
                    log(`Gemini Text: ${data.text}`);
                }
                
                // Clear audio queue if user interrupts Gemini speaking
                if (data.type === 'interrupted') {
                    log("Interruption detected. Flushing audio playback pipeline.");
                    if (audioContext) {
                        nextPlayTime = audioContext.currentTime;
                    }
                }
            } catch(e) {
                log(`Received text: ${event.data}`);
            }
        };

        socket.onerror = (error) => {
            log(`WebSocket Error: ${error.message || 'Unknown error'}`);
        };

        socket.onclose = () => {
            log("WebSocket connection closed.");
            cleanup();
        };

    } catch (err) {
        log(`Error starting session: ${err.message}`);
        alert(`Could not start session: ${err.message}`);
        cleanup();
    }
});

stopBtn.addEventListener('click', () => {
    log("Stop button clicked. Closing session...");
    cleanup();
});

function startAudioRecording() {
    try {
        const source = audioContext.createMediaStreamSource(mediaStream);
        processor = audioContext.createScriptProcessor(4096, 1, 1);
        
        source.connect(processor);
        processor.connect(audioContext.destination);

        processor.onaudioprocess = (e) => {
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            
            const inputData = e.inputBuffer.getChannelData(0);
            const pcmData = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
            }
            
            socket.send(pcmData.buffer);
        };
        log("Audio recording and streaming started.");
    } catch (e) {
        log(`Audio initialization error: ${e.message}`);
    }
}

function playReceivedAudio(arrayBuffer) {
    try {
        if (!audioContext) return;

        const int16Array = new Int16Array(arrayBuffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        const sampleRate = 24000; // Gemini Live natively outputs 24kHz
        const audioBuffer = audioContext.createBuffer(1, float32Array.length, sampleRate);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        // Calculate chronological scheduling window
        const startTime = Math.max(nextPlayTime, audioContext.currentTime);
        source.start(startTime);

        // Update when the NEXT segment should safely step in without clipping
        nextPlayTime = startTime + audioBuffer.duration;
    } catch (e) {
        console.error("Error playing scheduled audio segment", e);
    }
}

function cleanup() {
    updateStatus("disconnected");
    startBtn.disabled = false;
    stopBtn.disabled = true;

    if (socket) {
        if (socket.readyState === WebSocket.OPEN) socket.close();
        socket = null;
    }
    if (processor) {
        processor.disconnect();
        processor = null;
    }
    if (audioContext) {
        try {
            audioContext.close();
        } catch(e) {}
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    nextPlayTime = 0;
}
/**
 * MediaHandler: Encapsulates Web Audio Pipeline operations 
 * safely handling 16kHz microphone capture and 24kHz Gemini dynamic queue scheduling.
 */
class MediaHandler {
    constructor() {
        this.audioContext = null;
        this.mediaStream = null;
        this.processor = null;
        this.isRecording = false;
        this.nextPlayTime = 0;
        this.audioOutputEnabled = true;
    }

    logToPanel(message) {
        const logsDiv = document.getElementById('logs');
        if (logsDiv) {
            const p = document.createElement('p');
            p.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
            logsDiv.appendChild(p);
            logsDiv.scrollTop = logsDiv.scrollHeight;
        }
        console.log(message);
    }

    async initializeAudio() {
        this.logToPanel("Initializing AudioContext Engine...");
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        this.nextPlayTime = this.audioContext.currentTime;
    }

    async startAudio(onDataCallback) {
        this.logToPanel("Requesting microphone permissions...");
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.logToPanel("Hardware capture access active.");

        const source = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
        
        source.connect(this.processor);
        this.processor.connect(this.audioContext.destination);

        this.processor.onaudioprocess = (e) => {
            if (!this.isRecording) return;
            
            const inputData = e.inputBuffer.getChannelData(0);
            const pcmData = new Int16Array(inputData.length);
            
            // Map floating coordinates to Linear PCM Int16 spectrum
            for (let i = 0; i < inputData.length; i++) {
                pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
            }
            
            onDataCallback(pcmData.buffer);
        };

        this.isRecording = true;
        this.logToPanel("Stream initialized & pushed to socket loop.");
    }

    playAudio(arrayBuffer) {
        if (!this.audioOutputEnabled || !this.audioContext) return;

        try {
            const int16Array = new Int16Array(arrayBuffer);
            const float32Array = new Float32Array(int16Array.length);
            for (let i = 0; i < int16Array.length; i++) {
                float32Array[i] = int16Array[i] / 32768.0;
            }

            const sampleRate = 24000; // Native Gemini Live delivery
            const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, sampleRate);
            audioBuffer.getChannelData(0).set(float32Array);

            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.audioContext.destination);

            const startTime = Math.max(this.nextPlayTime, this.audioContext.currentTime);
            source.start(startTime);

            // Cascade next time slot forward to prevent overlap
            this.nextPlayTime = startTime + audioBuffer.duration;
        } catch (e) {
            console.error("Timeline insertion fault during frame playback:", e);
        }
    }
    stopAudioPlayback() {
        // 1. Terminate all scheduled audio nodes currently active
        this.activeNodes.forEach(node => {
            try { node.stop(); } catch(e) { /* already stopped */ }
        });
        this.activeNodes = [];

        // 2. Clear out the array/buffer holding scheduled chunks
        this.audioQueue = []; 
        
        console.log("Audio pipeline flushed successfully.");
    }

    stopAudio() {
        this.logToPanel("Terminating media tracking state loops...");
        this.isRecording = false;
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
    }
}
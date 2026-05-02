/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export class AudioStreamer {
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private audioQueue: Float32Array[] = [];
  private isProcessingQueue = false;
  private nextStartTime = 0;

  constructor(private sampleRate: number = 16000) {}

  async startRecording(onAudioData: (data: Int16Array) => void) {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.sampleRate,
      });
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.source = this.audioContext.createMediaStreamSource(this.micStream);
    
    // Using ScriptProcessorNode with 2048 buffer for lower latency
    this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);

    this.processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const int16Data = this.float32ToInt16(inputData);
      onAudioData(int16Data);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  stopRecording() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.micStream?.getTracks().forEach(track => track.stop());
    this.audioContext?.close();
    
    this.processor = null;
    this.source = null;
    this.micStream = null;
    this.audioContext = null;
  }

  async playAudio(base64Data: string) {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000, // Gemini response is 24kHz
      });
    }
    
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = this.int16ToFloat32(int16Array);
    
    this.audioQueue.push(float32Array);
    this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessingQueue || this.audioQueue.length === 0 || !this.audioContext) return;
    this.isProcessingQueue = true;

    while (this.audioQueue.length > 0) {
      const data = this.audioQueue.shift()!;
      const audioBuffer = this.audioContext.createBuffer(1, data.length, 24000);
      audioBuffer.getChannelData(0).set(data);

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContext.destination);

      const currentTime = this.audioContext.currentTime;
      if (this.nextStartTime < currentTime) {
        this.nextStartTime = currentTime;
      }

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      
      // Small buffer to avoid gaps
      const waitTime = (this.nextStartTime - currentTime) * 1000;
      if (waitTime > 0) {
          // We don't want to await exactly because we want to overlap slightly or be ahead
          // But for simple implementation we wait.
      }
    }

    this.isProcessingQueue = false;
  }

  private float32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  }

  private int16ToFloat32(int16Array: Int16Array): Float32Array {
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }
    return float32Array;
  }
  
  clearQueue() {
      this.audioQueue = [];
      this.nextStartTime = 0;
  }
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'listening' | 'speaking';

export interface LiveSessionCallbacks {
  onAudioData: (base64Audio: string) => void;
  onInterrupted: () => void;
  onStateChange: (state: SessionState) => void;
  onToolCall: (name: string, args: any) => Promise<any>;
  onTranscript?: (role: 'user' | 'model', text: string) => void;
}

export class LiveSession {
  private session: any = null;
  private state: SessionState = 'disconnected';

  constructor(private apiKey: string) {}

  async connect(callbacks: LiveSessionCallbacks, systemInstruction: string): Promise<void> {
    if (this.session) return;
    this.setState('connecting', callbacks);

    return new Promise(async (resolve, reject) => {
      try {
        const ai = new GoogleGenAI({ 
          apiKey: this.apiKey,
          apiVersion: "v1beta"
        });
        
        this.session = await ai.live.connect({
          model: "gemini-3.1-flash-live-preview",
          config: {
            systemInstruction: systemInstruction,
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
            },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "openWebsite",
                    description: "Opens a specific website in a new tab.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        url: {
                          type: Type.STRING,
                          description: "The full URL of the website to open, including https://",
                        },
                      },
                      required: ["url"],
                    },
                  },
                  {
                    name: "updatePreferences",
                    description: "Updates the user's personality or voice preferences for Hiya. Use this when the user asks to change how you behave or sound.",
                    parameters: {
                      type: Type.OBJECT,
                      properties: {
                        personality: {
                          type: Type.STRING,
                          description: "The new personality trait or instruction (e.g. 'extra sassy', 'more sweet', 'professional').",
                        },
                      },
                    }
                  }
                ]
              }
            ]
          },
          callbacks: {
            onopen: () => {
              console.log("Live session connected");
              this.setState('connected', callbacks);
              resolve();
            },
            onclose: () => {
              console.log("Live session closed");
              this.setState('disconnected', callbacks);
              this.session = null;
            },
            onerror: (err) => {
              console.error("Live session error:", err);
              this.setState('disconnected', callbacks);
              this.session = null;
              reject(err);
            },
            onmessage: async (message: LiveServerMessage) => {
              const serverContent: any = message.serverContent;
              
              if (serverContent?.modelTurn) {
                const part = serverContent.modelTurn.parts[0];
                if (part?.inlineData?.data) {
                  this.setState('speaking', callbacks);
                  callbacks.onAudioData(part.inlineData.data);
                }
                if (part?.text) {
                  callbacks.onTranscript?.('model', part.text);
                }
              }

              if (serverContent?.userContent) {
                const part = serverContent.userContent.parts[0];
                if (part?.text) {
                  callbacks.onTranscript?.('user', part.text);
                }
              }

              if (serverContent?.interrupted) {
                callbacks.onInterrupted();
                this.setState('listening', callbacks);
              }

              if (serverContent?.turnComplete) {
                this.setState('listening', callbacks);
              }

              if (message.toolCall) {
                for (const call of message.toolCall.functionCalls) {
                  const result = await callbacks.onToolCall(call.name, call.args);
                  if (this.session) {
                    this.session.sendRealtimeInput({
                      functionResponses: [{
                        name: call.name,
                        id: call.id,
                        response: { result }
                      }]
                    });
                  }
                }
              }
            }
          }
        });

      } catch (error) {
        console.error("Failed to connect to Live API:", error);
        this.setState('disconnected', callbacks);
        this.session = null;
        reject(error);
      }
    });
  }

  sendAudio(base64Data: string) {
    if (this.session && this.state !== 'disconnected') {
      try {
        this.session.sendRealtimeInput({
          audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
        });
      } catch (e) {
        console.error("Error sending audio:", e);
      }
    }
  }

  sendText(text: string) {
    if (this.session && (this.state === 'connected' || this.state === 'listening')) {
      try {
        this.session.sendRealtimeInput({ text });
      } catch (e) {
        console.error("Error sending text:", e);
      }
    }
  }

  disconnect() {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
  }

  private setState(state: SessionState, callbacks: LiveSessionCallbacks) {
    this.state = state;
    callbacks.onStateChange(state);
  }

  getState() {
      return this.state;
  }
}

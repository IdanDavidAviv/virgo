import { AudioStrategy, AudioVoice, AudioEngineEventType, AudioEngineEvent } from '../../common/types';

/**
 * LocalAudioStrategy: Standard Web Speech API Implementation.
 * Provides high-integrity, offline playback using browser built-in synthesis.
 * [PASSIVE WORKER]: Reports lifecycle events to the Engine/Controller.
 */
export class LocalAudioStrategy implements AudioStrategy {
  public readonly id = 'local';
  private synth: SpeechSynthesis;
  public onEvent?: (event: AudioEngineEvent) => void;
  
  private activeIntentId: number = 0;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private volume: number = 50;
  private rate: number = 0;

  constructor() {
    this.synth = window.speechSynthesis;
  }

  public getName(): string {
    return 'Local (Browser)';
  }

  public async synthesize(text: string, voice?: AudioVoice, intentId?: number): Promise<void> {
    if (intentId !== undefined) {
      this.activeIntentId = intentId;
    }
    
    this.stop();

    const utterance = new SpeechSynthesisUtterance(text);
    
    // Voice Selection logic
    if (voice) {
        const voices = this.synth.getVoices();
        const foundVoice = voices.find(v => v.name === voice.id || v.voiceURI === voice.id);
        if (foundVoice) {
            utterance.voice = foundVoice;
        }
    }

    // Param Mapping: Sliders use -10..10, SpeechSynthesis uses 0.1..10
    this.applySettingsToUtterance(utterance);
    
    return new Promise((resolve) => {
        let isResolved = false;
        const safeResolve = () => {
            if (!isResolved) {
                isResolved = true;
                resolve();
            }
        };

        // [SAFETY] 500ms timeout for browser audio focus
        const timeout = setTimeout(() => {
            console.warn(`[LocalStrategy] ⏳ onstart timeout (intentId: ${this.activeIntentId})`);
            safeResolve();
        }, 500);

        utterance.onstart = () => {
            console.log(`[LocalStrategy] ▶️ Playback started (intentId: ${this.activeIntentId})`);
            clearTimeout(timeout);
            this.onEvent?.({ type: AudioEngineEventType.PLAYING, intentId: this.activeIntentId });
            safeResolve();
        };

        utterance.onend = () => {
            console.log(`[LocalStrategy] ✅ Playback ended (intentId: ${this.activeIntentId})`);
            clearTimeout(timeout);
            this.onEvent?.({ type: AudioEngineEventType.ENDED, intentId: this.activeIntentId });
            safeResolve();
        };

        utterance.onerror = (e) => {
            console.error(`[LocalStrategy] ⛔ Synthesis error:`, e);
            clearTimeout(timeout);
            this.onEvent?.({ 
              type: AudioEngineEventType.ERROR, 
              intentId: this.activeIntentId, 
              message: `Synthesis error: ${e.error}` 
            });
            safeResolve(); 
        };

        this.currentUtterance = utterance;
        this.synth.speak(utterance);
    });
  }

  private applySettingsToUtterance(utterance: SpeechSynthesisUtterance): void {
      utterance.rate = this.rate >= 0 ? 1 + (this.rate / 5) : 1 + (this.rate / 10);
      utterance.volume = Math.max(0, Math.min(1, this.volume / 100));
  }

  public async play(intentId?: number): Promise<void> {
      if (intentId !== undefined && intentId < this.activeIntentId) {return;}
      if (this.synth.paused) {
          this.synth.resume();
      }
  }

  public pause(): void {
      if (this.synth.speaking && !this.synth.paused) {
          this.synth.pause();
      }
  }

  public resume(): void {
      if (this.synth.paused) {
          this.synth.resume();
      }
  }

  public stop(): void {
    if (this.synth.speaking) {
      this.synth.cancel();
    }
    this.currentUtterance = null;
  }

  public setVolume(value: number): void {
      this.volume = value;
      if (this.currentUtterance) {
          this.currentUtterance.volume = Math.max(0, Math.min(1, value / 100));
      }
  }

  public setRate(value: number): void {
      this.rate = value;
      if (this.currentUtterance) {
          // Standardized formula: -10 to 10 maps to 0.5x to 2x (linear approximation)
          this.currentUtterance.rate = value >= 0 ? 1 + (value / 10) : 1 + (value / 20);
      }
      console.log(`[LocalStrategy] 🎚️ Rate set to: ${value} (mapped to ${value >= 0 ? 1 + (value / 10) : 1 + (value / 20)})`);
  }

  public async getVoices(): Promise<AudioVoice[]> {
    return new Promise((resolve) => {
      let voices = this.synth.getVoices();
      if (voices.length > 0) {
        resolve(this.mapVoices(voices));
      } else {
        this.synth.onvoiceschanged = () => {
          voices = this.synth.getVoices();
          resolve(this.mapVoices(voices));
        };
      }
    });
  }

  private mapVoices(voices: SpeechSynthesisVoice[]): AudioVoice[] {
    return voices.map(v => ({
      id: v.name,
      name: v.name,
      lang: v.lang,
      engine: 'local'
    }));
  }

  public dispose(): void {
    this.stop();
  }
}


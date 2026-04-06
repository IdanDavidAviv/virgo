import { AudioStrategy, AudioVoice, OutgoingAction } from '../../common/types';
import { MessageClient } from '../core/MessageClient';

/**
 * LocalAudioStrategy: Standard Web Speech API Implementation.
 * Provides high-integrity, offline playback using browser built-in synthesis.
 */
export class LocalAudioStrategy implements AudioStrategy {
  public readonly id = 'local';
  private synth: SpeechSynthesis;
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
    
    utterance.onstart = () => {
        console.log(`[LocalStrategy] ▶️ Playback started (intentId: ${intentId})`);
    };

    utterance.onend = () => {
        console.log(`[LocalStrategy] ✅ Playback ended (intentId: ${intentId})`);
        MessageClient.getInstance().postAction(OutgoingAction.SENTENCE_ENDED);
    };

    utterance.onerror = (e) => {
        console.error(`[LocalStrategy] ⛔ Synthesis error:`, e);
    };

    this.currentUtterance = utterance;
    this.synth.speak(utterance);
  }

  private applySettingsToUtterance(utterance: SpeechSynthesisUtterance): void {
      utterance.rate = this.rate >= 0 ? 1 + (this.rate / 5) : 1 + (this.rate / 10);
      utterance.volume = Math.max(0, Math.min(1, this.volume / 100));
  }

  public async play(): Promise<void> {
      // Chrome/Safari often require a fresh utterance if paused too long, 
      // but standard resume() usually works if already speaking.
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
          this.currentUtterance.rate = value >= 0 ? 1 + (value / 5) : 1 + (value / 10);
      }
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

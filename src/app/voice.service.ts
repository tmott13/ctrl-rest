import { Injectable, computed, signal } from '@angular/core';

export interface VoiceOption {
  name: string;
  label: string;
}

/**
 * Optional spoken cues, using the computer's built-in voices (no network).
 * Lets people close their eyes, or use Ctrl+Rest without seeing the screen.
 */
@Injectable({ providedIn: 'root' })
export class VoiceService {
  readonly supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  private readonly all = signal<SpeechSynthesisVoice[]>([]);
  /** Name of the chosen voice, or '' for the automatic pick. */
  readonly selected = signal<string>(load());

  /** English voices, best-sounding first (Premium and Enhanced voices on macOS). */
  readonly options = computed<VoiceOption[]>(() => {
    const score = (v: SpeechSynthesisVoice) =>
      (/premium/i.test(v.name) ? 3 : /enhanced|natural|neural/i.test(v.name) ? 2 : 0) +
      (v.lang === 'en-US' ? 0.5 : 0);
    return this.all()
      .filter((v) => v.lang.startsWith('en') && !NOVELTY.test(v.name))
      .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
      .map((v) => ({ name: v.name, label: `${v.name} (${accent(v.lang)})` }));
  });

  private lastHintAt = 0;

  constructor() {
    if (!this.supported) return;
    const refresh = () => this.all.set(speechSynthesis.getVoices());
    refresh();
    speechSynthesis.addEventListener?.('voiceschanged', refresh);
  }

  choose(name: string): void {
    this.selected.set(name);
    try {
      localStorage.setItem('ctrl-rest.voice', name);
    } catch {
      // Storage unavailable.
    }
  }

  private current(): SpeechSynthesisVoice | null {
    const voices = this.all();
    const chosen = voices.find((v) => v.name === this.selected());
    if (chosen) return chosen;
    const best = this.options()[0];
    return voices.find((v) => v.name === best?.name) ?? null;
  }

  /** Speak a short cue. `interrupt` cancels anything still being said. */
  say(text: string, interrupt = true): void {
    if (!this.supported) return;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = this.current();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = 0.85;
    u.pitch = 1;
    u.volume = 0.9;
    speechSynthesis.speak(u);
  }

  preview(): void {
    this.say('Breathe in… and breathe out. Hi, I’m here to breathe with you.');
  }

  /** Camera hints, spoken at most every 8 seconds so they don't nag. */
  hint(text: string): void {
    const now = Date.now();
    if (!text || now - this.lastHintAt < 8000) return;
    this.lastHintAt = now;
    this.say(text, false);
  }

  stop(): void {
    if (this.supported) speechSynthesis.cancel();
  }
}

/** macOS novelty voices that don't suit a calm break. */
const NOVELTY =
  /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy)\b/;

function accent(lang: string): string {
  const map: Record<string, string> = {
    'en-US': 'US',
    'en-GB': 'UK',
    'en-AU': 'Australia',
    'en-IE': 'Ireland',
    'en-IN': 'India',
    'en-ZA': 'South Africa',
    'en-NZ': 'New Zealand',
    'en-CA': 'Canada',
    'en-SC': 'Scotland',
  };
  return map[lang] ?? lang;
}

function load(): string {
  try {
    return localStorage.getItem('ctrl-rest.voice') ?? '';
  } catch {
    return '';
  }
}

import { Injectable } from '@angular/core';
import type { ThemeId } from './scene';

/** What each scene sounds like, in words (shown as a caption). */
export const SOUND_CAPTIONS: Record<ThemeId, string> = {
  rain: 'Soft rain on the window',
  beach: 'Waves washing in and out',
  forest: 'A light breeze and birdsong',
  plain: 'A soft, warm hum',
};

/**
 * Calm ambient sound made entirely in code with the Web Audio API, so
 * there are no audio files to license and the sound can follow your
 * breathing: rain softens as you slow down, waves swell on the inhale,
 * and birds get quieter as you settle.
 */
@Injectable({ providedIn: 'root' })
export class SoundService {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];

  // Live controls the current scene exposes
  private bedGain: GainNode | null = null;
  private bedFilter: BiquadFilterNode | null = null;
  private theme: ThemeId = 'rain';
  private rate = 10;
  private calm = 0;
  private phase = 0;
  private lastUpdate = 0;
  private volume = 0.6;

  /** Start the sound for a scene. Call from a click so the browser allows audio. */
  start(theme: ThemeId, volume: number): void {
    this.stop();
    this.theme = theme;
    this.volume = volume;
    this.phase = 0;
    this.lastUpdate = performance.now();

    const ctx = (this.ctx ??= new AudioContext());
    void ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // Fade in over 3 seconds.
    master.gain.linearRampToValueAtTime(volume, ctx.currentTime + 3);
    this.master = master;

    if (theme === 'rain') this.buildRain(ctx, master);
    if (theme === 'beach') this.buildBeach(ctx, master);
    if (theme === 'forest') this.buildForest(ctx, master);
    if (theme === 'plain') this.buildPlain(ctx, master);
  }

  /** Fade out and release everything. */
  stop(): void {
    const ctx = this.ctx;
    const master = this.master;
    const sources = this.sources;
    const nodes = this.nodes;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.sources = [];
    this.nodes = [];
    this.master = null;
    this.bedGain = null;
    this.bedFilter = null;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0, t + 1.2);
    setTimeout(() => {
      sources.forEach((s) => {
        try {
          s.stop();
        } catch {
          // Already stopped.
        }
      });
      [...nodes, master].forEach((n) => n.disconnect());
    }, 1400);
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.2);
    }
  }

  /** Feed the latest breathing rate (per minute) and calm (0 to 1). Call often. */
  update(rate: number, calm: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    this.rate += (rate - this.rate) * Math.min(1, dt * 0.5);
    this.calm = calm;
    this.phase += dt * (this.rate / 60) * Math.PI * 2;
    const t = ctx.currentTime;

    if (this.theme === 'rain' && this.bedGain && this.bedFilter) {
      // Heavier rain when breathing is fast, a soft drizzle when slow.
      const intensity = Math.max(0.15, Math.min(1, (this.rate - 5) / 13));
      this.bedGain.gain.setTargetAtTime(0.6 + 1.0 * intensity, t, 0.5);
      this.bedFilter.frequency.setTargetAtTime(1800 + 2600 * intensity, t, 0.5);
    }
    if (this.theme === 'beach' && this.bedGain && this.bedFilter) {
      // Swell on the inhale, pull back on the exhale.
      const tide = 0.5 - 0.5 * Math.cos(this.phase);
      this.bedGain.gain.setTargetAtTime(0.1 + 0.42 * tide, t, 0.15);
      this.bedFilter.frequency.setTargetAtTime(350 + 900 * tide, t, 0.15);
    }
    if (this.theme === 'forest' && this.bedGain) {
      const breeze = 0.5 - 0.5 * Math.cos(this.phase);
      this.bedGain.gain.setTargetAtTime(0.4 + 0.5 * breeze, t, 0.3);
    }
  }

  // Scene builders

  private noiseSource(ctx: AudioContext, kind: 'white' | 'pink' | 'brown'): AudioBufferSourceNode {
    const length = ctx.sampleRate * 4;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (kind === 'white') {
        data[i] = white * 0.5;
      } else if (kind === 'pink') {
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.11;
      } else {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start();
    this.sources.push(src);
    return src;
  }

  private buildRain(ctx: AudioContext, out: AudioNode): void {
    const noise = this.noiseSource(ctx, 'pink');
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3500;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    noise.connect(hp).connect(lp).connect(gain).connect(out);
    this.nodes.push(hp, lp, gain);
    this.bedGain = gain;
    this.bedFilter = lp;

    // Occasional soft drops on the glass.
    const drop = () => {
      if (!this.master) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1400 + Math.random() * 1600, t);
      osc.frequency.exponentialRampToValueAtTime(500, t + 0.05);
      g.gain.setValueAtTime(0.04 * (1 - this.calm * 0.6), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + 0.08);
      const intensity = Math.max(0.15, Math.min(1, (this.rate - 5) / 13));
      this.timers.push(setTimeout(drop, 120 + (Math.random() * 700) / intensity));
    };
    drop();
  }

  private buildBeach(ctx: AudioContext, out: AudioNode): void {
    const noise = this.noiseSource(ctx, 'brown');
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    noise.connect(lp).connect(gain).connect(out);

    // A little high fizz for the foam.
    const fizz = this.noiseSource(ctx, 'white');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 5000;
    bp.Q.value = 0.6;
    const fizzGain = ctx.createGain();
    fizzGain.gain.value = 0.05;
    fizz.connect(bp).connect(fizzGain).connect(gain);

    this.nodes.push(lp, gain, bp, fizzGain);
    this.bedGain = gain;
    this.bedFilter = lp;
  }

  private buildForest(ctx: AudioContext, out: AudioNode): void {
    // Breeze
    const noise = this.noiseSource(ctx, 'pink');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.5;
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    noise.connect(bp).connect(gain).connect(out);
    this.nodes.push(bp, gain);
    this.bedGain = gain;

    // Birds: short chirps, fewer and softer as you settle.
    const chirp = () => {
      if (!this.master) return;
      const t = ctx.currentTime;
      const notes = 2 + Math.floor(Math.random() * 3);
      const base = 2600 + Math.random() * 1400;
      for (let i = 0; i < notes; i++) {
        const start = t + i * 0.12;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(base, start);
        osc.frequency.exponentialRampToValueAtTime(
          base * (1.25 + Math.random() * 0.3),
          start + 0.07,
        );
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.05 * (1 - this.calm * 0.5), start + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
        osc.connect(g).connect(out);
        osc.start(start);
        osc.stop(start + 0.1);
      }
      this.timers.push(setTimeout(chirp, (3000 + Math.random() * 5000) * (1 + this.calm * 1.5)));
    };
    this.timers.push(setTimeout(chirp, 1500));
  }

  private buildPlain(ctx: AudioContext, out: AudioNode): void {
    const gain = ctx.createGain();
    gain.gain.value = 0.06;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    for (const freq of [110, 164.8, 220.5]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(lp);
      osc.start();
      this.sources.push(osc);
    }
    lp.connect(gain).connect(out);
    this.nodes.push(lp, gain);
  }
}

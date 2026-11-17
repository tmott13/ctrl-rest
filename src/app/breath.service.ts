import { Injectable, computed, signal } from '@angular/core';
import {
  SmartSpectraSDK,
  ValidationCode,
  SmartSpectraErrorCode,
  MetricType,
  breathingMetrics,
} from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';

/** What the preload exposes in Electron. Missing in a plain browser. */
interface CtrlRestBridge {
  isElectron: boolean;
  getApiKey(): Promise<string>;
}
declare global {
  interface Window {
    ctrlRest?: CtrlRestBridge;
  }
}

export type BreathMode = 'camera' | 'demo';
export type BreathStatus = 'idle' | 'starting' | 'running' | 'error';

/** Friendly, short hints for the SDK's camera checks. */
const HINTS: Record<number, string> = {
  [ValidationCode.kNoFaceFound]: 'Looking for your face. Sit facing the camera.',
  [ValidationCode.kMultipleFacesFound]: 'I see more than one face. Just you, please.',
  [ValidationCode.kFaceNotCentered]: 'Center your face in the frame.',
  [ValidationCode.kFaceSizeOutOfRange]: 'Adjust how close you are to the camera.',
  [ValidationCode.kTooDark]: 'A little more light would help.',
  [ValidationCode.kTooBright]: 'A little less light would help.',
  [ValidationCode.kChestNotVisible]: 'Tilt the screen so your shoulders show.',
  [ValidationCode.kCameraTuning]: 'The camera is adjusting. One moment.',
  [ValidationCode.kFrameRateTooLow]: 'The camera is running slow. Try closing other apps.',
  [ValidationCode.kExcessiveMotion]: 'Get comfy and try to stay still.',
  [ValidationCode.kFaceTooClose]: 'Move back a little.',
  [ValidationCode.kFaceTooFar]: 'Move a little closer.',
  [ValidationCode.kFaceTooHigh]: 'Move down a little.',
  [ValidationCode.kFaceTooLow]: 'Move up a little.',
  [ValidationCode.kFaceNotForward]: 'Face the camera straight on.',
};

const ERRORS: Record<number, string> = {
  [SmartSpectraErrorCode.kAuthenticationFailed]:
    'Your Presage API key was not accepted. Check the key in your .env file.',
  [SmartSpectraErrorCode.kCreditExhausted]: 'Your Presage trial credits are used up.',
  [SmartSpectraErrorCode.kNetworkError]:
    'Could not reach Presage to check the API key. Check your internet connection.',
  [SmartSpectraErrorCode.kInputUnavailable]:
    'The camera is not available. Is another app using it?',
};

/**
 * Wraps the SmartSpectra renderer SDK (camera mode) and a simulated
 * breathing signal (demo mode) behind the same small set of signals.
 */
@Injectable({ providedIn: 'root' })
export class BreathService {
  readonly mode = signal<BreathMode>('demo');
  readonly status = signal<BreathStatus>('idle');
  /** Latest breathing rate in breaths per minute, or null before the first reading. */
  readonly rate = signal<number | null>(null);
  /** True once the SDK says the reading meets its accuracy bar. */
  readonly stable = signal(false);
  readonly hint = signal<string>('');
  readonly error = signal<string>('');
  readonly stream = signal<MediaStream | null>(null);
  /** First and latest stable readings, for the end-of-break summary. */
  readonly firstStable = signal<number | null>(null);
  readonly lastStable = signal<number | null>(null);
  /** Counts up each time a real smile is detected (the app reacts to changes). */
  readonly smiles = signal(0);

  private happyStreak = 0;
  private lastSmileAt = 0;
  private withExpressions = true;

  readonly hasCameraSupport = computed(() => !!window.ctrlRest?.isElectron);

  private sdk: SmartSpectraSDK | null = null;
  private demoTimer: ReturnType<typeof setInterval> | null = null;

  /** Can camera mode run here (Electron + an API key)? */
  async cameraReady(): Promise<boolean> {
    if (!window.ctrlRest) return false;
    const key = await window.ctrlRest.getApiKey();
    return key.trim().length > 0;
  }

  async start(mode: BreathMode): Promise<void> {
    await this.stop();
    this.reset();
    this.mode.set(mode);
    this.status.set('starting');
    if (mode === 'demo') {
      this.startDemo();
    } else {
      await this.startCamera();
    }
  }

  async stop(): Promise<void> {
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    if (this.sdk) {
      const sdk = this.sdk;
      this.sdk = null;
      try {
        await sdk.stop();
      } catch {
        // Already stopped or the window is closing.
      }
      sdk.destroy();
    }
    this.stream.set(null);
    if (this.status() !== 'error') this.status.set('idle');
  }

  private reset(): void {
    this.rate.set(null);
    this.stable.set(false);
    this.hint.set('');
    this.error.set('');
    this.firstStable.set(null);
    this.lastStable.set(null);
    this.happyStreak = 0;
  }

  /** A smile = "happy" is the top expression with good confidence for a moment. */
  private checkSmile(
    scores: { type?: number | null; confidence?: number | null }[] | null | undefined,
  ): void {
    if (!scores?.length) return;
    const happy = scores.find((s) => s.type === 5)?.confidence ?? 0; // 5 = HAPPY
    const top = scores.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a));
    this.happyStreak = top.type === 5 && happy >= 55 ? this.happyStreak + 1 : 0;
    const now = Date.now();
    if (this.happyStreak >= 3 && now - this.lastSmileAt > 8000) {
      this.lastSmileAt = now;
      this.happyStreak = 0;
      this.smiles.update((n) => n + 1);
    }
  }

  private record(rate: number, stable: boolean): void {
    this.rate.set(rate);
    this.stable.set(stable);
    if (stable) {
      if (this.firstStable() === null) this.firstStable.set(rate);
      this.lastStable.set(rate);
    }
  }

  private async startCamera(): Promise<void> {
    this.status.set('starting');
    const apiKey = (await window.ctrlRest?.getApiKey()) ?? '';
    const sdk = new SmartSpectraSDK({
      apiKey,
      // Breathing drives the break; expressions let Mochi wave back when you smile.
      requestedMetrics: this.withExpressions
        ? [...breathingMetrics, MetricType.EXPRESSIONS]
        : [...breathingMetrics],
      // Ctrl+Rest opts out of SDK telemetry. Nothing about your session
      // is sent to Presage beyond validating the API key.
      enableTelemetry: false,
    });
    this.sdk = sdk;

    sdk.on('streamAvailable', (stream) => this.stream.set(stream));
    sdk.on('validationStatus', (code) => {
      this.hint.set(code === ValidationCode.kOk ? '' : (HINTS[code] ?? ''));
    });
    sdk.on('metrics', (buf) => {
      const metrics = decodeMetrics(buf);
      const latest = metrics.breathing?.rate?.at(-1);
      if (latest?.value != null && latest.value > 0) {
        this.record(latest.value, !!latest.stable);
        this.status.set('running');
      }
      this.checkSmile(metrics.face?.expression?.at(-1)?.scores);
    });
    sdk.on('error', (code, message) => {
      // If the plan doesn't include expressions, quietly carry on with breathing only.
      if (code === SmartSpectraErrorCode.kMetricNotAuthorized && this.withExpressions) {
        this.withExpressions = false;
        void this.stop().then(() => this.startCamera());
        return;
      }
      this.error.set(ERRORS[code] ?? `Something went wrong (${message}).`);
      this.status.set('error');
    });

    try {
      await sdk.start();
      this.status.set('running');
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e.code === SmartSpectraErrorCode.kMetricNotAuthorized && this.withExpressions) {
        this.withExpressions = false;
        await this.stop();
        return this.startCamera();
      }
      this.error.set(
        (e.code != null && ERRORS[e.code]) ||
          `Could not start the camera (${e.message ?? 'unknown error'}).`,
      );
      this.status.set('error');
    }
  }

  /**
   * Demo mode: a gentle simulated breathing rate that drifts from about
   * 16 down to about 10 breaths per minute. Clearly labeled in the UI.
   */
  private startDemo(): void {
    let t = 0;
    const startRate = 16;
    const settledRate = 10;
    this.status.set('running');
    this.demoTimer = setInterval(() => {
      t += 1;
      // Like the real SDK, no reading for the first few seconds, and it
      // takes a while to become "stable".
      if (t < 4) return;
      const progress = Math.min(1, t / 120);
      const base = startRate - (startRate - settledRate) * progress;
      const wobble = Math.sin(t / 7) * 0.4;
      this.record(Math.round((base + wobble) * 10) / 10, t >= 12);
      // Simulated smile now and then, so the "Mochi waves back" moment can be previewed.
      if (t === 20 || (t > 20 && t % 40 === 0)) this.smiles.update((n) => n + 1);
    }, 1000);
  }
}

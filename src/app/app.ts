import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { BreathMode, BreathService } from './breath.service';
import { Scene, THEMES, ThemeId } from './scene';
import { SOUND_CAPTIONS, SoundService } from './sound.service';
import { VoiceService } from './voice.service';

type Screen = 'welcome' | 'consent' | 'session' | 'done';
type SessionKind = 'camera' | 'timer' | 'demo';

@Component({
  selector: 'app-root',
  imports: [DecimalPipe, Scene],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  protected readonly breath = inject(BreathService);
  private readonly injector = inject(Injector);
  private readonly sound = inject(SoundService);
  protected readonly voice = inject(VoiceService);

  // Sound and spoken cues (remembered between breaks)
  protected readonly soundOn = signal(load('ctrl-rest.sound', 'on') === 'on');
  protected readonly volume = signal(Number(load('ctrl-rest.volume', '60')));
  protected readonly spoken = signal(load('ctrl-rest.spoken', 'off') === 'on');
  protected readonly soundCaption = computed(() =>
    this.soundOn() ? `Sound: ${SOUND_CAPTIONS[this.theme()].toLowerCase()}` : 'Sound off',
  );

  protected readonly screen = signal<Screen>('welcome');
  protected readonly kind = signal<SessionKind>('timer');
  protected readonly cameraReady = signal(false);
  protected readonly inElectron = !!window.ctrlRest;

  // Settings
  protected readonly minutes = signal(3);
  /** Mochi's guide pace in breaths per minute. Comfortable, never a target. */
  protected readonly guidePace = signal(6);
  protected readonly reducedMotion = signal(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  protected readonly showPreview = signal(true);
  protected readonly themes = THEMES;
  protected readonly theme = signal<ThemeId>(loadTheme());
  protected readonly themeInfo = computed(
    () => THEMES.find((t) => t.id === this.theme()) ?? THEMES[0],
  );

  /** Breaths per minute that drive the scene: yours when measured, otherwise Mochi's pace. */
  protected readonly sceneRate = computed(() => {
    const r = this.breath.rate();
    const measuring = this.screen() === 'session' && this.kind() !== 'timer';
    return measuring && r && r > 0 ? r : this.guidePace();
  });

  /** The lights dim slowly over the break. */
  protected readonly calm = computed(() => {
    if (this.screen() === 'done') return 1;
    if (this.screen() !== 'session') return 0;
    return Math.min(1, this.elapsed() / (this.minutes() * 600));
  });

  // Session clock
  protected readonly elapsed = signal(0);
  private clock: ReturnType<typeof setInterval> | null = null;

  /** "in" or "out", following Mochi's guide pace. */
  protected readonly phase = computed(() => {
    const cycle = 60 / this.guidePace();
    const t = this.elapsed() % (cycle * 10);
    return t < (cycle * 10) / 2 ? 'in' : 'out';
  });

  /** Mochi dozes off during the last 20 seconds of the break. */
  protected readonly drowsy = computed(() => this.elapsed() >= this.minutes() * 600 - 200);
  /** A few sleepy head nods just before she dozes off. */
  protected readonly nodding = computed(() => {
    const left = this.minutes() * 600 - this.elapsed();
    return left <= 280 && left > 200;
  });

  /** Mochi waves back for a moment when you smile. */
  protected readonly waving = signal(false);
  protected readonly smileAnnouncement = signal('');
  private waveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSmiles = 0;

  /** Mochi blinks every few seconds. */
  protected readonly blink = signal(false);
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly minutesDone = computed(() => Math.floor(this.elapsed() / 600));

  protected readonly roundedRate = computed(() => {
    const r = this.breath.rate();
    return r == null ? null : Math.round(r);
  });

  /** Seconds per breath for your circle; falls back to Mochi's pace. */
  protected readonly yourCycle = computed(() => {
    const r = this.breath.rate();
    return r && r > 0 ? 60 / r : 60 / this.guidePace();
  });

  /** Screen-reader announcement for the rate, throttled so it isn't chatty. */
  protected readonly rateAnnouncement = signal('');
  private lastAnnounced: { value: number | null; at: number } = { value: null, at: 0 };

  private readonly heading = viewChild<ElementRef<HTMLElement>>('screenHeading');
  private readonly preview = viewChild<ElementRef<HTMLVideoElement>>('preview');

  constructor() {
    // Move focus to each new screen's heading so keyboard and screen
    // reader users land in the right place.
    effect(() => {
      this.screen();
      afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
    });

    // Attach the SDK's camera stream to the preview.
    effect(() => {
      const video = this.preview()?.nativeElement;
      const stream = this.breath.stream();
      if (video) video.srcObject = stream;
    });

    // You smiled: Mochi waves back (not while she's dozing off).
    effect(() => {
      const n = this.breath.smiles();
      if (n === this.lastSmiles) return;
      this.lastSmiles = n;
      if (n === 0 || this.screen() !== 'session' || this.drowsy() || this.nodding()) return;
      this.waving.set(true);
      this.smileAnnouncement.set('You smiled, and Mochi waved back.');
      if (this.waveTimer) clearTimeout(this.waveTimer);
      this.waveTimer = setTimeout(() => {
        this.waving.set(false);
        this.smileAnnouncement.set('');
      }, 2600);
    });

    // Spoken cues follow Mochi's pace.
    effect(() => {
      const phase = this.phase();
      if (this.screen() === 'session' && this.spoken()) {
        this.voice.say(phase === 'in' ? 'Breathe in' : 'Breathe out');
      }
    });

    // Spoken camera hints ("Move a little closer"), so framing works without the screen.
    effect(() => {
      const hint = this.breath.hint();
      if (this.screen() === 'session' && this.spoken() && hint) this.voice.hint(hint);
    });

    // Announce the breathing rate when it changes, at most every 15 seconds.
    effect(() => {
      const value = this.roundedRate();
      const stable = this.breath.stable();
      if (value == null || !stable || this.screen() !== 'session') return;
      const now = Date.now();
      if (value !== this.lastAnnounced.value && now - this.lastAnnounced.at > 15000) {
        this.lastAnnounced = { value, at: now };
        this.rateAnnouncement.set(`Your breathing: about ${value} breaths per minute.`);
      }
    });
  }

  private scheduleBlink(): void {
    this.blinkTimer = setTimeout(
      () => {
        if (!this.reducedMotion()) {
          this.blink.set(true);
          setTimeout(() => this.blink.set(false), 160);
        }
        this.scheduleBlink();
      },
      2500 + Math.random() * 3500,
    );
  }

  async ngOnInit(): Promise<void> {
    this.scheduleBlink();
    this.cameraReady.set(await this.breath.cameraReady());
  }

  ngOnDestroy(): void {
    if (this.blinkTimer) clearTimeout(this.blinkTimer);
    this.stopClock();
    this.sound.stop();
    this.voice.stop();
    void this.breath.stop();
  }

  // Navigation

  protected chooseCamera(): void {
    this.screen.set('consent');
  }

  protected async begin(kind: SessionKind): Promise<void> {
    this.kind.set(kind);
    this.elapsed.set(0);
    this.lastAnnounced = { value: null, at: 0 };
    this.rateAnnouncement.set('');
    this.screen.set('session');
    if (this.soundOn()) this.sound.start(this.theme(), this.volume() / 100);
    if (kind === 'camera' || kind === 'demo') {
      await this.breath.start(kind as BreathMode);
    }
    this.startClock();
  }

  protected async end(): Promise<void> {
    if (this.screen() !== 'session') return;
    this.stopClock();
    this.sound.stop();
    this.screen.set('done');
    if (this.spoken()) this.voice.say('Mochi is asleep. Nice work taking a pause.');
    await this.breath.stop();
  }

  protected backToStart(): void {
    this.screen.set('welcome');
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.screen() === 'session') void this.end();
    else if (this.screen() === 'consent') this.backToStart();
  }

  // Settings handlers

  protected setMinutes(value: string): void {
    this.minutes.set(Number(value));
  }

  protected setTheme(id: ThemeId): void {
    this.theme.set(id);
    try {
      localStorage.setItem('ctrl-rest.theme', id);
    } catch {
      // Storage unavailable; the choice just won't be remembered.
    }
  }

  protected toggleSound(on: boolean): void {
    this.soundOn.set(on);
    save('ctrl-rest.sound', on ? 'on' : 'off');
    if (this.screen() === 'session') {
      if (on) this.sound.start(this.theme(), this.volume() / 100);
      else this.sound.stop();
    }
  }

  protected setVolume(value: string): void {
    this.volume.set(Number(value));
    save('ctrl-rest.volume', value);
    this.sound.setVolume(Number(value) / 100);
  }

  protected toggleSpoken(on: boolean): void {
    this.spoken.set(on);
    save('ctrl-rest.spoken', on ? 'on' : 'off');
    if (!on) this.voice.stop();
  }

  protected setPace(value: string): void {
    this.guidePace.set(Number(value));
  }

  // Clock (ticks every 100 ms so the in/out cue stays smooth)

  private startClock(): void {
    this.stopClock();
    this.clock = setInterval(() => {
      this.elapsed.update((t) => t + 1);
      this.sound.update(this.sceneRate(), this.calm());
      if (this.elapsed() >= this.minutes() * 600) void this.end();
    }, 100);
  }

  private stopClock(): void {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }
}

function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem('ctrl-rest.theme');
    if (saved && THEMES.some((t) => t.id === saved)) return saved as ThemeId;
  } catch {
    // Storage unavailable.
  }
  return 'rain';
}

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the setting just won't be remembered.
  }
}

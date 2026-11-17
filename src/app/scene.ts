import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  input,
  viewChild,
} from '@angular/core';

export type ThemeId = 'rain' | 'beach' | 'forest' | 'plain';

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  /** What moves, in words. Shown as a caption so the scene isn't visual-only. */
  caption: string;
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'rain',
    name: 'Rain',
    caption: 'Rain falls outside a cozy window. It softens as your breathing slows.',
  },
  { id: 'beach', name: 'Beach', caption: 'Waves roll in and out with your breath at sunset.' },
  {
    id: 'forest',
    name: 'Forest',
    caption: 'Sunlight in a forest glows and fades with your breath.',
  },
  { id: 'plain', name: 'Plain', caption: 'A simple, quiet background.' },
];

/** Areas inside each background image, as fractions of the image size. */
const RAIN_WINDOW = { x0: 0.245, y0: 0.07, x1: 0.795, y1: 0.725 };
const BEACH_SHORE_Y = 0.79;
const BEACH_HORIZON_Y = 0.553;
/** Outline of the rocks and plant at the lower left of the beach image (they stay in front of the water). */
const BEACH_ROCKS: [number, number][] = [
  [0, 0.6],
  [0.06, 0.62],
  [0.1, 0.66],
  [0.105, 0.72],
  [0.13, 0.745],
  [0.155, 0.77],
  [0.18, 0.785],
  [0.19, 0.81],
  [0.17, 0.85],
  [0.08, 0.86],
  [0, 0.86],
];
const FOREST_LIGHT = { x: 0.6, y: 0.0 };

interface Drop {
  x: number;
  y: number;
  len: number;
  speed: number;
}

interface Mote {
  x: number;
  y: number;
  r: number;
  drift: number;
  seed: number;
  leaf: boolean;
}

/**
 * Full-window animated background. The moving layer follows `rate`
 * (breaths per minute): rain gets lighter, waves roll at your pace, and
 * forest light pulses with each breath. `calm` (0 to 1) dims the lights
 * as you settle. Decorative only (aria-hidden); the app shows a text
 * caption of what's happening.
 */
@Component({
  selector: 'app-scene',
  template: `
    <div
      class="bg"
      aria-hidden="true"
      [style.background-image]="theme() === 'plain' ? null : 'url(themes/' + theme() + '.webp)'"
    ></div>
    <canvas #canvas class="scene" aria-hidden="true"></canvas>
    <div class="dim" aria-hidden="true"></div>
    <div class="dim calm" [style.opacity]="calm()" aria-hidden="true"></div>
  `,
  styles: `
    :host {
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
    }
    .bg,
    .scene,
    .dim {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .bg {
      background-color: #1d2433;
      background-image: radial-gradient(circle at 50% 45%, #2a3348, #161b27 70%);
      background-size: cover;
      background-position: center;
    }
    /* Lights dim gently as you settle (the second layer fades in with calm). */
    .dim {
      background: radial-gradient(
        circle at 50% 50%,
        rgb(10 12 20 / 15%) 20%,
        rgb(10 12 20 / 45%) 75%
      );
    }
    .dim.calm {
      background: radial-gradient(
        circle at 50% 50%,
        rgb(10 12 20 / 10%) 20%,
        rgb(10 12 20 / 25%) 75%
      );
      transition: opacity 1s linear;
    }
  `,
})
export class Scene implements OnDestroy {
  readonly theme = input<ThemeId>('rain');
  /** Breaths per minute driving the motion. */
  readonly rate = input<number>(10);
  /** 0 = just started, 1 = fully settled. */
  readonly calm = input<number>(0);
  readonly still = input<boolean>(false);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly images = new Map<ThemeId, HTMLImageElement>();
  private ctx: CanvasRenderingContext2D | null = null;
  private frame = 0;
  private last = 0;
  private phase = 0;
  /** Seconds of scene time, for motion that doesn't follow breathing (swells, sparkle). */
  private time = 0;
  private washCanvas: HTMLCanvasElement | null = null;
  private rainCanvas: HTMLCanvasElement | null = null;
  /** White where the window glass is, so rain never falls on the pillows or seat. */
  private readonly rainMask = new Image();
  private drops: Drop[] = [];
  private motes: Mote[] = [];
  private smoothRate = 10;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    for (const id of ['rain', 'beach', 'forest'] as ThemeId[]) {
      const img = new Image();
      img.src = `themes/${id}.webp`;
      this.images.set(id, img);
    }
    this.rainMask.src = 'themes/rain-glass.png';

    afterNextRender(() => {
      const canvas = this.canvas().nativeElement;
      this.ctx = canvas.getContext('2d');
      this.resize();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
      this.frame = requestAnimationFrame((t) => this.tick(t));
    });

    // Reset particles when the theme changes.
    effect(() => {
      this.theme();
      this.drops = [];
      this.motes = [];
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
  }

  private resize(): void {
    const canvas = this.canvas().nativeElement;
    // 1.5x is plenty for soft moving effects and keeps frames smooth on laptops.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }

  private tick(t: number): void {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    // Ease toward the live rate so the scene never jumps.
    this.smoothRate += (this.rate() - this.smoothRate) * Math.min(1, dt * 0.5);
    if (!this.still()) {
      this.phase += dt * (this.smoothRate / 60) * Math.PI * 2;
      this.time += dt;
    }
    this.draw(dt);
    this.frame = requestAnimationFrame((n) => this.tick(n));
  }

  /** Where the background image lands with object-fit: cover. */
  private cover(img: HTMLImageElement, w: number, h: number) {
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * s;
    const ih = img.naturalHeight * s;
    const ox = (w - iw) / 2;
    const oy = (h - ih) / 2;
    return {
      s,
      iw,
      ih,
      ox,
      oy,
      px: (fx: number) => ox + fx * iw,
      py: (fy: number) => oy + fy * ih,
    };
  }

  private draw(dt: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width: w, height: h } = ctx.canvas;
    const theme = this.theme();
    const img = this.images.get(theme);

    // The photo itself is a CSS background; the canvas only draws what moves.
    ctx.clearRect(0, 0, w, h);
    if (this.still() || theme === 'plain' || !img || !img.complete || !img.naturalWidth) return;

    const box = this.cover(img, w, h);
    if (theme === 'rain') this.drawRain(ctx, box, w, h, dt);
    if (theme === 'beach') this.drawWaves(ctx, box, w);
    if (theme === 'forest') this.drawForest(ctx, box, w, h, dt);
  }

  private drawRain(
    ctx: CanvasRenderingContext2D,
    box: ReturnType<Scene['cover']>,
    w: number,
    h: number,
    dt: number,
  ): void {
    // Work only inside the window's box, then cut the rain to the glass shape.
    const x0 = Math.max(0, Math.floor(box.px(RAIN_WINDOW.x0)));
    const y0 = Math.max(0, Math.floor(box.py(RAIN_WINDOW.y0)));
    const x1 = Math.min(w, Math.ceil(box.px(RAIN_WINDOW.x1)));
    const y1 = Math.min(h, Math.ceil(box.py(RAIN_WINDOW.y1)));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return;
    const off = (this.rainCanvas ??= document.createElement('canvas'));
    if (off.width !== bw || off.height !== bh) {
      off.width = bw;
      off.height = bh;
    }
    const o = off.getContext('2d');
    if (!o) return;
    o.clearRect(0, 0, bw, bh);
    o.save();
    o.translate(-x0, -y0);
    this.drawRainDrops(o, box, dt);
    o.restore();
    if (this.rainMask.complete && this.rainMask.naturalWidth) {
      o.globalCompositeOperation = 'destination-in';
      o.drawImage(this.rainMask, box.ox - x0, box.oy - y0, box.iw, box.ih);
      o.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(off, x0, y0);
  }

  private drawRainDrops(
    ctx: CanvasRenderingContext2D,
    box: ReturnType<Scene['cover']>,
    dt: number,
  ): void {
    const x0 = box.px(RAIN_WINDOW.x0);
    const x1 = box.px(RAIN_WINDOW.x1);
    const y0 = box.py(RAIN_WINDOW.y0);
    const y1 = box.py(RAIN_WINDOW.y1);
    // Faster breathing = heavier rain. Slower = a soft drizzle.
    const intensity = Math.max(0.12, Math.min(1, (this.smoothRate - 5) / 13));
    const target = Math.round(40 + 220 * intensity);
    while (this.drops.length < target) {
      this.drops.push({
        x: x0 + Math.random() * (x1 - x0),
        y: y0 + Math.random() * (y1 - y0),
        len: (8 + Math.random() * 14) * box.s * 1.6,
        speed: (500 + Math.random() * 400) * box.s * 1.6,
      });
    }
    if (this.drops.length > target) this.drops.length = target;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.strokeStyle = 'rgba(210, 225, 245, 0.35)';
    ctx.lineWidth = Math.max(1, box.s * 1.4);
    ctx.lineCap = 'round';
    ctx.beginPath();
    const speedScale = 0.55 + 0.6 * intensity;
    for (const d of this.drops) {
      d.y += d.speed * speedScale * dt;
      d.x -= d.speed * 0.08 * dt;
      if (d.y > y1 || d.x < x0) {
        d.y = y0 - Math.random() * 40;
        d.x = x0 + Math.random() * (x1 - x0 + 40);
      }
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.len * 0.08, d.y + d.len);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Beach: instead of drawing cartoon waves, move the photo itself.
   * The open water gently ripples, and the shallow water near the shore is
   * stretched up the sand on the inhale and slides back on the exhale,
   * with a soft feathered edge and a whisper of foam.
   */
  private drawWaves(
    ctx: CanvasRenderingContext2D,
    box: ReturnType<Scene['cover']>,
    w: number,
  ): void {
    const img = this.images.get('beach');
    if (!img) return;
    const sx = img.naturalWidth / box.iw; // canvas px -> image px
    const horizon = box.py(BEACH_HORIZON_Y);
    const shore = box.py(BEACH_SHORE_Y);
    const ih = box.ih;
    const t = this.time;
    const tide = 0.5 - 0.5 * Math.cos(this.phase); // in on the inhale

    // 1. Gentle ripple across the open water: redraw thin rows of the
    //    photo with a tiny sideways sway that grows toward the shore.
    const row = Math.max(3, Math.round(ih / 260));
    // Skip the far water near the horizon, where the sway would be invisible.
    for (let y = Math.round(horizon + (shore - horizon) * 0.12); y < shore - ih * 0.01; y += row) {
      const depth = (y - horizon) / (shore - horizon);
      const dx =
        Math.sin((y * 0.09) / Math.max(0.3, depth) + t * 1.2) * (0.4 + 2.2 * depth) * (ih / 900);
      const srcY = (y - box.oy) * sx;
      ctx.drawImage(img, 0, srcY, img.naturalWidth, row * sx, box.ox + dx, y, box.iw, row);
    }

    // 2. The wash: the shallow water band, stretched up the sand.
    const bandTop = shore - ih * 0.07;
    const reach = ih * 0.09 * tide;
    const destH = shore + reach - bandTop + ih * 0.01;
    if (destH > 2) {
      const off = (this.washCanvas ??= document.createElement('canvas'));
      off.width = w;
      off.height = Math.ceil(destH);
      const o = off.getContext('2d');
      if (o) {
        o.clearRect(0, 0, off.width, off.height);
        // Source: the water just above the shoreline.
        const srcTop = (bandTop - box.oy) * sx;
        const srcH = (shore - bandTop) * sx;
        o.drawImage(img, (0 - box.ox) * sx, srcTop, w * sx, srcH, 0, 0, w, destH);
        // Feather with a softly wavy leading edge, so it reads as water, not a strip.
        o.globalCompositeOperation = 'destination-in';
        const fade = o.createLinearGradient(0, 0, 0, destH);
        fade.addColorStop(0, 'rgba(0,0,0,1)');
        fade.addColorStop(0.75, 'rgba(0,0,0,0.85)');
        fade.addColorStop(1, 'rgba(0,0,0,0)');
        o.fillStyle = fade;
        o.beginPath();
        o.moveTo(0, 0);
        for (let x = 0; x <= w + 16; x += 16) {
          const wave =
            Math.sin(x / (w * 0.09) + t * 0.45) * 0.5 + Math.sin(x / (w * 0.035) - t * 0.7) * 0.3;
          o.lineTo(x, destH * (0.97 + 0.03 * wave) - ih * 0.006 * (1 - wave) * tide);
        }
        o.lineTo(w, 0);
        o.closePath();
        o.fill();
        o.globalCompositeOperation = 'source-over';
        ctx.drawImage(off, 0, bandTop);
      }

      // Keep the rocks and plant in front of the water.
      ctx.save();
      ctx.beginPath();
      BEACH_ROCKS.forEach(([fx, fy], n) =>
        n ? ctx.lineTo(box.px(fx), box.py(fy)) : ctx.moveTo(box.px(fx), box.py(fy)),
      );
      ctx.closePath();
      ctx.clip();
      // Only redraw the lower-left part of the photo (where the rocks are).
      ctx.drawImage(
        img,
        0,
        img.naturalHeight * 0.58,
        img.naturalWidth * 0.2,
        img.naturalHeight * 0.3,
        box.ox,
        box.py(0.58),
        box.iw * 0.2,
        box.ih * 0.3,
      );
      ctx.restore();

      // 3. A whisper of foam right at the leading edge, softly blurred.
      const edgeY = bandTop + destH * 0.86;
      ctx.save();
      ctx.filter = `blur(${Math.max(1, ih * 0.004)}px)`;
      const foam = ctx.createLinearGradient(0, 0, w, 0);
      for (let n = 0; n <= 20; n++) {
        const a = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(n * 1.7 + t * 0.3)) * (0.4 + 0.6 * tide);
        foam.addColorStop(n / 20, `rgba(255, 246, 240, ${a.toFixed(3)})`);
      }
      ctx.fillStyle = foam;
      ctx.beginPath();
      for (let x = 0; x <= w + 20; x += 20) {
        const y = edgeY + Math.sin(x / (w * 0.08) + t * 0.4) * ih * 0.004;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let x = w + 20; x >= 0; x -= 20) {
        ctx.lineTo(x, edgeY + ih * 0.006 + Math.sin(x / (w * 0.05) - t * 0.3) * ih * 0.003);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private drawForest(
    ctx: CanvasRenderingContext2D,
    box: ReturnType<Scene['cover']>,
    w: number,
    h: number,
    dt: number,
  ): void {
    // Sun rays glow on the inhale.
    const glow = 0.5 - 0.5 * Math.cos(this.phase);
    const lx = box.px(FOREST_LIGHT.x);
    const ly = box.py(FOREST_LIGHT.y);
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, box.ih * 0.9);
    g.addColorStop(0, `rgba(255, 236, 170, ${0.1 + 0.2 * glow})`);
    g.addColorStop(1, 'rgba(255, 236, 170, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Floating light motes and a few drifting leaves. Their motion runs on
    // its own gentle clock (not the breath) so it stays smooth.
    const unit = box.ih / 1000;
    while (this.motes.length < 60) {
      const leaf = this.motes.filter((m) => m.leaf).length < 6 && Math.random() < 0.2;
      this.motes.push({
        x: Math.random() * w,
        y: leaf ? Math.random() * h * 1.1 - h * 0.3 : Math.random() * h,
        r: leaf ? (9 + Math.random() * 6) * unit : (1.2 + Math.random() * 2) * unit,
        drift: (leaf ? 38 + Math.random() * 22 : 8 + Math.random() * 8) * unit,
        seed: Math.random() * 100,
        leaf,
      });
    }
    const t = this.time;
    for (const m of this.motes) {
      if (m.leaf) {
        // Fall slowly, drifting side to side like a real leaf.
        m.y += m.drift * dt;
        m.x += Math.sin(t * 0.9 + m.seed) * m.drift * 0.9 * dt;
        if (m.y > h + 30) {
          m.y = -30;
          m.x = Math.random() * w;
        }
        const flutter = Math.cos(t * 1.3 + m.seed); // the leaf turning over
        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.rotate(Math.sin(t * 0.6 + m.seed) * 0.7 + m.seed);
        ctx.scale(0.35 + 0.65 * Math.abs(flutter), 1);
        const hue = m.seed % 3;
        ctx.fillStyle =
          hue < 1
            ? 'rgba(206, 178, 72, 0.85)'
            : hue < 2
              ? 'rgba(160, 170, 70, 0.85)'
              : 'rgba(196, 140, 60, 0.85)';
        ctx.beginPath();
        ctx.moveTo(0, -m.r);
        ctx.quadraticCurveTo(m.r * 0.6, 0, 0, m.r);
        ctx.quadraticCurveTo(-m.r * 0.6, 0, 0, -m.r);
        ctx.fill();
        ctx.strokeStyle = 'rgba(110, 90, 40, 0.5)';
        ctx.lineWidth = Math.max(0.6, unit * 0.8);
        ctx.beginPath();
        ctx.moveTo(0, -m.r * 0.85);
        ctx.lineTo(0, m.r * 0.9);
        ctx.stroke();
        ctx.restore();
      } else {
        m.y -= m.drift * 0.5 * dt;
        m.x += Math.sin(t * 0.4 + m.seed) * m.drift * 0.3 * dt;
        if (m.y < -10) {
          m.y = h + 10;
          m.x = Math.random() * w;
        }
        const twinkle = 0.5 + 0.5 * Math.sin(t * 0.8 + m.seed);
        ctx.fillStyle = `rgba(255, 245, 200, ${(0.15 + 0.3 * glow) * (0.5 + 0.5 * twinkle)})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

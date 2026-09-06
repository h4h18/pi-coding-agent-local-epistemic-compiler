import { LumaField, loadImage, subjectRect } from "./luma.ts";
import { type Plate, plates } from "./story.ts";

export type Pointer = {
  readonly x: number;
  readonly y: number;
  readonly strength: number;
};

type Point = {
  x: number;
  y: number;
  lift: number;
};

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class ScanlineEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly fields = new Map<string, LumaField>();
  private readonly images = new Map<string, HTMLImageElement>();
  private width = 0;
  private height = 0;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) {
      throw new Error("canvas 2d unavailable");
    }
    this.canvas = canvas;
    this.ctx = ctx;
  }

  async prepare(): Promise<void> {
    const loaded = await Promise.all(plates.map(async (plate) => ({ plate, image: await loadImage(plate.src) })));
    for (const item of loaded) {
      this.images.set(item.plate.id, item.image);
    }
    this.rebuildFields();
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    const ratio = Math.min(2, Math.max(1, pixelRatio));
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.rebuildFields();
  }

  render(from: Plate, to: Plate, mixT: number, pointer: Pointer): void {
    const { ctx, width, height } = this;
    const fieldA = this.fields.get(from.id);
    const fieldB = this.fields.get(to.id);
    if (fieldA === undefined || fieldB === undefined) {
      ctx.fillStyle = "#050505";
      ctx.fillRect(0, 0, width, height);
      return;
    }

    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, width, height);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#e4dccf";

    const lineCount = height < 1100 ? 168 : 210;
    const samples = width < 1400 ? 280 : 360;
    const amplitude = mix(from.amplitude, to.amplitude, mixT) * height;
    const floor = mix(from.floor, to.floor, mixT);
    const spacing = height / lineCount;
    const points: Point[] = new Array<Point>(samples + 1);
    const scale = Math.min(2, height / 900);

    for (let row = 0; row < lineCount; row += 1) {
      const v = (row + 0.5) / lineCount;
      const y0 = (row + 0.5) * spacing;
      for (let col = 0; col <= samples; col += 1) {
        const u = col / samples;
        const raw = mix(fieldA.sample(u, v), fieldB.sample(u, v), mixT);
        const lifted = smoothstep(floor, 0.88, raw);
        const dx = u - pointer.x;
        const dy = v - pointer.y;
        const falloff = Math.exp(-(dx * dx + dy * dy) * 22) * pointer.strength * 0.01;
        const existing = points[col];
        const next: Point = {
          x: u * width,
          y: y0 - (lifted * 0.72 + falloff) * amplitude,
          lift: lifted,
        };
        if (existing === undefined) {
          points[col] = next;
        } else {
          existing.x = next.x;
          existing.y = next.y;
          existing.lift = next.lift;
        }
      }

      ctx.beginPath();
      const origin = points[0];
      if (origin !== undefined) {
        ctx.moveTo(origin.x, origin.y);
        for (let col = 1; col <= samples; col += 1) {
          const point = points[col];
          if (point !== undefined) {
            ctx.lineTo(point.x, point.y);
          }
        }
        ctx.globalAlpha = 0.16;
        ctx.lineWidth = 0.55 * scale;
        ctx.stroke();
      }

      const chunk = 6;
      for (let i = 0; i < samples; i += chunk) {
        const end = Math.min(samples, i + chunk);
        const first = points[i];
        if (first === undefined) {
          continue;
        }
        let local = first.lift;
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        for (let c = i + 1; c <= end; c += 1) {
          const point = points[c];
          if (point === undefined) {
            continue;
          }
          local = Math.max(local, point.lift);
          ctx.lineTo(point.x, point.y);
        }
        ctx.globalAlpha = 0.14 + local * 0.78;
        ctx.lineWidth = mix(0.55, 1.35, local) * scale;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  private rebuildFields(): void {
    if (this.width === 0 || this.height === 0 || this.images.size === 0) {
      return;
    }
    const fieldHeight = 720;
    const fieldWidth = Math.max(400, Math.round(fieldHeight * (this.width / this.height)));
    this.fields.clear();
    for (const plate of plates) {
      const image = this.images.get(plate.id);
      if (image === undefined) {
        continue;
      }
      const dest = subjectRect(fieldWidth, fieldHeight, image.naturalWidth, image.naturalHeight);
      this.fields.set(
        plate.id,
        LumaField.fromImage(
          image,
          image.naturalWidth,
          image.naturalHeight,
          fieldWidth,
          fieldHeight,
          dest,
          2.6,
        ),
      );
    }
  }
}

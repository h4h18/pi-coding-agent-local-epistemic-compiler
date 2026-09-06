export type Vec2 = readonly [number, number];

export class LumaField {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;

  constructor(width: number, height: number, data: Float32Array) {
    this.width = width;
    this.height = height;
    this.data = data;
  }

  static fromImage(
    image: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    fieldWidth: number,
    fieldHeight: number,
    dest: { x: number; y: number; w: number; h: number },
    blurPx: number,
  ): LumaField {
    const canvas = document.createElement("canvas");
    canvas.width = fieldWidth;
    canvas.height = fieldHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      throw new Error("unable to sample plate");
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, fieldWidth, fieldHeight);
    ctx.filter = `blur(${String(blurPx)}px)`;
    ctx.drawImage(image, 0, 0, sourceWidth, sourceHeight, dest.x, dest.y, dest.w, dest.h);
    ctx.filter = "none";
    const pixels = ctx.getImageData(0, 0, fieldWidth, fieldHeight).data;
    const data = new Float32Array(fieldWidth * fieldHeight);
    for (let i = 0, p = 0; i < data.length; i += 1, p += 4) {
      const r = pixels[p] ?? 0;
      const g = pixels[p + 1] ?? 0;
      const b = pixels[p + 2] ?? 0;
      data[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    return new LumaField(fieldWidth, fieldHeight, data);
  }

  sample(u: number, v: number): number {
    const x = u * (this.width - 1);
    const y = v * (this.height - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(this.width - 1, x0 + 1);
    const y1 = Math.min(this.height - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const a = this.data[y0 * this.width + x0] ?? 0;
    const b = this.data[y0 * this.width + x1] ?? 0;
    const c = this.data[y1 * this.width + x0] ?? 0;
    const d = this.data[y1 * this.width + x1] ?? 0;
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }
}

export function subjectRect(
  canvasWidth: number,
  canvasHeight: number,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; w: number; h: number } {
  const imageAspect = imageWidth / Math.max(imageHeight, 1);
  const height = canvasHeight * 1.02;
  const width = height * imageAspect;
  const x = canvasWidth * 0.56 - width * 0.5;
  const y = (canvasHeight - height) * 0.5;
  return { x, y, w: width, h: height };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error(`failed to load ${src}`));
    };
    image.src = src;
  });
}

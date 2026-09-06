import { ScanlineEngine, type Pointer } from "./raster/scanline.ts";
import { type Plate, plateAt, plates } from "./raster/story.ts";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

function scrollPair(): { from: Plate; to: Plate; mix: number } {
  const last = plates.length - 1;
  const mid = window.scrollY + window.innerHeight * 0.5;
  const posters = document.querySelectorAll<HTMLElement>("[data-poster]");
  if (posters.length === 0) {
    return { from: plateAt(0), to: plateAt(0), mix: 0 };
  }

  let index = 0;
  for (const [i, poster] of posters.entries()) {
    const top = poster.offsetTop;
    const bottom = top + poster.offsetHeight;
    if (mid >= top && mid <= bottom) {
      const local = (mid - top) / Math.max(poster.offsetHeight, 1);
      if (local > 0.7 && i < last) {
        return {
          from: plateAt(i),
          to: plateAt(i + 1),
          mix: ease((local - 0.7) / 0.3),
        };
      }
      return { from: plateAt(i), to: plateAt(i), mix: 0 };
    }
    if (mid < top) {
      index = Math.max(0, i - 1);
      break;
    }
    index = i;
  }
  return { from: plateAt(index), to: plateAt(index), mix: 0 };
}

export async function startLanding(): Promise<() => void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#raster");
  if (canvas === null) {
    throw new Error("raster canvas is missing");
  }

  const engine = new ScanlineEngine(canvas);
  await engine.prepare();

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let pointer: Pointer = { x: 0.5, y: 0.5, strength: 0 };
  let pointerTarget: Pointer = { x: 0.5, y: 0.5, strength: 0 };
  let frame = 0;
  let running = true;

  const resize = (): void => {
    engine.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  };

  const draw = (): void => {
    const pair = scrollPair();
    const easePtr = reduced.matches ? 1 : 0.1;
    pointer = {
      x: lerp(pointer.x, pointerTarget.x, easePtr),
      y: lerp(pointer.y, pointerTarget.y, easePtr),
      strength: lerp(pointer.strength, reduced.matches ? 0 : pointerTarget.strength, easePtr),
    };
    engine.render(pair.from, pair.to, pair.mix, pointer);
  };

  const tick = (): void => {
    if (!running) {
      return;
    }
    draw();
    frame = window.requestAnimationFrame(tick);
  };

  const onPointerMove = (event: PointerEvent): void => {
    pointerTarget = {
      x: event.clientX / Math.max(window.innerWidth, 1),
      y: event.clientY / Math.max(window.innerHeight, 1),
      strength: 1,
    };
  };

  const onPointerLeave = (): void => {
    pointerTarget = { ...pointerTarget, strength: 0 };
  };

  const onScroll = (): void => {
    if (reduced.matches) {
      draw();
    }
  };

  const onVisibility = (): void => {
    if (document.hidden) {
      window.cancelAnimationFrame(frame);
      return;
    }
    if (!reduced.matches) {
      frame = window.requestAnimationFrame(tick);
    }
  };

  resize();
  draw();
  if (!reduced.matches) {
    frame = window.requestAnimationFrame(tick);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onPointerLeave, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    running = false;
    window.cancelAnimationFrame(frame);
    window.removeEventListener("resize", resize);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerleave", onPointerLeave);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

export function revealPosters(): void {
  const posters = document.querySelectorAll<HTMLElement>("[data-poster]");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle("is-active", entry.isIntersecting && entry.intersectionRatio > 0.32);
      }
    },
    { threshold: [0.32, 0.6, 0.85] },
  );
  for (const poster of posters) {
    observer.observe(poster);
  }
}

export function bindCopy(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-copy]");
  if (button === null) {
    return;
  }
  const command = button.dataset.copy ?? "";
  button.addEventListener("click", () => {
    if (navigator.clipboard === undefined) {
      return;
    }
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        button.dataset.state = "copied";
        window.setTimeout(() => {
          button.dataset.state = "idle";
        }, 1600);
      })
      .catch(() => {
        button.dataset.state = "idle";
      });
  });
}

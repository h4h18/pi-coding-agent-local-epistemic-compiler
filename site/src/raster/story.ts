import doubt from "../plates/doubt.png";
import hero from "../plates/hero.png";
import proof from "../plates/proof.png";
import start from "../plates/start.png";

export type PlateId = "hero" | "doubt" | "proof" | "start";

export type Plate = {
  readonly id: PlateId;
  readonly src: string;
  readonly amplitude: number;
  readonly floor: number;
};

export const plates: readonly Plate[] = [
  { id: "hero", src: hero, amplitude: 0.016, floor: 0.05 },
  { id: "doubt", src: doubt, amplitude: 0.015, floor: 0.045 },
  { id: "proof", src: proof, amplitude: 0.015, floor: 0.04 },
  { id: "start", src: start, amplitude: 0.016, floor: 0.05 },
];

export function plateAt(index: number): Plate {
  const plate = plates[index];
  if (plate === undefined) {
    const fallback = plates[0];
    if (fallback === undefined) {
      throw new Error("plates are empty");
    }
    return fallback;
  }
  return plate;
}

export function plateIndex(id: PlateId): number {
  switch (id) {
    case "hero":
      return 0;
    case "doubt":
      return 1;
    case "proof":
      return 2;
    case "start":
      return 3;
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

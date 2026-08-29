import { add } from "./math.ts";

describe("math", () => {
  it("adds fnordwidget numbers", () => {
    expect(add(1, 2)).toBe(3);
  });
});

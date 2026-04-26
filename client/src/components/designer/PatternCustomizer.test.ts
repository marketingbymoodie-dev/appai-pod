import { describe, expect, it } from "vitest";
import { getDefaultPanelRenderConfig } from "./PatternCustomizer";

describe("getDefaultPanelRenderConfig", () => {
  it("defaults hoodie front panels to artwork enabled", () => {
    const cfg = getDefaultPanelRenderConfig("front_left", "hoodie", "hoodie_v1");
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe("artwork");
  });

  it("defaults hoodie back/hood panels to artwork off", () => {
    const back = getDefaultPanelRenderConfig("back", "hoodie", "hoodie_v1");
    const hood = getDefaultPanelRenderConfig("left_hood", "hoodie", "hoodie_v1");
    expect(back.enabled).toBe(false);
    expect(hood.enabled).toBe(false);
  });

  it("defaults hoodie supporting panels to solid mode", () => {
    const cfg = getDefaultPanelRenderConfig("right_cuff_panel", "hoodie", "hoodie_v1");
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe("solid");
  });
});


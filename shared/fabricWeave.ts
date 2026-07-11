/** Printify blueprint: Woven Wall Tapestry — default woven texture mockup. */
export const WOVEN_WALL_TAPESTRY_BLUEPRINT_ID = 1649;

/** Whether flat mockups apply procedural woven-fabric texture. */
export function resolveFabricWeaveTexture(opts: {
  fabricWeaveTexture?: boolean | null;
  printifyBlueprintId?: number | null;
}): boolean {
  if (typeof opts.fabricWeaveTexture === "boolean") return opts.fabricWeaveTexture;
  return opts.printifyBlueprintId === WOVEN_WALL_TAPESTRY_BLUEPRINT_ID;
}

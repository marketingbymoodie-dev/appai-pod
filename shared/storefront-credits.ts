/** Free AI generations included for each storefront customer (before paid credits). */
export const STOREFRONT_FREE_GENERATION_LIMIT = 10;

export function storefrontArtworksRemaining(args: {
  freeGenerationsUsed?: number;
  paidCredits?: number;
}): number {
  const freeUsed = args.freeGenerationsUsed ?? 0;
  const paid = args.paidCredits ?? 0;
  const freeRemaining = Math.max(0, STOREFRONT_FREE_GENERATION_LIMIT - freeUsed);
  return freeRemaining + paid;
}

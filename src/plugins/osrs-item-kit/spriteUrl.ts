const RUNELITE_SPRITE_CDN = "https://static.runelite.net/cache/item/icon";

/** Each item id renders its own real icon — no substitution between variants. */
export function spriteUrl(itemId: number): string {
  return `${RUNELITE_SPRITE_CDN}/${itemId}.png`;
}

/** 32x32 gray "unknown item" placeholder, embedded so this kit has zero local asset dependencies. */
export const FALLBACK_SPRITE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANElEQVR4nGPQkOSiKWIYtWDUglEL8FoQYCNHPBq1YNSCUQtGLRi1YKAsoAoatWDUgiFgAQDAIX+Py4ErTAAAAABJRU5ErkJggg==";

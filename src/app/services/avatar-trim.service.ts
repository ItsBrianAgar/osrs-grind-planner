import { Injectable } from '@angular/core';

/**
 * OSRS item sprites bake asymmetric transparent padding into their fixed-size canvas (it's
 * hand-authored per item, not uniform), so `object-fit: contain` alone leaves icons looking
 * off-center. This trims that padding down to the actual artwork so centering is accurate.
 */
@Injectable({ providedIn: 'root' })
export class AvatarTrimService {
  private readonly cache = new Map<string, Promise<string>>();

  trim(url: string): Promise<string> {
    if (!url) return Promise.resolve(url);
    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.loadAndTrim(url).catch(() => url);
      this.cache.set(url, pending);
    }
    return pending;
  }

  private loadAndTrim(url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          resolve(this.cropTransparentPadding(img));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error(`Failed to load avatar image: ${url}`));
      img.src = url;
    });
  }

  private cropTransparentPadding(img: HTMLImageElement): string {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return img.src;
    ctx.drawImage(img, 0, 0);

    const { width, height } = canvas;
    const { data } = ctx.getImageData(0, 0, width, height);

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // Fully transparent, or already tight to its canvas — nothing to gain from cropping.
    if (maxX < minX || maxY < minY || (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1)) {
      return img.src;
    }

    const trimmedWidth = maxX - minX + 1;
    const trimmedHeight = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = trimmedWidth;
    out.height = trimmedHeight;
    const outCtx = out.getContext('2d');
    if (!outCtx) return img.src;
    outCtx.drawImage(canvas, minX, minY, trimmedWidth, trimmedHeight, 0, 0, trimmedWidth, trimmedHeight);
    return out.toDataURL('image/png');
  }
}

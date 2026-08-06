import { Injectable, signal } from '@angular/core';

export interface NodeSize {
  width: number;
  height: number;
}

/**
 * Tracks each node's actual rendered size, keyed by node id. Node cards size to their
 * content (title length, notes), so connection lines and hit-testing need
 * real measured dimensions instead of the nominal NODE_WIDTH/NODE_HEIGHT constants.
 */
@Injectable({ providedIn: 'root' })
export class NodeMetricsService {
  private readonly sizes = signal<Record<string, NodeSize>>({});

  get(id: string): NodeSize | undefined {
    return this.sizes()[id];
  }

  set(id: string, size: NodeSize): void {
    const current = this.sizes()[id];
    if (current && current.width === size.width && current.height === size.height) return;
    this.sizes.update(s => ({ ...s, [id]: size }));
  }

  remove(id: string): void {
    this.sizes.update(s => {
      if (!(id in s)) return s;
      const rest = { ...s };
      delete rest[id];
      return rest;
    });
  }
}

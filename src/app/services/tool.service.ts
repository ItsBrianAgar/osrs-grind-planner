import { Injectable, computed, signal } from '@angular/core';

export type Tool = 'select' | 'hand';

@Injectable({ providedIn: 'root' })
export class ToolService {
  readonly tool = signal<Tool>('select');
  private readonly spaceHeld = signal(false);

  /** The tool actually in effect right now — holding space temporarily forces hand/pan behavior regardless of the selected tool. */
  readonly effectiveTool = computed<Tool>(() => this.spaceHeld() ? 'hand' : this.tool());

  setTool(tool: Tool): void {
    this.tool.set(tool);
  }

  setSpaceHeld(held: boolean): void {
    this.spaceHeld.set(held);
  }
}

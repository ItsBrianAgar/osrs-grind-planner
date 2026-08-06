export type NodeSide = 'top' | 'right' | 'bottom' | 'left';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 120;
export const GROUP_PADDING = 24;
/** Space reserved above a group's nodes for its header row (label, rename, ungroup) — replaces GROUP_PADDING on that one side. */
export const GROUP_HEADER_HEIGHT = 36;

export interface GrindNode {
  id: string;
  x: number;
  y: number;
  title: string;
  notes: string;
  avatarUrl?: string;
  groupId?: string;
  completed: boolean;
}

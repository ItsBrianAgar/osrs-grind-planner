export type NodeCategory = 'quest' | 'skill' | 'item' | 'boss' | 'minigame' | 'general';

export type NodeSide = 'top' | 'right' | 'bottom' | 'left';

export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  quest: '#8b1a1a',
  skill: '#1a6b1a',
  item: '#8b6314',
  boss: '#6b1a8b',
  minigame: '#1a3a8b',
  general: '#5a3e1b',
};

export const CATEGORY_ICONS: Record<NodeCategory, string> = {
  quest: 'pi-book',
  skill: 'pi-chart-line',
  item: 'pi-shield',
  boss: 'pi-bolt',
  minigame: 'pi-star',
  general: 'pi-circle',
};

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  quest: 'Quest',
  skill: 'Skill',
  item: 'Item',
  boss: 'Boss',
  minigame: 'Minigame',
  general: 'General',
};

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
  category: NodeCategory;
  completed: boolean;
}

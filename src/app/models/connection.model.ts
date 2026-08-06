import { NodeSide } from './grind-node.model';

/** A connection endpoint attaches to either a specific node or a whole group — never both. */
export type EndpointKind = 'node' | 'group';

/**
 * Every connection is a prereq gate: the source must be completed before the target is
 * unlocked. When an endpoint is a group, it stands in for all of that group's member nodes
 * (grouping is one level deep, so this never needs to recurse) — a group source gates until
 * every member is completed, and a group target applies that same gate to every member.
 */
export interface NodeConnection {
  id: string;
  /** A node id (when fromKind is 'node') or a group id (when fromKind is 'group'). */
  fromId: string;
  fromKind: EndpointKind;
  /** Which side of the source box (node or group) this connection attaches to. */
  fromSide: NodeSide;
  /** A node id (when toKind is 'node') or a group id (when toKind is 'group'). */
  toId: string;
  toKind: EndpointKind;
  /** Which side of the target box (node or group) this connection attaches to. */
  toSide: NodeSide;
}

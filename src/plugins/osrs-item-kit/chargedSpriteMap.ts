/**
 * Maps uncharged/inactive item IDs to their charged/active counterpart.
 * Used by itemMapping.ts to inject the counterpart as its own separately searchable
 * and selectable entry — both forms keep their own id, name, and icon.
 */
export const CHARGED_SPRITE_MAP: Record<number, number> = {
  // Scythe of vitur (uncharged) ↔ Scythe of vitur
  22325: 22324,
  // Tumeken's shadow (uncharged) ↔ Tumeken's shadow
  27277: 27275,
  // Sanguinesti staff (uncharged) ↔ Sanguinesti staff
  24422: 24420,
  // Uncharged trident ↔ Trident of the swamp
  11908: 12899,
  // Trident of the seas (uncharged) ↔ Trident of the seas
  11907: 11905,
  // Bow of faerdhinen (inactive) ↔ Bow of faerdhinen (c)
  25739: 25862,
  // Blade of saeldor (inactive) ↔ Blade of saeldor (c)
  25869: 25870,
  // Crystal bow (inactive) ↔ Crystal bow
  23855: 23760,
  // Crystal shield (inactive) ↔ Crystal shield
  23859: 23991,
  // Crystal helm (inactive) ↔ Crystal helm
  23857: 33031,
  // Crystal body (inactive) ↔ Crystal body
  23858: 33023,
  // Crystal legs (inactive) ↔ Crystal legs
  23860: 33027,
  // Dawnbringer (uncharged) ↔ Dawnbringer
  22349: 22347,
};

/**
 * Feature flags. Single source of truth so a feature can be turned on/off in
 * one place rather than hunted across components.
 */

// AI "plain English" explainers (the ✨ product blurbs in the Quick View,
// Product Detail, and the deal/mover "AI note" cells). Turned OFF: the stored
// blurbs were going stale and describing old pricing. Flip to true to restore
// once the blurbs are regenerated against current data.
export const AI_EXPLAINERS_ENABLED = false;

/**
 * Battle display scale: small Genemon are DRAWN larger so they stay readable in a battle, while the
 * physics (body radius, reach, hit tests) keeps their true size. A 25-cm creature is drawn ~1.9x
 * (~47 cm), a 50-cm one 1.34x, anything from 90 cm up at 1x, so size order is preserved and an XL
 * still towers over an XS. Used by the battle view (meshes, side markers), the battle camera
 * (framing) and the QA readability metric, so all three measure what is drawn.
 *
 * WHY: QA round 2/3 measured 18-46 px fighters at 1440x900 with the camera framing every living
 * fighter; the designer's floor is 48 px (docs/reviews/round-1/designer-noob.md, fix 3).
 */
export function displayScale(heightM: number): number {
  return Math.min(2, Math.max(1, Math.sqrt(0.9 / Math.max(0.05, heightM))));
}

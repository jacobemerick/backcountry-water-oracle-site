/**
 * A band of contour lines, drawn in `--contour`.
 *
 * Purely ornamental, and the only ornament on the page — which is the argument
 * for it. A quad sheet is mostly terrain, and the home page is otherwise a
 * headline and a box. This is the one place the identity gets to be visible
 * without competing with the thing people came to do.
 *
 * The lines are generated rather than hand-drawn so they read as terrain
 * (irregular spacing, varying amplitude, no repeat you can spot) instead of as
 * a wave pattern. Deterministic, so the markup is stable between renders and
 * the server and client agree.
 */

const WIDTH = 1200;
const HEIGHT = 96;
const LINES = 8;
const STEP = 24;

/**
 * Two sine components of incommensurable wavelength, so the sum never visibly
 * repeats across the width. Each line is offset in phase as well as height,
 * which is what stops them reading as a stack of identical ripples.
 */
function contourPath(index: number): string {
  const base = 8 + index * ((HEIGHT - 16) / (LINES - 1));
  const phase = index * 0.85;
  const amp1 = 5 + ((index * 7) % 5);
  const amp2 = 2.5 + ((index * 3) % 4) * 0.5;

  const points: string[] = [];
  for (let x = 0; x <= WIDTH; x += STEP) {
    const y =
      base +
      amp1 * Math.sin(x / 190 + phase) +
      amp2 * Math.sin(x / 71 + phase * 1.7);
    points.push(`${x} ${y.toFixed(2)}`);
  }
  return `M ${points.join(" L ")}`;
}

export function ContourBand({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className={`h-16 w-full text-contour sm:h-24 ${className}`}
    >
      {Array.from({ length: LINES }, (_, i) => (
        <path
          key={i}
          d={contourPath(i)}
          fill="none"
          stroke="currentColor"
          strokeWidth={i % 4 === 0 ? 1.4 : 0.7}
          // Index contours — every fourth line heavier and more opaque — is how
          // a real sheet lets you count elevation without reading every label.
          strokeOpacity={i % 4 === 0 ? 0.55 : 0.3}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

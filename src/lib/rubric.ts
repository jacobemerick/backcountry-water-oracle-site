/**
 * The scoring rubric — the site's most load-bearing piece of shared data.
 *
 * Every observation the engine correlates is one of these numbers, so this
 * table *is* the interface between what a hiker saw and what the model reads.
 * It mirrors `.claude/skills/water-forecast/SKILL.md` in the engine repo; the
 * two must not drift, because a corpus scored under two different rubrics is
 * worse than a smaller one scored consistently.
 *
 * The realisation behind this issue: on the web the fuzzy-scoring problem
 * disappears. The skill needs an LLM to map free text onto these anchors; a
 * dropdown *is* the rubric, and a person choosing their own score is more
 * consistent than a model inferring it, not less.
 */

export type RubricStep = {
  score: number;
  /** Short label for the option itself. */
  label: string;
  /** What it looks like in the field — the thing people actually match against. */
  detail: string;
};

export const RUBRIC: readonly RubricStep[] = [
  { score: 0.0, label: "Dry", detail: "No water at all — not even pools" },
  { score: 0.2, label: "Pools or dripping", detail: "Water present but not flowing; stagnant pools, a drip, a full spring box with no outflow" },
  { score: 0.4, label: "Trickle", detail: "Light but filterable — you can fill a bottle, slowly" },
  { score: 0.6, label: "Moderate", detail: "Steady flow, roughly a quart per minute" },
  { score: 0.8, label: "Strong", detail: "Roughly a gallon per minute" },
  { score: 1.0, label: "Raging", detail: "Gallon-plus, loud, no question about it" },
] as const;

/**
 * The single most important instruction on the form.
 *
 * Score what a hiker could *use*, not the state of the geological feature. A
 * seep whose face has stopped running but whose rock tanks are holding is
 * water in the pack, and the engine's whole value is predicting water in the
 * pack. Getting this backwards would encode a systematically different
 * quantity than the seed corpus was scored on.
 */
export const RUBRIC_GUIDANCE =
  "Score the water you could actually use. If the seep itself has stopped but the rock tanks below it are holding, that is water — score the tanks.";

export function isRubricScore(value: number): boolean {
  return RUBRIC.some((step) => Math.abs(step.score - value) < 1e-9);
}

/**
 * Nearest rubric step to an arbitrary score.
 *
 * The single place a continuous number becomes rubric language — used both for
 * rendering imported rows and, via `flowLabel`, for every predicted flow the
 * site shows.
 *
 * **Ties round down, toward less water.** A value sitting exactly between two
 * anchors is reported as the drier of them, because the cost of the two errors
 * is not symmetric: overstating a seep sends someone past it with an empty
 * bottle. The `<` rather than `<=` in the reduce below is what does it, and it
 * is deliberate.
 */
export function nearestStep(score: number): RubricStep {
  return RUBRIC.reduce((best, step) =>
    Math.abs(step.score - score) < Math.abs(best.score - score) ? step : best,
  );
}

/** The engine's precipitation record starts here; earlier reports cannot be correlated. */
export const PRECIP_RECORD_START = "2007-01-01";

/**
 * How far the ERA5 archive trails reality. Reports newer than this cannot be
 * correlated *yet* — they fold in on their own once the archive catches up,
 * which is a very different thing from being unusable.
 */
export const PRECIP_LAG_DAYS = 7;

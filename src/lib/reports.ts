import { PRECIP_LAG_DAYS, PRECIP_RECORD_START, isRubricScore } from "./rubric.ts";

/**
 * Validation for a submitted report, kept apart from both the HTTP layer and
 * the database so the rules are testable and stated once.
 */

export type ReportInput = {
  observedOn: string;
  score: number;
  status?: string | null;
};

export type ValidationResult =
  | { ok: true; value: { observedOn: string; score: number; status: string | null }; warnings: string[] }
  | { ok: false; error: string };

export const MAX_STATUS = 500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in UTC. The engine works in whole days, so timezone precision is noise. */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function validateReport(input: ReportInput, today = todayIso()): ValidationResult {
  const warnings: string[] = [];

  if (typeof input.observedOn !== "string" || !ISO_DATE.test(input.observedOn)) {
    return { ok: false, error: "Enter the date you saw the water, as YYYY-MM-DD." };
  }

  // Reject impossible dates that still match the pattern (2026-02-31).
  const parsed = new Date(`${input.observedOn}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.observedOn) {
    return { ok: false, error: `${input.observedOn} is not a real date.` };
  }

  // A CHECK constraint cannot reference current_date, so the future-date rule
  // has to live here. It matters: every correlation is against rainfall
  // antecedent to this date, and rainfall after today does not exist.
  if (input.observedOn > today) {
    return { ok: false, error: "That date is in the future. Report water you have already seen." };
  }

  if (typeof input.score !== "number" || !Number.isFinite(input.score)) {
    return { ok: false, error: "Choose how much water there was." };
  }
  if (input.score < 0 || input.score > 1) {
    return { ok: false, error: "Score must be between 0.0 and 1.0." };
  }
  // The form only offers the six anchors. Anything else is a client that has
  // drifted from the rubric, and silently accepting it would let a second,
  // undocumented scale into the corpus.
  if (!isRubricScore(input.score)) {
    return { ok: false, error: "Score must be one of the six rubric values." };
  }

  // Accepted, not rejected: the observation is real and worth keeping even
  // though this particular engine cannot use it. The engine now reports these
  // exclusions per source rather than dropping them silently, so saying so at
  // entry time keeps the two honest with each other.
  if (input.observedOn < PRECIP_RECORD_START) {
    warnings.push(
      `Recorded, but it predates the rainfall record (${PRECIP_RECORD_START}), so it cannot be correlated.`,
    );
  }

  // The opposite edge, and a much more common one: the rainfall archive trails
  // reality by about six days, so anything from this week cannot be correlated
  // *yet*. Saying so matters — the person reporting water they saw on Tuesday
  // is the most valuable contributor there is, and silently omitting their
  // report from the numbers looks like it was ignored.
  const daysAgo = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${input.observedOn}T00:00:00Z`)) / 86_400_000,
  );
  if (daysAgo >= 0 && daysAgo < PRECIP_LAG_DAYS) {
    warnings.push(
      "Recorded. The rainfall archive runs about a week behind, so this one joins the forecast in a few days.",
    );
  }

  const status = typeof input.status === "string" ? input.status.trim().slice(0, MAX_STATUS) : "";

  return {
    ok: true,
    value: { observedOn: input.observedOn, score: input.score, status: status || null },
    warnings,
  };
}

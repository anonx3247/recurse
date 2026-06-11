/**
 * Merge gate — the pure heart of the recursion (see ARCHITECTURE.md "Merge
 * gate"). A Change lands only if BOTH a review approves it AND its eval metrics
 * did not regress against the project baseline. These functions are pure and
 * heavily unit-tested; the {@link Kernel} merely composes them.
 */

import type { MetricSpec, Review, ReviewComment, ReviewVerdict } from "../core/types";

/** Outcome of comparing a change's new metrics against a baseline. */
export interface MetricComparison {
  /** Metric keys that moved in the wrong direction (per their spec). */
  regressed: string[];
  /** Metric keys that strictly improved. */
  improved: string[];
  /** True when no metric regressed and none improved (everything held equal). */
  equalOnly: boolean;
}

/**
 * Compare `next` metrics against `base` for every project {@link MetricSpec}.
 *
 * - A key absent from `base` (e.g. the first-ever measurement, or a newly added
 *   metric) counts as an improvement — there is nothing to regress against.
 * - A key missing from `next` counts as a regression (the change failed to
 *   measure a required metric).
 * - Otherwise the spec's `direction` decides: `maximize` improves when
 *   `next > base`; `minimize` improves when `next < base`.
 */
export function compareMetrics(
  specs: MetricSpec[],
  base: Record<string, number> | undefined,
  next: Record<string, number>,
): MetricComparison {
  const regressed: string[] = [];
  const improved: string[] = [];

  for (const spec of specs) {
    const nv = next[spec.key];
    if (nv === undefined) {
      regressed.push(spec.key);
      continue;
    }
    const bv = base?.[spec.key];
    if (bv === undefined) {
      improved.push(spec.key);
      continue;
    }
    const delta = spec.direction === "maximize" ? nv - bv : bv - nv;
    if (delta > 0) improved.push(spec.key);
    else if (delta < 0) regressed.push(spec.key);
  }

  return { regressed, improved, equalOnly: regressed.length === 0 && improved.length === 0 };
}

/**
 * The merge policy: how strict the metric portion of the gate is.
 *
 * Kept as a tiny, documented, swappable value so projects can tune how much
 * "progress" a change must show. The default requires no regression on any
 * metric AND a strict improvement on at least one — every landed change must
 * raise the bar.
 */
export interface GatePolicy {
  /**
   * When true, a change with no regressions may merge even if it only holds
   * metrics equal (no strict improvement). When false (default), at least one
   * metric must strictly improve.
   */
  allowEqual: boolean;
}

/** Default policy: require no regression and at least one strict improvement. */
export const defaultGatePolicy: GatePolicy = { allowEqual: false };

/**
 * Whether a review counts as approving the change for the gate: the verdict is
 * `approve` AND it carries no `blocker`-severity comments.
 */
export function isReviewApproved(review: {
  verdict: ReviewVerdict;
  comments: ReviewComment[];
}): boolean {
  return review.verdict === "approve" && !review.comments.some((c) => c.severity === "blocker");
}

/** Inputs to {@link evaluateGate}. */
export interface EvaluateGateInput {
  review: Pick<Review, "verdict" | "comments">;
  comparison: MetricComparison;
  policy?: GatePolicy;
}

/** The gate decision and a human-readable reason for the event log. */
export interface GateDecision {
  merge: boolean;
  reason: string;
}

/**
 * Decide whether a change merges: review approved AND metrics satisfy the
 * policy. Returns a `reason` string describing the deciding factor.
 */
export function evaluateGate({
  review,
  comparison,
  policy = defaultGatePolicy,
}: EvaluateGateInput): GateDecision {
  if (!isReviewApproved(review)) {
    return { merge: false, reason: `review not approved (verdict: ${review.verdict})` };
  }
  if (comparison.regressed.length > 0) {
    return { merge: false, reason: `metrics regressed: ${comparison.regressed.join(", ")}` };
  }
  if (!policy.allowEqual && comparison.improved.length === 0) {
    return { merge: false, reason: "no metric strictly improved" };
  }
  const detail =
    comparison.improved.length > 0
      ? `improved: ${comparison.improved.join(", ")}`
      : "metrics held equal";
  return { merge: true, reason: `approved and ${detail}` };
}

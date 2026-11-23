/**
 * Score lines shared by the judge and by admission (#1777).
 *
 * The judge's rubric calls 0.00-0.39 "broken — blank, black, garbled" and
 * 0.40-0.59 "poor". Admission used to ignore the score entirely, so a piece
 * the judge rated 0.02 for being black was accepted.
 *
 * Admission rejects only the broken band. A "poor" score is a matter of taste,
 * and the judge gets taste wrong: hy4f hydra-buffers-xhigh-r1 scored 0.58 and
 * is a piece the operator loves. So the judge's pass line (0.6) stays a
 * judge verdict, and admission's floor is the line under "broken".
 */
export const JUDGE_PASSING_THRESHOLD = 0.6;
export const ADMISSION_BROKEN_FLOOR = 0.4;

/** True when a judge score clears the floor. NaN and out-of-range scores never do. */
export function meetsQualityFloor(score: number, floor = ADMISSION_BROKEN_FLOOR): boolean {
  return Number.isFinite(score) && score >= floor && score <= 1;
}

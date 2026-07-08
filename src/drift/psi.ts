export interface PsiResult {
  psi: number;
  kl: number;
  baseProps: number[];
  currProps: number[];
}

export function psiFromCounts(
  baseCounts: number[],
  currentCounts: number[],
  epsilon = 1e-6,
): PsiResult {
  const length = Math.max(baseCounts.length, currentCounts.length);
  const baseTotal = baseCounts.reduce((sum, count) => sum + count, 0);
  const currentTotal = currentCounts.reduce((sum, count) => sum + count, 0);
  if (baseTotal === 0 || currentTotal === 0) {
    return {
      psi: 0,
      kl: 0,
      baseProps: new Array<number>(length).fill(0),
      currProps: new Array<number>(length).fill(0),
    };
  }
  const baseProps = Array.from({ length }, (_, index) => (baseCounts[index] ?? 0) / baseTotal);
  const currProps = Array.from({ length }, (_, index) => (currentCounts[index] ?? 0) / currentTotal);
  let psi = 0;
  let kl = 0;
  for (let index = 0; index < length; index += 1) {
    const base = Math.max(epsilon, baseProps[index]);
    const current = Math.max(epsilon, currProps[index]);
    psi += (current - base) * Math.log(current / base);
    kl += current * Math.log(current / base);
  }
  return { psi: Math.max(0, psi), kl: Math.max(0, kl), baseProps, currProps };
}

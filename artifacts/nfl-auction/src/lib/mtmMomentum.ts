const MOMENTUM_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function momentumBaselineNetPayout(
  history: Array<{ asOf: string; netPayout: number | null }>,
) {
  const points = history
    .map((point) => ({ ...point, timestamp: Date.parse(point.asOf) }))
    .filter(
      (point): point is typeof point & { netPayout: number } =>
        Number.isFinite(point.timestamp) && point.netPayout != null,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  if (points.length === 0) return null;

  const target = points[points.length - 1].timestamp - MOMENTUM_WINDOW_MS;
  const sevenDayBaseline = points.reduce((closest, point) => {
    const closestDistance = Math.abs(closest.timestamp - target);
    const pointDistance = Math.abs(point.timestamp - target);
    return pointDistance < closestDistance ? point : closest;
  });
  return sevenDayBaseline.netPayout;
}
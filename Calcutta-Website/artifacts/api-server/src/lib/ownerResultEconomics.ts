export type OwnerResultEconomics = {
  cost: number;
  realizedGross: number;
  net: number;
  mtmGross: number;
  mtmNet: number;
  ptsToBreakeven: number | null;
};

const money = (value: number) => Math.round(value * 100) / 100;

/** Calculates a signed owner position from the normalized ownership ledger. */
export function calculateOwnerResultEconomics(args: {
  effectiveShare: number;
  originalCostBasis: number;
  tradePaid: number;
  tradeReceived: number;
  realizedTeamGross: number;
  mtmTeamGross: number;
  dollarsPerPoint: number | null;
}): OwnerResultEconomics {
  const cost = args.originalCostBasis + args.tradePaid - args.tradeReceived;
  const realizedGross = args.realizedTeamGross * args.effectiveShare;
  const mtmGross = args.mtmTeamGross * args.effectiveShare;
  const net = realizedGross - cost;
  return {
    cost: money(cost),
    realizedGross: money(realizedGross),
    net: money(net),
    mtmGross: money(mtmGross),
    mtmNet: money(mtmGross - cost),
    ptsToBreakeven: args.dollarsPerPoint != null && args.dollarsPerPoint > 0
      ? Math.round(net / args.dollarsPerPoint)
      : null,
  };
}
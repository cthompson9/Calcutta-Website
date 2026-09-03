export type AuctionResultRow = {
  teamId: number;
  teamName: string;
  bidAmount: string;
  winnerName: string;
  draftOrder: number | null;
};

export function buildAuctionResults(rows: AuctionResultRow[]) {
  const byTeam = new Map<
    number,
    {
      teamId: number;
      teamName: string;
      bidAmount: number;
      draftOrder: number | null;
      winnerNames: string[];
    }
  >();

  for (const row of rows) {
    const existing = byTeam.get(row.teamId);
    if (existing) {
      if (!existing.winnerNames.includes(row.winnerName)) {
        existing.winnerNames.push(row.winnerName);
      }
      continue;
    }

    byTeam.set(row.teamId, {
      teamId: row.teamId,
      teamName: row.teamName,
      bidAmount: Math.round(parseFloat(row.bidAmount) * 100) / 100,
      draftOrder: row.draftOrder,
      winnerNames: [row.winnerName],
    });
  }

  return Array.from(byTeam.values())
    .map(({ winnerNames, ...result }) => ({
      ...result,
      winnerName: winnerNames.sort((a, b) => a.localeCompare(b)).join(" / "),
    }))
    .sort(
      (a, b) =>
        (a.draftOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.draftOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.teamName.localeCompare(b.teamName),
    );
}
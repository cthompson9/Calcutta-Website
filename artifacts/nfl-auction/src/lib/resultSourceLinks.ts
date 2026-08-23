export type ResultSourceTarget = {
  seasonYear: number | null;
  teamId: number | null;
  tradeId: number | null;
};

function positiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseResultSourceTarget(location: string): ResultSourceTarget {
  const queryStart = location.indexOf("?");
  if (queryStart < 0) {
    return { seasonYear: null, teamId: null, tradeId: null };
  }

  const query = location.slice(queryStart + 1).split("#", 1)[0];
  const params = new URLSearchParams(query);
  return {
    seasonYear: positiveInteger(params.get("season")),
    teamId: positiveInteger(params.get("teamId")),
    tradeId: positiveInteger(params.get("tradeId")),
  };
}

export function auctionResultHref(seasonYear: number, teamId: number): string {
  const params = new URLSearchParams({
    season: String(seasonYear),
    teamId: String(teamId),
  });
  return `/dashboard?${params.toString()}`;
}

export function tradeHref(seasonYear: number, tradeId: number): string {
  const params = new URLSearchParams({
    season: String(seasonYear),
    tradeId: String(tradeId),
  });
  return `/trades?${params.toString()}`;
}
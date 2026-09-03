import {
  getKalshiSeasonContracts,
  marketQuoteFromTopOfBook,
  type MarketQuote,
  type MarketQuoteKind,
  type TeamMarketSnapshot,
} from "./weekZeroValuation";

const KALSHI_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";

const TEAM_TICKER_BY_NAME: Record<string, string> = {
  "Arizona Cardinals": "ARI",
  "Atlanta Falcons": "ATL",
  "Baltimore Ravens": "BAL",
  "Buffalo Bills": "BUF",
  "Carolina Panthers": "CAR",
  "Chicago Bears": "CHI",
  "Cincinnati Bengals": "CIN",
  "Cleveland Browns": "CLE",
  "Dallas Cowboys": "DAL",
  "Denver Broncos": "DEN",
  "Detroit Lions": "DET",
  "Green Bay Packers": "GB",
  "Houston Texans": "HOU",
  "Indianapolis Colts": "IND",
  "Jacksonville Jaguars": "JAC",
  "Kansas City Chiefs": "KC",
  "Las Vegas Raiders": "LV",
  "Los Angeles Chargers": "LAC",
  "Los Angeles Rams": "LAR",
  "Miami Dolphins": "MIA",
  "Minnesota Vikings": "MIN",
  "New England Patriots": "NE",
  "New Orleans Saints": "NO",
  "New York Giants": "NYG",
  "New York Jets": "NYJ",
  "Philadelphia Eagles": "PHI",
  "Pittsburgh Steelers": "PIT",
  "San Francisco 49ers": "SF",
  "Seattle Seahawks": "SEA",
  "Tampa Bay Buccaneers": "TB",
  "Tennessee Titans": "TEN",
  "Washington Commanders": "WAS",
};

interface KalshiMarket {
  ticker: string;
  floor_strike?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  yes_bid_size_fp?: string;
  yes_ask_size_fp?: string;
  updated_time?: string;
}

interface KalshiEventResponse {
  event?: {
    markets?: KalshiMarket[];
  };
}

function parseDecimal(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchKalshiEvent(eventTicker: string): Promise<KalshiMarket[]> {
  const url = `${KALSHI_BASE_URL}/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "NFL-Auction-Manager/1.0",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Kalshi event ${eventTicker} returned ${response.status} ${response.statusText}.`,
    );
  }

  const payload = (await response.json()) as KalshiEventResponse;
  return payload.event?.markets ?? [];
}

function toQuote(
  market: KalshiMarket | undefined,
  kind: MarketQuoteKind,
  line: number | null = null,
): MarketQuote | null {
  if (!market) return null;
  return marketQuoteFromTopOfBook({
    ticker: market.ticker,
    kind,
    line,
    bid: parseDecimal(market.yes_bid_dollars),
    ask: parseDecimal(market.yes_ask_dollars),
    last: parseDecimal(market.last_price_dollars),
    bidDepth: parseDecimal(market.yes_bid_size_fp),
    askDepth: parseDecimal(market.yes_ask_size_fp),
    updatedAt: market.updated_time ?? null,
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      output[currentIndex] = await mapper(values[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return output;
}

export async function captureKalshiWeekZero(input: {
  seasonYear: number;
  teams: Array<{ id: number; name: string; conference: string }>;
}): Promise<TeamMarketSnapshot[]> {
  const contracts = getKalshiSeasonContracts(input.seasonYear);

  const [playoffMarkets, afcMarkets, nfcMarkets, championshipMarkets] =
    await Promise.all([
      fetchKalshiEvent(contracts.playoffEvent),
      fetchKalshiEvent(contracts.afcChampionEvent),
      fetchKalshiEvent(contracts.nfcChampionEvent),
      fetchKalshiEvent(contracts.championshipEvent),
    ]);

  return mapWithConcurrency(input.teams, 6, async (team) => {
    const teamTicker = TEAM_TICKER_BY_NAME[team.name];
    if (!teamTicker) {
      throw new Error(`No Kalshi team mapping is configured for ${team.name}.`);
    }

    const winMarkets = await fetchKalshiEvent(
      `${contracts.winsEventPrefix}${teamTicker}`,
    );
    const findTeamMarket = (markets: KalshiMarket[]) =>
      markets.find((market) => market.ticker.endsWith(`-${teamTicker}`));

    return {
      teamId: team.id,
      teamName: team.name,
      conference: team.conference,
      contractSetId: contracts.contractSetId,
      winThresholds: winMarkets
        .filter((market) => market.floor_strike != null)
        .sort((a, b) => (a.floor_strike ?? 0) - (b.floor_strike ?? 0))
        .map((market) =>
          toQuote(
            market,
            "win_threshold",
            (market.floor_strike ?? 0) - 0.5,
          ),
        )
        .filter((quote): quote is MarketQuote => quote != null),
      playoff: toQuote(
        findTeamMarket(playoffMarkets),
        "playoff",
      ),
      conferenceChampion: toQuote(
        findTeamMarket(team.conference === "AFC" ? afcMarkets : nfcMarkets),
        "conference_champion",
      ),
      championship: toQuote(
        findTeamMarket(championshipMarkets),
        "championship",
      ),
    };
  });
}
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useGetSeasons } from "@workspace/api-client-react";

const STORAGE_KEY = "nfl-auction-season";
const DEFAULT_YEAR = 2026;

type Season = {
  id: number;
  year: number;
  isActive: boolean;
  isComplete: boolean;
  label: string;
};

type SeasonContextValue = {
  year: number;
  setYear: (year: number) => void;
  seasons: Season[];
  selectedSeason: Season | null;
  isLoading: boolean;
};

const SeasonContext = createContext<SeasonContextValue | null>(null);

function getStoredYear(): number | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function SeasonProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useGetSeasons();
  const seasons = (data ?? []) as Season[];
  const [selectedYear, setSelectedYear] = useState<number | null>(getStoredYear);

  const fallbackYear =
    seasons.find((season) => season.isActive)?.year ??
    seasons.at(-1)?.year ??
    DEFAULT_YEAR;
  const year =
    selectedYear != null && (seasons.length === 0 || seasons.some((season) => season.year === selectedYear))
      ? selectedYear
      : fallbackYear;

  useEffect(() => {
    if (seasons.length > 0 && selectedYear != null && !seasons.some((season) => season.year === selectedYear)) {
      setSelectedYear(fallbackYear);
    }
  }, [fallbackYear, seasons, selectedYear]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, year.toString());
    } catch {}
  }, [year]);

  const value = useMemo<SeasonContextValue>(
    () => ({
      year,
      setYear: setSelectedYear,
      seasons,
      selectedSeason: seasons.find((season) => season.year === year) ?? null,
      isLoading,
    }),
    [isLoading, seasons, year],
  );

  return createElement(SeasonContext.Provider, { value }, children);
}

export function useSeason() {
  const context = useContext(SeasonContext);
  if (!context) {
    throw new Error("useSeason must be used within a SeasonProvider");
  }
  return context;
}

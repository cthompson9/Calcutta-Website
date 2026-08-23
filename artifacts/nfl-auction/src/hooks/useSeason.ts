import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useCallback,
  useState,
  type ReactNode,
} from "react";
import {
  useGetCalcuttas,
  type CalcuttaOption,
} from "@workspace/api-client-react";

const STORAGE_KEY = "nfl-auction-calcutta";
const LEGACY_STORAGE_KEY = "nfl-auction-season";
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
  calcuttas: CalcuttaOption[];
  selectedCalcutta: CalcuttaOption | null;
  selectedSeason: Season | null;
  setCalcutta: (id: number) => void;
  isLoading: boolean;
};

const SeasonContext = createContext<SeasonContextValue | null>(null);

function getStoredSelection(): { id: number | null; year: number | null } {
  try {
    const storedId = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10);
    const storedYear = Number.parseInt(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "", 10);
    return {
      id: Number.isFinite(storedId) ? storedId : null,
      year: Number.isFinite(storedYear) ? storedYear : null,
    };
  } catch {
    return { id: null, year: null };
  }
}

export function SeasonProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useGetCalcuttas();
  const calcuttas = data ?? [];
  const [storedSelection] = useState(getStoredSelection);
  const [selectedCalcuttaId, setSelectedCalcuttaId] = useState<number | null>(
    storedSelection.id,
  );

  const selectedCalcutta =
    calcuttas.find((calcutta) => calcutta.id === selectedCalcuttaId) ??
    calcuttas.find((calcutta) => calcutta.year === storedSelection.year) ??
    calcuttas[0] ??
    null;
  const year = selectedCalcutta?.year ?? storedSelection.year ?? DEFAULT_YEAR;

  useEffect(() => {
    if (calcuttas.length > 0 && selectedCalcutta && selectedCalcutta.id !== selectedCalcuttaId) {
      setSelectedCalcuttaId(selectedCalcutta.id);
    }
  }, [calcuttas, selectedCalcutta, selectedCalcuttaId]);

  useEffect(() => {
    try {
      if (selectedCalcutta) {
        localStorage.setItem(STORAGE_KEY, selectedCalcutta.id.toString());
      }
    } catch {}
  }, [selectedCalcutta]);

  const setCalcutta = useCallback((id: number) => {
    setSelectedCalcuttaId(id);
  }, []);

  const setYear = useCallback(
    (nextYear: number) => {
      const calcutta = calcuttas.find((candidate) => candidate.year === nextYear);
      setSelectedCalcuttaId(calcutta?.id ?? null);
    },
    [calcuttas],
  );

  const value = useMemo<SeasonContextValue>(
    () => ({
      year,
      setYear,
      calcuttas,
      selectedCalcutta,
      selectedSeason: selectedCalcutta
        ? {
            id: selectedCalcutta.seasonId,
            year: selectedCalcutta.year,
            isActive: selectedCalcutta.isActive,
            isComplete: selectedCalcutta.isComplete,
            label: `${selectedCalcutta.year} Season`,
          }
        : null,
      setCalcutta,
      isLoading,
    }),
    [calcuttas, isLoading, selectedCalcutta, setCalcutta, setYear, year],
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

export function formatCalcuttaLabel(
  calcutta: Pick<CalcuttaOption, "name" | "sport" | "year">,
): string {
  return `${calcutta.name} - ${calcutta.sport} ${calcutta.year}`;
}

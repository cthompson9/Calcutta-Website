import { useState, useEffect } from "react";

const STORAGE_KEY = "nfl-auction-season";
const DEFAULT_YEAR = 2026;

export function useSeason() {
  const [year, setYear] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? parseInt(stored, 10) : DEFAULT_YEAR;
    } catch {
      return DEFAULT_YEAR;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, year.toString());
    } catch {}
  }, [year]);

  return { year, setYear };
}

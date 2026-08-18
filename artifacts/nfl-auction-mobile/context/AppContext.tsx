import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const SEASON_KEY = 'nfl-auction.season';
const ADMIN_KEY = 'nfl-auction.adminKey';

// The admin key is a bearer credential. On iOS/Android it lives in the
// platform secure enclave (Keychain / Keystore via SecureStore). On web
// there is no secure storage, so it is deliberately kept in memory only
// and must be re-entered after a page reload.
const canPersistAdminKey = Platform.OS !== 'web';

interface AppContextValue {
  season: number;
  setSeason: (year: number) => void;
  adminKey: string | null;
  setAdminKey: (key: string | null) => void;
  hydrated: boolean;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [season, setSeasonState] = useState<number>(2025);
  const [adminKey, setAdminKeyState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      try {
        const [storedSeason, storedKey] = await Promise.all([
          AsyncStorage.getItem(SEASON_KEY),
          canPersistAdminKey ? SecureStore.getItemAsync(ADMIN_KEY) : Promise.resolve(null),
        ]);
        if (storedSeason) {
          const y = parseInt(storedSeason, 10);
          if (!isNaN(y)) setSeasonState(y);
        }
        if (storedKey) setAdminKeyState(storedKey);
      } catch {
        // ignore hydration errors — defaults are fine
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  const setSeason = useCallback((year: number) => {
    setSeasonState(year);
    AsyncStorage.setItem(SEASON_KEY, String(year)).catch(() => {});
  }, []);

  const setAdminKey = useCallback((key: string | null) => {
    setAdminKeyState(key);
    if (!canPersistAdminKey) return; // web: memory-only, nothing persisted
    if (key) {
      SecureStore.setItemAsync(ADMIN_KEY, key).catch(() => {});
    } else {
      SecureStore.deleteItemAsync(ADMIN_KEY).catch(() => {});
    }
  }, []);

  const value = useMemo(
    () => ({ season, setSeason, adminKey, setAdminKey, hydrated }),
    [season, setSeason, adminKey, setAdminKey, hydrated],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

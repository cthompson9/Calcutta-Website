import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';

// ── Screen header with season toggle ────────────────────────────────────────

export function ScreenHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: topInset + 16,
          backgroundColor: colors.card,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <View style={styles.headerRow}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={[styles.headerCBox, { backgroundColor: colors.primary }]}>
            <Text style={[styles.headerCBoxText, { color: colors.primaryForeground }]}>C</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text
                style={[styles.headerSubtitle, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>
        {right}
      </View>
    </View>
  );
}

// ── Season toggle (2025 / 2026) ──────────────────────────────────────────────

const SEASONS = [2025, 2026];

export function SeasonToggle({
  onSeasonChange,
}: {
  onSeasonChange?: (season: number) => void;
} = {}) {
  const colors = useColors();
  const { season, setSeason } = useApp();

  return (
    <View style={[styles.seasonWrap, { borderColor: colors.border, backgroundColor: colors.muted }]}>
      {SEASONS.map((year) => {
        const active = season === year;
        return (
          <Pressable
            key={year}
            testID={`season-${year}`}
            onPress={() => {
              if (!active) {
                Haptics.selectionAsync();
                if (onSeasonChange) onSeasonChange(year);
                else setSeason(year);
              }
            }}
            style={[
              styles.seasonBtn,
              active && { backgroundColor: colors.primary },
            ]}
          >
            <Text
              style={[
                styles.seasonText,
                { color: active ? colors.primaryForeground : colors.mutedForeground },
              ]}
            >
              {year}{year === 2026 && active ? ' •' : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Segmented control ────────────────────────────────────────────────────────

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const colors = useColors();
  return (
    <View style={[styles.segmentWrap, { backgroundColor: colors.muted }]}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            testID={`segment-${opt.value}`}
            onPress={() => {
              if (!active) {
                Haptics.selectionAsync();
                onChange(opt.value);
              }
            }}
            style={[
              styles.segmentBtn,
              active && {
                backgroundColor: colors.background,
                borderColor: colors.border,
                borderWidth: StyleSheet.hairlineWidth,
              },
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                {
                  color: active ? colors.foreground : colors.mutedForeground,
                  fontFamily: active ? 'JetBrainsMono_700Bold' : 'JetBrainsMono_500Medium',
                },
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string }) {
  const colors = useColors();
  const config: Record<string, { label: string; color: string; bg: string }> = {
    pending: { label: 'PENDING', color: colors.warning, bg: `${colors.warning}1A` },
    approved: { label: 'APPROVED', color: colors.success, bg: `${colors.success}1A` },
    rejected: { label: 'REJECTED', color: colors.destructive, bg: `${colors.destructive}1A` },
  };
  const c = config[status] ?? config['pending'];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.color }]}>{c.label}</Text>
    </View>
  );
}

// ── Conference chip ──────────────────────────────────────────────────────────

export function ConferenceChip({ conference }: { conference: string }) {
  const colors = useColors();
  const color = conference === 'AFC' ? colors.afc : colors.nfc;
  return (
    <View style={[styles.badge, { backgroundColor: `${color}1A` }]}>
      <Text style={[styles.badgeText, { color }]}>{conference}</Text>
    </View>
  );
}

// ── Results source return ────────────────────────────────────────────────────

export function ResultsBacklink({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.backlink,
        { backgroundColor: `${colors.primary}12`, borderColor: `${colors.primary}55` },
      ]}
    >
      <Feather name="corner-up-left" size={15} color={colors.primary} />
      <Text style={[styles.backlinkText, { color: colors.foreground }]}>
        Viewing a source record from Results
      </Text>
      <Pressable
        testID="back-to-results"
        onPress={() => {
          Haptics.selectionAsync();
          onPress();
        }}
        style={({ pressed }) => [
          styles.backlinkButton,
          { backgroundColor: colors.primary, opacity: pressed ? 0.72 : 1 },
        ]}
      >
        <Text style={[styles.backlinkButtonText, { color: colors.primaryForeground }]}>
          Back to Results
        </Text>
      </Pressable>
    </View>
  );
}

// ── States ───────────────────────────────────────────────────────────────────

export function LoadingState() {
  const colors = useColors();
  return (
    <View style={styles.stateWrap}>
      <ActivityIndicator size="large" color={colors.mutedForeground} />
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.stateWrap}>
      <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
      <Text style={[styles.stateText, { color: colors.mutedForeground }]}>
        {message ?? "Couldn't load data. Check your connection."}
      </Text>
      <Pressable
        testID="retry-button"
        onPress={onRetry}
        style={({ pressed }) => [
          styles.retryBtn,
          { backgroundColor: colors.primary, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Text style={[styles.retryText, { color: colors.primaryForeground }]}>
          Retry
        </Text>
      </Pressable>
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle?: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.stateWrap}>
      <Feather name={icon} size={32} color={colors.mutedForeground} />
      <Text style={[styles.stateTitle, { color: colors.foreground }]}>{title.toUpperCase()}</Text>
      {subtitle ? (
        <Text style={[styles.stateText, { color: colors.mutedForeground }]}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerCBox: {
    width: 32,
    height: 32,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCBoxText: {
    fontFamily: 'Archivo_900Black',
    fontSize: 18,
    lineHeight: 20,
    marginTop: 2,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: 'Archivo_900Black',
    letterSpacing: -0.5,
    textTransform: 'uppercase',
  },
  headerSubtitle: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginTop: 2,
  },
  seasonWrap: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 999,
    padding: 2,
  },
  seasonBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  seasonText: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono_500Medium',
    letterSpacing: 1.2,
  },
  segmentWrap: {
    flexDirection: 'row',
    padding: 3,
  },
  segmentBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  segmentText: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 2,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono_700Bold',
    letterSpacing: 0.8,
  },
  backlink: {
    borderWidth: 1,
    marginHorizontal: 16,
    marginTop: 10,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backlinkText: {
    flex: 1,
    fontSize: 10,
    fontFamily: 'JetBrainsMono_500Medium',
    lineHeight: 14,
  },
  backlinkButton: {
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  backlinkButtonText: {
    fontSize: 9,
    fontFamily: 'JetBrainsMono_700Bold',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  stateWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 32,
    minHeight: 240,
  },
  stateTitle: {
    fontSize: 18,
    fontFamily: 'Archivo_900Black',
    letterSpacing: 0.5,
  },
  stateText: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 2,
  },
  retryText: {
    fontSize: 14,
    fontFamily: 'JetBrainsMono_700Bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});
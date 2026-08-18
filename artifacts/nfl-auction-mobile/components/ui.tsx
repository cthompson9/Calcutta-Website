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
          paddingTop: topInset + 12,
          backgroundColor: colors.background,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={[styles.headerSubtitle, { color: colors.mutedForeground }]}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
    </View>
  );
}

// ── Season toggle (2025 / 2026) ──────────────────────────────────────────────

const SEASONS = [2025, 2026];

export function SeasonToggle() {
  const colors = useColors();
  const { season, setSeason } = useApp();

  return (
    <View style={[styles.seasonWrap, { borderColor: colors.border }]}>
      {SEASONS.map((year) => {
        const active = season === year;
        return (
          <Pressable
            key={year}
            testID={`season-${year}`}
            onPress={() => {
              if (!active) {
                Haptics.selectionAsync();
                setSeason(year);
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
              {year}
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
                  fontFamily: active ? 'Inter_600SemiBold' : 'Inter_500Medium',
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
      <Text style={[styles.stateTitle, { color: colors.foreground }]}>{title}</Text>
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
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    fontSize: 24,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  seasonWrap: {
    flexDirection: 'row',
    borderWidth: 1,
  },
  seasonBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  seasonText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
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
    fontSize: 13,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.8,
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
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  stateText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 6,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryText: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
});

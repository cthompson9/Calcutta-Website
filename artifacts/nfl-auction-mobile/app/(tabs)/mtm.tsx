import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useGetMtmSnapshots, type MtmWeekData } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ScreenHeader,
  SeasonToggle,
  SegmentedControl,
} from '@/components/ui';
import { fmtMoney } from '@/lib/format';

type ViewTab = 'owners' | 'teams';
type MarketStatus = 'live' | 'stale' | 'incomplete' | 'manual';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

// ── Week selector pill ────────────────────────────────────────────────────────

function WeekPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={[
        styles.weekPill,
        {
          backgroundColor: active ? colors.foreground : colors.card,
          borderColor: active ? colors.foreground : colors.border,
        },
      ]}
    >
      <Text
        style={[
          styles.weekPillText,
          { color: active ? colors.background : colors.foreground },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── Market status badge ───────────────────────────────────────────────────────

function StatusDot({ status }: { status: MarketStatus }) {
  const colors = useColors();
  const dotColor =
    status === 'live'
      ? colors.success
      : status === 'stale'
      ? colors.warning
      : status === 'incomplete'
      ? colors.destructive
      : colors.mutedForeground;
  const label =
    status === 'live' ? 'LIVE' : status === 'stale' ? 'STALE' : status === 'incomplete' ? 'INCOMPLETE' : 'MANUAL';

  return (
    <View style={styles.statusRow}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={[styles.statusLabel, { color: dotColor }]}>{label}</Text>
    </View>
  );
}

// ── Owner row ─────────────────────────────────────────────────────────────────

function OwnerRow({
  owner,
  rank,
}: {
  owner: { bidderName: string; mtmTotal: number };
  rank: number;
}) {
  const colors = useColors();
  const isTop = rank === 1;
  return (
    <View
      style={[
        styles.ownerRow,
        {
          borderBottomColor: colors.border,
          backgroundColor: isTop ? colors.gold + '18' : 'transparent',
        },
      ]}
    >
      <View style={[styles.rankBox, isTop && { backgroundColor: colors.gold }]}>
        <Text style={[styles.rankText, { color: isTop ? '#171717' : colors.mutedForeground }]}>
          {rank}
        </Text>
      </View>
      <Text style={[styles.ownerName, { color: colors.foreground }]} numberOfLines={1}>
        {owner.bidderName}
      </Text>
      <Text style={[styles.ownerValue, { color: colors.foreground }]}>
        {fmtMoney(owner.mtmTotal)}
      </Text>
    </View>
  );
}

// ── Team card ─────────────────────────────────────────────────────────────────

function TeamCard({ team }: { team: MtmWeekData['teamValues'][number] }) {
  const colors = useColors();
  const status = (
    team.marketStatus === 'live' ||
    team.marketStatus === 'stale' ||
    team.marketStatus === 'incomplete'
      ? team.marketStatus
      : 'manual'
  ) as MarketStatus;

  return (
    <View style={[styles.teamCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.teamCardTop}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.teamName, { color: colors.foreground }]} numberOfLines={1}>
            {team.teamName}
          </Text>
          <Text style={[styles.teamOwner, { color: colors.mutedForeground }]} numberOfLines={1}>
            {team.ownerName || '—'}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <Text style={[styles.teamValue, { color: colors.foreground }]}>
            {fmtMoney(team.mtmValue)}
          </Text>
          <StatusDot status={status} />
        </View>
      </View>

      {(team.expectedWins != null || team.playoffProbability != null) && (
        <View style={[styles.teamStats, { borderTopColor: colors.border }]}>
          {team.expectedWins != null && (
            <View style={styles.teamStat}>
              <Text style={[styles.teamStatLabel, { color: colors.mutedForeground }]}>E[W]</Text>
              <Text style={[styles.teamStatValue, { color: colors.foreground }]}>
                {team.expectedWins.toFixed(1)}
              </Text>
            </View>
          )}
          {team.playoffProbability != null && (
            <View style={styles.teamStat}>
              <Text style={[styles.teamStatLabel, { color: colors.mutedForeground }]}>PO%</Text>
              <Text style={[styles.teamStatValue, { color: colors.foreground }]}>
                {fmtPct(team.playoffProbability)}
              </Text>
            </View>
          )}
          {team.superBowlProbability != null && (
            <View style={styles.teamStat}>
              <Text style={[styles.teamStatLabel, { color: colors.mutedForeground }]}>SB%</Text>
              <Text style={[styles.teamStatValue, { color: colors.foreground }]}>
                {fmtPct(team.superBowlProbability)}
              </Text>
            </View>
          )}
          {team.normalizedShare != null && (
            <View style={styles.teamStat}>
              <Text style={[styles.teamStatLabel, { color: colors.mutedForeground }]}>SHARE</Text>
              <Text style={[styles.teamStatValue, { color: colors.foreground }]}>
                {fmtPct(team.normalizedShare)}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ── Week summary header ───────────────────────────────────────────────────────

function WeekSummary({ week }: { week: MtmWeekData }) {
  const colors = useColors();
  const live = week.marketStatusCounts?.live ?? 0;
  const stale = week.marketStatusCounts?.stale ?? 0;
  const incomplete = week.marketStatusCounts?.incomplete ?? 0;
  const manual = week.marketStatusCounts?.manual ?? 0;
  const hasKalshi = week.source === 'kalshi';

  return (
    <View style={[styles.weekSummary, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.weekSummaryRow}>
        <Text style={[styles.weekSummaryLabel, { color: colors.mutedForeground }]}>POT</Text>
        <Text style={[styles.weekSummaryValue, { color: colors.foreground }]}>
          {fmtMoney(week.potSize)}
        </Text>
      </View>
      {hasKalshi && (
        <View style={[styles.weekSummaryRow, { borderTopColor: colors.border }]}>
          <Text style={[styles.weekSummaryLabel, { color: colors.mutedForeground }]}>MARKET</Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            {live > 0 && (
              <Text style={[styles.weekBadge, { color: colors.success }]}>{live}L</Text>
            )}
            {stale > 0 && (
              <Text style={[styles.weekBadge, { color: colors.warning }]}>{stale}S</Text>
            )}
            {incomplete > 0 && (
              <Text style={[styles.weekBadge, { color: colors.destructive }]}>{incomplete}I</Text>
            )}
            {manual > 0 && (
              <Text style={[styles.weekBadge, { color: colors.mutedForeground }]}>{manual}M</Text>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function MtmScreen() {
  const colors = useColors();
  const { season } = useApp();
  const { data, isLoading, error, refetch, isRefetching } = useGetMtmSnapshots({ season });

  const weeks = data?.weeks ?? [];
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [tab, setTab] = useState<ViewTab>('owners');

  const activeWeek = useMemo<MtmWeekData | null>(() => {
    if (!weeks.length) return null;
    const date = selectedDate ?? weeks[weeks.length - 1]?.snapshotDate;
    return weeks.find((w) => w.snapshotDate === date) ?? weeks[weeks.length - 1] ?? null;
  }, [weeks, selectedDate]);

  const listBottomPad = Platform.OS === 'web' ? 84 + 16 : 100;

  const teamsSorted = useMemo(() => {
    if (!activeWeek) return [];
    return [...activeWeek.teamValues].sort((a, b) => b.mtmValue - a.mtmValue);
  }, [activeWeek]);

  const ownersSorted = useMemo(() => {
    if (!activeWeek) return [];
    return [...activeWeek.ownerTotals].sort((a, b) => b.mtmTotal - a.mtmTotal);
  }, [activeWeek]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="M2M"
        subtitle={`Mark-to-Market · ${season}`}
        right={<SeasonToggle />}
      />

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !weeks.length ? (
        <EmptyState
          icon="trending-up"
          title="No M2M data yet"
          subtitle={`No mark-to-market snapshots recorded for the ${season} season.`}
        />
      ) : (
        <>
          {/* Week selector */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.weekScroll}
            style={[styles.weekScrollWrap, { borderBottomColor: colors.border }]}
          >
            {weeks.map((w) => (
              <WeekPill
                key={w.snapshotDate}
                label={w.label ?? w.snapshotDate}
                active={(selectedDate ?? weeks[weeks.length - 1]?.snapshotDate) === w.snapshotDate}
                onPress={() => setSelectedDate(w.snapshotDate)}
              />
            ))}
          </ScrollView>

          {activeWeek && <WeekSummary week={activeWeek} />}

          {/* Owner / Team toggle */}
          <View style={styles.segmentContainer}>
            <SegmentedControl<ViewTab>
              options={[
                { label: 'By Owner', value: 'owners' },
                { label: 'By Team', value: 'teams' },
              ]}
              value={tab}
              onChange={setTab}
            />
          </View>

          {tab === 'owners' ? (
            <FlatList
              data={ownersSorted}
              keyExtractor={(item) => item.bidderName}
              renderItem={({ item, index }) => (
                <OwnerRow owner={item} rank={index + 1} />
              )}
              contentContainerStyle={[
                styles.listContent,
                { paddingBottom: listBottomPad },
              ]}
              scrollEnabled={ownersSorted.length > 0}
              refreshControl={
                <RefreshControl
                  refreshing={isRefetching}
                  onRefresh={() => refetch()}
                  tintColor={colors.mutedForeground}
                />
              }
              ListEmptyComponent={
                <EmptyState
                  icon="users"
                  title="No owner totals"
                  subtitle="No owners assigned for this snapshot."
                />
              }
            />
          ) : (
            <FlatList
              data={teamsSorted}
              keyExtractor={(item) => String(item.teamId)}
              renderItem={({ item }) => <TeamCard team={item} />}
              contentContainerStyle={[
                styles.listContent,
                { paddingBottom: listBottomPad },
              ]}
              scrollEnabled={teamsSorted.length > 0}
              refreshControl={
                <RefreshControl
                  refreshing={isRefetching}
                  onRefresh={() => refetch()}
                  tintColor={colors.mutedForeground}
                />
              }
              ListEmptyComponent={
                <EmptyState
                  icon="shield"
                  title="No team values"
                  subtitle="No team values for this snapshot."
                />
              }
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  weekScrollWrap: {
    maxHeight: 48,
    borderBottomWidth: 1,
  },
  weekScroll: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 6,
    alignItems: 'center',
  },
  weekPill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderWidth: 1,
    borderRadius: 2,
  },
  weekPillText: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono_500Medium',
    letterSpacing: 0.5,
  },
  weekSummary: {
    marginHorizontal: 16,
    marginTop: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  weekSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    borderTopWidth: 0,
  },
  weekSummaryLabel: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono_500Medium',
    letterSpacing: 0.8,
  },
  weekSummaryValue: {
    fontSize: 18,
    fontFamily: 'Archivo_900Black',
  },
  weekBadge: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono_700Bold',
    letterSpacing: 0.5,
  },
  segmentContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  listContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  // Owner row
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  rankBox: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rankText: {
    fontSize: 12,
    fontFamily: 'JetBrainsMono_700Bold',
  },
  ownerName: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Archivo_700Bold',
  },
  ownerValue: {
    fontSize: 16,
    fontFamily: 'Archivo_900Black',
    flexShrink: 0,
  },
  // Team card
  teamCard: {
    borderWidth: 1,
  },
  teamCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 10,
  },
  teamName: {
    fontSize: 16,
    fontFamily: 'Archivo_700Bold',
  },
  teamOwner: {
    fontSize: 12,
    fontFamily: 'JetBrainsMono_400Regular',
    marginTop: 2,
  },
  teamValue: {
    fontSize: 16,
    fontFamily: 'Archivo_900Black',
  },
  teamStats: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 0,
  },
  teamStat: {
    flex: 1,
    alignItems: 'center',
  },
  teamStatLabel: {
    fontSize: 9,
    fontFamily: 'JetBrainsMono_500Medium',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  teamStatValue: {
    fontSize: 14,
    fontFamily: 'Archivo_700Bold',
    marginTop: 3,
  },
  // Status
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusLabel: {
    fontSize: 9,
    fontFamily: 'JetBrainsMono_700Bold',
    letterSpacing: 0.6,
  },
});

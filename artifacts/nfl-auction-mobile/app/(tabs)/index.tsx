import React, { useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  useGetMtmSnapshots,
  useGetResults,
  useGetResultsByOwner,
  type MtmOwnerSeries,
  type OwnerResultRow,
  type TeamResultRow,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import {
  ConferenceChip,
  EmptyState,
  ErrorState,
  LoadingState,
  ScreenHeader,
  SeasonToggle,
  SegmentedControl,
} from '@/components/ui';
import { fmtMoney, fmtMoneySigned, fmtPct, fmtShare } from '@/lib/format';

type ViewMode = 'owner' | 'team';

// ── Sparkline ─────────────────────────────────────────────────────────────────

const SPARK_W = 64;
const SPARK_H = 24;

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * SPARK_W;
      // invert y: high value → small y (top of SVG)
      const y = SPARK_H - ((v - min) / range) * SPARK_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <Svg width={SPARK_W} height={SPARK_H}>
      <Polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// ── Owner card ───────────────────────────────────────────────────────────────

function OwnerCard({
  owner,
  rank,
  weeklyTotals,
}: {
  owner: OwnerResultRow;
  rank: number;
  weeklyTotals?: number[];
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState<boolean>(false);
  const mtmColor =
    owner.totalMtm - owner.totalCost >= 0 ? colors.success : colors.destructive;

  // Week-over-week delta: last two entries in weeklyTotals
  const wowDelta =
    weeklyTotals && weeklyTotals.length >= 2
      ? weeklyTotals[weeklyTotals.length - 1] - weeklyTotals[weeklyTotals.length - 2]
      : null;
  const wowColor =
    wowDelta === null ? colors.mutedForeground : wowDelta >= 0 ? colors.success : colors.destructive;
  const sparklineColor = wowDelta === null || wowDelta >= 0 ? colors.success : colors.destructive;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Pressable
        testID={`owner-card-${owner.bidderId}`}
        onPress={() => {
          Haptics.selectionAsync();
          setExpanded((e) => !e);
        }}
        style={({ pressed }) => [styles.cardBody, { opacity: pressed ? 0.85 : 1 }]}
      >
        <View style={styles.ownerTopRow}>
          <View style={[styles.rankBox, rank === 1 && { backgroundColor: colors.gold }]}>
            <Text
              style={[
                styles.rankText,
                { color: rank === 1 ? '#171717' : colors.mutedForeground },
              ]}
            >
              {rank}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.ownerName, { color: colors.foreground }]}>
              {owner.bidderName}
            </Text>
            <Text
              style={[
                styles.ownerConsortium,
                { color: owner.consortium ? colors.foreground : colors.mutedForeground },
              ]}
              numberOfLines={1}
            >
              {owner.consortium ? `Consortium · ${owner.consortium}` : 'Unassigned'}
            </Text>
            <Text style={[styles.ownerMeta, { color: colors.mutedForeground }]}>
              {owner.teamCount} {owner.teamCount === 1 ? 'team' : 'teams'} ·{' '}
              {fmtMoney(owner.totalCost)} invested
            </Text>
          </View>

          {/* MTM value + WoW trend */}
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <View style={styles.mtmRow}>
              {weeklyTotals && weeklyTotals.length >= 2 && (
                <Sparkline data={weeklyTotals} color={sparklineColor} />
              )}
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.mtmValue, { color: colors.foreground }]}>
                  {fmtMoney(owner.totalMtm)}
                </Text>
                <Text style={[styles.mtmDelta, { color: mtmColor }]}>
                  {fmtMoneySigned(owner.totalMtm - owner.totalCost)}
                </Text>
              </View>
            </View>
            {wowDelta !== null && (
              <View style={styles.wowRow}>
                <Feather
                  name={wowDelta >= 0 ? 'trending-up' : 'trending-down'}
                  size={11}
                  color={wowColor}
                />
                <Text style={[styles.wowText, { color: wowColor }]}>
                  {fmtMoneySigned(wowDelta)} WoW
                </Text>
              </View>
            )}
          </View>

          <Feather
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={colors.mutedForeground}
          />
        </View>

        <View style={[styles.statRow, { borderTopColor: colors.border }]}>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
              REALIZED
            </Text>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              {fmtMoney(owner.totalRealizedReturn)}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
              NET
            </Text>
            <Text
              style={[
                styles.statValue,
                {
                  color:
                    owner.totalNetReturn >= 0 ? colors.success : colors.destructive,
                },
              ]}
            >
              {fmtMoneySigned(owner.totalNetReturn)}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
              NET %
            </Text>
            <Text
              style={[
                styles.statValue,
                {
                  color:
                    owner.netPctReturn >= 0 ? colors.success : colors.destructive,
                },
              ]}
            >
              {fmtPct(owner.netPctReturn)}
            </Text>
          </View>
        </View>
      </Pressable>

      {expanded && (
        <View style={[styles.teamList, { borderTopColor: colors.border }]}>
          {owner.teams.map((t) => {
            const share = t.owners.find((o) => o.bidderId === owner.bidderId);
            return (
              <View key={t.teamId} style={styles.teamListRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.teamListName, { color: colors.foreground }]}>
                    {t.teamName}
                    {share && share.ownershipShare < 0.999 ? (
                      <Text style={{ color: colors.mutedForeground }}>
                        {'  '}
                        {fmtShare(share.ownershipShare)}
                      </Text>
                    ) : null}
                  </Text>
                  <Text style={[styles.teamListMeta, { color: colors.mutedForeground }]}>
                    {t.conference} {t.division} · {t.wins} W · cost {fmtMoney(t.cost)}
                  </Text>
                </View>
                <Text style={[styles.teamListMtm, { color: colors.foreground }]}>
                  {fmtMoney(t.markToMarket)}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ── Team row ─────────────────────────────────────────────────────────────────

function TeamCard({ team }: { team: TeamResultRow }) {
  const colors = useColors();
  const netColor = team.netReturn >= 0 ? colors.success : colors.destructive;
  const ownerNames = team.owners
    .map((o) =>
      o.ownershipShare < 0.999
        ? `${o.bidderName} (${fmtShare(o.ownershipShare)})`
        : o.bidderName,
    )
    .join(', ');

  return (
    <View
      style={[
        styles.card,
        styles.cardBody,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={styles.teamTopRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.ownerName, { color: colors.foreground }]}>
            {team.teamName}
          </Text>
          <Text style={[styles.ownerMeta, { color: colors.mutedForeground }]}>
            {ownerNames || 'Unowned'}
          </Text>
        </View>
        <ConferenceChip conference={team.conference} />
      </View>
      <View style={[styles.statRow, { borderTopColor: colors.border }]}>
        <View style={styles.stat}>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>COST</Text>
          <Text style={[styles.statValue, { color: colors.foreground }]}>
            {fmtMoney(team.cost)}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>WINS</Text>
          <Text style={[styles.statValue, { color: colors.foreground }]}>{team.wins}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>MTM</Text>
          <Text style={[styles.statValue, { color: colors.foreground }]}>
            {fmtMoney(team.markToMarket)}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>NET</Text>
          <Text style={[styles.statValue, { color: netColor }]}>
            {fmtMoneySigned(team.netReturn)}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function StandingsScreen() {
  const colors = useColors();
  const { season } = useApp();
  const [mode, setMode] = useState<ViewMode>('owner');

  const ownerQuery = useGetResultsByOwner({ season });
  const teamQuery = useGetResults({ season });
  const mtmQuery = useGetMtmSnapshots({ season });

  // Build bidderName → weeklyTotals lookup from MTM snapshot data
  const mtmByName = React.useMemo<Record<string, number[]>>(() => {
    if (!mtmQuery.data?.owners) return {};
    return Object.fromEntries(
      mtmQuery.data.owners.map((o: MtmOwnerSeries) => [o.bidderName, o.weeklyTotals]),
    );
  }, [mtmQuery.data]);

  const active = mode === 'owner' ? ownerQuery : teamQuery;

  const listBottomPad = Platform.OS === 'web' ? 84 + 16 : 100;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Standings"
        subtitle={`Calcutta Returns · ${season}`}
        right={<SeasonToggle />}
      />
      <View style={styles.segmentContainer}>
        <SegmentedControl<ViewMode>
          options={[
            { label: 'By Owner', value: 'owner' },
            { label: 'By Team', value: 'team' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </View>

      {active.isLoading ? (
        <LoadingState />
      ) : active.error ? (
        <ErrorState onRetry={() => active.refetch()} />
      ) : mode === 'owner' ? (
        <FlatList
          data={ownerQuery.data ?? []}
          keyExtractor={(item) => String(item.bidderId)}
          renderItem={({ item, index }) => (
            <OwnerCard
              owner={item}
              rank={index + 1}
              weeklyTotals={mtmByName[item.bidderName]}
            />
          )}
          contentContainerStyle={[styles.listContent, { paddingBottom: listBottomPad }]}
          scrollEnabled={(ownerQuery.data ?? []).length > 0}
          refreshControl={
            <RefreshControl
              refreshing={ownerQuery.isRefetching}
              onRefresh={() => ownerQuery.refetch()}
              tintColor={colors.mutedForeground}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="bar-chart-2"
              title="No standings yet"
              subtitle={`No results recorded for the ${season} season.`}
            />
          }
        />
      ) : (
        <FlatList
          data={teamQuery.data ?? []}
          keyExtractor={(item) => String(item.teamId)}
          renderItem={({ item }) => <TeamCard team={item} />}
          contentContainerStyle={[styles.listContent, { paddingBottom: listBottomPad }]}
          scrollEnabled={(teamQuery.data ?? []).length > 0}
          refreshControl={
            <RefreshControl
              refreshing={teamQuery.isRefetching}
              onRefresh={() => teamQuery.refetch()}
              tintColor={colors.mutedForeground}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="shield"
              title="No teams yet"
              subtitle={`No teams recorded for the ${season} season.`}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  segmentContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  listContent: {
    paddingHorizontal: 16,
    gap: 10,
  },
  card: {
    borderWidth: 1,
  },
  cardBody: {
    padding: 14,
  },
  ownerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  teamTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  rankBox: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rankText: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  ownerName: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  ownerConsortium: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    marginTop: 3,
  },
  ownerMeta: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  mtmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mtmValue: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
  },
  mtmDelta: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    marginTop: 2,
  },
  wowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  wowText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
  statRow: {
    flexDirection: 'row',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  stat: {
    flex: 1,
  },
  statLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
  },
  statValue: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
    marginTop: 3,
  },
  teamList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  teamListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  teamListName: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  teamListMeta: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  teamListMtm: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
});

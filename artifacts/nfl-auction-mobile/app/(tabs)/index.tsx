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
  useGetResultsCompare,
  getGetResultsCompareQueryKey,
  useGetSeasons,
  type CalcuttaComparisonResponse,
  type CalcuttaComparisonRow,
  type MtmOwnerSeries,
  type OwnershipSegment,
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

type ViewMode = 'owner' | 'team' | 'compare';

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
  basis,
}: {
  owner: OwnerResultRow;
  rank: number;
  weeklyTotals?: number[];
  basis: 'realized' | 'mtm';
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState<boolean>(false);
  const value = basis === 'mtm' ? owner.totalMtm : owner.totalRealizedReturn;
  const net = basis === 'mtm' ? owner.totalMtm - owner.totalCost : owner.totalNetReturn;
  const mtmColor =
    net >= 0 ? colors.success : colors.destructive;

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
              {basis === 'mtm' && weeklyTotals && weeklyTotals.length >= 2 && (
                <Sparkline data={weeklyTotals} color={sparklineColor} />
              )}
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[styles.mtmValue, { color: colors.foreground }]}>
                  {fmtMoney(value)}
                </Text>
                <Text style={[styles.mtmDelta, { color: mtmColor }]}>
                  {fmtMoneySigned(net)}
                </Text>
              </View>
            </View>
            {basis === 'mtm' && wowDelta !== null && (
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
            const ownerSegments = t.ownershipSegments.filter(
              (segment) => segment.bidderId === owner.bidderId,
            );
            const ownerEntries = t.owners.filter(
              (entry) => entry.bidderId === owner.bidderId,
            );
            return (
              <View key={t.teamId} style={styles.teamListRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.teamListName, { color: colors.foreground }]}>
                    {t.teamName}
                  </Text>
                  <OwnershipBreakdown
                    segments={ownerSegments}
                    owners={ownerEntries}
                    compact
                  />
                  <Text style={[styles.teamListMeta, { color: colors.mutedForeground }]}>
                    {t.conference} {t.division} · {t.wins} W · cost {fmtMoney(t.cost)}
                  </Text>
                </View>
                <Text style={[styles.teamListMtm, { color: colors.foreground }]}>
                  {fmtMoney(basis === 'mtm' ? t.markToMarket : t.realizedReturn)}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

function formatOwnershipSegmentShare(share: number, isTrade: boolean): string {
  if (!isTrade) return fmtShare(share);

  const percentage = Math.round(share * 10_000) / 100;
  const sign = percentage > 0 ? '+' : '';
  return `${sign}${percentage}%`;
}

function OwnershipBreakdown({
  segments,
  owners,
  compact = false,
}: {
  segments: OwnershipSegment[];
  owners: TeamResultRow['owners'];
  compact?: boolean;
}) {
  const colors = useColors();
  const displaySegments: OwnershipSegment[] =
    segments.length > 0
      ? segments
      : owners.map((owner) => ({ ...owner, source: 'primary' }));

  if (displaySegments.length === 0) return null;

  return (
    <View style={styles.ownershipBreakdown}>
      {!compact && (
        <Text style={[styles.ownershipHeading, { color: colors.mutedForeground }]}>
          OWNERSHIP
        </Text>
      )}
      {displaySegments.map((segment, index) => {
        const isTrade = segment.source === 'trade';
        const isAcquisition = segment.tradeDirection === 'acquired';
        const counterparty = segment.counterpartyBidderName;
        const sourceLabel = !isTrade
          ? 'AUCTION'
          : isAcquisition
            ? 'TRADE IN'
            : 'TRADE OUT';
        const rowBorder = !isTrade
          ? colors.border
          : isAcquisition
            ? colors.nfc
            : colors.destructive;

        return (
          <View
            key={`${segment.source}-${segment.tradeId ?? 'primary'}-${segment.bidderId}-${index}`}
            style={[
              styles.ownershipRow,
              { backgroundColor: colors.muted, borderColor: rowBorder },
            ]}
          >
            <View style={styles.ownershipInfo}>
              <Text style={[styles.ownershipSource, { color: colors.foreground }]}>
                {sourceLabel}
              </Text>
              <Text
                style={[styles.ownershipParty, { color: colors.foreground }]}
                numberOfLines={1}
              >
                {segment.bidderName}
              </Text>
              {isTrade && counterparty ? (
                <Text
                  style={[styles.ownershipCounterparty, { color: colors.mutedForeground }]}
                  numberOfLines={1}
                >
                  {isAcquisition ? 'from' : 'to'} {counterparty}
                </Text>
              ) : null}
            </View>
            <Text
              style={[styles.ownershipShare, { color: colors.foreground }]}
            >
              {formatOwnershipSegmentShare(segment.ownershipShare, isTrade)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ── Team row ─────────────────────────────────────────────────────────────────

function TeamCard({ team, basis }: { team: TeamResultRow; basis: 'realized' | 'mtm' }) {
  const colors = useColors();
  const value = basis === 'mtm' ? team.markToMarket : team.realizedReturn;
  const net = basis === 'mtm' ? team.markToMarket - team.cost : team.netReturn;
  const netColor = net >= 0 ? colors.success : colors.destructive;

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
        </View>
        <ConferenceChip conference={team.conference} />
      </View>
      <OwnershipBreakdown segments={team.ownershipSegments} owners={team.owners} />
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
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
            {basis === 'mtm' ? 'MTM' : 'RETURN'}
          </Text>
          <Text style={[styles.statValue, { color: colors.foreground }]}>
            {fmtMoney(value)}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>NET</Text>
          <Text style={[styles.statValue, { color: netColor }]}>
            {fmtMoneySigned(net)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function ComparisonCard({
  row,
  comparison,
  basis,
}: {
  row: CalcuttaComparisonRow;
  comparison: CalcuttaComparisonResponse;
  basis: 'realized' | 'mtm';
}) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const aggregateReturn = basis === 'mtm' ? row.aggregate.totalMtm : row.aggregate.totalNetReturn;

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Pressable
        testID={`comparison-card-${row.id}`}
        onPress={() => {
          Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
        style={({ pressed }) => [styles.cardBody, { opacity: pressed ? 0.85 : 1 }]}
      >
        <View style={styles.ownerTopRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.ownerName, { color: colors.foreground }]}>{row.name}</Text>
            <Text style={[styles.ownerConsortium, { color: colors.mutedForeground }]}>
              {comparison.groupBy === 'bidder' ? 'OWNER · TAP FOR CALCUTTAS' : 'CONSORTIUM · TAP FOR CALCUTTAS'}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
              {basis === 'mtm' ? 'MTM RETURN' : 'NET RETURN'}
            </Text>
            {row.aggregate.snapshotAvailable ? (
              <Text style={[styles.mtmValue, { color: aggregateReturn >= 0 ? colors.success : colors.destructive }]}>
                {fmtMoneySigned(aggregateReturn)}
              </Text>
            ) : (
              <Text style={[styles.comparisonMissing, { color: colors.destructive }]}>PARTIAL SNAPSHOTS</Text>
            )}
          </View>
        </View>
        <View style={[styles.comparisonSummary, { borderTopColor: colors.border }]}>
          <View>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>EXPOSURE</Text>
            <Text style={[styles.comparisonSummaryValue, { color: colors.foreground }]}>
              {fmtMoney(row.aggregate.exposure)}
            </Text>
          </View>
          <View>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>SIGNED POS.</Text>
            <Text style={[styles.comparisonSummaryValue, { color: colors.foreground }]}>
              {fmtShare(row.aggregate.signedShare)}
            </Text>
          </View>
          <View>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>POOLS</Text>
            <Text style={[styles.comparisonSummaryValue, { color: colors.foreground }]}>
              {row.calcuttas.filter(Boolean).length}
            </Text>
          </View>
        </View>
      </Pressable>
      {expanded ? (
        <View style={[styles.comparisonDetails, { borderTopColor: colors.border }]}>
          {comparison.calcuttas.map((calcutta, index) => {
            const cell = row.calcuttas[index];
            const value =
              basis === 'mtm' ? (cell?.totalMtm ?? 0) : (cell?.totalNetReturn ?? 0);
            return (
              <View
                key={calcutta.id}
                style={[styles.comparisonCell, { backgroundColor: colors.muted, borderColor: colors.border }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.comparisonYear, { color: colors.foreground }]}>{calcutta.year}</Text>
                  <Text style={[styles.comparisonMeta, { color: colors.mutedForeground }]}>
                    {cell ? `${cell.consortium ?? 'Unassigned'} · ${fmtShare(cell.signedShare)}` : 'No position'}
                  </Text>
                </View>
                {cell && !cell.snapshotAvailable ? (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.comparisonMissing, { color: colors.destructive }]}>
                      {cell.snapshotTeamCount > 0 ? 'PARTIAL SNAPSHOTS' : 'SNAPSHOT MISSING'}
                    </Text>
                    <Text style={[styles.comparisonMeta, { color: colors.mutedForeground }]}>
                      {cell.snapshotTeamCount}/{cell.teamCount} positions covered
                    </Text>
                  </View>
                ) : (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.comparisonValue, { color: value >= 0 ? colors.success : colors.destructive }]}>
                      {fmtMoneySigned(value)}
                    </Text>
                    <Text style={[styles.comparisonMeta, { color: colors.mutedForeground }]}>
                      EXP {fmtMoney(cell?.exposure ?? 0)}
                    </Text>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function StandingsScreen() {
  const colors = useColors();
  const { season } = useApp();
  const [mode, setMode] = useState<ViewMode>('owner');
  const [period, setPeriod] = useState<number | undefined>(undefined);
  const [basis, setBasis] = useState<'realized' | 'mtm'>('mtm');
  const [comparisonGroupBy, setComparisonGroupBy] = useState<'bidder' | 'consortium'>('bidder');
  const [comparisonYears, setComparisonYears] = useState<number[]>([]);

  const ownerQuery = useGetResultsByOwner({ season, period, basis });
  const teamQuery = useGetResults({ season, period, basis });
  const mtmQuery = useGetMtmSnapshots({ season });
  const seasonsQuery = useGetSeasons();
  const availableComparisonYears = React.useMemo(
    () => (seasonsQuery.data ?? []).map((item) => item.year).sort((a, b) => a - b),
    [seasonsQuery.data],
  );
  React.useEffect(() => {
    if (comparisonYears.length === 0 && availableComparisonYears.length >= 2) {
      setComparisonYears(availableComparisonYears.slice(-2));
    }
  }, [availableComparisonYears, comparisonYears.length]);
  const comparisonQuery = useGetResultsCompare(
    {
      seasons: comparisonYears.join(','),
      period,
      basis,
      groupBy: comparisonGroupBy,
    },
    { query: { enabled: comparisonYears.length >= 2, queryKey: getGetResultsCompareQueryKey({
      seasons: comparisonYears.join(','),
      period,
      basis,
      groupBy: comparisonGroupBy,
    }) } },
  );

  // Build bidderName → weeklyTotals lookup from MTM snapshot data
  const mtmByName = React.useMemo<Record<string, number[]>>(() => {
    if (!mtmQuery.data?.owners) return {};
    return Object.fromEntries(
      mtmQuery.data.owners.map((o: MtmOwnerSeries) => [o.bidderName, o.weeklyTotals]),
    );
  }, [mtmQuery.data]);

  const active = mode === 'owner' ? ownerQuery : mode === 'team' ? teamQuery : comparisonQuery;

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
            { label: 'Compare', value: 'compare' },
          ]}
          value={mode}
          onChange={setMode}
        />
      </View>
      <View style={styles.snapshotControls}>
        <View style={styles.periodChipRow}>
          {[
            { label: 'Latest', value: undefined },
            { label: 'Wk 0', value: 0 },
            { label: 'Wk 18', value: 18 },
            { label: 'SB', value: 22 },
          ].map((option) => (
            <Pressable
              key={option.label}
              onPress={() => setPeriod(option.value)}
              style={[
                styles.snapshotChip,
                {
                  borderColor: period === option.value ? colors.primary : colors.border,
                  backgroundColor: period === option.value ? colors.primary : 'transparent',
                },
              ]}
            >
              <Text style={{ color: period === option.value ? colors.primaryForeground : colors.mutedForeground, fontSize: 11, fontFamily: 'Inter_600SemiBold' }}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {mode === 'compare' ? (
          <>
            <View style={styles.periodChipRow}>
              {availableComparisonYears.map((year) => {
                const selected = comparisonYears.includes(year);
                return (
                  <Pressable
                    key={year}
                    testID={`compare-season-${year}`}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setComparisonYears((current) => {
                        if (current.includes(year)) return current.filter((item) => item !== year);
                        return [...current, year].sort((a, b) => a - b).slice(-6);
                      });
                    }}
                    style={[
                      styles.snapshotChip,
                      {
                        borderColor: selected ? colors.primary : colors.border,
                        backgroundColor: selected ? colors.primary : 'transparent',
                      },
                    ]}
                  >
                    <Text style={{ color: selected ? colors.primaryForeground : colors.mutedForeground, fontSize: 11, fontFamily: 'Inter_600SemiBold' }}>
                      {year}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.periodChipRow}>
              {(['bidder', 'consortium'] as const).map((option) => (
                <Pressable
                  key={option}
                  onPress={() => setComparisonGroupBy(option)}
                  style={[
                    styles.snapshotChip,
                    {
                      borderColor: comparisonGroupBy === option ? colors.primary : colors.border,
                      backgroundColor: comparisonGroupBy === option ? colors.primary : 'transparent',
                    },
                  ]}
                >
                  <Text style={{ color: comparisonGroupBy === option ? colors.primaryForeground : colors.mutedForeground, fontSize: 11, fontFamily: 'Inter_600SemiBold' }}>
                    {option === 'bidder' ? 'OWNERS' : 'CONSORTIUMS'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        <View style={styles.periodChipRow}>
          {(['mtm', 'realized'] as const).map((option) => (
            <Pressable
              key={option}
              onPress={() => setBasis(option)}
              style={[
                styles.snapshotChip,
                {
                  borderColor: basis === option ? colors.primary : colors.border,
                  backgroundColor: basis === option ? colors.primary : 'transparent',
                },
              ]}
            >
              <Text style={{ color: basis === option ? colors.primaryForeground : colors.mutedForeground, fontSize: 11, fontFamily: 'Inter_600SemiBold' }}>
                {option === 'mtm' ? 'MARK TO MARKET' : 'REALIZED'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {active.isLoading ? (
        <LoadingState />
      ) : active.error ? (
        <ErrorState onRetry={() => active.refetch()} />
      ) : mode === 'compare' ? (
        comparisonYears.length < 2 ? (
          <EmptyState
            icon="list"
            title="Select two Calcuttas"
            subtitle="Choose at least two seasons to compare returns."
          />
        ) : (
          <FlatList
            data={comparisonQuery.data?.rows ?? []}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) =>
              comparisonQuery.data ? (
                <ComparisonCard row={item} comparison={comparisonQuery.data} basis={basis} />
              ) : null
            }
            contentContainerStyle={[styles.listContent, { paddingBottom: listBottomPad }]}
            refreshControl={
              <RefreshControl
                refreshing={comparisonQuery.isRefetching}
                onRefresh={() => comparisonQuery.refetch()}
                tintColor={colors.mutedForeground}
              />
            }
            ListEmptyComponent={
              <EmptyState
                icon="bar-chart-2"
                title="No comparable positions"
                subtitle="The selected Calcuttas have no owner positions yet."
              />
            }
          />
        )
      ) : mode === 'owner' ? (
        <FlatList
          data={ownerQuery.data ?? []}
          keyExtractor={(item) => String(item.bidderId)}
          renderItem={({ item, index }) => (
            <OwnerCard
              owner={item}
              rank={index + 1}
              weeklyTotals={mtmByName[item.bidderName]}
              basis={basis}
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
          renderItem={({ item }) => <TeamCard team={item} basis={basis} />}
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
  snapshotControls: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 6,
  },
  periodChipRow: {
    flexDirection: 'row',
    gap: 6,
  },
  snapshotChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  comparisonSummary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  comparisonSummaryValue: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    marginTop: 3,
  },
  comparisonDetails: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 6,
  },
  comparisonCell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 9,
    paddingVertical: 8,
  },
  comparisonYear: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  comparisonMeta: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
    marginTop: 2,
  },
  comparisonValue: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
  },
  comparisonMissing: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  ownershipBreakdown: {
    gap: 4,
  },
  ownershipHeading: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  ownershipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
  },
  ownershipInfo: {
    flex: 1,
    minWidth: 0,
  },
  ownershipSource: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.7,
  },
  ownershipParty: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    marginTop: 1,
  },
  ownershipCounterparty: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 1,
  },
  ownershipShare: {
    flexShrink: 0,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: 'Inter_700Bold',
  },
});

import React from 'react';
import {
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useGetAuctionSummary } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import {
  ConferenceChip,
  EmptyState,
  ErrorState,
  LoadingState,
  ScreenHeader,
  SeasonToggle,
} from '@/components/ui';
import { fmtMoney, fmtPct } from '@/lib/format';

// ── Stat tile ─────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ComponentProps<typeof Feather>['name'];
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.statTile,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={styles.statTileTop}>
        <Text style={[styles.statTileLabel, { color: colors.mutedForeground }]}>
          {label.toUpperCase()}
        </Text>
        <Feather name={icon} size={14} color={colors.mutedForeground} style={{ opacity: 0.5 }} />
      </View>
      <Text style={[styles.statTileValue, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
}

// ── Standing row ──────────────────────────────────────────────────────────────

function StandingRow({
  standing,
  rank,
  potSize,
}: {
  standing: { bidderId: number; bidderName: string; totalPaid: number; teamCount: number; percentOfPot: number };
  rank: number;
  potSize: number;
}) {
  const colors = useColors();
  const isLeader = rank === 1 && standing.totalPaid > 0;
  const barWidth = potSize > 0 ? (standing.totalPaid / potSize) * 100 : 0;

  return (
    <View
      style={[
        styles.standingRow,
        {
          borderBottomColor: colors.border,
          backgroundColor: isLeader ? colors.gold + '18' : 'transparent',
        },
      ]}
    >
      <View style={styles.standingLeft}>
        <View style={[styles.rankBox, isLeader && { backgroundColor: colors.gold }]}>
          <Text
            style={[
              styles.rankText,
              { color: isLeader ? '#171717' : colors.mutedForeground },
            ]}
          >
            {rank}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.standingNameRow}>
            {isLeader && (
              <Feather name="award" size={13} color={colors.gold} style={{ marginRight: 4 }} />
            )}
            <Text
              style={[styles.standingName, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {standing.bidderName}
            </Text>
          </View>
          <View style={styles.standingMeta}>
            <Text style={[styles.standingMetaText, { color: colors.mutedForeground }]}>
              {standing.teamCount} {standing.teamCount === 1 ? 'team' : 'teams'}
            </Text>
            <View
              style={[
                styles.bar,
                { backgroundColor: colors.border },
              ]}
            >
              <View
                style={[
                  styles.barFill,
                  {
                    backgroundColor: isLeader ? colors.gold : colors.primary,
                    width: `${barWidth}%` as any,
                  },
                ]}
              />
            </View>
            <Text style={[styles.standingMetaText, { color: colors.mutedForeground }]}>
              {fmtPct(standing.percentOfPot)}
            </Text>
          </View>
        </View>
      </View>
      <Text style={[styles.standingValue, { color: colors.foreground }]}>
        {fmtMoney(standing.totalPaid)}
      </Text>
    </View>
  );
}

// ── Conference card ───────────────────────────────────────────────────────────

function ConferenceCard({
  conf,
}: {
  conf: { conference: string; totalSpent: number; teamCount: number; avgBid: number };
}) {
  const colors = useColors();
  const isAFC = conf.conference === 'AFC';
  const accent = isAFC ? colors.afc : colors.nfc;

  return (
    <View
      style={[
        styles.confCard,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderTopColor: accent,
        },
      ]}
    >
      <View style={styles.confTop}>
        <Text style={[styles.confName, { color: accent }]}>{conf.conference}</Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.confLabel, { color: colors.mutedForeground }]}>SPENT</Text>
          <Text style={[styles.confValue, { color: colors.foreground }]}>
            {fmtMoney(conf.totalSpent)}
          </Text>
        </View>
      </View>
      <View style={[styles.confStats, { borderTopColor: colors.border }]}>
        <View>
          <Text style={[styles.confLabel, { color: colors.mutedForeground }]}>TEAMS</Text>
          <Text style={[styles.confStatVal, { color: colors.foreground }]}>
            {conf.teamCount}/16
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[styles.confLabel, { color: colors.mutedForeground }]}>AVG BID</Text>
          <Text style={[styles.confStatVal, { color: colors.foreground }]}>
            {fmtMoney(conf.avgBid)}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function AuctionScreen() {
  const colors = useColors();
  const { season } = useApp();
  const query = useGetAuctionSummary({ season });

  const listBottomPad = Platform.OS === 'web' ? 84 + 16 : 100;

  if (query.isLoading) return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Auction" subtitle={`${season} Auction Board`} right={<SeasonToggle />} />
      <LoadingState />
    </View>
  );

  if (query.error) return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Auction" subtitle={`${season} Auction Board`} right={<SeasonToggle />} />
      <ErrorState onRetry={() => query.refetch()} />
    </View>
  );

  const summary = query.data;
  const hasData = summary && summary.teamsAuctioned > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Auction"
        subtitle={`${season} Auction Board`}
        right={<SeasonToggle />}
      />

      {!hasData ? (
        <EmptyState
          icon="shopping-bag"
          title="No auction data yet"
          subtitle={`No teams have been auctioned for the ${season} season.`}
        />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: listBottomPad }]}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.mutedForeground}
            />
          }
        >
          {/* Stat tiles */}
          <View style={styles.tilesGrid}>
            <StatTile label="Total Pot" value={fmtMoney(summary!.potSize)} icon="award" />
            <StatTile label="Avg Bid" value={fmtMoney(summary!.avgBidPerTeam)} icon="dollar-sign" />
            <StatTile label="Auctioned" value={`${summary!.teamsAuctioned}/32`} icon="activity" />
            <StatTile label="Remaining" value={String(summary!.nominationsLeft)} icon="trending-up" />
          </View>

          {/* Standings */}
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Standings</Text>
          <View style={[styles.table, { borderColor: colors.border, backgroundColor: colors.card }]}>
            {(summary!.standings).length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No active bidders yet.
              </Text>
            ) : (
              summary!.standings.map((s, i) => (
                <StandingRow
                  key={s.bidderId}
                  standing={s}
                  rank={i + 1}
                  potSize={summary!.potSize}
                />
              ))
            )}
          </View>

          {/* Conference breakdown */}
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
            Conference Splits
          </Text>
          {summary!.conferenceBreakdown.length === 0 ? (
            <View style={[styles.emptyConf, { borderColor: colors.border }]}>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No conference data for {season}.
              </Text>
            </View>
          ) : (
            <View style={styles.confRow}>
              {summary!.conferenceBreakdown.map((c) => (
                <ConferenceCard key={c.conference} conf={c} />
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  tilesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  statTile: {
    flex: 1,
    minWidth: '45%',
    borderWidth: 1,
    padding: 14,
  },
  statTileTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statTileLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
  },
  statTileValue: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  table: {
    borderWidth: 1,
    marginBottom: 20,
    overflow: 'hidden',
  },
  standingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  standingLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
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
    fontFamily: 'Inter_700Bold',
  },
  standingNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  standingName: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
  },
  standingMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  standingMetaText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  bar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  barFill: {
    height: 4,
    borderRadius: 2,
  },
  standingValue: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    flexShrink: 0,
  },
  confRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  confCard: {
    flex: 1,
    borderWidth: 1,
    borderTopWidth: 4,
    padding: 14,
  },
  confTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  confName: {
    fontSize: 32,
    fontFamily: 'Inter_700Bold',
  },
  confLabel: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  confValue: {
    fontSize: 16,
    fontFamily: 'Inter_700Bold',
    marginTop: 2,
  },
  confStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
  },
  confStatVal: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    marginTop: 3,
  },
  emptyConf: {
    borderWidth: 1,
    borderStyle: 'dashed',
    padding: 24,
    alignItems: 'center',
    marginBottom: 20,
  },
  emptyText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    padding: 16,
  },
});

import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { importAuctionData, importDraftOrder, useGetAuctionSummary } from '@workspace/api-client-react';
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
import { fmtMoney } from '@/lib/format';

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

// ── Auction result row ─────────────────────────────────────────────────────────

function AuctionResultRow({
  result,
}: {
  result: {
    teamId: number;
    teamName: string;
    winnerName: string;
    bidAmount: number;
    draftOrder: number | null;
  };
}) {
  const colors = useColors();

  return (
    <View
      style={[
        styles.resultRow,
        {
          borderBottomColor: colors.border,
        },
      ]}
    >
      <View style={[styles.orderBox, { backgroundColor: colors.muted }]}>
        <Text style={[styles.orderText, { color: colors.foreground }]}>
          {result.draftOrder ?? '—'}
        </Text>
      </View>
      <View style={styles.resultDetails}>
        <View style={styles.resultNameRow}>
          <Text style={[styles.resultTeam, { color: colors.foreground }]} numberOfLines={1}>
            {result.teamName}
          </Text>
          <Text style={[styles.resultBid, { color: colors.foreground }]}>
            {fmtMoney(result.bidAmount)}
          </Text>
        </View>
        <Text style={[styles.resultWinner, { color: colors.mutedForeground }]} numberOfLines={1}>
          Winner: {result.winnerName}
        </Text>
      </View>
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
  const { season, adminKey, setAdminKey } = useApp();
  const query = useGetAuctionSummary({ season });
  const [adminKeyDraft, setAdminKeyDraft] = useState(adminKey ?? '');

  // AuctionPro (URL-fetch) import state
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  // Draft-order import state
  const [draftImportMessage, setDraftImportMessage] = useState<string | null>(null);
  const [draftImportError, setDraftImportError] = useState<string | null>(null);
  const [isDraftImporting, setIsDraftImporting] = useState(false);

  const listBottomPad = Platform.OS === 'web' ? 84 + 16 : 100;

  const importDraftOrderData = async () => {
    setDraftImportMessage(null);
    setDraftImportError(null);
    const key = adminKeyDraft.trim() || adminKey?.trim() || '';
    if (!key) {
      setDraftImportError('Enter the admin key before importing.');
      return;
    }
    if (key !== adminKey) setAdminKey(key);
    setIsDraftImporting(true);
    try {
      const result = await importDraftOrder(
        { seasonYear: season },
        { headers: { Authorization: `Bearer ${key}` } },
      );
      setDraftImportMessage(
        `Imported ${result.importedTeams} teams with draft order for ${result.seasonYear}.`,
      );
      await query.refetch();
    } catch (error) {
      setDraftImportError(error instanceof Error ? error.message : 'Draft-order import failed.');
    } finally {
      setIsDraftImporting(false);
    }
  };

  const importAuction = async () => {
    setImportMessage(null);
    setImportError(null);
    const key = adminKeyDraft.trim() || adminKey?.trim() || '';
    if (!key) {
      setImportError('Enter the admin key before starting an import.');
      return;
    }
    if (key !== adminKey) setAdminKey(key);
    setIsImporting(true);
    try {
      const result = await importAuctionData(
        { seasonYear: season },
        { headers: { Authorization: `Bearer ${key}` } },
      );
      setImportMessage(
        `Imported ${result.importedTeams} teams and ${result.importedOwners} ownership entries for ${result.seasonYear}.`,
      );
      await query.refetch();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'AuctionPro import failed.');
    } finally {
      setIsImporting(false);
    }
  };

  if (query.isLoading) return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Auction" subtitle={`${season} Auction Results`} right={<SeasonToggle />} />
      <LoadingState />
    </View>
  );

  if (query.error) return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader title="Auction" subtitle={`${season} Auction Results`} right={<SeasonToggle />} />
      <ErrorState onRetry={() => query.refetch()} />
    </View>
  );

  const summary = query.data;
  const hasData = summary && summary.teamsAuctioned > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Auction"
        subtitle={`${season} Auction Results`}
        right={<SeasonToggle />}
      />

      <View style={[styles.importPanel, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <View style={styles.importHeading}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.importTitle, { color: colors.foreground }]}>AuctionPro Import</Text>
            <Text style={[styles.importHint, { color: colors.mutedForeground }]}>
              Replace this season’s complete auction data from the configured export.
            </Text>
          </View>
          <Feather name="download-cloud" size={19} color={colors.mutedForeground} />
        </View>
        {!adminKey ? (
          <TextInput
            value={adminKeyDraft}
            onChangeText={setAdminKeyDraft}
            placeholder="Admin key"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.keyInput,
              { color: colors.foreground, borderColor: colors.input, backgroundColor: colors.background },
            ]}
          />
        ) : (
          <View style={styles.keyLoadedRow}>
            <Text style={[styles.keyLoadedText, { color: colors.success }]}>Admin key ready</Text>
            <Pressable
              onPress={() => {
                setAdminKey(null);
                setAdminKeyDraft('');
              }}
              hitSlop={8}
            >
              <Text style={[styles.clearKeyText, { color: colors.mutedForeground }]}>Clear</Text>
            </Pressable>
          </View>
        )}
        <Pressable
          testID="auctionpro-import-button"
          disabled={isImporting}
          onPress={importAuction}
          style={({ pressed }) => [
            styles.importButton,
            {
              backgroundColor: colors.primary,
              opacity: pressed || isImporting ? 0.7 : 1,
            },
          ]}
        >
          <Feather
            name={isImporting ? 'clock' : 'download'}
            size={15}
            color={colors.primaryForeground}
          />
          <Text style={[styles.importButtonText, { color: colors.primaryForeground }]}>
            {isImporting ? 'Importing…' : `Import ${season} Auction`}
          </Text>
        </Pressable>
        {importMessage ? (
          <Text testID="auctionpro-import-success" style={[styles.importMessage, { color: colors.success }]}>
            {importMessage}
          </Text>
        ) : null}
        {importError ? (
          <Text testID="auctionpro-import-error" style={[styles.importMessage, { color: colors.destructive }]}>
            {importError}
          </Text>
        ) : null}
      </View>

      {/* Draft-order import panel */}
      <View style={[styles.importPanel, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <View style={styles.importHeading}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.importTitle, { color: colors.foreground }]}>Draft-Order Import</Text>
            <Text style={[styles.importHint, { color: colors.mutedForeground }]}>
              Pull live auction prices, ownership, and draft order from AuctionPro.
            </Text>
          </View>
          <Feather name="list" size={19} color={colors.mutedForeground} />
        </View>
        <Pressable
          testID="draft-order-import-button"
          disabled={isDraftImporting}
          onPress={importDraftOrderData}
          style={({ pressed }) => [
            styles.importButton,
            {
              backgroundColor: colors.primary,
              opacity: pressed || isDraftImporting ? 0.7 : 1,
            },
          ]}
        >
          <Feather
            name={isDraftImporting ? 'clock' : 'activity'}
            size={15}
            color={colors.primaryForeground}
          />
          <Text style={[styles.importButtonText, { color: colors.primaryForeground }]}>
            {isDraftImporting ? 'Importing…' : `Import ${season} Draft Order`}
          </Text>
        </Pressable>
        {draftImportMessage ? (
          <Text testID="draft-order-import-success" style={[styles.importMessage, { color: colors.success }]}>
            {draftImportMessage}
          </Text>
        ) : null}
        {draftImportError ? (
          <Text testID="draft-order-import-error" style={[styles.importMessage, { color: colors.destructive }]}>
            {draftImportError}
          </Text>
        ) : null}
      </View>

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
            <StatTile label="Total Pot" value={fmtMoney(summary!.potSize)} icon="dollar-sign" />
            <StatTile label="Avg Bid" value={fmtMoney(summary!.avgBidPerTeam)} icon="dollar-sign" />
            <StatTile
              label="Most Expensive"
              value={summary!.mostExpensiveTeam
                ? `${summary!.mostExpensiveTeam.name} · ${fmtMoney(summary!.mostExpensiveTeam.bidAmount)}`
                : '—'}
              icon="file-text"
            />
          </View>

          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Auction Results</Text>
          <View style={[styles.table, { borderColor: colors.border, backgroundColor: colors.card }]}>
            {summary!.auctionResults.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No auction results for {season} yet.
              </Text>
            ) : (
              summary!.auctionResults.map((result) => (
                <AuctionResultRow
                  key={result.teamId}
                  result={result}
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
  importPanel: {
    marginHorizontal: 16,
    marginTop: 12,
    borderWidth: 1,
    padding: 12,
    gap: 10,
  },
  importHeading: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  importTitle: {
    fontSize: 13,
    fontFamily: 'Archivo_700Bold',
    letterSpacing: 0.4,
  },
  importHint: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono_400Regular',
    lineHeight: 16,
    marginTop: 2,
  },
  keyInput: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 13,
    fontFamily: 'JetBrainsMono_400Regular',
  },
  keyLoadedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  keyLoadedText: {
    fontSize: 12,
    fontFamily: 'Archivo_600SemiBold',
  },
  clearKeyText: {
    fontSize: 12,
    fontFamily: 'Archivo_600SemiBold',
  },
  importButton: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  importButtonText: {
    fontSize: 13,
    fontFamily: 'Archivo_700Bold',
  },
  importMessage: {
    fontSize: 12,
    fontFamily: 'JetBrainsMono_500Medium',
    lineHeight: 17,
  },
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
    fontFamily: 'JetBrainsMono_700Bold',
    letterSpacing: 0.8,
  },
  statTileValue: {
    fontSize: 22,
    fontFamily: 'Archivo_900Black',
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'JetBrainsMono_700Bold',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  table: {
    borderWidth: 1,
    marginBottom: 20,
    overflow: 'hidden',
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  orderBox: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  orderText: {
    fontSize: 12,
    fontFamily: 'Archivo_700Bold',
  },
  resultDetails: {
    flex: 1,
    minWidth: 0,
  },
  resultNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  resultTeam: {
    fontSize: 16,
    fontFamily: 'Archivo_700Bold',
    flexShrink: 1,
  },
  resultWinner: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono_400Regular',
    marginTop: 3,
  },
  resultBid: {
    fontSize: 16,
    fontFamily: 'Archivo_900Black',
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
    fontFamily: 'Archivo_900Black',
  },
  confLabel: {
    fontSize: 9,
    fontFamily: 'JetBrainsMono_700Bold',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  confValue: {
    fontSize: 16,
    fontFamily: 'Archivo_900Black',
    marginTop: 2,
  },
  confStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    paddingTop: 12,
  },
  confStatVal: {
    fontSize: 16,
    fontFamily: 'Archivo_700Bold',
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
    fontFamily: 'JetBrainsMono_400Regular',
    textAlign: 'center',
    padding: 16,
  },
});

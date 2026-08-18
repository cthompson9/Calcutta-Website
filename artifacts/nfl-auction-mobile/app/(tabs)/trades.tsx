import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import {
  setTradeStatus,
  useGetTrades,
  type TradeRow,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ScreenHeader,
  SeasonToggle,
  StatusBadge,
} from '@/components/ui';
import { fmtDate, fmtMoney } from '@/lib/format';

// ── Admin key modal ──────────────────────────────────────────────────────────

function AdminKeyModal({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const colors = useColors();
  const { adminKey, setAdminKey } = useApp();
  const [draft, setDraft] = useState<string>('');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View
          style={[
            styles.modalCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <View style={styles.modalHeader}>
            <Feather name="key" size={18} color={colors.foreground} />
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Admin Key
            </Text>
            <Pressable
              testID="close-admin-modal"
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, marginLeft: 'auto' })}
            >
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>
          <Text style={[styles.modalText, { color: colors.mutedForeground }]}>
            Approving or rejecting trades requires the commissioner's admin key.
            {Platform.OS === 'web'
              ? ' In the browser it is kept in memory only and cleared when the page reloads.'
              : ' It is stored in this device\u2019s secure keychain and never leaves the device.'}
          </Text>
          <TextInput
            testID="admin-key-input"
            value={draft}
            onChangeText={setDraft}
            placeholder={adminKey ? '••••••••  (key saved)' : 'Enter admin key'}
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.modalInput,
              {
                borderColor: colors.input,
                color: colors.foreground,
                backgroundColor: colors.background,
              },
            ]}
          />
          <View style={styles.modalActions}>
            {adminKey ? (
              <Pressable
                testID="clear-admin-key"
                onPress={() => {
                  setAdminKey(null);
                  setDraft('');
                }}
                style={({ pressed }) => [
                  styles.modalBtn,
                  { borderColor: colors.border, borderWidth: 1, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={[styles.modalBtnText, { color: colors.destructive }]}>
                  Clear key
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              testID="save-admin-key"
              disabled={!draft.trim()}
              onPress={() => {
                setAdminKey(draft.trim());
                setDraft('');
                onSaved();
              }}
              style={({ pressed }) => [
                styles.modalBtn,
                {
                  backgroundColor: colors.primary,
                  opacity: !draft.trim() ? 0.4 : pressed ? 0.7 : 1,
                },
              ]}
            >
              <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>
                Save key
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Trade card ───────────────────────────────────────────────────────────────

function TradeCard({
  trade,
  onDecide,
  deciding,
}: {
  trade: TradeRow;
  onDecide: (trade: TradeRow, status: 'approved' | 'rejected') => void;
  deciding: number | null;
}) {
  const colors = useColors();
  const isPending = trade.status === 'pending';
  const busy = deciding === trade.id;

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: isPending ? colors.warning : colors.border,
        },
      ]}
    >
      <View style={styles.tradeTopRow}>
        <Text style={[styles.tradeTeam, { color: colors.foreground }]}>
          {trade.teamName}
        </Text>
        <StatusBadge status={trade.status} />
      </View>

      <View style={styles.tradeFlowRow}>
        <Text style={[styles.tradeBidder, { color: colors.foreground }]} numberOfLines={1}>
          {trade.fromBidderName}
        </Text>
        <Feather name="arrow-right" size={14} color={colors.mutedForeground} />
        <Text style={[styles.tradeBidder, { color: colors.foreground }]} numberOfLines={1}>
          {trade.toBidderName}
        </Text>
      </View>

      <Text style={[styles.tradeMeta, { color: colors.mutedForeground }]}>
        {trade.percentage < 100 ? `${trade.percentage}% stake · ` : ''}
        {fmtMoney(trade.price)} · {fmtDate(trade.tradeDate)}
      </Text>
      {trade.notes ? (
        <Text style={[styles.tradeNotes, { color: colors.mutedForeground }]}>
          {trade.notes}
        </Text>
      ) : null}

      {isPending && (
        <View style={[styles.tradeActions, { borderTopColor: colors.border }]}>
          {busy ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <>
              <Pressable
                testID={`reject-trade-${trade.id}`}
                onPress={() => onDecide(trade, 'rejected')}
                disabled={deciding !== null}
                style={({ pressed }) => [
                  styles.actionBtn,
                  {
                    borderColor: colors.destructive,
                    borderWidth: 1,
                    opacity: pressed || deciding !== null ? 0.6 : 1,
                  },
                ]}
              >
                <Feather name="x" size={15} color={colors.destructive} />
                <Text style={[styles.actionText, { color: colors.destructive }]}>
                  Reject
                </Text>
              </Pressable>
              <Pressable
                testID={`approve-trade-${trade.id}`}
                onPress={() => onDecide(trade, 'approved')}
                disabled={deciding !== null}
                style={({ pressed }) => [
                  styles.actionBtn,
                  {
                    backgroundColor: colors.success,
                    opacity: pressed || deciding !== null ? 0.6 : 1,
                  },
                ]}
              >
                <Feather name="check" size={15} color="#ffffff" />
                <Text style={[styles.actionText, { color: '#ffffff' }]}>Approve</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function TradesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { season, adminKey } = useApp();
  const queryClient = useQueryClient();

  const tradesQuery = useGetTrades({ season });
  const [keyModalVisible, setKeyModalVisible] = useState<boolean>(false);
  const [deciding, setDeciding] = useState<number | null>(null);

  const sections = useMemo(() => {
    const trades = tradesQuery.data ?? [];
    const pending = trades.filter((t) => t.status === 'pending');
    const decided = trades.filter((t) => t.status !== 'pending');
    const out: { title: string; data: TradeRow[] }[] = [];
    if (pending.length) out.push({ title: 'Needs approval', data: pending });
    if (decided.length) out.push({ title: 'History', data: decided });
    return out;
  }, [tradesQuery.data]);

  async function decide(trade: TradeRow, status: 'approved' | 'rejected') {
    if (!adminKey) {
      setKeyModalVisible(true);
      return;
    }
    setDeciding(trade.id);
    try {
      await setTradeStatus(
        trade.id,
        { status },
        { headers: { Authorization: `Bearer ${adminKey}` } },
      );
      Haptics.notificationAsync(
        status === 'approved'
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
      // Trade status changes affect standings (effective ownership) too
      await queryClient.invalidateQueries();
    } catch (err: unknown) {
      const anyErr = err as { status?: number };
      if (anyErr?.status === 401) {
        Alert.alert(
          'Invalid admin key',
          'The server rejected this key. Enter the correct admin key and try again.',
          [{ text: 'OK', onPress: () => setKeyModalVisible(true) }],
        );
      } else {
        Alert.alert('Something went wrong', `Could not ${status === 'approved' ? 'approve' : 'reject'} the trade. Please try again.`);
      }
    } finally {
      setDeciding(null);
    }
  }

  const listBottomPad = Platform.OS === 'web' ? 84 + 16 : Math.max(insets.bottom, 16) + 84;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        title="Trades"
        subtitle={`Season ${season}`}
        right={
          <View style={styles.headerRight}>
            <Pressable
              testID="open-admin-modal"
              onPress={() => setKeyModalVisible(true)}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Feather
                name="key"
                size={20}
                color={adminKey ? colors.success : colors.mutedForeground}
              />
            </Pressable>
            <SeasonToggle />
          </View>
        }
      />

      {tradesQuery.isLoading ? (
        <LoadingState />
      ) : tradesQuery.error ? (
        <ErrorState onRetry={() => tradesQuery.refetch()} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <TradeCard trade={item} onDecide={decide} deciding={deciding} />
          )}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>
              {section.title.toUpperCase()}
            </Text>
          )}
          contentContainerStyle={[styles.listContent, { paddingBottom: listBottomPad }]}
          stickySectionHeadersEnabled={false}
          scrollEnabled={sections.length > 0}
          refreshControl={
            <RefreshControl
              refreshing={tradesQuery.isRefetching}
              onRefresh={() => tradesQuery.refetch()}
              tintColor={colors.mutedForeground}
            />
          }
          ListEmptyComponent={
            <EmptyState
              icon="repeat"
              title="No trades yet"
              subtitle={`No trades recorded for the ${season} season.`}
            />
          }
        />
      )}

      <AdminKeyModal
        visible={keyModalVisible}
        onClose={() => setKeyModalVisible(false)}
        onSaved={() => setKeyModalVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  listContent: {
    paddingHorizontal: 16,
  },
  sectionHeader: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1,
    marginTop: 18,
    marginBottom: 8,
  },
  card: {
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  tradeTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  tradeTeam: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
  },
  tradeFlowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  tradeBidder: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
    flexShrink: 1,
  },
  tradeMeta: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 6,
  },
  tradeNotes: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    fontStyle: 'italic',
    marginTop: 4,
  },
  tradeActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: 46,
    alignItems: 'center',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  actionText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    padding: 18,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: 'Inter_700Bold',
  },
  modalText: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 19,
    marginTop: 10,
  },
  modalInput: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    marginTop: 14,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 14,
  },
  modalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  modalBtnText: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
});

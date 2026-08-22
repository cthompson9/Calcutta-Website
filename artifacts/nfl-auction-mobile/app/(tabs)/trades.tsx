import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
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
  useCreateTrade,
  useGetBidders,
  useGetTeams,
  useGetTrades,
  type BidderSummary,
  type Team,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTodayNY(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// ── Picker sheet (web-safe select replacement) ────────────────────────────────

function PickerModal<T extends { id: number; label: string }>({
  visible,
  title,
  items,
  selectedId,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  items: T[];
  selectedId: number | null;
  onSelect: (item: T) => void;
  onClose: () => void;
}) {
  const colors = useColors();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.pickerOverlay} onPress={onClose}>
        <Pressable
          style={[styles.pickerSheet, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => {}}
        >
          <View style={[styles.pickerHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.pickerTitle, { color: colors.foreground }]}>{title}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Feather name="x" size={20} color={colors.mutedForeground} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.pickerList}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {items.map((item) => {
              const active = item.id === selectedId;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => {
                    onSelect(item);
                    onClose();
                  }}
                  style={({ pressed }) => [
                    styles.pickerItem,
                    {
                      backgroundColor: active
                        ? `${colors.primary}18`
                        : pressed
                        ? colors.muted
                        : 'transparent',
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.pickerItemText,
                      {
                        color: active ? colors.primary : colors.foreground,
                        fontFamily: active ? 'Inter_600SemiBold' : 'Inter_400Regular',
                      },
                    ]}
                  >
                    {item.label}
                  </Text>
                  {active && (
                    <Feather name="check" size={16} color={colors.primary} />
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Submit Trade Modal ────────────────────────────────────────────────────────

interface TradeFormState {
  teamId: number | null;
  fromBidderId: number | null;
  toBidderId: number | null;
  percentage: string;
  price: string;
  tradeDate: string;
  notes: string;
}

const INITIAL_FORM: TradeFormState = {
  teamId: null,
  fromBidderId: null,
  toBidderId: null,
  percentage: '100',
  price: '',
  tradeDate: getTodayNY(),
  notes: '',
};

function SubmitTradeModal({
  visible,
  season,
  onClose,
}: {
  visible: boolean;
  season: number;
  onClose: () => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const createTrade = useCreateTrade();

  const teamsQuery = useGetTeams({ season });
  const biddersQuery = useGetBidders({});

  const [form, setForm] = useState<TradeFormState>(INITIAL_FORM);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Picker visibility
  const [teamPickerOpen, setTeamPickerOpen] = useState(false);
  const [sellerPickerOpen, setSellerPickerOpen] = useState(false);
  const [buyerPickerOpen, setBuyerPickerOpen] = useState(false);

  const teamItems = useMemo(
    () =>
      (teamsQuery.data ?? []).map((t: Team) => ({ id: t.id, label: t.name })),
    [teamsQuery.data],
  );

  const bidderItems = useMemo(
    () =>
      (biddersQuery.data ?? []).map((b: BidderSummary) => ({ id: b.id, label: b.name })),
    [biddersQuery.data],
  );

  const selectedTeam = teamItems.find((t) => t.id === form.teamId) ?? null;
  const selectedSeller = bidderItems.find((b) => b.id === form.fromBidderId) ?? null;
  const selectedBuyer = bidderItems.find((b) => b.id === form.toBidderId) ?? null;

  // Determine if the seller currently owns a stake in the selected team
  const sellerHasStake = useMemo(() => {
    if (!form.teamId || !form.fromBidderId) return true; // unknown → don't warn
    const team = (teamsQuery.data ?? []).find((t: Team) => t.id === form.teamId);
    if (!team) return true;
    return team.owners.some((o) => o.bidderId === form.fromBidderId);
  }, [form.teamId, form.fromBidderId, teamsQuery.data]);

  const pctValue = parseInt(form.percentage, 10);
  const isValid =
    form.teamId !== null &&
    form.fromBidderId !== null &&
    form.toBidderId !== null &&
    form.fromBidderId !== form.toBidderId &&
    !isNaN(pctValue) &&
    pctValue >= 1 &&
    pctValue <= 100 &&
    /^\d{4}-\d{2}-\d{2}$/.test(form.tradeDate);

  function resetAndClose() {
    setForm({ ...INITIAL_FORM, tradeDate: getTodayNY() });
    setSubmitError(null);
    onClose();
  }

  async function handleSubmit() {
    if (!isValid) return;
    setSubmitError(null);

    const priceNum = form.price.trim() !== '' ? parseFloat(form.price) : undefined;

    try {
      await createTrade.mutateAsync({
        data: {
          seasonYear: season,
          teamId: form.teamId!,
          fromBidderId: form.fromBidderId!,
          toBidderId: form.toBidderId!,
          percentage: pctValue,
          ...(priceNum !== undefined && !isNaN(priceNum) ? { price: priceNum } : {}),
          tradeDate: form.tradeDate,
          ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await queryClient.invalidateQueries();
      resetAndClose();
    } catch (err: unknown) {
      const anyErr = err as { message?: string; status?: number };
      const msg =
        anyErr?.message ??
        'Could not submit the trade. Please check your inputs and try again.';
      setSubmitError(msg);
    }
  }

  const busy = createTrade.isPending;

  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={resetAndClose}
      >
        <Pressable style={styles.modalOverlay} onPress={resetAndClose}>
          <Pressable
            style={[
              styles.submitModalCard,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            onPress={() => {}}
          >
            {/* Header */}
            <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
              <Feather name="repeat" size={18} color={colors.foreground} />
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>
                Submit Trade
              </Text>
              <Pressable
                onPress={resetAndClose}
                hitSlop={8}
                style={({ pressed }) => ({
                  opacity: pressed ? 0.6 : 1,
                  marginLeft: 'auto',
                })}
              >
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </Pressable>
            </View>

            <ScrollView
              style={styles.submitModalScroll}
              contentContainerStyle={styles.submitModalContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Team */}
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                Team
              </Text>
              <Pressable
                onPress={() => setTeamPickerOpen(true)}
                style={[
                  styles.pickerButton,
                  { borderColor: colors.input, backgroundColor: colors.background },
                ]}
              >
                <Text
                  style={[
                    styles.pickerButtonText,
                    {
                      color: selectedTeam ? colors.foreground : colors.mutedForeground,
                      fontFamily: selectedTeam ? 'Inter_500Medium' : 'Inter_400Regular',
                    },
                  ]}
                >
                  {selectedTeam ? selectedTeam.label : 'Select team…'}
                </Text>
                <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
              </Pressable>

              {/* Seller */}
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                Seller / Short Seller
              </Text>
              <Pressable
                onPress={() => setSellerPickerOpen(true)}
                style={[
                  styles.pickerButton,
                  { borderColor: colors.input, backgroundColor: colors.background },
                ]}
              >
                <Text
                  style={[
                    styles.pickerButtonText,
                    {
                      color: selectedSeller ? colors.foreground : colors.mutedForeground,
                      fontFamily: selectedSeller ? 'Inter_500Medium' : 'Inter_400Regular',
                    },
                  ]}
                >
                  {selectedSeller ? selectedSeller.label : 'Select seller…'}
                </Text>
                <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
              </Pressable>
              {/* Synthetic/short-sale notice */}
              {form.fromBidderId !== null && !sellerHasStake && (
                <View
                  style={[
                    styles.noticeBox,
                    { backgroundColor: `${colors.warning}18`, borderColor: `${colors.warning}40` },
                  ]}
                >
                  <Feather name="alert-triangle" size={13} color={colors.warning} />
                  <Text style={[styles.noticeText, { color: colors.warning }]}>
                    This seller has no current stake in the selected team — this is a
                    synthetic / short sale and will require commissioner review.
                  </Text>
                </View>
              )}

              {/* Buyer */}
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                Buyer
              </Text>
              <Pressable
                onPress={() => setBuyerPickerOpen(true)}
                style={[
                  styles.pickerButton,
                  { borderColor: colors.input, backgroundColor: colors.background },
                ]}
              >
                <Text
                  style={[
                    styles.pickerButtonText,
                    {
                      color: selectedBuyer ? colors.foreground : colors.mutedForeground,
                      fontFamily: selectedBuyer ? 'Inter_500Medium' : 'Inter_400Regular',
                    },
                  ]}
                >
                  {selectedBuyer ? selectedBuyer.label : 'Select buyer…'}
                </Text>
                <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
              </Pressable>

              {/* Percentage */}
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                Percentage (1–100)
              </Text>
              <TextInput
                value={form.percentage}
                onChangeText={(v) => setForm((f) => ({ ...f, percentage: v }))}
                placeholder="100"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                returnKeyType="done"
                style={[
                  styles.modalInput,
                  { borderColor: colors.input, color: colors.foreground, backgroundColor: colors.background },
                ]}
              />

              {/* Price (optional) */}
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                Price (optional — leave blank for server default)
              </Text>
              <TextInput
                value={form.price}
                onChangeText={(v) => setForm((f) => ({ ...f, price: v }))}
                placeholder="e.g. 250"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="decimal-pad"
                returnKeyType="done"
                style={[
                  styles.modalInput,
                  { borderColor: colors.input, color: colors.foreground, backgroundColor: colors.background },
                ]}
              />

              {/* Date */}
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                Trade Date (YYYY-MM-DD)
              </Text>
              <TextInput
                value={form.tradeDate}
                onChangeText={(v) => setForm((f) => ({ ...f, tradeDate: v }))}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                style={[
                  styles.modalInput,
                  { borderColor: colors.input, color: colors.foreground, backgroundColor: colors.background },
                ]}
              />

              {/* Notes */}
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                Notes (optional)
              </Text>
              <TextInput
                value={form.notes}
                onChangeText={(v) => setForm((f) => ({ ...f, notes: v }))}
                placeholder="Any additional context…"
                placeholderTextColor={colors.mutedForeground}
                multiline
                numberOfLines={3}
                style={[
                  styles.modalInput,
                  styles.notesInput,
                  { borderColor: colors.input, color: colors.foreground, backgroundColor: colors.background },
                ]}
              />

              {/* Submission error */}
              {submitError ? (
                <View
                  style={[
                    styles.noticeBox,
                    { backgroundColor: `${colors.destructive}18`, borderColor: `${colors.destructive}40` },
                  ]}
                >
                  <Feather name="alert-circle" size={13} color={colors.destructive} />
                  <Text style={[styles.noticeText, { color: colors.destructive }]}>
                    {submitError}
                  </Text>
                </View>
              ) : null}

              {/* Info note */}
              <Text style={[styles.infoText, { color: colors.mutedForeground }]}>
                Submitted trades start as <Text style={{ fontFamily: 'Inter_600SemiBold' }}>pending</Text> and require commissioner approval before they take effect.
              </Text>
            </ScrollView>

            {/* Actions */}
            <View style={[styles.submitModalActions, { borderTopColor: colors.border }]}>
              <Pressable
                onPress={resetAndClose}
                style={({ pressed }) => [
                  styles.modalBtn,
                  { borderColor: colors.border, borderWidth: 1, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <Text style={[styles.modalBtnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="submit-trade-btn"
                onPress={handleSubmit}
                disabled={!isValid || busy}
                style={({ pressed }) => [
                  styles.modalBtn,
                  {
                    backgroundColor: colors.primary,
                    opacity: !isValid || busy ? 0.4 : pressed ? 0.7 : 1,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                  },
                ]}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : null}
                <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>
                  {busy ? 'Submitting…' : 'Submit Trade'}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Sub-pickers rendered outside main modal to layer above it */}
      <PickerModal
        visible={teamPickerOpen}
        title="Select Team"
        items={teamItems}
        selectedId={form.teamId}
        onSelect={(item) => setForm((f) => ({ ...f, teamId: item.id }))}
        onClose={() => setTeamPickerOpen(false)}
      />
      <PickerModal
        visible={sellerPickerOpen}
        title="Select Seller / Short Seller"
        items={bidderItems}
        selectedId={form.fromBidderId}
        onSelect={(item) => setForm((f) => ({ ...f, fromBidderId: item.id }))}
        onClose={() => setSellerPickerOpen(false)}
      />
      <PickerModal
        visible={buyerPickerOpen}
        title="Select Buyer"
        items={bidderItems}
        selectedId={form.toBidderId}
        onSelect={(item) => setForm((f) => ({ ...f, toBidderId: item.id }))}
        onClose={() => setBuyerPickerOpen(false)}
      />
    </>
  );
}

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
  const [submitModalVisible, setSubmitModalVisible] = useState<boolean>(false);
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
              testID="open-submit-trade-modal"
              onPress={() => setSubmitModalVisible(true)}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Feather name="plus-circle" size={20} color={colors.foreground} />
            </Pressable>
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

      {submitModalVisible ? (
        <SubmitTradeModal
          visible
          season={season}
          onClose={() => setSubmitModalVisible(false)}
        />
      ) : null}
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
  // ── Shared modal styles ──────────────────────────────────────────────────
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
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 4,
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
    marginTop: 6,
    marginBottom: 12,
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
  // ── Submit Trade modal specifics ─────────────────────────────────────────
  submitModalCard: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    maxHeight: '88%',
  },
  submitModalScroll: {
    flexGrow: 0,
  },
  submitModalContent: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 8,
  },
  submitModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  fieldLabel: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  pickerButton: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  pickerButtonText: {
    fontSize: 14,
    flexShrink: 1,
  },
  noticeBox: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    borderWidth: 1,
    padding: 10,
    marginBottom: 14,
  },
  noticeText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    lineHeight: 17,
    flex: 1,
  },
  infoText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    lineHeight: 17,
    marginTop: 4,
    marginBottom: 4,
  },
  notesInput: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: 10,
  },
  // ── Picker sheet ─────────────────────────────────────────────────────────
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    borderTopWidth: 1,
    maxHeight: '60%',
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  pickerList: {
    flexGrow: 0,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerItemText: {
    fontSize: 15,
    flex: 1,
  },
});

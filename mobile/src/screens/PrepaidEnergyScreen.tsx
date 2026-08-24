/**
 * The prepaid customer's screen: their token, their credit, and what the meter
 * has actually taken.
 *
 * A phone is where a customer stands in front of a keypad, so the token code is
 * the first thing on it — and the one thing this screen will never manufacture.
 * Where no vending key is configured, where the ledger has not posted, or where
 * no meter measures consumption, the affected figure reads as a named unknown
 * with the reason, in the same words the web app uses.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  ACCOUNT_STATUS_COPY,
  BALANCE_BASIS_COPY,
  BALANCE_UNAVAILABLE_COPY,
  CONSUMPTION_SOURCE_COPY,
  SUPPLY_ACTION_COPY,
  SUPPLY_REASON_LABEL,
  TOKEN_CHECK_COPY,
  TOKEN_STATUS_COPY,
  copyFor,
  kwhLabel,
  vendingCopy,
  type Tone,
} from '../../../shared/prepaid-state';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
  live: { bg: '#cffafe', fg: '#155e75' },
  good: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  danger: { bg: '#fee2e2', fg: '#991b1b' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

function when(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

interface PrepaidEnergyScreenProps {
  navigation: { goBack: () => void };
}

export default function PrepaidEnergyScreen({ navigation }: PrepaidEnergyScreenProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [checkState, setCheckState] = useState<{ reason: string; energyWh: number | null } | null>(
    null
  );

  const utils = trpc.useUtils();
  const vendingQuery = trpc.prepaid.vendingStatus.useQuery();
  const accountsQuery = trpc.prepaid.myAccounts.useQuery();
  const accounts = accountsQuery.data?.accounts ?? [];
  const accountId = selectedAccountId ?? accounts[0]?.id ?? null;

  const viewQuery = trpc.prepaid.account.useQuery(
    { accountId: accountId ?? 0 },
    { enabled: accountId !== null, retry: false }
  );
  const tokensQuery = trpc.prepaid.tokens.useQuery(
    { accountId: accountId ?? 0, limit: 10 },
    { enabled: accountId !== null, retry: false }
  );
  const consumptionQuery = trpc.prepaid.consumption.useQuery(
    { accountId: accountId ?? 0, limit: 10 },
    { enabled: accountId !== null, retry: false }
  );
  const supplyQuery = trpc.prepaid.supplyEvents.useQuery(
    { accountId: accountId ?? 0, limit: 10 },
    { enabled: accountId !== null, retry: false }
  );

  const readMeter = trpc.prepaid.refreshConsumption.useMutation({
    onSuccess: () => {
      void utils.prepaid.account.invalidate();
      void utils.prepaid.consumption.invalidate();
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      accountsQuery.refetch(),
      vendingQuery.refetch(),
      accountId !== null ? viewQuery.refetch() : null,
      accountId !== null ? tokensQuery.refetch() : null,
      accountId !== null ? consumptionQuery.refetch() : null,
      accountId !== null ? supplyQuery.refetch() : null,
    ]);
    setRefreshing(false);
  };

  const checkCode = async () => {
    if (accountId === null || code.trim().length < 4) return;
    setCheckState(null);
    try {
      const result = await utils.prepaid.checkToken.fetch({
        accountId,
        tokenCode: code.trim(),
      });
      setCheckState({ reason: result.reason, energyWh: result.energyWh });
    } catch {
      // A check that did not complete says nothing about the code, so nothing
      // is asserted about it here either.
      setCheckState({ reason: 'undecidable', energyWh: null });
    }
  };

  const balance = viewQuery.data?.balance;
  const account = viewQuery.data?.account;
  const latestToken = viewQuery.data?.latestToken ?? null;
  const vendingState = vendingCopy(vendingQuery.data?.configured ?? false);
  const balanceState = balance
    ? balance.unavailableReason
      ? copyFor(BALANCE_UNAVAILABLE_COPY, balance.unavailableReason)
      : copyFor(BALANCE_BASIS_COPY, balance.basis)
    : null;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Prepaid energy</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="information-circle" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Your credit, your token and the energy your meter reported as taken. {vendingState.meaning}
        </Text>
      </View>

      {accountsQuery.isLoading ? (
        <Text style={styles.emptyText}>Reading your meters…</Text>
      ) : accounts.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.meaning}>
            You have no prepaid meter yet. An operator opens one against your meter serial and device
            profile — the token digits depend on both, so neither is guessed.
          </Text>
        </View>
      ) : (
        <>
          {accounts.length > 1 && (
            <View style={styles.tabRow}>
              {accounts.map((row) => {
                const active = row.id === accountId;
                return (
                  <TouchableOpacity
                    key={row.id}
                    onPress={() => setSelectedAccountId(row.id)}
                    style={[styles.tab, active && styles.tabActive]}
                  >
                    <Text style={[styles.tabText, active && styles.tabTextActive]}>
                      {row.meterSerial}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {viewQuery.isError ? (
            <View style={styles.card}>
              {/* A failed read is an unknown balance, not an empty one. */}
              <Text style={styles.emptyText}>
                {viewQuery.error?.message || 'Could not read this account'} — your balance is unknown
                right now. This does not mean you have no credit.
              </Text>
            </View>
          ) : viewQuery.isLoading || !balance ? (
            <Text style={styles.emptyText}>Reading your account…</Text>
          ) : (
            <>
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.target}>Energy remaining</Text>
                  {balanceState && <Chip label={balanceState.label} tone={balanceState.tone} />}
                </View>
                <Text style={styles.bigValue}>
                  {kwhLabel(balance.remainingWh) === null
                    ? 'unknown'
                    : `${kwhLabel(balance.remainingWh)} kWh`}
                </Text>
                <Text style={styles.meaning}>{balanceState?.meaning}</Text>
                <View style={styles.metricsRow}>
                  <View style={styles.metric}>
                    <Text style={styles.metricLabel}>Bought</Text>
                    <Text style={styles.metricValue}>{kwhLabel(balance.creditedWh)} kWh</Text>
                  </View>
                  <View style={styles.metric}>
                    <Text style={styles.metricLabel}>Taken</Text>
                    <Text style={styles.metricValue}>{kwhLabel(balance.consumedWh)} kWh</Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.button}
                  disabled={readMeter.isPending}
                  onPress={() => {
                    if (accountId !== null) readMeter.mutate({ accountId });
                  }}
                >
                  <Ionicons name="refresh" size={16} color="#ffffff" />
                  <Text style={styles.buttonText}>
                    {readMeter.isPending ? 'Reading meter…' : 'Read my meter'}
                  </Text>
                </TouchableOpacity>
                {readMeter.isError && (
                  <Text style={styles.meaning}>{readMeter.error?.message}</Text>
                )}
              </View>

              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.target}>Your latest token</Text>
                  {latestToken && (
                    <Chip
                      label={copyFor(TOKEN_STATUS_COPY, latestToken.status).label}
                      tone={copyFor(TOKEN_STATUS_COPY, latestToken.status).tone}
                    />
                  )}
                </View>
                {latestToken ? (
                  <>
                    <Text style={styles.tokenCode}>{latestToken.tokenCode}</Text>
                    <Text style={styles.meaning}>
                      {kwhLabel(latestToken.energyWh)} kWh · vended {when(latestToken.issuedAt)}
                    </Text>
                    <Text style={styles.meaning}>
                      {copyFor(TOKEN_STATUS_COPY, latestToken.status).meaning}
                    </Text>
                  </>
                ) : (
                  <Text style={styles.meaning}>
                    No token has been vended on this meter yet. Buying credit vends one against the
                    confirmed payment — and only against a confirmed one.
                  </Text>
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.target}>Check a code</Text>
                <Text style={styles.meaning}>
                  Ask what your meter would do with a code, without crediting anything.
                </Text>
                <View style={styles.inputRow}>
                  <TextInput
                    style={styles.input}
                    value={code}
                    onChangeText={setCode}
                    placeholder="123456789"
                    keyboardType="number-pad"
                  />
                  <TouchableOpacity
                    style={[styles.button, styles.buttonInline]}
                    onPress={() => void checkCode()}
                  >
                    <Text style={styles.buttonText}>Check</Text>
                  </TouchableOpacity>
                </View>
                {checkState && (
                  <>
                    <Chip
                      label={copyFor(TOKEN_CHECK_COPY, checkState.reason).label}
                      tone={copyFor(TOKEN_CHECK_COPY, checkState.reason).tone}
                    />
                    <Text style={styles.meaning}>
                      {copyFor(TOKEN_CHECK_COPY, checkState.reason).meaning}
                      {checkState.energyWh === null
                        ? ''
                        : ` It carries ${kwhLabel(checkState.energyWh)} kWh.`}
                    </Text>
                  </>
                )}
              </View>

              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.target}>Supply</Text>
                  {account && (
                    <Chip
                      label={copyFor(ACCOUNT_STATUS_COPY, account.status).label}
                      tone={copyFor(ACCOUNT_STATUS_COPY, account.status).tone}
                    />
                  )}
                </View>
                {(supplyQuery.data?.events ?? []).length === 0 ? (
                  <Text style={styles.meaning}>No supply decision has been recorded.</Text>
                ) : (
                  (supplyQuery.data?.events ?? []).map((event) => (
                    <View key={event.id} style={styles.row}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.detailValue}>
                          {copyFor(SUPPLY_ACTION_COPY, event.action).label} ·{' '}
                          {SUPPLY_REASON_LABEL[event.reason] ?? event.reason}
                        </Text>
                        <Text style={styles.metricLabel}>
                          {when(event.createdAt)} ·{' '}
                          {event.enforcedAtMeter
                            ? 'enforced at the meter'
                            : 'not enforced at the meter'}
                        </Text>
                      </View>
                    </View>
                  ))
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Tokens</Text>
                {(tokensQuery.data?.tokens ?? []).length === 0 ? (
                  <Text style={styles.meaning}>No token has been vended yet.</Text>
                ) : (
                  (tokensQuery.data?.tokens ?? []).map((token) => {
                    const state = copyFor(TOKEN_STATUS_COPY, token.status);
                    return (
                      <View key={token.id} style={styles.row}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.detailValue}>{token.tokenCode}</Text>
                          <Text style={styles.metricLabel}>
                            {kwhLabel(token.energyWh)} kWh · {when(token.issuedAt)}
                          </Text>
                        </View>
                        <Chip label={state.label} tone={state.tone} />
                      </View>
                    );
                  })
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.sectionLabel}>Metered consumption</Text>
                {(consumptionQuery.data?.periods ?? []).length === 0 ? (
                  <Text style={styles.meaning}>
                    No metered period is recorded. A period with no reading is left unaccounted
                    rather than charged as an estimate or given away as zero.
                  </Text>
                ) : (
                  (consumptionQuery.data?.periods ?? []).map((period) => {
                    const source = copyFor(CONSUMPTION_SOURCE_COPY, period.source);
                    return (
                      <View key={period.id} style={styles.row}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.detailValue}>
                            {kwhLabel(period.energyWh)} kWh
                          </Text>
                          <Text style={styles.metricLabel}>
                            to {when(period.toAt)} · register {period.registerStartWh} →{' '}
                            {period.registerEndWh} Wh
                          </Text>
                        </View>
                        <Chip label={source.label} tone={source.tone} />
                      </View>
                    );
                  })
                )}
              </View>
            </>
          )}
        </>
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
    backgroundColor: '#ffffff',
  },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  introCard: {
    flexDirection: 'row',
    gap: 10,
    margin: 16,
    marginBottom: 8,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
  },
  introText: { flex: 1, fontSize: 13, lineHeight: 19, color: '#1e3a8a' },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: '#f3f4f6' },
  tabActive: { backgroundColor: '#1e40af' },
  tabText: { fontSize: 13, color: '#374151' },
  tabTextActive: { color: '#ffffff', fontWeight: '600' },
  card: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    borderRadius: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  target: { fontSize: 15, fontWeight: '700', color: '#111827' },
  bigValue: { fontSize: 30, fontWeight: '700', color: '#111827', marginBottom: 4 },
  tokenCode: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: 4,
    color: '#111827',
    marginBottom: 6,
  },
  metricsRow: { flexDirection: 'row', gap: 16, marginTop: 4, marginBottom: 8 },
  metric: { flex: 1 },
  metricLabel: { fontSize: 12, color: '#6b7280' },
  metricValue: { fontSize: 15, fontWeight: '600', color: '#111827' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
  detailValue: { fontSize: 13, color: '#111827', fontWeight: '500' },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  meaning: { fontSize: 12, lineHeight: 18, color: '#6b7280', marginBottom: 4 },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', paddingHorizontal: 16 },
  chip: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 8 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#1e40af',
    borderRadius: 8,
    paddingVertical: 12,
    marginTop: 8,
  },
  buttonInline: { marginTop: 0, paddingHorizontal: 16 },
  buttonText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
});

/**
 * "Does the money we say we hold add up?" — the operator's field view.
 *
 * Same three records as the web console: the ledger's balances, the platform's own
 * postings, and the settlements members were shown. Disagreement leads; nothing
 * here repairs anything, and retrying an unconfirmed entry only re-presents it to
 * the ledger, which answers a duplicate rather than moving money twice.
 *
 * A deployment with no ledger reads as having no balance, not a balance of zero.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  POSTING_STATE_COPY,
  VERDICT_COPY,
  formatMinor,
  postingKindLabel,
  reconciliationHeadline,
  summariseReconciliation,
  type LedgerPosting,
  type MemberReconciliation,
  type Tone,
} from '../../../shared/ledger-state';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
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

export default function LedgerReconciliationScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const { data: currentUser } = trpc.auth.me.useQuery();
  const isAdmin = currentUser?.role === 'admin';

  const status = trpc.ledger.status.useQuery(undefined, { enabled: isAdmin });
  const reconciliation = trpc.ledger.reconciliation.useQuery(undefined, { enabled: isAdmin });
  const unposted = trpc.ledger.unposted.useQuery(undefined, { enabled: isAdmin });
  const sweep = trpc.ledger.sweepUnconfirmed.useMutation();

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      isAdmin ? reconciliation.refetch() : Promise.resolve(),
      isAdmin ? unposted.refetch() : Promise.resolve(),
    ]);
    setRefreshing(false);
  };

  const members = (reconciliation.data?.members ?? []) as unknown as MemberReconciliation[];
  const postings = (unposted.data?.postings ?? []) as unknown as LedgerPosting[];
  const configured = status.data?.configured ?? false;
  const summary = summariseReconciliation(members);
  const headline = reconciliationHeadline(summary, configured);

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Ledger</Text>
        <View style={{ width: 40 }} />
      </View>

      {!isAdmin ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            Ledger balances and reconciliation findings are visible to platform administrators only.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.introCard}>
            <Ionicons name="scale-outline" size={20} color="#1e40af" />
            <Text style={styles.introText}>
              Balances come from the double-entry ledger and are compared against the platform&apos;s
              own postings and the settlements members were shown. Differences are reported, never
              corrected.
            </Text>
          </View>

          {status.data && !configured && (
            <View style={styles.dangerCard}>
              <Text style={styles.dangerTitle}>No double-entry ledger</Text>
              <Text style={styles.dangerText}>{status.data.detail}</Text>
            </View>
          )}

          {reconciliation.isError ? (
            /* A failed read is missing information, never an all-clear. */
            <View style={styles.dangerCard}>
              <Text style={styles.dangerTitle}>Balances could not be reconciled</Text>
              <Text style={styles.dangerText}>
                {reconciliation.error?.message} — nothing is known about these balances right now.
              </Text>
            </View>
          ) : reconciliation.isLoading ? (
            <Text style={styles.emptyText}>Loading balances…</Text>
          ) : (
            <>
              <View style={headline.tone === 'good' ? styles.card : styles.warnCard}>
                <Text style={styles.headline}>{headline.text}</Text>
                <Text style={styles.meaning}>
                  {reconciliation.data?.note ?? 'No note recorded for this check.'}
                </Text>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Agree / disagree / unreadable</Text>
                  <Text style={styles.detailValue}>
                    {summary.matched} / {summary.mismatches} / {summary.unknowns}
                  </Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Recorded but on no balance</Text>
                  <Text style={styles.detailValue}>{summary.unconfirmedMinor} minor units</Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Member balances ({members.length})</Text>
              {members.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.emptyText}>
                    No member holds a ledger account yet. That is an empty ledger, not a reconciled
                    one.
                  </Text>
                </View>
              ) : (
                members.map(member => {
                  const copy = VERDICT_COPY[member.verdict];
                  return (
                    <View key={`${member.userId}:${member.currency}`} style={styles.card}>
                      <View style={styles.cardHeader}>
                        <Text style={styles.target}>Member #{member.userId}</Text>
                        <Chip label={copy.label} tone={copy.tone} />
                      </View>
                      <Text style={styles.meaning}>{member.note}</Text>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Ledger</Text>
                        <Text style={styles.detailValue}>
                          {formatMinor(member.ledgerBalanceMinor, member.currency)}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Our postings</Text>
                        <Text style={styles.detailValue}>
                          {formatMinor(member.postedBalanceMinor, member.currency)}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Shown to member</Text>
                        <Text style={styles.detailValue}>
                          {formatMinor(member.businessBalanceMinor, member.currency)}
                        </Text>
                      </View>
                    </View>
                  );
                })
              )}

              <Text style={styles.sectionTitle}>
                Entries not on the ledger ({postings.length})
              </Text>
              {postings.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.emptyText}>Every recorded movement is on the ledger.</Text>
                </View>
              ) : (
                postings.map(posting => {
                  const copy = POSTING_STATE_COPY[posting.state];
                  return (
                    <View key={posting.id} style={styles.card}>
                      <View style={styles.cardHeader}>
                        <Text style={styles.target}>{postingKindLabel(posting.postingKind)}</Text>
                        <Chip label={copy.label} tone={copy.tone} />
                      </View>
                      <Text style={styles.meaning}>{posting.detail ?? copy.meaning}</Text>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Amount</Text>
                        <Text style={styles.detailValue}>
                          {formatMinor(posting.amountMinor, posting.currency)}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Source</Text>
                        <Text style={styles.detailValue}>
                          {posting.sourceType} #{posting.sourceId}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Provider reference</Text>
                        <Text style={styles.detailValue}>{posting.providerReference ?? '—'}</Text>
                      </View>
                    </View>
                  );
                })
              )}

              {configured && postings.length > 0 && (
                <TouchableOpacity
                  style={[styles.action, sweeping && styles.actionDisabled]}
                  disabled={sweeping}
                  onPress={async () => {
                    setSweeping(true);
                    try {
                      await HapticService.buttonPress();
                      await sweep.mutateAsync({});
                      await Promise.all([unposted.refetch(), reconciliation.refetch()]);
                    } finally {
                      setSweeping(false);
                    }
                  }}
                >
                  <Text style={styles.actionText}>
                    {sweeping ? 'Retrying…' : 'Retry unconfirmed entries'}
                  </Text>
                </TouchableOpacity>
              )}
              {sweep.data && (
                <Text style={styles.actionNote}>
                  {sweep.data.attempted} attempted · {sweep.data.posted} posted ·{' '}
                  {sweep.data.stillPending} still unconfirmed · {sweep.data.refused} refused
                </Text>
              )}
              {sweep.isError && <Text style={styles.actionError}>{sweep.error?.message}</Text>}
            </>
          )}
        </>
      )}

      <View style={{ height: 24 }} />
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
  backButton: { width: 40, height: 40, justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: '#111827' },
  introCard: {
    flexDirection: 'row',
    gap: 10,
    margin: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#eff6ff',
  },
  introText: { flex: 1, fontSize: 13, color: '#1e3a8a', lineHeight: 18 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginTop: 20,
    marginHorizontal: 16,
  },
  card: {
    margin: 16,
    marginBottom: 0,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#ffffff',
  },
  warnCard: {
    margin: 16,
    marginBottom: 0,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#fef3c7',
  },
  dangerCard: {
    margin: 16,
    marginBottom: 0,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#fee2e2',
  },
  dangerTitle: { fontSize: 14, fontWeight: '600', color: '#991b1b' },
  dangerText: { fontSize: 12, color: '#991b1b', marginTop: 4, lineHeight: 17 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headline: { fontSize: 15, fontWeight: '600', color: '#111827' },
  target: { fontSize: 15, fontWeight: '600', color: '#111827', flexShrink: 1 },
  meaning: { fontSize: 12, color: '#6b7280', marginTop: 6, lineHeight: 17 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  detailLabel: { fontSize: 12, color: '#6b7280' },
  detailValue: {
    fontSize: 12,
    color: '#111827',
    fontWeight: '500',
    flexShrink: 1,
    textAlign: 'right',
  },
  action: {
    margin: 16,
    marginBottom: 0,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#111827',
    alignItems: 'center',
  },
  actionDisabled: { opacity: 0.6 },
  actionText: { fontSize: 14, fontWeight: '600', color: '#ffffff' },
  actionNote: { fontSize: 12, color: '#6b7280', marginTop: 8, marginHorizontal: 16 },
  actionError: { fontSize: 12, color: '#991b1b', marginTop: 8, marginHorizontal: 16 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 16 },
});

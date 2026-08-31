import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

const formatKwh = (wh: number | null | undefined) =>
  wh == null ? '—' : `${(wh / 1000).toFixed(2)} kWh`;

const formatPct = (pct100: number | null | undefined) =>
  pct100 == null ? '—' : `${(pct100 / 100).toFixed(1)}%`;

const formatDate = (d: unknown) => (d ? new Date(d as string).toLocaleDateString() : '—');

export default function ChallengesScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const utils = trpc.useUtils();

  const listQuery = trpc.challenges.list.useQuery({ limit: 50 });
  const challenges = listQuery.data ?? [];

  const selected = challenges.find((c) => c.id === selectedId) ?? challenges[0] ?? null;

  const leaderboardQuery = trpc.challenges.leaderboard.useQuery(
    { challengeId: selected!.id },
    { enabled: selected != null }
  );
  const leaderboard = leaderboardQuery.data?.leaderboard ?? [];

  const myProgressQuery = trpc.challenges.myProgress.useQuery(
    { challengeId: selected!.id },
    { enabled: selected != null }
  );
  const myProgress = myProgressQuery.data ?? null;

  const joinMutation = trpc.challenges.join.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      Alert.alert('Joined', 'You joined the challenge.');
      utils.challenges.leaderboard.invalidate();
      utils.challenges.myProgress.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const withdrawMutation = trpc.challenges.withdraw.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      utils.challenges.leaderboard.invalidate();
      utils.challenges.myProgress.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      listQuery.refetch(),
      leaderboardQuery.refetch(),
      myProgressQuery.refetch(),
    ]);
    setRefreshing(false);
  };

  const handleJoin = (challengeId: number) => {
    joinMutation.mutate({ challengeId });
  };

  const handleWithdraw = (challengeId: number) => {
    Alert.alert('Withdraw', 'Withdraw from this challenge?', [
      { text: 'Stay', style: 'cancel' },
      {
        text: 'Withdraw',
        style: 'destructive',
        onPress: () => withdrawMutation.mutate({ challengeId }),
      },
    ]);
  };

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Challenges</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Challenge list */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Community Challenges</Text>
        {listQuery.isLoading ? (
          <Text style={styles.emptyText}>Loading challenges…</Text>
        ) : listQuery.isError ? (
          <Text style={styles.emptyText}>Could not load challenges</Text>
        ) : challenges.length === 0 ? (
          <Text style={styles.emptyText}>No challenges yet.</Text>
        ) : (
          challenges.map((c) => (
            <TouchableOpacity
              key={c.id}
              style={[styles.challengeRow, selected?.id === c.id && styles.challengeRowActive]}
              onPress={() => setSelectedId(c.id)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.challengeTitle}>{c.title}</Text>
                <Text style={styles.challengeMeta}>
                  Goal: reduce {formatPct(c.goalPercent100)} vs baseline · {c.status}
                </Text>
                <Text style={styles.challengeMeta}>
                  Measure {formatDate(c.periodStart)} – {formatDate(c.periodEnd)}
                </Text>
              </View>
              {c.status === 'open' && (
                <TouchableOpacity
                  style={styles.joinButton}
                  onPress={() => handleJoin(c.id)}
                  disabled={joinMutation.isPending}
                >
                  <Text style={styles.joinButtonText}>Join</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ))
        )}
      </View>

      {/* Selected challenge detail */}
      {selected && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>{selected.title}</Text>
          {selected.description ? (
            <Text style={styles.bodyText}>{selected.description}</Text>
          ) : null}
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Baseline window</Text>
            <Text style={styles.detailValue}>
              {formatDate(selected.baselineStart)} – {formatDate(selected.baselineEnd)}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Measurement window</Text>
            <Text style={styles.detailValue}>
              {formatDate(selected.periodStart)} – {formatDate(selected.periodEnd)}
            </Text>
          </View>

          {/* My progress */}
          <Text style={[styles.inputLabel, { marginTop: 10 }]}>My progress</Text>
          {myProgressQuery.isLoading ? (
            <Text style={styles.emptyText}>Computing your progress…</Text>
          ) : myProgress == null ? (
            <Text style={styles.emptyText}>
              You have not joined this challenge.
              {selected.status === 'open' ? ' Join to participate.' : ''}
            </Text>
          ) : myProgress.progressAvailable ? (
            <>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Baseline (daily avg)</Text>
                <Text style={styles.detailValue}>{formatKwh(myProgress.baselineDailyWh)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Current (daily avg)</Text>
                <Text style={styles.detailValue}>{formatKwh(myProgress.currentDailyWh)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Reduction achieved</Text>
                <Text
                  style={[
                    styles.detailValue,
                    {
                      color:
                        (myProgress.reductionPercent100 ?? 0) >= 0 ? '#10b981' : '#dc2626',
                    },
                  ]}
                >
                  {formatPct(myProgress.reductionPercent100)}
                </Text>
              </View>
              <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.detailLabel}>Goal ({formatPct(selected.goalPercent100)})</Text>
                <Text style={styles.detailValue}>
                  {myProgress.goalMet == null ? '—' : myProgress.goalMet ? 'Met' : 'Not yet'}
                </Text>
              </View>
            </>
          ) : (
            <View style={styles.unavailableBox}>
              <Ionicons name="information-circle-outline" size={16} color="#92400e" />
              <Text style={styles.unavailableText}>
                Progress unavailable: {myProgress.unavailableReason ?? 'no data yet'}
              </Text>
            </View>
          )}

          {myProgress != null && myProgress.entryStatus === 'active' && (
            <TouchableOpacity
              style={styles.withdrawButton}
              onPress={() => handleWithdraw(selected.id)}
              disabled={withdrawMutation.isPending}
            >
              <Text style={styles.withdrawButtonText}>Withdraw</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Leaderboard */}
      {selected && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Leaderboard</Text>
          <Text style={styles.bodyText}>
            Computed from real meter readings; participants without baseline data are
            unranked.
          </Text>
          {leaderboardQuery.isLoading ? (
            <Text style={styles.emptyText}>Computing leaderboard…</Text>
          ) : leaderboardQuery.isError ? (
            <Text style={styles.emptyText}>Could not compute leaderboard</Text>
          ) : leaderboard.length === 0 ? (
            <Text style={styles.emptyText}>No participants yet.</Text>
          ) : (
            leaderboard.map((p) => (
              <View key={p.userId} style={styles.leaderRow}>
                <Text style={styles.rankText}>
                  {p.rank != null ? `#${p.rank}` : '—'}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.leaderName}>
                    User #{p.userId}
                    {p.entryStatus === 'withdrawn' ? ' (withdrawn)' : ''}
                  </Text>
                  {!p.progressAvailable && (
                    <Text style={styles.leaderReason} numberOfLines={2}>
                      {p.unavailableReason ?? 'progress unavailable'}
                    </Text>
                  )}
                </View>
                <Text
                  style={[
                    styles.leaderScore,
                    !p.progressAvailable && { color: '#9ca3af' },
                  ]}
                >
                  {p.progressAvailable ? formatPct(p.reductionPercent100) : '—'}
                </Text>
              </View>
            ))
          )}
        </View>
      )}

      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    marginTop: 8,
  },
  backButton: {
    padding: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  card: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  bodyText: {
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 20,
    marginBottom: 12,
  },
  inputLabel: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 6,
    marginTop: 4,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 20,
  },
  challengeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 8,
  },
  challengeRowActive: {
    backgroundColor: '#f0fdf4',
  },
  challengeTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  challengeMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  joinButton: {
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  joinButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 8,
  },
  detailLabel: {
    fontSize: 14,
    color: '#6b7280',
    flexShrink: 1,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    textAlign: 'right',
    flexShrink: 1,
  },
  unavailableBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    padding: 12,
    gap: 8,
    marginTop: 4,
  },
  unavailableText: {
    fontSize: 13,
    color: '#92400e',
    flex: 1,
    lineHeight: 18,
  },
  withdrawButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#dc2626',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  withdrawButtonText: {
    color: '#dc2626',
    fontSize: 14,
    fontWeight: '600',
  },
  leaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    gap: 10,
  },
  rankText: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#10b981',
    width: 34,
  },
  leaderName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  leaderReason: {
    fontSize: 12,
    color: '#92400e',
    marginTop: 2,
  },
  leaderScore: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#111827',
  },
});

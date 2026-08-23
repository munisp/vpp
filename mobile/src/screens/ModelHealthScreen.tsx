/**
 * "Is there a trained model behind this, and can we still prove it?" — the field view.
 *
 * Same records and the same copy map as the web console, so neither surface can
 * describe a model more favourably than the other: where the training data came
 * from, whether the checkpoint still hashes to the bytes that were evaluated, and
 * live accuracy only where actuals exist.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  ARTIFACT_STATE_COPY,
  JOB_STATUS_COPY,
  ORIGIN_COPY,
  TRAINING_RUN_STATE_COPY,
  USAGE_COPY,
  copyFor,
  metricLabel,
  provenanceLine,
  whenLabel,
  type ArtifactState,
  type DataOrigin,
  type Tone,
  type UsageState,
} from '../../../shared/model-health-state';

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

export default function ModelHealthScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const { data: currentUser } = trpc.auth.me.useQuery();
  const isAdmin = currentUser?.role === 'admin';

  const overview = trpc.modelHealth.overview.useQuery({ limit: 25 }, { enabled: isAdmin });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    if (isAdmin) await overview.refetch();
    setRefreshing(false);
  };

  const models = overview.data?.models ?? [];
  const jobs = overview.data?.jobs ?? [];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Model health</Text>
        <View style={{ width: 40 }} />
      </View>

      {!isAdmin ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            Model provenance and training state are visible to platform administrators only.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.introCard}>
            <Ionicons name="cube-outline" size={20} color="#1e40af" />
            <Text style={styles.introText}>
              A registry row is not evidence that a model exists. Weights are re-hashed against the
              digest the training run recorded, and accuracy is measured only over predictions whose
              actual has arrived.
            </Text>
          </View>

          {overview.isError ? (
            /* A failed read is missing information, never an all-clear. */
            <View style={styles.dangerCard}>
              <Text style={styles.dangerTitle}>Model state could not be read</Text>
              <Text style={styles.dangerText}>
                {overview.error?.message} — nothing is known about what is serving right now.
              </Text>
            </View>
          ) : overview.isLoading ? (
            <Text style={styles.emptyText}>Loading model state…</Text>
          ) : (
            <>
              <View
                style={
                  (overview.data?.unverifiedProduction ?? 0) > 0 ? styles.warnCard : styles.card
                }
              >
                <Text style={styles.headline}>{overview.data?.detail}</Text>
              </View>

              <Text style={styles.sectionTitle}>Versions ({models.length})</Text>
              {models.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.emptyText}>
                    No model version has ever been registered, so nothing here is serving a trained
                    model.
                  </Text>
                </View>
              ) : (
                models.map(model => {
                  const origin = (model.dataset?.origin ?? 'unknown') as DataOrigin;
                  const originCopy = ORIGIN_COPY[origin];
                  const artifactCopy = ARTIFACT_STATE_COPY[model.artifact.state as ArtifactState];
                  const usageCopy = USAGE_COPY[model.usage as UsageState];
                  const runCopy = model.run
                    ? copyFor(TRAINING_RUN_STATE_COPY, model.run.state)
                    : null;
                  return (
                    <View key={model.id} style={styles.card}>
                      <View style={styles.cardHeader}>
                        <Text style={styles.target}>
                          {model.modelName} {model.version}
                        </Text>
                        <Chip label={artifactCopy.label} tone={artifactCopy.tone} />
                      </View>
                      <Text style={styles.meaning}>{model.detail}</Text>
                      <View style={styles.chipRow}>
                        <Chip label={model.status} tone="neutral" />
                        <Chip label={originCopy.label} tone={originCopy.tone} />
                        <Chip label={usageCopy.label} tone={usageCopy.tone} />
                        {runCopy && <Chip label={runCopy.label} tone={runCopy.tone} />}
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Trained on</Text>
                        <Text style={styles.detailValue}>
                          {provenanceLine(origin, {
                            sourceObjects: model.dataset?.sourceObjects,
                            generator: model.dataset?.generator,
                            generatorVersion: model.dataset?.generatorVersion,
                            seed: model.dataset?.seed,
                          })}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Held-out MAE</Text>
                        <Text style={styles.detailValue}>
                          {metricLabel(model.accuracy.heldOutMae, 1)}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Live accuracy</Text>
                        <Text style={styles.detailValue}>
                          {metricLabel(model.accuracy.liveMae, 1)}
                        </Text>
                      </View>
                      <Text style={styles.meaning}>{model.accuracy.detail}</Text>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Last prediction</Text>
                        <Text style={styles.detailValue}>{whenLabel(model.lastPredictionAt)}</Text>
                      </View>
                      {model.rolledBackFrom && (
                        <View style={styles.detailRow}>
                          <Text style={styles.detailLabel}>Rolled back from</Text>
                          <Text style={styles.detailValue}>{model.rolledBackFrom.version}</Text>
                        </View>
                      )}
                      <Text style={styles.meaning}>{artifactCopy.meaning}</Text>
                    </View>
                  );
                })
              )}

              <Text style={styles.sectionTitle}>Retraining ({jobs.length})</Text>
              {jobs.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.emptyText}>
                    No retraining job has been recorded against this platform.
                  </Text>
                </View>
              ) : (
                jobs.map(job => {
                  const statusCopy = copyFor(JOB_STATUS_COPY, job.status);
                  return (
                    <View key={job.jobId} style={styles.card}>
                      <View style={styles.cardHeader}>
                        <Text style={styles.target}>{job.modelName ?? `model ${job.modelId}`}</Text>
                        <Chip label={statusCopy.label} tone={statusCopy.tone} />
                      </View>
                      <Text style={styles.meaning}>
                        {job.errorMessage ?? job.promotionNote ?? statusCopy.meaning}
                      </Text>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Trigger</Text>
                        <Text style={styles.detailValue}>{job.triggerType}</Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>New version</Text>
                        <Text style={styles.detailValue}>{job.newModelVersion ?? 'none'}</Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Finished</Text>
                        <Text style={styles.detailValue}>
                          {whenLabel(job.completedAt ?? job.startedAt ?? job.createdAt)}
                        </Text>
                      </View>
                    </View>
                  );
                })
              )}
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
  card: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 10, backgroundColor: '#ffffff' },
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
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
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 16 },
});

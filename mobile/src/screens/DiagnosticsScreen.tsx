/**
 * "Something is wrong" — the on-call view, from the same copy map as the web console.
 *
 * An operator can ask a local model a question and get either an answer whose
 * findings cite observations that were actually supplied, or a refusal that names
 * what was missing. There is no third outcome: no model and no readable evidence
 * means no diagnosis, not a reassuring one.
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
  CONFIDENCE_TONE,
  availabilityCopy,
  diagnosticStateCopy,
  latencyLabel,
  measureLabel,
  modelStatusCopy,
  whenLabel,
  type Tone,
} from '../../../shared/diagnostics-state';

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

export default function DiagnosticsScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [question, setQuestion] = useState('Why has settlement stopped completing for some trades?');
  const { data: currentUser } = trpc.auth.me.useQuery();
  const isAdmin = currentUser?.role === 'admin';

  const health = trpc.diagnostics.health.useQuery(undefined, { enabled: isAdmin });
  const evidence = trpc.diagnostics.evidence.useQuery(undefined, { enabled: isAdmin });
  const runs = trpc.diagnostics.runs.useQuery({ limit: 10 }, { enabled: isAdmin });
  const diagnose = trpc.diagnostics.diagnose.useMutation({
    onSuccess: () => {
      void runs.refetch();
      void evidence.refetch();
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      isAdmin ? health.refetch() : Promise.resolve(),
      isAdmin ? evidence.refetch() : Promise.resolve(),
      isAdmin ? runs.refetch() : Promise.resolve(),
    ]);
    setRefreshing(false);
  };

  const modelStatus = health.data
    ? modelStatusCopy(health.data)
    : { label: 'unknown', tone: 'neutral' as Tone };
  const observations = evidence.data?.observations ?? [];
  const result = diagnose.data;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Diagnostics</Text>
        <View style={{ width: 40 }} />
      </View>

      {!isAdmin ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            Diagnostic runs read payment, ledger and control state, so they are visible to platform
            administrators only.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.introCard}>
            <Ionicons name="hardware-chip-outline" size={20} color="#1e40af" />
            <Text style={styles.introText}>
              A local model answers from measurements taken out of this platform's tables. No model,
              or no readable evidence, is a refusal — never a plausible answer.
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.target}>{health.data?.requestedModel || 'no model set'}</Text>
              <Chip label={modelStatus.label} tone={modelStatus.tone} />
            </View>
            <Text style={styles.meaning}>{health.data?.detail ?? 'Probing the endpoint…'}</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Endpoint</Text>
              <Text style={styles.detailValue}>{health.data?.baseUrl || 'unset'}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Models pulled</Text>
              <Text style={styles.detailValue}>
                {health.data?.models.length ? health.data.models.join(', ') : 'none reported'}
              </Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Ask</Text>
          <View style={styles.card}>
            <TextInput
              style={styles.input}
              value={question}
              onChangeText={setQuestion}
              multiline
              placeholder="What should I look at?"
            />
            <TouchableOpacity
              style={[
                styles.button,
                (diagnose.isPending || question.trim().length < 8) && styles.buttonDisabled,
              ]}
              disabled={diagnose.isPending || question.trim().length < 8}
              onPress={async () => {
                await HapticService.buttonPress();
                diagnose.mutate({ question });
              }}
            >
              <Text style={styles.buttonText}>
                {diagnose.isPending ? 'Asking the local model…' : 'Diagnose'}
              </Text>
            </TouchableOpacity>
            {diagnose.isError ? (
              <Text style={styles.dangerText}>{diagnose.error?.message}</Text>
            ) : null}
          </View>

          {result?.state === 'refused' ? (
            <View style={styles.warnCard}>
              <Text style={styles.headline}>Refused — no diagnosis was produced</Text>
              <Text style={styles.meaning}>{result.reason}</Text>
            </View>
          ) : null}

          {result?.state === 'succeeded' ? (
            <>
              <View style={styles.card}>
                <Text style={styles.headline}>
                  {result.model} · {latencyLabel(result.latencyMs)}
                </Text>
                <Text style={styles.meaning}>{result.answer}</Text>
              </View>

              {result.findings.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.emptyText}>
                    No finding was reported against these observations. That is not a clean bill of
                    health for anything they do not cover.
                  </Text>
                </View>
              ) : (
                result.findings.map((finding, index) => (
                  <View key={`${finding.title}-${index}`} style={styles.card}>
                    <View style={styles.cardHeader}>
                      <Text style={styles.target}>{finding.title}</Text>
                      <Chip
                        label={finding.confidence}
                        tone={(CONFIDENCE_TONE[finding.confidence] ?? 'neutral') as Tone}
                      />
                    </View>
                    <Text style={styles.meaning}>{finding.hypothesis}</Text>
                    <Text style={styles.action}>Check: {finding.recommendedAction}</Text>
                    <Text style={styles.cites}>cites: {finding.observationIds.join(', ')}</Text>
                  </View>
                ))
              )}

              {result.rejectedCitations > 0 ? (
                <View style={styles.warnCard}>
                  <Text style={styles.meaning}>
                    {result.rejectedCitations} citation(s) named observations that were never
                    supplied and were dropped.
                  </Text>
                </View>
              ) : null}
            </>
          ) : null}

          <Text style={styles.sectionTitle}>Observations ({observations.length})</Text>
          {evidence.isError ? (
            <View style={styles.dangerCard}>
              <Text style={styles.dangerTitle}>Evidence could not be collected</Text>
              <Text style={styles.dangerText}>{evidence.error?.message}</Text>
            </View>
          ) : (
            observations.map(observation => {
              const copy = availabilityCopy(observation.available);
              return (
                <View key={observation.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.target}>{observation.title}</Text>
                    <Chip label={copy.label} tone={copy.tone} />
                  </View>
                  <Text style={styles.cites}>{observation.id}</Text>
                  <Text style={styles.meaning}>{observation.detail}</Text>
                  {Object.entries(observation.measures).map(([key, value]) => (
                    <View key={key} style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{key}</Text>
                      <Text style={styles.detailValue}>{measureLabel(value)}</Text>
                    </View>
                  ))}
                </View>
              );
            })
          )}

          <Text style={styles.sectionTitle}>Past runs ({runs.data?.runs.length ?? 0})</Text>
          {(runs.data?.runs.length ?? 0) === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                No diagnostic run has been recorded on this deployment.
              </Text>
            </View>
          ) : (
            (runs.data?.runs ?? []).map(run => {
              const copy = diagnosticStateCopy(run.state);
              return (
                <View key={run.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.target}>{whenLabel(run.startedAt)}</Text>
                    <Chip label={copy.label} tone={copy.tone} />
                  </View>
                  <Text style={styles.meaning}>{run.question}</Text>
                  <Text style={styles.meaning}>{run.refusalReason ?? run.answer ?? ''}</Text>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Model / findings</Text>
                    <Text style={styles.detailValue}>
                      {(run.model ?? '—') + ' · ' + run.findings.length}
                    </Text>
                  </View>
                </View>
              );
            })
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
  dangerText: { fontSize: 12, color: '#991b1b', marginTop: 6, lineHeight: 17 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headline: { fontSize: 15, fontWeight: '600', color: '#111827' },
  target: { fontSize: 15, fontWeight: '600', color: '#111827', flexShrink: 1 },
  meaning: { fontSize: 12, color: '#6b7280', marginTop: 6, lineHeight: 17 },
  action: { fontSize: 12, color: '#111827', marginTop: 6, lineHeight: 17 },
  cites: { fontSize: 11, color: '#9ca3af', marginTop: 6 },
  emptyText: { fontSize: 12, color: '#6b7280', lineHeight: 17 },
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
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 10,
    minHeight: 70,
    fontSize: 13,
    color: '#111827',
    textAlignVertical: 'top',
  },
  button: {
    marginTop: 12,
    backgroundColor: '#1d4ed8',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonDisabled: { backgroundColor: '#9ca3af' },
  buttonText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
});

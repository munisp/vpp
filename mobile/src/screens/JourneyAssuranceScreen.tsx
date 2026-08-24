/**
 * "Which stakeholder scenarios has this deployment executed?" — the field view.
 *
 * Same records and the same copy map as the web console, so a journey cannot
 * read as green here and blocked there. The catalog is a contract; only a
 * recorded run is evidence, so a journey nobody has run reads `not run`.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  JOURNEY_STATUS_COPY,
  OUTCOME_COPY,
  scoreCaveat,
  type JourneyTone,
} from '../../../shared/journey-state';
import {
  EXTERNAL_DEPENDENCY_LABELS,
  JOURNEYS,
  journeyStatus,
  type ExternalDependency,
} from '../../../shared/journeys';

const TONE_COLOR: Record<JourneyTone, { bg: string; fg: string }> = {
  good: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  danger: { bg: '#fee2e2', fg: '#991b1b' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

function Chip({ label, tone }: { label: string; tone: JourneyTone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

export default function JourneyAssuranceScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: currentUser } = trpc.auth.me.useQuery();
  const isAdmin = currentUser?.role === 'admin';

  const report = trpc.journeys.report.useQuery(undefined, { enabled: isAdmin });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    if (isAdmin) await report.refetch();
    setRefreshing(false);
  };

  const runs = report.data?.runs ?? [];
  const summary = report.data?.summary;
  const runByJourney = new Map(runs.map(run => [run.journeyId, run]));

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Journeys</Text>
        <View style={{ width: 40 }} />
      </View>

      {!isAdmin ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            Journey runs carry other members' asset, offer and payment identifiers, so they are
            visible to platform administrators only.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.introCard}>
            <Ionicons name="compass-outline" size={20} color="#1e40af" />
            <Text style={styles.introText}>
              Twenty stakeholder journeys, each a durable workflow over the platform's own services.
              A refusal counts as a pass — declining to act without evidence is the behaviour under
              test. A step blocked on an absent provider is excluded from the score.
            </Text>
          </View>

          {report.isError ? (
            <View style={styles.dangerCard}>
              <Text style={styles.dangerTitle}>Journey history could not be read</Text>
              <Text style={styles.dangerText}>
                {report.error?.message} — nothing is known about what has been exercised.
              </Text>
            </View>
          ) : report.isLoading ? (
            <Text style={styles.emptyText}>Loading journey history…</Text>
          ) : (
            <>
              <View style={summary && summary.stepsFailed > 0 ? styles.dangerCard : styles.card}>
                <Text style={styles.headline}>
                  {summary?.exercisableScorePct === null || summary === undefined
                    ? 'No journey step has been exercised here'
                    : `${summary.exercisableScorePct}% of exercisable steps behaved`}
                </Text>
                <Text style={styles.meaning}>
                  {summary
                    ? scoreCaveat(summary.stepsBlocked, summary.notRun)
                    : 'No journey has been run on this deployment yet.'}
                </Text>
                {summary && (
                  <View style={styles.chipRow}>
                    <Chip label={`${summary.passed}/${summary.journeys} journeys passed`} tone="good" />
                    <Chip
                      label={`${summary.stepsBlocked} blocked`}
                      tone={summary.stepsBlocked > 0 ? 'warning' : 'good'}
                    />
                    <Chip
                      label={`${summary.stepsFailed} failed`}
                      tone={summary.stepsFailed > 0 ? 'danger' : 'good'}
                    />
                  </View>
                )}
              </View>

              {JOURNEYS.map(journey => {
                const run = runByJourney.get(journey.id);
                const status = journeyStatus(
                  run?.steps ?? [],
                  journey.steps.map(step => step.id)
                );
                const statusCopy = JOURNEY_STATUS_COPY[status];
                const needs = [
                  ...new Set(journey.steps.flatMap(step => step.requires ?? [])),
                ] as ExternalDependency[];
                const isOpen = expanded === journey.id;
                return (
                  <TouchableOpacity
                    key={journey.id}
                    style={styles.card}
                    onPress={() => setExpanded(isOpen ? null : journey.id)}
                  >
                    <View style={styles.cardHeader}>
                      <Text style={styles.target}>{journey.title}</Text>
                      <Chip label={statusCopy.label} tone={statusCopy.tone} />
                    </View>
                    <Text style={styles.meaning}>{statusCopy.meaning}</Text>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Steps recorded</Text>
                      <Text style={styles.detailValue}>
                        {run?.steps.length ?? 0}/{journey.steps.length}
                      </Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Needs externally</Text>
                      <Text style={styles.detailValue}>
                        {needs.length === 0
                          ? 'nothing'
                          : needs.map(need => EXTERNAL_DEPENDENCY_LABELS[need]).join(', ')}
                      </Text>
                    </View>
                    {isOpen &&
                      journey.steps.map(step => {
                        const result = run?.steps.find(candidate => candidate.stepId === step.id);
                        const outcomeCopy = result ? OUTCOME_COPY[result.outcome] : null;
                        return (
                          <View key={step.id} style={styles.stepRow}>
                            <View style={styles.cardHeader}>
                              <Text style={styles.stepTitle}>{step.title}</Text>
                              {outcomeCopy ? (
                                <Chip label={outcomeCopy.label} tone={outcomeCopy.tone} />
                              ) : (
                                <Chip label="not run" tone="neutral" />
                              )}
                            </View>
                            <Text style={styles.meaning}>
                              {result ? result.detail : step.services.join(', ')}
                            </Text>
                          </View>
                        );
                      })}
                  </TouchableOpacity>
                );
              })}
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
  card: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 10, backgroundColor: '#ffffff' },
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
  target: { fontSize: 15, fontWeight: '600', color: '#111827', flexShrink: 1, paddingRight: 8 },
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
  stepRow: { marginTop: 12, borderTopWidth: 1, borderTopColor: '#f3f4f6', paddingTop: 10 },
  stepTitle: { fontSize: 13, fontWeight: '500', color: '#111827', flexShrink: 1, paddingRight: 8 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 16 },
});

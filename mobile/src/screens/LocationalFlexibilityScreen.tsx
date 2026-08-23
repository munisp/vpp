/**
 * "The grid needs relief where you are, here is what it pays, and here is what
 * your meter actually showed."
 *
 * Members offer capacity into a requirement at the node their asset sits behind,
 * so this screen holds the same line the service does: an award is a promise, not
 * a payment; delivery comes from this asset's own telemetry against its own
 * baseline; and a window with too little telemetry is reported as unverified —
 * neither performance nor breach — rather than as a failure to deliver.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

type Tone = 'good' | 'warning' | 'danger' | 'neutral';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
  good: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  danger: { bg: '#fee2e2', fg: '#991b1b' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

/** Prices are stored as cents per kWh scaled by 100, as everywhere else. */
const PRICE_SCALE = 100;

type DeliveryStatus = 'unmeasured' | 'delivered' | 'partial' | 'not_delivered' | 'unverified';
type LinkSource = 'operator_declared' | 'utility_verified' | 'unverified';

interface Opportunity {
  requirementId: number;
  assetId: number;
  assetName: string;
  assetCapacityW: number;
  nodeCode: string;
  linkSource: LinkSource;
  direction: 'import_reduction' | 'export_reduction';
  startsAt: string;
  endsAt: string;
  requiredPowerW: number;
  priceCapCentsPerKwh: number;
  currency: string;
  alreadyOffered: boolean;
}

interface Award {
  awardId: number;
  nodeCode: string;
  direction: 'import_reduction' | 'export_reduction';
  startsAt: string;
  endsAt: string;
  awardedPowerW: number;
  priceCentsPerKwh: number;
  currency: string;
  deliveryStatus: DeliveryStatus;
  measuredSamples: number;
  deliveredPowerW: number | null;
  deliveredEnergyWh: number | null;
  earnedAmount: number | null;
  settled: boolean;
  unverifiedReason: string | null;
}

const DIRECTION_LABEL: Record<Opportunity['direction'], string> = {
  import_reduction: 'Use less from the grid',
  export_reduction: 'Push less into the grid',
};

const LINK_LABEL: Record<LinkSource, { label: string; tone: Tone }> = {
  utility_verified: { label: 'Location confirmed', tone: 'good' },
  operator_declared: { label: 'Location declared', tone: 'warning' },
  unverified: { label: 'Location unverified', tone: 'danger' },
};

const DELIVERY_LABEL: Record<DeliveryStatus, { label: string; tone: Tone; meaning: string }> = {
  unmeasured: {
    label: 'Not measured yet',
    tone: 'neutral',
    meaning: 'Your award is recorded. Nothing is paid until the window is measured.',
  },
  delivered: {
    label: 'Delivered',
    tone: 'good',
    meaning: 'Your meter readings show the full change you were awarded for.',
  },
  partial: {
    label: 'Partly delivered',
    tone: 'warning',
    meaning: 'Your readings show a real change, but less than awarded. You are paid for what was measured.',
  },
  not_delivered: {
    label: 'No change measured',
    tone: 'danger',
    meaning: 'Readings covered the window and show no change in the direction asked for, so nothing is paid.',
  },
  unverified: {
    label: 'Could not be checked',
    tone: 'danger',
    meaning:
      'There were too few readings to judge this window. This is not counted against you, and it cannot be paid either.',
  },
};

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

function kw(watts: number): string {
  return `${(watts / 1000).toFixed(2)} kW`;
}

function price(scaled: number, currency: string): string {
  return `${(scaled / PRICE_SCALE).toFixed(2)} ${currency}/kWh`;
}

function windowLabel(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return `${start.toLocaleDateString()} ${start.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })} – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export default function LocationalFlexibilityScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [powerInputs, setPowerInputs] = useState<Record<string, string>>({});
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});

  const utils = trpc.useUtils();
  const opportunitiesQuery = trpc.locationalFlexibility.myOpportunities.useQuery();
  const awardsQuery = trpc.locationalFlexibility.myAwards.useQuery({ limit: 25 });

  const offer = trpc.locationalFlexibility.offer.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      Alert.alert(
        'Offer submitted',
        'Your offer is in the queue. It only becomes an award if clearing reaches your price.'
      );
      utils.locationalFlexibility.myOpportunities.invalidate();
      utils.locationalFlexibility.myAwards.invalidate();
    },
    onError: async error => {
      await HapticService.error();
      Alert.alert('Offer refused', error.message || 'The offer could not be submitted');
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([opportunitiesQuery.refetch(), awardsQuery.refetch()]);
    setRefreshing(false);
  };

  const opportunities = (opportunitiesQuery.data ?? []) as unknown as Opportunity[];
  const awards = (awardsQuery.data ?? []) as unknown as Award[];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Local Grid Support</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="location" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Sometimes the network needs relief at one substation or feeder, and pays whoever is behind
          it. Only assets whose location the network operator has recorded can take part, and payment
          follows what your readings show, not what was promised.
        </Text>
      </View>

      <Text style={styles.sectionHeading}>Open near you</Text>
      {opportunitiesQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading requirements…</Text>
      ) : opportunitiesQuery.isError ? (
        <View style={styles.card}>
          {/* A failed read is an outage, never an empty market. */}
          <Text style={styles.emptyText}>
            {opportunitiesQuery.error?.message || 'Could not load requirements'}
          </Text>
        </View>
      ) : opportunities.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            Nothing open for your assets. Your asset also has to be recorded behind the node that
            needs help — the network operator records that, not the app.
          </Text>
        </View>
      ) : (
        opportunities.map(row => {
          const key = `${row.requirementId}:${row.assetId}`;
          const link = LINK_LABEL[row.linkSource];
          return (
            <View key={key} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.target}>{row.assetName}</Text>
                <Chip label={link.label} tone={link.tone} />
              </View>
              <Text style={styles.meaning}>
                At {row.nodeCode} · {DIRECTION_LABEL[row.direction]}
              </Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Window</Text>
                <Text style={styles.detailValue}>{windowLabel(row.startsAt, row.endsAt)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Node needs</Text>
                <Text style={styles.detailValue}>{kw(row.requiredPowerW)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Pays up to</Text>
                <Text style={styles.detailValue}>
                  {price(row.priceCapCentsPerKwh, row.currency)}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Your asset is rated</Text>
                <Text style={styles.detailValue}>{kw(row.assetCapacityW)}</Text>
              </View>

              {row.alreadyOffered ? (
                <Text style={styles.meaning}>
                  You have already offered this asset into this window.
                </Text>
              ) : (
                <>
                  <View style={styles.inputRow}>
                    <View style={styles.inputBlock}>
                      <Text style={styles.inputLabel}>Offer (W)</Text>
                      <TextInput
                        style={styles.input}
                        keyboardType="number-pad"
                        value={powerInputs[key] ?? ''}
                        placeholder={String(row.assetCapacityW)}
                        onChangeText={value =>
                          setPowerInputs(previous => ({ ...previous, [key]: value }))
                        }
                      />
                    </View>
                    <View style={styles.inputBlock}>
                      <Text style={styles.inputLabel}>Your price (×100)</Text>
                      <TextInput
                        style={styles.input}
                        keyboardType="number-pad"
                        value={priceInputs[key] ?? ''}
                        placeholder={String(row.priceCapCentsPerKwh)}
                        onChangeText={value =>
                          setPriceInputs(previous => ({ ...previous, [key]: value }))
                        }
                      />
                    </View>
                  </View>
                  <TouchableOpacity
                    style={[styles.button, offer.isPending && styles.buttonDisabled]}
                    disabled={offer.isPending}
                    onPress={() =>
                      offer.mutate({
                        requirementId: row.requirementId,
                        assetId: row.assetId,
                        offeredPowerW: Number(powerInputs[key] ?? 0),
                        priceCentsPerKwh: Number(priceInputs[key] ?? 0),
                      })
                    }
                  >
                    <Text style={styles.buttonText}>Submit offer</Text>
                  </TouchableOpacity>
                  <Text style={styles.meaning}>
                    Cheapest offers are taken first, up to what the node needs. Nothing is committed
                    until the operator clears the window.
                  </Text>
                </>
              )}
            </View>
          );
        })
      )}

      <Text style={styles.sectionHeading}>Your awards</Text>
      {awardsQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading your awards…</Text>
      ) : awardsQuery.isError ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {awardsQuery.error?.message || 'Could not load your awards'}
          </Text>
        </View>
      ) : awards.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No award yet. An offer becomes an award only when the operator clears the window.
          </Text>
        </View>
      ) : (
        awards.map(award => {
          const status = DELIVERY_LABEL[award.deliveryStatus];
          return (
            <View key={award.awardId} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.target}>{award.nodeCode}</Text>
                <Chip
                  label={award.settled ? `${status.label} · paid` : status.label}
                  tone={status.tone}
                />
              </View>
              <Text style={styles.meaning}>{windowLabel(award.startsAt, award.endsAt)}</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Awarded</Text>
                <Text style={styles.detailValue}>
                  {kw(award.awardedPowerW)} at {price(award.priceCentsPerKwh, award.currency)}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Measured change</Text>
                <Text style={styles.detailValue}>
                  {award.deliveredPowerW === null ? '—' : kw(award.deliveredPowerW)}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Credited energy</Text>
                <Text style={styles.detailValue}>
                  {award.deliveredEnergyWh === null
                    ? '—'
                    : `${(award.deliveredEnergyWh / 1000).toFixed(2)} kWh`}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Earned</Text>
                <Text style={styles.detailValue}>
                  {award.earnedAmount === null
                    ? '—'
                    : `${award.earnedAmount} ${award.currency}`}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Readings used</Text>
                <Text style={styles.detailValue}>{award.measuredSamples}</Text>
              </View>
              <Text style={styles.meaning}>
                {award.unverifiedReason ? `${status.meaning} ${award.unverifiedReason}.` : status.meaning}
              </Text>
            </View>
          );
        })
      )}

      <View style={styles.card}>
        <Text style={styles.target}>How delivery is judged</Text>
        <Text style={styles.meaning}>
          Your asset is compared against itself: the same clock window on earlier days becomes the
          baseline, and windows you were already paid for are left out of it. Payment follows the
          measured energy, capped at what you were awarded — never the award on its own.
        </Text>
      </View>

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
  sectionHeading: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
  },
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
    marginBottom: 6,
  },
  target: { fontSize: 15, fontWeight: '700', color: '#111827' },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  detailLabel: { fontSize: 13, color: '#6b7280' },
  detailValue: { fontSize: 13, color: '#111827', fontWeight: '500' },
  meaning: { fontSize: 12, lineHeight: 18, color: '#6b7280', marginTop: 4 },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', paddingHorizontal: 16 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: '600' },
  inputRow: { flexDirection: 'row', gap: 12, marginTop: 10 },
  inputBlock: { flex: 1 },
  inputLabel: { fontSize: 12, color: '#6b7280', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  button: {
    marginTop: 12,
    backgroundColor: '#1e40af',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
});

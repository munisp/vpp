import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
} from 'react-native';
import { trpc } from '../services/trpc';
import ShareButton from '../components/ShareButton';
import { ShareService } from '../services/shareService';
import { HapticService } from '../services/hapticService';

export default function DRParticipationScreen() {
  const utils = trpc.useUtils();

  // getEnrollment returns the caller's DrParticipant row (or null).
  const {
    data: enrollment,
    refetch,
    isLoading: enrollmentLoading,
  } = trpc.demandResponse.getEnrollment.useQuery();
  const { data: events } = trpc.demandResponse.getUpcomingEvents.useQuery();
  // getMyCompensation returns an array of DrCompensation rows.
  const { data: compensation } = trpc.demandResponse.getMyCompensation.useQuery();
  // getMyResponses returns the caller's DR event responses.
  const { data: myResponses } = trpc.demandResponse.getMyResponses.useQuery();

  const enrollMutation = trpc.demandResponse.enroll.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      Alert.alert('Success', 'Enrolled in demand response program');
      refetch();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const respondMutation = trpc.demandResponse.respondToEvent.useMutation({
    onSuccess: async () => {
      await HapticService.drEventStarted();
      Alert.alert('Success', 'Your response has been recorded');
      utils.demandResponse.getMyResponses.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const handleEnroll = async () => {
    await HapticService.buttonPress();
    // Server input (server/routers/demandResponse.ts -> enroll):
    // { autoOptIn, minCompensation? (cents/kWh), maxReduction? (kW) }
    enrollMutation.mutate({
      autoOptIn: true,
      minCompensation: 500, // 5 TZS per kWh
    });
  };

  const handleParticipate = async (eventId: number, targetReduction: number) => {
    await HapticService.buttonPress();
    // Server input (respondToEvent): { eventId, participate, targetReduction? }
    respondMutation.mutate({
      eventId,
      participate: true,
      targetReduction,
    });
  };

  const isEnrolled = !!enrollment && enrollment.status !== 'cancelled';

  // Derived stats from real rows (amounts in cents).
  const totalEarnedCents = (compensation ?? [])
    .filter((c) => c.status === 'paid')
    .reduce((sum, c) => sum + c.amount, 0);
  const pendingCents = (compensation ?? [])
    .filter((c) => c.status === 'pending')
    .reduce((sum, c) => sum + c.amount, 0);
  const eventsJoined = (myResponses ?? []).filter(
    (r) => r.participationStatus !== 'opted_out'
  ).length;
  const totalReductionKw = (myResponses ?? []).reduce(
    (sum, r) => sum + (r.actualReduction ?? 0),
    0
  );

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Demand Response</Text>
        <Text style={styles.subtitle}>Earn by helping balance the grid</Text>
      </View>

      {/* Enrollment Status */}
      {enrollmentLoading ? (
        <View style={styles.enrollCard}>
          <Text style={styles.enrollText}>Loading enrollment status…</Text>
        </View>
      ) : !isEnrolled ? (
        <View style={styles.enrollCard}>
          <Text style={styles.enrollIcon}>⚡</Text>
          <Text style={styles.enrollTitle}>Join Demand Response Program</Text>
          <Text style={styles.enrollText}>
            Participate in grid balancing events and earn compensation for
            reducing your energy consumption during peak times.
          </Text>
          <View style={styles.benefits}>
            <BenefitItem text="Earn compensation per kWh reduced" />
            <BenefitItem text="Automatic participation in events" />
            <BenefitItem text="Compensation payments for participation" />
            <BenefitItem text="Help stabilize the grid" />
          </View>
          <TouchableOpacity
            style={styles.enrollButton}
            onPress={handleEnroll}
            disabled={enrollMutation.isPending}
          >
            <Text style={styles.enrollButtonText}>
              {enrollMutation.isPending ? 'Enrolling...' : 'Enroll Now'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Stats (derived from real compensation and response rows) */}
          <View style={styles.statsGrid}>
            <StatCard
              title="Total Earned"
              value={`${(totalEarnedCents / 100).toFixed(0)} TZS`}
              icon="💰"
              color="#10b981"
            />
            <StatCard
              title="Events Joined"
              value={eventsJoined.toString()}
              icon="🎯"
              color="#3b82f6"
            />
            <StatCard
              title="Total Reduction"
              value={`${totalReductionKw} kW`}
              icon="⚡"
              color="#f59e0b"
            />
            <StatCard
              title="Pending"
              value={`${(pendingCents / 100).toFixed(0)} TZS`}
              icon="⏳"
              color="#8b5cf6"
            />
          </View>

          {/* Upcoming Events */}
          {events && events.length > 0 && (
            <View style={styles.eventsCard}>
              <Text style={styles.sectionTitle}>Upcoming DR Events</Text>
              {events.map((event) => (
                <DREventItem
                  key={event.id}
                  event={event}
                  onParticipate={handleParticipate}
                />
              ))}
            </View>
          )}

          {/* Compensation History (getMyCompensation returns an array) */}
          {compensation && compensation.length > 0 && (
            <View style={styles.historyCard}>
              <Text style={styles.sectionTitle}>Compensation History</Text>
              {compensation.map((item) => (
                <CompensationItem key={item.id} item={item} />
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function BenefitItem({ text }: { text: string }) {
  return (
    <View style={styles.benefitItem}>
      <Text style={styles.benefitCheck}>✓</Text>
      <Text style={styles.benefitText}>{text}</Text>
    </View>
  );
}

function StatCard({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: string;
  icon: string;
  color: string;
}) {
  return (
    <View style={[styles.statCard, { borderLeftColor: color }]}>
      <Text style={styles.statIcon}>{icon}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statTitle}>{title}</Text>
    </View>
  );
}

function DREventItem({
  event,
  onParticipate,
}: {
  event: any;
  onParticipate: (eventId: number, targetReduction: number) => void;
}) {
  const startTime = new Date(event.startTime);
  const endTime = new Date(event.endTime);
  const duration = Math.round(
    (endTime.getTime() - startTime.getTime()) / (1000 * 60)
  ); // minutes

  return (
    <View style={styles.eventItem}>
      <View style={styles.eventHeader}>
        <Text style={styles.eventName}>{event.eventName}</Text>
        <View style={[
          styles.eventType,
          { backgroundColor: getEventTypeColor(event.eventType) },
        ]}>
          <Text style={styles.eventTypeText}>{event.eventType}</Text>
        </View>
      </View>

      <View style={styles.eventDetails}>
        <EventDetail
          icon="⏰"
          label="Duration"
          value={`${duration} min`}
        />
        <EventDetail
          icon="⚡"
          label="Target"
          value={`${event.targetReduction} kW`}
        />
        <EventDetail
          icon="💰"
          label="Rate"
          value={`${(event.compensationRate / 100).toFixed(2)} TZS/kWh`}
        />
      </View>

      <View style={styles.eventTime}>
        <Text style={styles.eventTimeText}>
          {startTime.toLocaleTimeString()} - {endTime.toLocaleTimeString()}
        </Text>
      </View>

      <View style={styles.eventActions}>
        <TouchableOpacity
          style={styles.participateButton}
          onPress={() => onParticipate(event.id, event.targetReduction)}
        >
          <Text style={styles.participateButtonText}>Participate</Text>
        </TouchableOpacity>
        <ShareButton
          onPress={() =>
            ShareService.shareDREvent(
              event.eventName,
              event.compensationRate,
              startTime
            )
          }
          size="small"
        />
      </View>
    </View>
  );
}

function EventDetail({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.eventDetail}>
      <Text style={styles.eventDetailIcon}>{icon}</Text>
      <View>
        <Text style={styles.eventDetailLabel}>{label}</Text>
        <Text style={styles.eventDetailValue}>{value}</Text>
      </View>
    </View>
  );
}

function CompensationItem({ item }: { item: any }) {
  // DrCompensation row: { id, eventId, amount (cents), currency, status, ... }
  return (
    <View style={styles.compensationItem}>
      <View style={styles.compensationLeft}>
        <Text style={styles.compensationEvent}>DR Event #{item.eventId}</Text>
        <Text style={styles.compensationDate}>
          {new Date(item.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <View style={styles.compensationRight}>
        <Text style={styles.compensationAmount}>
          +{(item.amount / 100).toFixed(0)} {item.currency || 'TZS'}
        </Text>
        <Text style={styles.compensationReduction}>
          {item.status === 'paid'
            ? `Paid${item.paidAt ? ` on ${new Date(item.paidAt).toLocaleDateString()}` : ''}`
            : item.status}
        </Text>
      </View>
    </View>
  );
}

function getEventTypeColor(type: string): string {
  switch (type) {
    case 'emergency':
      return '#ef4444';
    case 'peak_shaving':
      return '#f59e0b';
    case 'load_shifting':
      return '#3b82f6';
    case 'economic':
      return '#10b981';
    default:
      return '#6b7280';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  header: {
    padding: 24,
    paddingTop: 60,
    backgroundColor: '#8b5cf6',
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    color: '#e9d5ff',
  },
  enrollCard: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  enrollIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  enrollTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 8,
    textAlign: 'center',
  },
  enrollText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  benefits: {
    width: '100%',
    marginBottom: 24,
  },
  benefitItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  benefitCheck: {
    fontSize: 20,
    color: '#10b981',
    marginRight: 12,
  },
  benefitText: {
    fontSize: 14,
    color: '#374151',
  },
  enrollButton: {
    backgroundColor: '#8b5cf6',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
  },
  enrollButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 16,
    marginTop: -32,
  },
  statCard: {
    width: '48%',
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    margin: '1%',
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statIcon: {
    fontSize: 24,
    marginBottom: 8,
  },
  statValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  statTitle: {
    fontSize: 12,
    color: '#6b7280',
  },
  eventsCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginTop: 0,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  eventItem: {
    backgroundColor: '#f9fafb',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  eventHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  eventName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
  },
  eventType: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  eventTypeText: {
    fontSize: 11,
    color: '#fff',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  eventDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  eventDetail: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  eventDetailIcon: {
    fontSize: 16,
    marginRight: 4,
  },
  eventDetailLabel: {
    fontSize: 10,
    color: '#6b7280',
  },
  eventDetailValue: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
  eventTime: {
    marginBottom: 12,
  },
  eventTimeText: {
    fontSize: 12,
    color: '#6b7280',
  },
  eventActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  participateButton: {
    flex: 1,
    backgroundColor: '#8b5cf6',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  participateButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  historyCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginTop: 0,
    marginBottom: 32,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  compensationItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  compensationLeft: {
    flex: 1,
  },
  compensationEvent: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
    marginBottom: 2,
  },
  compensationDate: {
    fontSize: 12,
    color: '#6b7280',
  },
  compensationRight: {
    alignItems: 'flex-end',
  },
  compensationAmount: {
    fontSize: 16,
    fontWeight: '600',
    color: '#10b981',
    marginBottom: 2,
  },
  compensationReduction: {
    fontSize: 11,
    color: '#6b7280',
  },
});

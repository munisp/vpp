import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Modal,
  ScrollView,
  Alert,
} from 'react-native';
import { trpc } from '../lib/trpc';
import { Ionicons } from '@expo/vector-icons';

type WorkflowType = 'auto_trading' | 'manual_trading' | 'p2p_trading' | 'dr_participation' | 'payment_processing' | 'monitoring';
type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export default function WorkflowMonitorScreen() {
  const [selectedType, setSelectedType] = useState<WorkflowType | 'all'>('all');
  const [selectedStatus, setSelectedStatus] = useState<WorkflowStatus | 'all'>('all');
  const [selectedWorkflow, setSelectedWorkflow] = useState<any>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);

  const { data: workflows, isLoading, refetch } = trpc.orchestrator.listWorkflows.useQuery({
    type: selectedType === 'all' ? undefined : selectedType,
    status: selectedStatus === 'all' ? undefined : selectedStatus,
  });

  const cancelWorkflow = trpc.orchestrator.cancelWorkflow.useMutation({
    onSuccess: () => {
      Alert.alert('Success', 'Workflow cancelled successfully');
      refetch();
      setShowDetailModal(false);
    },
    onError: () => {
      Alert.alert('Error', 'Failed to cancel workflow');
    },
  });

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  const handleCancelWorkflow = (workflowId: string) => {
    Alert.alert(
      'Cancel Workflow',
      'Are you sure you want to cancel this workflow?',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes',
          style: 'destructive',
          onPress: () => cancelWorkflow.mutate({ workflowId }),
        },
      ]
    );
  };

  const renderWorkflowItem = ({ item }: { item: any }) => (
    <TouchableOpacity
      style={styles.workflowCard}
      onPress={() => {
        setSelectedWorkflow(item);
        setShowDetailModal(true);
      }}
    >
      <View style={styles.workflowHeader}>
        <View style={styles.workflowIcon}>
          <Ionicons
            name={getWorkflowIcon(item.type)}
            size={24}
            color={getStatusColor(item.status)}
          />
        </View>
        <View style={styles.workflowInfo}>
          <Text style={styles.workflowTitle}>{formatWorkflowType(item.type)}</Text>
          <Text style={styles.workflowId}>ID: {item.workflowId.substring(0, 8)}...</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) + '20' }]}>
          <Text style={[styles.statusText, { color: getStatusColor(item.status) }]}>
            {item.status}
          </Text>
        </View>
      </View>

      <View style={styles.workflowDetails}>
        <DetailRow icon="time" label="Started" value={formatDate(item.startedAt)} />
        {item.completedAt && (
          <DetailRow icon="checkmark-circle" label="Completed" value={formatDate(item.completedAt)} />
        )}
        {item.progress !== undefined && (
          <View style={styles.progressContainer}>
            <Text style={styles.progressLabel}>Progress</Text>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${item.progress}%`, backgroundColor: getStatusColor(item.status) },
                ]}
              />
            </View>
            <Text style={styles.progressText}>{item.progress}%</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Workflow Monitor</Text>
        <Text style={styles.subtitle}>Track your automated workflows</Text>
      </View>

      {/* Filters */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterContainer}>
        <FilterChip
          label="All Types"
          selected={selectedType === 'all'}
          onPress={() => setSelectedType('all')}
        />
        <FilterChip
          label="Auto Trading"
          selected={selectedType === 'auto_trading'}
          onPress={() => setSelectedType('auto_trading')}
        />
        <FilterChip
          label="Manual Trading"
          selected={selectedType === 'manual_trading'}
          onPress={() => setSelectedType('manual_trading')}
        />
        <FilterChip
          label="P2P Trading"
          selected={selectedType === 'p2p_trading'}
          onPress={() => setSelectedType('p2p_trading')}
        />
        <FilterChip
          label="DR Events"
          selected={selectedType === 'dr_participation'}
          onPress={() => setSelectedType('dr_participation')}
        />
        <FilterChip
          label="Payments"
          selected={selectedType === 'payment_processing'}
          onPress={() => setSelectedType('payment_processing')}
        />
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterContainer}>
        <FilterChip
          label="All Status"
          selected={selectedStatus === 'all'}
          onPress={() => setSelectedStatus('all')}
        />
        <FilterChip
          label="Running"
          selected={selectedStatus === 'running'}
          onPress={() => setSelectedStatus('running')}
        />
        <FilterChip
          label="Completed"
          selected={selectedStatus === 'completed'}
          onPress={() => setSelectedStatus('completed')}
        />
        <FilterChip
          label="Failed"
          selected={selectedStatus === 'failed'}
          onPress={() => setSelectedStatus('failed')}
        />
        <FilterChip
          label="Cancelled"
          selected={selectedStatus === 'cancelled'}
          onPress={() => setSelectedStatus('cancelled')}
        />
      </ScrollView>

      {/* Workflow List */}
      <FlatList
        data={workflows || []}
        renderItem={renderWorkflowItem}
        keyExtractor={(item) => item.workflowId}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10b981" />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="git-network-outline" size={64} color="#d1d5db" />
            <Text style={styles.emptyTitle}>No Workflows Found</Text>
            <Text style={styles.emptyDescription}>
              Workflows will appear here when you start automated trading or participate in DR events.
            </Text>
          </View>
        }
      />

      {/* Detail Modal */}
      <Modal
        visible={showDetailModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowDetailModal(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Workflow Details</Text>
            <TouchableOpacity onPress={() => setShowDetailModal(false)}>
              <Ionicons name="close" size={24} color="#6b7280" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalContent}>
            {selectedWorkflow && (
              <>
                <View style={styles.modalSection}>
                  <Text style={styles.modalSectionTitle}>Basic Information</Text>
                  <DetailRow icon="layers" label="Type" value={formatWorkflowType(selectedWorkflow.type)} />
                  <DetailRow icon="key" label="Workflow ID" value={selectedWorkflow.workflowId} />
                  <DetailRow
                    icon="flag"
                    label="Status"
                    value={selectedWorkflow.status}
                    valueColor={getStatusColor(selectedWorkflow.status)}
                  />
                  <DetailRow icon="time" label="Started At" value={formatDate(selectedWorkflow.startedAt)} />
                  {selectedWorkflow.completedAt && (
                    <DetailRow
                      icon="checkmark-circle"
                      label="Completed At"
                      value={formatDate(selectedWorkflow.completedAt)}
                    />
                  )}
                </View>

                {selectedWorkflow.input && (
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>Input Parameters</Text>
                    <View style={styles.codeBlock}>
                      <Text style={styles.codeText}>
                        {JSON.stringify(selectedWorkflow.input, null, 2)}
                      </Text>
                    </View>
                  </View>
                )}

                {selectedWorkflow.result && (
                  <View style={styles.modalSection}>
                    <Text style={styles.modalSectionTitle}>Result</Text>
                    <View style={styles.codeBlock}>
                      <Text style={styles.codeText}>
                        {JSON.stringify(selectedWorkflow.result, null, 2)}
                      </Text>
                    </View>
                  </View>
                )}

                {selectedWorkflow.error && (
                  <View style={styles.modalSection}>
                    <Text style={[styles.modalSectionTitle, { color: '#ef4444' }]}>Error</Text>
                    <View style={[styles.codeBlock, { backgroundColor: '#fef2f2' }]}>
                      <Text style={[styles.codeText, { color: '#991b1b' }]}>
                        {selectedWorkflow.error}
                      </Text>
                    </View>
                  </View>
                )}

                {selectedWorkflow.status === 'running' && (
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => handleCancelWorkflow(selectedWorkflow.workflowId)}
                    disabled={cancelWorkflow.isLoading}
                  >
                    <Ionicons name="stop-circle" size={20} color="#fff" />
                    <Text style={styles.cancelButtonText}>Cancel Workflow</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.filterChip, selected && styles.filterChipSelected]}
      onPress={onPress}
    >
      <Text style={[styles.filterChipText, selected && styles.filterChipTextSelected]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function DetailRow({
  icon,
  label,
  value,
  valueColor,
}: {
  icon: string;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailLeft}>
        <Ionicons name={icon as any} size={16} color="#6b7280" />
        <Text style={styles.detailLabel}>{label}</Text>
      </View>
      <Text style={[styles.detailValue, valueColor && { color: valueColor }]}>{value}</Text>
    </View>
  );
}

function getWorkflowIcon(type: string): any {
  const icons: Record<string, any> = {
    auto_trading: 'flash',
    manual_trading: 'hand-left',
    p2p_trading: 'people',
    dr_participation: 'trending-down',
    payment_processing: 'card',
    monitoring: 'pulse',
  };
  return icons[type] || 'git-network';
}

function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    running: '#3b82f6',
    completed: '#10b981',
    failed: '#ef4444',
    cancelled: '#6b7280',
  };
  return colors[status] || '#6b7280';
}

function formatWorkflowType(type: string): string {
  return type
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDate(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleString();
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  header: {
    padding: 16,
    paddingTop: 60,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
  },
  filterContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
    marginRight: 8,
  },
  filterChipSelected: {
    backgroundColor: '#10b981',
  },
  filterChipText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6b7280',
  },
  filterChipTextSelected: {
    color: '#fff',
  },
  listContent: {
    padding: 16,
  },
  workflowCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  workflowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  workflowIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f0fdf4',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  workflowInfo: {
    flex: 1,
  },
  workflowTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 2,
  },
  workflowId: {
    fontSize: 12,
    color: '#6b7280',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  workflowDetails: {
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    paddingTop: 12,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  detailLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 14,
    color: '#6b7280',
    marginLeft: 8,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
  },
  progressContainer: {
    marginTop: 8,
  },
  progressLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  progressBar: {
    height: 8,
    backgroundColor: '#e5e7eb',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'right',
    marginTop: 4,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyDescription: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingTop: 60,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
  },
  modalContent: {
    flex: 1,
  },
  modalSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  modalSectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  codeBlock: {
    backgroundColor: '#f9fafb',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  codeText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: '#374151',
  },
  cancelButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ef4444',
    margin: 16,
    padding: 16,
    borderRadius: 8,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    marginLeft: 8,
  },
});

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Modal,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { trpc } from '../lib/trpc';
import { Ionicons } from '@expo/vector-icons';

type ActionFilter = 'all' | 'create' | 'update' | 'delete' | 'approve' | 'suspend';
type EntityFilter = 'all' | 'user' | 'asset' | 'trade' | 'payment';
type StatusFilter = 'all' | 'success' | 'failure';

export default function AuditLogsScreen() {
  const [searchQuery, setSearchQuery] = useState('');
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all');
  const [entityFilter, setEntityFilter] = useState<EntityFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const { data: logs, isLoading, refetch } = trpc.auditLogs.list.useQuery({
    action: actionFilter !== 'all' ? actionFilter : undefined,
    entityType: entityFilter !== 'all' ? entityFilter : undefined,
    status: statusFilter !== 'all' ? statusFilter : undefined,
    search: searchQuery || undefined,
    limit: 50,
  });

  const { data: stats } = trpc.auditLogs.getStats.useQuery();

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  const getActionColor = (action: string) => {
    switch (action) {
      case 'create':
        return '#10b981';
      case 'update':
        return '#3b82f6';
      case 'delete':
        return '#ef4444';
      case 'approve':
        return '#8b5cf6';
      case 'suspend':
        return '#f59e0b';
      default:
        return '#6b7280';
    }
  };

  const getStatusColor = (status: string) => {
    return status === 'success' ? '#10b981' : '#ef4444';
  };

  const renderLogItem = ({ item }: { item: any }) => (
    <TouchableOpacity
      style={styles.logItem}
      onPress={() => setSelectedLog(item)}
    >
      <View style={styles.logHeader}>
        <View style={[styles.actionBadge, { backgroundColor: getActionColor(item.action) + '20' }]}>
          <Text style={[styles.actionText, { color: getActionColor(item.action) }]}>
            {item.action}
          </Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) + '20' }]}>
          <Text style={[styles.statusText, { color: getStatusColor(item.status) }]}>
            {item.status}
          </Text>
        </View>
      </View>

      <Text style={styles.logDescription}>{item.description}</Text>

      <View style={styles.logMeta}>
        <Text style={styles.logMetaText}>
          <Ionicons name="folder-outline" size={12} color="#6b7280" /> {item.entityType}
        </Text>
        <Text style={styles.logMetaText}>
          <Ionicons name="person-outline" size={12} color="#6b7280" /> {item.userName || 'System'}
        </Text>
        <Text style={styles.logMetaText}>
          <Ionicons name="time-outline" size={12} color="#6b7280" />{' '}
          {new Date(item.timestamp).toLocaleString()}
        </Text>
      </View>
    </TouchableOpacity>
  );

  if (isLoading && !refreshing) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Audit Logs</Text>
        <TouchableOpacity
          style={styles.filterButton}
          onPress={() => setShowFilters(!showFilters)}
        >
          <Ionicons name="filter" size={24} color="#374151" />
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#6b7280" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search logs..."
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Ionicons name="close-circle" size={20} color="#6b7280" />
          </TouchableOpacity>
        )}
      </View>

      {/* Filters */}
      {showFilters && (
        <View style={styles.filtersContainer}>
          <Text style={styles.filterLabel}>Action</Text>
          <View style={styles.filterChips}>
            {(['all', 'create', 'update', 'delete', 'approve', 'suspend'] as ActionFilter[]).map(
              (action) => (
                <TouchableOpacity
                  key={action}
                  style={[
                    styles.filterChip,
                    actionFilter === action && styles.filterChipActive,
                  ]}
                  onPress={() => setActionFilter(action)}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      actionFilter === action && styles.filterChipTextActive,
                    ]}
                  >
                    {action}
                  </Text>
                </TouchableOpacity>
              )
            )}
          </View>

          <Text style={styles.filterLabel}>Entity</Text>
          <View style={styles.filterChips}>
            {(['all', 'user', 'asset', 'trade', 'payment'] as EntityFilter[]).map((entity) => (
              <TouchableOpacity
                key={entity}
                style={[
                  styles.filterChip,
                  entityFilter === entity && styles.filterChipActive,
                ]}
                onPress={() => setEntityFilter(entity)}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    entityFilter === entity && styles.filterChipTextActive,
                  ]}
                >
                  {entity}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.filterLabel}>Status</Text>
          <View style={styles.filterChips}>
            {(['all', 'success', 'failure'] as StatusFilter[]).map((status) => (
              <TouchableOpacity
                key={status}
                style={[
                  styles.filterChip,
                  statusFilter === status && styles.filterChipActive,
                ]}
                onPress={() => setStatusFilter(status)}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    statusFilter === status && styles.filterChipTextActive,
                  ]}
                >
                  {status}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Stats */}
      {stats && (
        <View style={styles.statsContainer}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{stats.totalLogs}</Text>
            <Text style={styles.statLabel}>Total Logs</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{stats.successRate.toFixed(1)}%</Text>
            <Text style={styles.statLabel}>Success Rate</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{stats.failedActions}</Text>
            <Text style={styles.statLabel}>Failed</Text>
          </View>
        </View>
      )}

      {/* Logs List */}
      <FlatList
        data={logs?.logs || []}
        renderItem={renderLogItem}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={64} color="#9ca3af" />
            <Text style={styles.emptyTitle}>No audit logs found</Text>
            <Text style={styles.emptyText}>
              Audit logs will appear here as actions are performed
            </Text>
          </View>
        }
      />

      {/* Log Detail Modal */}
      <Modal
        visible={selectedLog !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelectedLog(null)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Audit Log Details</Text>
            <TouchableOpacity onPress={() => setSelectedLog(null)}>
              <Ionicons name="close" size={28} color="#000" />
            </TouchableOpacity>
          </View>

          {selectedLog && (
            <View style={styles.modalContent}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Action</Text>
                <View style={[styles.actionBadge, { backgroundColor: getActionColor(selectedLog.action) + '20' }]}>
                  <Text style={[styles.actionText, { color: getActionColor(selectedLog.action) }]}>
                    {selectedLog.action}
                  </Text>
                </View>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Status</Text>
                <View style={[styles.statusBadge, { backgroundColor: getStatusColor(selectedLog.status) + '20' }]}>
                  <Text style={[styles.statusText, { color: getStatusColor(selectedLog.status) }]}>
                    {selectedLog.status}
                  </Text>
                </View>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Entity Type</Text>
                <Text style={styles.detailValue}>{selectedLog.entityType}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Entity ID</Text>
                <Text style={styles.detailValue}>{selectedLog.entityId}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>User</Text>
                <Text style={styles.detailValue}>{selectedLog.userName || 'System'}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Timestamp</Text>
                <Text style={styles.detailValue}>
                  {new Date(selectedLog.timestamp).toLocaleString()}
                </Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>IP Address</Text>
                <Text style={styles.detailValue}>{selectedLog.ipAddress || 'N/A'}</Text>
              </View>

              <View style={styles.detailSection}>
                <Text style={styles.detailLabel}>Description</Text>
                <Text style={styles.detailText}>{selectedLog.description}</Text>
              </View>

              {selectedLog.changes && (
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>Changes</Text>
                  <View style={styles.changesContainer}>
                    <Text style={styles.changesText}>
                      {JSON.stringify(selectedLog.changes, null, 2)}
                    </Text>
                  </View>
                </View>
              )}

              {selectedLog.errorMessage && (
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>Error Message</Text>
                  <Text style={styles.errorText}>{selectedLog.errorMessage}</Text>
                </View>
              )}
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  },
  filterButton: {
    padding: 8,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    margin: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 16,
  },
  filtersContainer: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  filterLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginTop: 12,
    marginBottom: 8,
  },
  filterChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f3f4f6',
  },
  filterChipActive: {
    backgroundColor: '#10b981',
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#374151',
  },
  filterChipTextActive: {
    color: '#fff',
  },
  statsContainer: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
  },
  statLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  listContent: {
    padding: 16,
    paddingTop: 0,
  },
  logItem: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  logHeader: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  actionBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  actionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  logDescription: {
    fontSize: 14,
    color: '#111827',
    marginBottom: 8,
  },
  logMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  logMetaText: {
    fontSize: 12,
    color: '#6b7280',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
    marginTop: 64,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
  },
  // Modal styles
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
    padding: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  detailLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6b7280',
  },
  detailValue: {
    fontSize: 14,
    color: '#111827',
  },
  detailSection: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  detailText: {
    fontSize: 14,
    color: '#111827',
    marginTop: 8,
  },
  changesContainer: {
    backgroundColor: '#f9fafb',
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  changesText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#374151',
  },
  errorText: {
    fontSize: 14,
    color: '#ef4444',
    marginTop: 8,
  },
});

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

type Priority = 'low' | 'medium' | 'high' | 'critical';

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical'];

const EVENT_LABELS: Record<string, string> = {
  created: 'Created',
  assigned: 'Assigned',
  status_changed: 'Status changed',
  verified: 'Verified',
  cancelled: 'Cancelled',
  note: 'Note',
};

const formatDate = (d: unknown) => (d ? new Date(d as string).toLocaleString() : '—');

export default function WorkOrdersScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  // Create form
  const [assetId, setAssetId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');

  const utils = trpc.useUtils();

  const listQuery = trpc.workOrders.list.useQuery({ limit: 50 });
  const orders = listQuery.data?.orders ?? [];

  const assetsQuery = trpc.assets.list.useQuery();
  const assets = assetsQuery.data?.assets ?? [];

  const detailQuery = trpc.workOrders.get.useQuery(
    { workOrderId: detailId! },
    { enabled: detailId != null }
  );
  const detail = detailQuery.data ?? null;

  const createMutation = trpc.workOrders.create.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      Alert.alert('Created', 'Work order raised.');
      setCreateVisible(false);
      setTitle('');
      setDescription('');
      setPriority('medium');
      utils.workOrders.list.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await listQuery.refetch();
    if (detailId != null) await detailQuery.refetch();
    setRefreshing(false);
  };

  const handleCreate = () => {
    if (assetId == null) {
      Alert.alert('Error', 'Select an asset for this work order');
      return;
    }
    if (!title.trim()) {
      Alert.alert('Error', 'Enter a title');
      return;
    }
    createMutation.mutate({
      assetId,
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
    });
  };

  const assetName = (id: number) => assets.find((a) => a.id === id)?.name ?? `Asset #${id}`;

  return (
    <View style={styles.wrapper}>
      <ScrollView
        style={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color="#111827" />
          </TouchableOpacity>
          <Text style={styles.title}>Work Orders</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Orders list */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>My Work Orders</Text>
          {listQuery.isLoading ? (
            <Text style={styles.emptyText}>Loading work orders…</Text>
          ) : listQuery.isError ? (
            <Text style={styles.emptyText}>Could not load work orders</Text>
          ) : orders.length === 0 ? (
            <Text style={styles.emptyText}>No work orders yet.</Text>
          ) : (
            orders.map((o) => (
              <TouchableOpacity
                key={o.id}
                style={styles.orderRow}
                onPress={() => setDetailId(o.id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderTitle}>{o.title}</Text>
                  <Text style={styles.orderMeta}>
                    {assetName(o.assetId)} · {o.priority} · raised {formatDate(o.createdAt)}
                  </Text>
                  {o.dueAt ? (
                    <Text style={styles.orderMeta}>Due {formatDate(o.dueAt)}</Text>
                  ) : null}
                </View>
                <View
                  style={[
                    styles.statusChip,
                    (o.status === 'verified' || o.status === 'done') && styles.statusDone,
                    o.status === 'cancelled' && styles.statusCancelled,
                    o.status === 'in_progress' && styles.statusInProgress,
                  ]}
                >
                  <Text style={styles.statusChipText}>{o.status.replace('_', ' ')}</Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

        <TouchableOpacity style={styles.addButton} onPress={() => setCreateVisible(true)}>
          <Ionicons name="add" size={22} color="white" />
          <Text style={styles.addButtonText}>New Work Order</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Create modal */}
      <Modal
        visible={createVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setCreateVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <ScrollView>
              <Text style={styles.modalTitle}>New Work Order</Text>

              <Text style={styles.inputLabel}>Asset</Text>
              {assetsQuery.isLoading ? (
                <Text style={styles.emptyText}>Loading assets…</Text>
              ) : assets.length === 0 ? (
                <Text style={styles.emptyText}>
                  No assets registered. A work order must be linked to an asset.
                </Text>
              ) : (
                <View style={styles.chipRowWrap}>
                  {assets.map((a) => (
                    <TouchableOpacity
                      key={a.id}
                      style={[styles.chip, assetId === a.id && styles.chipActive]}
                      onPress={() => setAssetId(a.id)}
                    >
                      <Text
                        style={[styles.chipText, assetId === a.id && styles.chipTextActive]}
                      >
                        {a.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <Text style={styles.inputLabel}>Title</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Inverter fault after voltage sag"
                placeholderTextColor="#9ca3af"
                value={title}
                onChangeText={setTitle}
              />

              <Text style={styles.inputLabel}>Description (optional)</Text>
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                placeholder="What needs to be done?"
                placeholderTextColor="#9ca3af"
                value={description}
                onChangeText={setDescription}
                multiline
              />

              <Text style={styles.inputLabel}>Priority</Text>
              <View style={styles.chipRowWrap}>
                {PRIORITIES.map((p) => (
                  <TouchableOpacity
                    key={p}
                    style={[styles.chip, priority === p && styles.chipActive]}
                    onPress={() => setPriority(p)}
                  >
                    <Text style={[styles.chipText, priority === p && styles.chipTextActive]}>
                      {p}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity
                style={styles.saveButton}
                onPress={handleCreate}
                disabled={createMutation.isPending || assets.length === 0}
              >
                <Text style={styles.saveButtonText}>
                  {createMutation.isPending ? 'Creating…' : 'Create Work Order'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setCreateVisible(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Detail modal with events timeline */}
      <Modal
        visible={detailId != null}
        animationType="slide"
        transparent
        onRequestClose={() => setDetailId(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <ScrollView>
              {detailQuery.isLoading ? (
                <Text style={styles.emptyText}>Loading work order…</Text>
              ) : detailQuery.isError || detail == null ? (
                <Text style={styles.emptyText}>Could not load this work order</Text>
              ) : (
                <>
                  <Text style={styles.modalTitle}>{detail.order.title}</Text>
                  <Text style={styles.orderMeta}>
                    {assetName(detail.order.assetId)} · priority {detail.order.priority} ·
                    status {detail.order.status.replace('_', ' ')}
                  </Text>
                  {detail.order.description ? (
                    <Text style={styles.bodyText}>{detail.order.description}</Text>
                  ) : null}
                  {detail.order.assignedTo != null && (
                    <Text style={styles.orderMeta}>
                      Assigned to user #{detail.order.assignedTo}
                    </Text>
                  )}
                  {detail.order.dueAt ? (
                    <Text style={styles.orderMeta}>Due {formatDate(detail.order.dueAt)}</Text>
                  ) : null}

                  <Text style={[styles.sectionTitle, { marginTop: 16 }]}>Timeline</Text>
                  {detail.events.length === 0 ? (
                    <Text style={styles.emptyText}>No events recorded.</Text>
                  ) : (
                    detail.events.map((e) => (
                      <View key={e.id} style={styles.eventRow}>
                        <View style={styles.eventDot} />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.eventTitle}>
                            {EVENT_LABELS[e.eventType] ?? e.eventType}
                            {e.fromStatus || e.toStatus
                              ? ` (${e.fromStatus ?? '—'} → ${e.toStatus ?? '—'})`
                              : ''}
                          </Text>
                          {e.note ? (
                            <Text style={styles.eventNote} numberOfLines={3}>
                              {e.note}
                            </Text>
                          ) : null}
                          <Text style={styles.eventMeta}>
                            {formatDate(e.createdAt)} · by user #{e.actorUserId}
                          </Text>
                        </View>
                      </View>
                    ))
                  )}
                </>
              )}
              <TouchableOpacity style={styles.modalCancel} onPress={() => setDetailId(null)}>
                <Text style={styles.modalCancelText}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  container: {
    flex: 1,
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
    marginTop: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 20,
  },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 8,
  },
  orderTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  orderMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  statusChip: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#e0f2fe',
  },
  statusDone: {
    backgroundColor: '#d1fae5',
  },
  statusCancelled: {
    backgroundColor: '#e5e7eb',
  },
  statusInProgress: {
    backgroundColor: '#fef3c7',
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
  addButton: {
    backgroundColor: '#10b981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 24,
    gap: 6,
  },
  addButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: 'white',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    maxHeight: '90%',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 8,
  },
  inputLabel: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111827',
    marginBottom: 12,
    backgroundColor: '#f9fafb',
  },
  inputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  chipRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  chip: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  chipText: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '600',
  },
  chipTextActive: {
    color: 'white',
  },
  saveButton: {
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  saveButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  modalCancelText: {
    color: '#6b7280',
    fontSize: 16,
    fontWeight: '600',
  },
  eventRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  eventDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#10b981',
    marginTop: 4,
  },
  eventTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  eventNote: {
    fontSize: 13,
    color: '#374151',
    marginTop: 2,
  },
  eventMeta: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  },
});

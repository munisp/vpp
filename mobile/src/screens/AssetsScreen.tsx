import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import { trpc } from '../services/trpc';

export default function AssetsScreen() {
  const { data: assets, isLoading, refetch } = trpc.assets.list.useQuery();
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<any>(null);

  const registerMutation = trpc.assets.register.useMutation({
    onSuccess: () => {
      refetch();
      setModalVisible(false);
      Alert.alert('Success', 'Asset registered successfully');
    },
    onError: (error) => {
      Alert.alert('Error', error.message);
    },
  });

  const handleRegister = (data: any) => {
    registerMutation.mutate(data);
  };

  const renderAsset = ({ item }: { item: any }) => (
    <TouchableOpacity
      style={styles.assetCard}
      onPress={() => {
        setSelectedAsset(item);
        setModalVisible(true);
      }}
    >
      <View style={styles.assetHeader}>
        <View>
          <Text style={styles.assetName}>{item.name}</Text>
          <Text style={styles.assetType}>{item.type}</Text>
        </View>
        <View style={[
          styles.statusBadge,
          { backgroundColor: item.status === 'active' ? '#10b981' : '#6b7280' }
        ]}>
          <Text style={styles.statusText}>{item.status}</Text>
        </View>
      </View>

      <View style={styles.assetStats}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Capacity</Text>
          <Text style={styles.statValue}>{(item.capacity / 1000).toFixed(1)} kW</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>Location</Text>
          <Text style={styles.statValue}>{item.location}</Text>
        </View>
      </View>

      {item.metadata && (
        <View style={styles.metadata}>
          <Text style={styles.metadataText}>
            {JSON.parse(item.metadata).manufacturer || 'N/A'}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>My Assets</Text>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => {
            setSelectedAsset(null);
            setModalVisible(true);
          }}
        >
          <Text style={styles.addButtonText}>+ Add Asset</Text>
        </TouchableOpacity>
      </View>

      {/* Assets List */}
      {isLoading ? (
        <View style={styles.loading}>
          <Text>Loading assets...</Text>
        </View>
      ) : assets && assets.length > 0 ? (
        <FlatList
          data={assets}
          renderItem={renderAsset}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.list}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>📦</Text>
          <Text style={styles.emptyTitle}>No Assets Yet</Text>
          <Text style={styles.emptyText}>
            Register your first solar panel or battery to get started
          </Text>
          <TouchableOpacity
            style={styles.emptyButton}
            onPress={() => setModalVisible(true)}
          >
            <Text style={styles.emptyButtonText}>Register Asset</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Add/Edit Modal */}
      <AssetFormModal
        visible={modalVisible}
        asset={selectedAsset}
        onClose={() => setModalVisible(false)}
        onSubmit={handleRegister}
      />
    </View>
  );
}

function AssetFormModal({
  visible,
  asset,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  asset: any;
  onClose: () => void;
  onSubmit: (data: any) => void;
}) {
  const [name, setName] = useState(asset?.name || '');
  const [type, setType] = useState(asset?.type || 'solar_panel');
  const [capacity, setCapacity] = useState(asset?.capacity?.toString() || '');
  const [location, setLocation] = useState(asset?.location || '');

  const handleSubmit = () => {
    if (!name || !capacity || !location) {
      Alert.alert('Error', 'Please fill all required fields');
      return;
    }

    onSubmit({
      name,
      type,
      capacity: parseInt(capacity),
      location,
      status: 'active',
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>
            {asset ? 'Edit Asset' : 'Register New Asset'}
          </Text>

          <TextInput
            style={styles.input}
            placeholder="Asset Name"
            value={name}
            onChangeText={setName}
          />

          <View style={styles.typeSelector}>
            <TouchableOpacity
              style={[
                styles.typeButton,
                type === 'solar_panel' && styles.typeButtonActive,
              ]}
              onPress={() => setType('solar_panel')}
            >
              <Text
                style={[
                  styles.typeButtonText,
                  type === 'solar_panel' && styles.typeButtonTextActive,
                ]}
              >
                ☀️ Solar Panel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.typeButton,
                type === 'battery' && styles.typeButtonActive,
              ]}
              onPress={() => setType('battery')}
            >
              <Text
                style={[
                  styles.typeButtonText,
                  type === 'battery' && styles.typeButtonTextActive,
                ]}
              >
                🔋 Battery
              </Text>
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.input}
            placeholder="Capacity (Watts)"
            value={capacity}
            onChangeText={setCapacity}
            keyboardType="numeric"
          />

          <TextInput
            style={styles.input}
            placeholder="Location"
            value={location}
            onChangeText={setLocation}
          />

          <View style={styles.modalButtons}>
            <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.submitButton} onPress={handleSubmit}>
              <Text style={styles.submitButtonText}>
                {asset ? 'Update' : 'Register'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  addButton: {
    backgroundColor: '#10b981',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  list: {
    padding: 16,
  },
  assetCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  assetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  assetName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  assetType: {
    fontSize: 14,
    color: '#6b7280',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  assetStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  stat: {
    flex: 1,
  },
  statLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  metadata: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
  },
  metadataText: {
    fontSize: 12,
    color: '#6b7280',
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 24,
  },
  emptyButton: {
    backgroundColor: '#10b981',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  emptyButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 24,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  typeSelector: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  typeButton: {
    flex: 1,
    padding: 12,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    marginRight: 8,
    alignItems: 'center',
  },
  typeButtonActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  typeButtonText: {
    color: '#6b7280',
    fontWeight: '500',
  },
  typeButtonTextActive: {
    color: '#fff',
  },
  modalButtons: {
    flexDirection: 'row',
    marginTop: 8,
  },
  cancelButton: {
    flex: 1,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    marginRight: 8,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#6b7280',
    fontWeight: '600',
  },
  submitButton: {
    flex: 1,
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#10b981',
    alignItems: 'center',
  },
  submitButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});

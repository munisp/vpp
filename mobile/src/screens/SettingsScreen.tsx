import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const [notifications, setNotifications] = React.useState(true);
  const [autoSell, setAutoSell] = React.useState(false);
  const [drAutoOptIn, setDrAutoOptIn] = React.useState(true);

  const handleLogout = () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Logout', onPress: logout, style: 'destructive' },
      ]
    );
  };

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      {/* Profile Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Profile</Text>
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {user?.name?.charAt(0).toUpperCase() || 'U'}
            </Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{user?.name || 'User'}</Text>
            <Text style={styles.profileEmail}>{user?.email || 'No email'}</Text>
          </View>
        </View>
      </View>

      {/* Notifications */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        <SettingItem
          icon="🔔"
          title="Push Notifications"
          description="Receive alerts about DR events and trades"
          rightComponent={
            <Switch
              value={notifications}
              onValueChange={setNotifications}
              trackColor={{ false: '#d1d5db', true: '#10b981' }}
              thumbColor="#fff"
            />
          }
        />
      </View>

      {/* Trading Preferences */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Trading</Text>
        <SettingItem
          icon="💱"
          title="Auto-sell Energy"
          description="Automatically sell surplus energy at market price"
          rightComponent={
            <Switch
              value={autoSell}
              onValueChange={setAutoSell}
              trackColor={{ false: '#d1d5db', true: '#10b981' }}
              thumbColor="#fff"
            />
          }
        />
        <SettingItem
          icon="💰"
          title="Payment Method"
          description="M-Pesa (255XXXXXXXXX)"
          onPress={() => Alert.alert('Coming soon')}
        />
      </View>

      {/* Demand Response */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Demand Response</Text>
        <SettingItem
          icon="⚡"
          title="Auto Opt-in"
          description="Automatically participate in DR events"
          rightComponent={
            <Switch
              value={drAutoOptIn}
              onValueChange={setDrAutoOptIn}
              trackColor={{ false: '#d1d5db', true: '#10b981' }}
              thumbColor="#fff"
            />
          }
        />
        <SettingItem
          icon="🎯"
          title="Participation Preferences"
          description="Set your DR participation limits"
          onPress={() => Alert.alert('Coming soon')}
        />
      </View>

      {/* App Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>App</Text>
        <SettingItem
          icon="🌙"
          title="Dark Mode"
          description="Switch to dark theme"
          onPress={() => Alert.alert('Coming soon')}
        />
        <SettingItem
          icon="🌍"
          title="Language"
          description="English"
          onPress={() => Alert.alert('Coming soon')}
        />
        <SettingItem
          icon="📊"
          title="Data Usage"
          description="Manage offline sync settings"
          onPress={() => Alert.alert('Coming soon')}
        />
      </View>

      {/* About */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <SettingItem
          icon="ℹ️"
          title="App Version"
          description="1.0.0"
        />
        <SettingItem
          icon="📄"
          title="Terms of Service"
          onPress={() => Alert.alert('Coming soon')}
        />
        <SettingItem
          icon="🔒"
          title="Privacy Policy"
          onPress={() => Alert.alert('Coming soon')}
        />
        <SettingItem
          icon="💬"
          title="Help & Support"
          onPress={() => Alert.alert('Coming soon')}
        />
      </View>

      {/* Logout */}
      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutButtonText}>Logout</Text>
      </TouchableOpacity>

      <View style={styles.footer}>
        <Text style={styles.footerText}>VPP Platform © 2025</Text>
      </View>
    </ScrollView>
  );
}

function SettingItem({
  icon,
  title,
  description,
  onPress,
  rightComponent,
}: {
  icon: string;
  title: string;
  description?: string;
  onPress?: () => void;
  rightComponent?: React.ReactNode;
}) {
  const content = (
    <View style={styles.settingItem}>
      <View style={styles.settingLeft}>
        <Text style={styles.settingIcon}>{icon}</Text>
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>{title}</Text>
          {description && (
            <Text style={styles.settingDescription}>{description}</Text>
          )}
        </View>
      </View>
      {rightComponent || (
        onPress && (
          <Text style={styles.settingArrow}>›</Text>
        )
      )}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress}>
        {content}
      </TouchableOpacity>
    );
  }

  return content;
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
  },
  section: {
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  profileCard: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e5e7eb',
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  avatarText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  profileEmail: {
    fontSize: 14,
    color: '#6b7280',
  },
  settingItem: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  settingIcon: {
    fontSize: 24,
    marginRight: 16,
  },
  settingText: {
    flex: 1,
  },
  settingTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#111827',
    marginBottom: 2,
  },
  settingDescription: {
    fontSize: 13,
    color: '#6b7280',
  },
  settingArrow: {
    fontSize: 24,
    color: '#d1d5db',
  },
  logoutButton: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 24,
    marginBottom: 16,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ef4444',
  },
  logoutButtonText: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '600',
  },
  footer: {
    padding: 24,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: '#9ca3af',
  },
});

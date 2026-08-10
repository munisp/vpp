import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { trpc } from '../services/trpc';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';

// Server-side preference fields (server/routers/notificationPreferences.ts).
// The server has no master "enablePush"/"enableEmail" or generic
// "notifyTrade" flags — only per-category flags — so the group toggles
// below are derived from / mapped onto these real fields.
const PUSH_FLAGS = [
  'pushPaymentReceived',
  'pushAchievementUnlocked',
  'pushDREventReminder',
  'pushDREventCreated',
  'pushLeaderboardRankChange',
  'pushTradeExecuted',
  'pushTradeFailed',
  'pushSystemAlert',
  'pushBillingAlert',
] as const;

const EMAIL_FLAGS = [
  'emailPaymentReceived',
  'emailTradeExecuted',
  'emailTradeFailed',
  'emailSystemAlert',
  'emailAchievementUnlocked',
  'emailDREventReminder',
  'emailDREventCreated',
  'emailLeaderboardRankChange',
] as const;

// Maps each local group toggle to the server field(s) it controls.
const GROUP_TO_SERVER_FLAGS: Record<string, readonly string[]> = {
  notifyTrade: ['pushTradeExecuted', 'pushTradeFailed'],
  notifyPayment: ['pushPaymentReceived'],
  notifyDR: ['pushDREventReminder', 'pushDREventCreated'],
  notifyAchievement: ['pushAchievementUnlocked'],
  notifySystem: ['pushSystemAlert'],
  notifyBilling: ['pushBillingAlert'],
};

export default function NotificationSettingsScreen() {
  const { data: preferences, isLoading } = trpc.notificationPreferences.get.useQuery();
  const utils = trpc.useUtils();
  const updatePreferences = trpc.notificationPreferences.update.useMutation({
    onSuccess: () => {
      utils.notificationPreferences.get.invalidate();
    },
    onError: (error) => {
      Alert.alert('Error', `Could not update preferences: ${error.message}`);
    },
  });

  const [localPrefs, setLocalPrefs] = useState({
    enablePush: true,
    enableEmail: false,
    enableSound: true,
    notifyTrade: true,
    notifyPayment: true,
    notifyDR: true,
    notifyAchievement: true,
    notifySystem: true,
    notifyBilling: true,
    emailWeeklySummary: false,
    emailMonthlySummary: false,
    frequency: 'instant' as 'instant' | 'hourly' | 'daily',
    quietHoursEnabled: false,
    quietHoursStart: '22:00:00',
    quietHoursEnd: '07:00:00',
  });

  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);

  useEffect(() => {
    if (preferences) {
      const prefs = preferences as unknown as Record<string, unknown>;
      // Master toggles are "on" only when every underlying server flag is
      // enabled (same convention as SettingsScreen's push toggle).
      setLocalPrefs({
        enablePush: PUSH_FLAGS.every((flag) => prefs[flag] === true),
        enableEmail: EMAIL_FLAGS.every((flag) => prefs[flag] === true),
        enableSound: (prefs.notificationSound as boolean) ?? true,
        notifyTrade:
          ((prefs.pushTradeExecuted as boolean) ?? true) &&
          ((prefs.pushTradeFailed as boolean) ?? true),
        notifyPayment: (prefs.pushPaymentReceived as boolean) ?? true,
        notifyDR:
          ((prefs.pushDREventReminder as boolean) ?? true) &&
          ((prefs.pushDREventCreated as boolean) ?? true),
        notifyAchievement: (prefs.pushAchievementUnlocked as boolean) ?? true,
        notifySystem: (prefs.pushSystemAlert as boolean) ?? true,
        notifyBilling: (prefs.pushBillingAlert as boolean) ?? true,
        emailWeeklySummary: (prefs.emailWeeklySummary as boolean) ?? false,
        emailMonthlySummary: (prefs.emailMonthlySummary as boolean) ?? false,
        frequency:
          (prefs.notificationFrequency as 'instant' | 'hourly' | 'daily') ||
          'instant',
        quietHoursEnabled: (prefs.quietHoursEnabled as boolean) ?? false,
        quietHoursStart: (prefs.quietHoursStart as string) || '22:00:00',
        quietHoursEnd: (prefs.quietHoursEnd as string) || '07:00:00',
      });
    }
  }, [preferences]);

  // Translate a local toggle into the server schema's real field names
  // before sending; unknown keys would be silently dropped by the server.
  const buildServerPayload = (
    key: keyof typeof localPrefs,
    value: any
  ): Record<string, unknown> => {
    if (key === 'enablePush') {
      return Object.fromEntries(PUSH_FLAGS.map((flag) => [flag, value]));
    }
    if (key === 'enableEmail') {
      return Object.fromEntries(EMAIL_FLAGS.map((flag) => [flag, value]));
    }
    if (key === 'enableSound') {
      return { notificationSound: value };
    }
    if (key === 'frequency') {
      return { notificationFrequency: value };
    }
    if (key in GROUP_TO_SERVER_FLAGS) {
      return Object.fromEntries(
        GROUP_TO_SERVER_FLAGS[key].map((flag) => [flag, value])
      );
    }
    // emailWeeklySummary, emailMonthlySummary, quietHours* map 1:1.
    return { [key]: value };
  };

  const handleToggle = async (key: keyof typeof localPrefs, value: any) => {
    const newPrefs = { ...localPrefs, [key]: value };
    setLocalPrefs(newPrefs);

    try {
      await updatePreferences.mutateAsync(
        buildServerPayload(key, value) as any
      );
    } catch (error) {
      console.error('Failed to update preferences:', error);
      // Revert on error
      setLocalPrefs(localPrefs);
    }
  };

  const parseTime = (timeString: string) => {
    const [hours, minutes] = timeString.split(':').map(Number);
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
  };

  const formatTime = (date: Date) => {
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}:00`;
  };

  const handleTimeChange = async (type: 'start' | 'end', event: any, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowStartPicker(false);
      setShowEndPicker(false);
    }

    if (selectedDate) {
      const timeString = formatTime(selectedDate);
      const key = type === 'start' ? 'quietHoursStart' : 'quietHoursEnd';
      await handleToggle(key, timeString);
    }
  };

  if (isLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Notification Settings</Text>
        <Text style={styles.subtitle}>
          Customize how you receive notifications
        </Text>
      </View>

      {/* Push Notifications */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Push Notifications</Text>
        
        <SettingRow
          icon="notifications"
          label="Enable Push Notifications"
          value={localPrefs.enablePush}
          onValueChange={(value) => handleToggle('enablePush', value)}
        />

        <SettingRow
          icon="volume-high"
          label="Notification Sound"
          value={localPrefs.enableSound}
          onValueChange={(value) => handleToggle('enableSound', value)}
          disabled={!localPrefs.enablePush}
        />
      </View>

      {/* Notification Types */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notification Types</Text>
        
        <SettingRow
          icon="flash"
          label="Trade Confirmations"
          description="Notifications when trades are executed"
          value={localPrefs.notifyTrade}
          onValueChange={(value) => handleToggle('notifyTrade', value)}
          disabled={!localPrefs.enablePush}
        />

        <SettingRow
          icon="card"
          label="Payment Notifications"
          description="Notifications for payment receipts"
          value={localPrefs.notifyPayment}
          onValueChange={(value) => handleToggle('notifyPayment', value)}
          disabled={!localPrefs.enablePush}
        />

        <SettingRow
          icon="trending-down"
          label="DR Event Alerts"
          description="Demand response event notifications"
          value={localPrefs.notifyDR}
          onValueChange={(value) => handleToggle('notifyDR', value)}
          disabled={!localPrefs.enablePush}
        />

        <SettingRow
          icon="trophy"
          label="Achievement Unlocked"
          description="Gamification and milestone notifications"
          value={localPrefs.notifyAchievement}
          onValueChange={(value) => handleToggle('notifyAchievement', value)}
          disabled={!localPrefs.enablePush}
        />

        <SettingRow
          icon="information-circle"
          label="System Alerts"
          description="Important system notifications"
          value={localPrefs.notifySystem}
          onValueChange={(value) => handleToggle('notifySystem', value)}
          disabled={!localPrefs.enablePush}
        />

        <SettingRow
          icon="receipt"
          label="Billing Notifications"
          description="Invoice and billing updates"
          value={localPrefs.notifyBilling}
          onValueChange={(value) => handleToggle('notifyBilling', value)}
          disabled={!localPrefs.enablePush}
        />
      </View>

      {/* Notification Frequency */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notification Frequency</Text>
        
        <View style={styles.radioGroup}>
          <RadioOption
            label="Instant"
            description="Receive notifications immediately"
            selected={localPrefs.frequency === 'instant'}
            onPress={() => handleToggle('frequency', 'instant')}
            disabled={!localPrefs.enablePush}
          />
          <RadioOption
            label="Hourly Digest"
            description="Receive a summary every hour"
            selected={localPrefs.frequency === 'hourly'}
            onPress={() => handleToggle('frequency', 'hourly')}
            disabled={!localPrefs.enablePush}
          />
          <RadioOption
            label="Daily Digest"
            description="Receive a summary once per day"
            selected={localPrefs.frequency === 'daily'}
            onPress={() => handleToggle('frequency', 'daily')}
            disabled={!localPrefs.enablePush}
          />
        </View>
      </View>

      {/* Quiet Hours */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quiet Hours</Text>
        
        <SettingRow
          icon="moon"
          label="Enable Quiet Hours"
          description="Pause notifications during specific hours"
          value={localPrefs.quietHoursEnabled}
          onValueChange={(value) => handleToggle('quietHoursEnabled', value)}
          disabled={!localPrefs.enablePush}
        />

        {localPrefs.quietHoursEnabled && (
          <>
            <TouchableOpacity
              style={styles.timeButton}
              onPress={() => setShowStartPicker(true)}
              disabled={!localPrefs.enablePush}
            >
              <View style={styles.timeButtonContent}>
                <Ionicons name="time" size={20} color="#6b7280" />
                <Text style={styles.timeButtonLabel}>Start Time</Text>
              </View>
              <Text style={styles.timeButtonValue}>
                {localPrefs.quietHoursStart.substring(0, 5)}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.timeButton}
              onPress={() => setShowEndPicker(true)}
              disabled={!localPrefs.enablePush}
            >
              <View style={styles.timeButtonContent}>
                <Ionicons name="time" size={20} color="#6b7280" />
                <Text style={styles.timeButtonLabel}>End Time</Text>
              </View>
              <Text style={styles.timeButtonValue}>
                {localPrefs.quietHoursEnd.substring(0, 5)}
              </Text>
            </TouchableOpacity>

            {showStartPicker && (
              <DateTimePicker
                value={parseTime(localPrefs.quietHoursStart)}
                mode="time"
                is24Hour={true}
                display="default"
                onChange={(event, date) => handleTimeChange('start', event, date)}
              />
            )}

            {showEndPicker && (
              <DateTimePicker
                value={parseTime(localPrefs.quietHoursEnd)}
                mode="time"
                is24Hour={true}
                display="default"
                onChange={(event, date) => handleTimeChange('end', event, date)}
              />
            )}
          </>
        )}
      </View>

      {/* Email Notifications */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Email Notifications</Text>
        
        <SettingRow
          icon="mail"
          label="Enable Email Notifications"
          value={localPrefs.enableEmail}
          onValueChange={(value) => handleToggle('enableEmail', value)}
        />

        <SettingRow
          icon="calendar"
          label="Weekly Summary"
          description="Receive a weekly activity summary"
          value={localPrefs.emailWeeklySummary}
          onValueChange={(value) => handleToggle('emailWeeklySummary', value)}
          disabled={!localPrefs.enableEmail}
        />

        <SettingRow
          icon="calendar"
          label="Monthly Summary"
          description="Receive a monthly activity summary"
          value={localPrefs.emailMonthlySummary}
          onValueChange={(value) => handleToggle('emailMonthlySummary', value)}
          disabled={!localPrefs.enableEmail}
        />
      </View>
    </ScrollView>
  );
}

function SettingRow({
  icon,
  label,
  description,
  value,
  onValueChange,
  disabled = false,
}: {
  icon: string;
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.settingRow, disabled && styles.settingRowDisabled]}>
      <View style={styles.settingLeft}>
        <Ionicons
          name={icon as any}
          size={24}
          color={disabled ? '#d1d5db' : '#6b7280'}
        />
        <View style={styles.settingText}>
          <Text style={[styles.settingLabel, disabled && styles.disabledText]}>
            {label}
          </Text>
          {description && (
            <Text style={[styles.settingDescription, disabled && styles.disabledText]}>
              {description}
            </Text>
          )}
        </View>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: '#d1d5db', true: '#86efac' }}
        thumbColor={value ? '#10b981' : '#f3f4f6'}
      />
    </View>
  );
}

function RadioOption({
  label,
  description,
  selected,
  onPress,
  disabled = false,
}: {
  label: string;
  description: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.radioOption,
        selected && styles.radioOptionSelected,
        disabled && styles.radioOptionDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={styles.radioCircle}>
        {selected && <View style={styles.radioCircleInner} />}
      </View>
      <View style={styles.radioText}>
        <Text style={[styles.radioLabel, disabled && styles.disabledText]}>
          {label}
        </Text>
        <Text style={[styles.radioDescription, disabled && styles.disabledText]}>
          {description}
        </Text>
      </View>
    </TouchableOpacity>
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
  section: {
    backgroundColor: '#fff',
    marginTop: 16,
    paddingVertical: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  settingRowDisabled: {
    opacity: 0.5,
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 16,
  },
  settingText: {
    marginLeft: 12,
    flex: 1,
  },
  settingLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
  },
  settingDescription: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  disabledText: {
    color: '#d1d5db',
  },
  radioGroup: {
    paddingHorizontal: 16,
  },
  radioOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginBottom: 8,
  },
  radioOptionSelected: {
    borderColor: '#10b981',
    backgroundColor: '#f0fdf4',
  },
  radioOptionDisabled: {
    opacity: 0.5,
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#d1d5db',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  radioCircleInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#10b981',
  },
  radioText: {
    flex: 1,
  },
  radioLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
  },
  radioDescription: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  timeButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  timeButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  timeButtonLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
    marginLeft: 12,
  },
  timeButtonValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#10b981',
  },
});

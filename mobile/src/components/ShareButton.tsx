import React from 'react';
import { TouchableOpacity, Text, StyleSheet, View, Alert } from 'react-native';
import { HapticService } from '../services/hapticService';

interface ShareButtonProps {
  onPress: () => Promise<boolean>;
  label?: string;
  icon?: string;
  variant?: 'primary' | 'secondary' | 'icon';
  size?: 'small' | 'medium' | 'large';
}

/**
 * Reusable Share Button Component
 * Provides consistent share functionality across the app
 */
export default function ShareButton({
  onPress,
  label = 'Share',
  icon = '📤',
  variant = 'secondary',
  size = 'medium',
}: ShareButtonProps) {
  const [isSharing, setIsSharing] = React.useState(false);

  const handlePress = async () => {
    if (isSharing) return;

    // Haptic feedback on button press
    await HapticService.buttonPress();

    setIsSharing(true);
    try {
      const success = await onPress();
      if (success) {
        // Haptic feedback on successful share
        await HapticService.shareAction();
      }
    } catch (error) {
      // Haptic feedback on error
      await HapticService.error();
      Alert.alert('Error', 'Failed to share. Please try again.');
      console.error('Share error:', error);
    } finally {
      setIsSharing(false);
    }
  };

  if (variant === 'icon') {
    return (
      <TouchableOpacity
        onPress={handlePress}
        disabled={isSharing}
        style={[styles.iconButton, styles[`${size}Icon`]]}
        activeOpacity={0.7}
      >
        <Text style={styles.iconText}>{icon}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={isSharing}
      style={[
        styles.button,
        styles[variant],
        styles[size],
        isSharing && styles.disabled,
      ]}
      activeOpacity={0.7}
    >
      <View style={styles.content}>
        <Text style={styles.icon}>{icon}</Text>
        <Text style={[styles.label, styles[`${variant}Label`]]}>
          {isSharing ? 'Sharing...' : label}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  primary: {
    backgroundColor: '#10b981',
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#10b981',
  },
  small: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  medium: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  large: {
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  disabled: {
    opacity: 0.5,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  icon: {
    fontSize: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
  primaryLabel: {
    color: '#ffffff',
  },
  secondaryLabel: {
    color: '#10b981',
  },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: '#f0fdf4',
  },
  smallIcon: {
    width: 32,
    height: 32,
  },
  mediumIcon: {
    width: 40,
    height: 40,
  },
  largeIcon: {
    width: 48,
    height: 48,
  },
  iconText: {
    fontSize: 20,
  },
});

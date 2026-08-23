import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Alert,
  FlatList,
} from 'react-native';
import { trpc } from '../services/trpc';
import { Ionicons } from '@expo/vector-icons';

const { width } = Dimensions.get('window');

const STEPS = [
  {
    id: 1,
    title: 'Register Your First Asset',
    description: 'Add your solar panels and batteries to start earning from your energy.',
    icon: 'flash',
  },
  {
    id: 2,
    title: 'Setup Payments',
    description: 'Configure how you want to receive payments for your energy.',
    icon: 'card',
  },
  {
    id: 3,
    title: 'Configure Trading',
    description: 'Set your trading preferences and automation rules.',
    icon: 'trending-up',
  },
  {
    id: 4,
    title: 'Complete Your Profile',
    description: "You're all set! Start earning from your energy today.",
    icon: 'checkmark-circle',
  },
];

export default function OnboardingScreen({ navigation }: any) {
  const [currentStep, setCurrentStep] = useState(0);
  const flatListRef = useRef<FlatList>(null);

  const utils = trpc.useUtils();
  const registerAsset = trpc.assets.register.useMutation();
  const updateOnboarding = trpc.onboarding.updateStep.useMutation();
  const completeOnboarding = trpc.onboarding.complete.useMutation({
    onSuccess: () => {
      // Keep AppNavigator's routing signal (onboarding.getStatus) in sync.
      utils.onboarding.getStatus.invalidate();
    },
  });

  // Step 1: Asset Registration
  const [assetForm, setAssetForm] = useState({
    name: '',
    type: 'solar_panel' as 'solar_panel' | 'battery',
    capacity: '',
    make: '',
    model: '',
  });

  // Step 3: Trading Preferences
  const [tradingForm, setTradingForm] = useState({
    autoTradingEnabled: false,
    minExportPrice: '',
    maxImportPrice: '',
  });

  const handleNext = async () => {
    if (currentStep === 0) {
      // Validate and save asset
      if (!assetForm.name || !assetForm.capacity) {
        Alert.alert('Error', 'Please fill in all required fields');
        return;
      }

      try {
        await registerAsset.mutateAsync({
          name: assetForm.name,
          // assets.register accepts 'solar' | 'battery' | ... (not 'solar_panel')
          assetType: assetForm.type === 'solar_panel' ? 'solar' : 'battery',
          // capacity is a positive integer in Wh
          capacity: Math.round(parseFloat(assetForm.capacity)),
          make: assetForm.make || undefined,
          model: assetForm.model || undefined,
        });
        await updateOnboarding.mutateAsync({ step: 2 });
      } catch (error) {
        Alert.alert('Error', 'Failed to register asset');
        return;
      }
    } else if (currentStep === 1) {
      // Skip payment setup for now (admin only)
      await updateOnboarding.mutateAsync({ step: 3 });
    } else if (currentStep === 2) {
      // Save trading preferences
      await updateOnboarding.mutateAsync({ step: 4 });
    } else if (currentStep === 3) {
      // Complete onboarding
      try {
        await completeOnboarding.mutateAsync();
        Alert.alert(
          'Welcome to VPP Platform! 🎉',
          'Your account is ready. Start trading energy now!',
          [
            {
              text: 'Get Started',
              onPress: () => navigation.replace('Main'),
            },
          ]
        );
        return;
      } catch (error) {
        Alert.alert('Error', 'Failed to complete onboarding');
        return;
      }
    }

    const nextStep = currentStep + 1;
    setCurrentStep(nextStep);
    flatListRef.current?.scrollToIndex({ index: nextStep, animated: true });
  };

  const handleSkip = async () => {
    Alert.alert(
      'Skip Onboarding?',
      'You can complete these steps later from Settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Skip',
          style: 'destructive',
          onPress: async () => {
            try {
              await completeOnboarding.mutateAsync();
              navigation.replace('Main');
            } catch (error) {
              console.error('Failed to skip onboarding:', error);
            }
          },
        },
      ]
    );
  };

  const renderStep = ({ item, index }: { item: typeof STEPS[0]; index: number }) => {
    return (
      <View style={[styles.stepContainer, { width }]}>
        <View style={styles.stepContent}>
          <View style={styles.iconContainer}>
            <Ionicons name={item.icon as any} size={64} color="#10b981" />
          </View>

          <Text style={styles.stepTitle}>{item.title}</Text>
          <Text style={styles.stepDescription}>{item.description}</Text>

          {index === 0 && <Step1AssetForm form={assetForm} setForm={setAssetForm} />}
          {index === 1 && <Step2PaymentInfo />}
          {index === 2 && <Step3TradingPreferences form={tradingForm} setForm={setTradingForm} />}
          {index === 3 && <Step4Complete />}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Progress Bar */}
      <View style={styles.progressContainer}>
        <View style={styles.progressBar}>
          {STEPS.map((_, index) => (
            <View
              key={index}
              style={[
                styles.progressDot,
                index <= currentStep && styles.progressDotActive,
              ]}
            />
          ))}
        </View>
        <TouchableOpacity style={styles.skipButton} onPress={handleSkip}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>

      {/* Steps */}
      <FlatList
        ref={flatListRef}
        data={STEPS}
        renderItem={renderStep}
        keyExtractor={(item) => item.id.toString()}
        horizontal
        pagingEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
      />

      {/* Navigation */}
      <View style={styles.navigationContainer}>
        <TouchableOpacity
          style={[styles.button, styles.buttonPrimary]}
          onPress={handleNext}
          disabled={registerAsset.isPending || updateOnboarding.isPending || completeOnboarding.isPending}
        >
          <Text style={styles.buttonText}>
            {currentStep === 3 ? 'Complete' : 'Continue'}
          </Text>
          <Ionicons name="arrow-forward" size={20} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Step1AssetForm({ form, setForm }: any) {
  return (
    <View style={styles.formContainer}>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Asset Type *</Text>
        <View style={styles.segmentedControl}>
          <TouchableOpacity
            style={[
              styles.segment,
              form.type === 'solar_panel' && styles.segmentActive,
            ]}
            onPress={() => setForm({ ...form, type: 'solar_panel' })}
          >
            <Text
              style={[
                styles.segmentText,
                form.type === 'solar_panel' && styles.segmentTextActive,
              ]}
            >
              Solar Panel
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.segment,
              form.type === 'battery' && styles.segmentActive,
            ]}
            onPress={() => setForm({ ...form, type: 'battery' })}
          >
            <Text
              style={[
                styles.segmentText,
                form.type === 'battery' && styles.segmentTextActive,
              ]}
            >
              Battery
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Asset Name *</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g., Rooftop Solar Panel"
          value={form.name}
          onChangeText={(text) => setForm({ ...form, name: text })}
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Capacity (Watts) *</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g., 5000"
          value={form.capacity}
          onChangeText={(text) => setForm({ ...form, capacity: text })}
          keyboardType="numeric"
        />
      </View>

      <View style={styles.inputRow}>
        <View style={[styles.inputGroup, styles.inputHalf]}>
          <Text style={styles.inputLabel}>Make</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g., SunPower"
            value={form.make}
            onChangeText={(text) => setForm({ ...form, make: text })}
          />
        </View>

        <View style={[styles.inputGroup, styles.inputHalf]}>
          <Text style={styles.inputLabel}>Model</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g., SPR-X22-370"
            value={form.model}
            onChangeText={(text) => setForm({ ...form, model: text })}
          />
        </View>
      </View>
    </View>
  );
}

function Step2PaymentInfo() {
  return (
    <View style={styles.formContainer}>
      <View style={styles.infoBox}>
        <Ionicons name="information-circle" size={24} color="#3b82f6" />
        <Text style={styles.infoText}>
          Payment setup is currently managed by administrators. Your account will be configured shortly.
        </Text>
      </View>
    </View>
  );
}

function Step3TradingPreferences({ form, setForm }: any) {
  return (
    <View style={styles.formContainer}>
      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Minimum Export Price (TZS/kWh)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g., 300"
          value={form.minExportPrice}
          onChangeText={(text) => setForm({ ...form, minExportPrice: text })}
          keyboardType="numeric"
        />
        <Text style={styles.inputHint}>
          The minimum price you're willing to sell energy for
        </Text>
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Maximum Import Price (TZS/kWh)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g., 500"
          value={form.maxImportPrice}
          onChangeText={(text) => setForm({ ...form, maxImportPrice: text })}
          keyboardType="numeric"
        />
        <Text style={styles.inputHint}>
          The maximum price you're willing to buy energy for
        </Text>
      </View>

      <View style={styles.infoBox}>
        <Ionicons name="bulb" size={24} color="#f59e0b" />
        <Text style={styles.infoText}>
          You can always adjust these settings later from the Trading page.
        </Text>
      </View>
    </View>
  );
}

function Step4Complete() {
  return (
    <View style={styles.completeContainer}>
      <View style={styles.celebrationIcon}>
        <Text style={styles.celebrationEmoji}>🎉</Text>
      </View>
      <Text style={styles.completeTitle}>You're All Set!</Text>
      <Text style={styles.completeDescription}>
        Your VPP account is ready. Start trading energy and earning rewards today!
      </Text>

      <View style={styles.featureList}>
        <FeatureItem icon="flash" text="Trade energy automatically" />
        <FeatureItem icon="trending-up" text="Monitor real-time earnings" />
        <FeatureItem icon="trophy" text="Earn achievements and rewards" />
        <FeatureItem icon="people" text="Join the VPP community" />
      </View>
    </View>
  );
}

function FeatureItem({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={styles.featureItem}>
      <View style={styles.featureIcon}>
        <Ionicons name={icon as any} size={20} color="#10b981" />
      </View>
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  progressContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 20,
  },
  progressBar: {
    flexDirection: 'row',
    flex: 1,
    marginRight: 16,
  },
  progressDot: {
    flex: 1,
    height: 4,
    backgroundColor: '#e5e7eb',
    marginHorizontal: 4,
    borderRadius: 2,
  },
  progressDotActive: {
    backgroundColor: '#10b981',
  },
  skipButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  skipButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
  },
  stepContainer: {
    flex: 1,
  },
  stepContent: {
    flex: 1,
    paddingHorizontal: 24,
  },
  iconContainer: {
    alignItems: 'center',
    marginVertical: 24,
  },
  stepTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 8,
  },
  stepDescription: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 32,
  },
  formContainer: {
    flex: 1,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 14,
    color: '#111827',
  },
  inputHint: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  inputRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  inputHalf: {
    flex: 1,
    marginHorizontal: 4,
  },
  segmentedControl: {
    flexDirection: 'row',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  segmentActive: {
    backgroundColor: '#10b981',
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
  },
  segmentTextActive: {
    color: '#fff',
  },
  infoBox: {
    flexDirection: 'row',
    backgroundColor: '#eff6ff',
    padding: 16,
    borderRadius: 8,
    marginTop: 16,
  },
  infoText: {
    flex: 1,
    fontSize: 14,
    color: '#1e40af',
    marginLeft: 12,
  },
  completeContainer: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 24,
  },
  celebrationIcon: {
    marginBottom: 24,
  },
  celebrationEmoji: {
    fontSize: 80,
  },
  completeTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 8,
  },
  completeDescription: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 32,
    paddingHorizontal: 24,
  },
  featureList: {
    width: '100%',
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  featureIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0fdf4',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  featureText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  navigationContainer: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  button: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 8,
  },
  buttonPrimary: {
    backgroundColor: '#10b981',
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    marginRight: 8,
  },
});

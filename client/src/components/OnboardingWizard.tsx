import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Battery, CheckCircle2, CreditCard, Settings, Zap } from "lucide-react";
import confetti from "canvas-confetti";

interface OnboardingWizardProps {
  onComplete: () => void;
}

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const utils = trpc.useUtils();

  // Step 1: Asset Registration
  const [assetData, setAssetData] = useState({
    assetType: "solar" as "solar" | "battery" | "meter" | "generator" | "wind",
    name: "",
    capacity: "",
    make: "",
    model: "",
  });

  // Step 2: Payment Setup (skipped for now - payment credentials are admin-only)
  const [paymentData, setPaymentData] = useState({
    paymentMethod: "mpesa" as "mpesa" | "airtel_money" | "tigo_pesa",
    phoneNumber: "",
  });

  // Step 3: Trading Configuration
  const [tradingData, setTradingData] = useState({
    autoTrading: false,
    p2pEnabled: false,
    minPrice: "",
    maxPrice: "",
  });

  // Mutations
  const createAssetMutation = trpc.assets.register.useMutation({
    onSuccess: () => {
      toast.success("Asset registered successfully!");
      utils.assets.list.invalidate();
      handleNext();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to register asset");
    },
  });

  // Payment credentials are admin-only, so we just skip this step
  const skipPaymentStep = () => {
    toast.info("Payment setup will be configured by admin");
    handleNext();
  };

  const updateTradingPreferencesMutation = trpc.trading.updatePreferences.useMutation({
    onSuccess: () => {
      toast.success("Trading preferences saved!");
      utils.trading.getPreferences.invalidate();
      handleNext();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to save trading preferences");
    },
  });

  const updateStepMutation = trpc.onboarding.updateStep.useMutation();
  const completeOnboardingMutation = trpc.onboarding.complete.useMutation({
    onSuccess: () => {
      // Celebration!
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
      });
      toast.success("Welcome to VPP Platform! 🎉");
      onComplete();
    },
  });

  const skipOnboardingMutation = trpc.onboarding.skip.useMutation({
    onSuccess: () => {
      toast.info("You can complete setup later from Settings");
      onComplete();
    },
  });

  const handleNext = () => {
    const nextStep = currentStep + 1;
    setCurrentStep(nextStep);
    updateStepMutation.mutate({ step: nextStep });
  };

  const handleBack = () => {
    const prevStep = currentStep - 1;
    setCurrentStep(prevStep);
    updateStepMutation.mutate({ step: prevStep });
  };

  const handleStep1Submit = (e: React.FormEvent) => {
    e.preventDefault();
    createAssetMutation.mutate({
      assetType: assetData.assetType,
      name: assetData.name,
      capacity: parseInt(assetData.capacity),
      make: assetData.make || undefined,
      model: assetData.model || undefined,
    });
  };

  const handleStep2Submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Just skip to next step since payment credentials are admin-only
    skipPaymentStep();
  };

  const handleStep3Submit = (e: React.FormEvent) => {
    e.preventDefault();
    updateTradingPreferencesMutation.mutate({
      tradingMode: tradingData.autoTrading ? "automatic" : "manual",
      enableP2P: tradingData.p2pEnabled,
      minExportPrice: tradingData.minPrice ? parseInt(tradingData.minPrice) : undefined,
      maxImportPrice: tradingData.maxPrice ? parseInt(tradingData.maxPrice) : undefined,
    });
  };

  const handleStep4Submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Profile data is already in user table, just complete onboarding
    completeOnboardingMutation.mutate();
  };

  const handleSkip = () => {
    skipOnboardingMutation.mutate();
  };

  const steps = [
    { number: 1, title: "Register Assets", icon: Battery },
    { number: 2, title: "Setup Payments", icon: CreditCard },
    { number: 3, title: "Configure Trading", icon: Settings },
    { number: 4, title: "Complete Profile", icon: CheckCircle2 },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl shadow-xl">
        <CardHeader>
          <div className="flex items-center justify-between mb-4">
            <div>
              <CardTitle className="text-2xl">Welcome to VPP Platform</CardTitle>
              <CardDescription className="mt-2">
                Step {currentStep} of 4
              </CardDescription>
            </div>
            <Button variant="ghost" onClick={handleSkip} disabled={skipOnboardingMutation.isPending}>
              Skip for now
            </Button>
          </div>

          {/* Progress Bar */}
          <div className="relative">
            <div className="flex justify-between mb-2">
              {steps.map((step) => {
                const Icon = step.icon;
                const isActive = currentStep === step.number;
                const isCompleted = currentStep > step.number;
                return (
                  <div key={step.number} className="flex flex-col items-center flex-1">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isCompleted
                          ? "bg-green-600 text-white"
                          : isActive
                          ? "bg-green-600 text-white ring-4 ring-green-200"
                          : "bg-gray-200 text-gray-400"
                      }`}
                    >
                      {isCompleted ? <CheckCircle2 className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                    </div>
                    <p className={`text-xs mt-2 text-center ${isActive ? "font-semibold" : ""}`}>
                      {step.title}
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="absolute top-5 left-0 right-0 h-0.5 bg-gray-200 -z-10">
              <div
                className="h-full bg-green-600 transition-all duration-300"
                style={{ width: `${((currentStep - 1) / 3) * 100}%` }}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {/* Step 1: Register Assets */}
          {currentStep === 1 && (
            <form onSubmit={handleStep1Submit} className="space-y-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 bg-green-100 rounded-lg">
                  <Battery className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg">Register Your First Asset</h3>
                  <p className="text-sm text-muted-foreground">
                    Add your solar panels and batteries to start earning from your energy.
                  </p>
                </div>
              </div>

              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="assetType">Asset Type *</Label>
                  <Select
                    value={assetData.assetType}
                    onValueChange={(value: any) => setAssetData({ ...assetData, assetType: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="solar">Solar Panel</SelectItem>
                      <SelectItem value="battery">Battery</SelectItem>
                      <SelectItem value="meter">Smart Meter</SelectItem>
                      <SelectItem value="generator">Generator</SelectItem>
                      <SelectItem value="wind">Wind Turbine</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="name">Asset Name *</Label>
                  <Input
                    id="name"
                    placeholder="e.g., Rooftop Solar Panel"
                    value={assetData.name}
                    onChange={(e) => setAssetData({ ...assetData, name: e.target.value })}
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="capacity">Capacity (Watts) *</Label>
                  <Input
                    id="capacity"
                    type="number"
                    placeholder="e.g., 5000"
                    value={assetData.capacity}
                    onChange={(e) => setAssetData({ ...assetData, capacity: e.target.value })}
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="make">Make</Label>
                    <Input
                      id="make"
                      placeholder="e.g., SunPower"
                      value={assetData.make}
                      onChange={(e) => setAssetData({ ...assetData, make: e.target.value })}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="model">Model</Label>
                    <Input
                      id="model"
                      placeholder="e.g., SPR-X22-370"
                      value={assetData.model}
                      onChange={(e) => setAssetData({ ...assetData, model: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-6">
                <Button type="submit" disabled={createAssetMutation.isPending}>
                  {createAssetMutation.isPending ? "Registering..." : "Continue"}
                </Button>
              </div>
            </form>
          )}

          {/* Step 2: Setup Payments */}
          {currentStep === 2 && (
            <form onSubmit={handleStep2Submit} className="space-y-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 bg-green-100 rounded-lg">
                  <CreditCard className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg">Setup Payment Method</h3>
                  <p className="text-sm text-muted-foreground">
                    Connect your mobile money account to receive payments.
                  </p>
                </div>
              </div>

              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="paymentMethod">Payment Method *</Label>
                  <Select
                    value={paymentData.paymentMethod}
                    onValueChange={(value: any) => setPaymentData({ ...paymentData, paymentMethod: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mpesa">M-Pesa</SelectItem>
                      <SelectItem value="airtel_money">Airtel Money</SelectItem>
                      <SelectItem value="tigo_pesa">Tigo Pesa</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="phoneNumber">Phone Number *</Label>
                  <Input
                    id="phoneNumber"
                    type="tel"
                    placeholder="e.g., +255712345678"
                    value={paymentData.phoneNumber}
                    onChange={(e) => setPaymentData({ ...paymentData, phoneNumber: e.target.value })}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    This number will be used to receive your earnings
                  </p>
                </div>
              </div>

              <div className="flex justify-between gap-2 mt-6">
                <Button type="button" variant="outline" onClick={handleBack}>
                  Back
                </Button>
                <Button type="submit">
                  Continue
                </Button>
              </div>
            </form>
          )}

          {/* Step 3: Configure Trading */}
          {currentStep === 3 && (
            <form onSubmit={handleStep3Submit} className="space-y-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 bg-green-100 rounded-lg">
                  <Settings className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg">Configure Trading Preferences</h3>
                  <p className="text-sm text-muted-foreground">
                    Set your preferences for how you want to trade your energy.
                  </p>
                </div>
              </div>

              <div className="grid gap-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="autoTrading">Enable Auto-Trading</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically sell excess energy at market prices
                    </p>
                  </div>
                  <Switch
                    id="autoTrading"
                    checked={tradingData.autoTrading}
                    onCheckedChange={(checked) => setTradingData({ ...tradingData, autoTrading: checked })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="p2pEnabled">Enable P2P Trading</Label>
                    <p className="text-sm text-muted-foreground">
                      Trade directly with other community members
                    </p>
                  </div>
                  <Switch
                    id="p2pEnabled"
                    checked={tradingData.p2pEnabled}
                    onCheckedChange={(checked) => setTradingData({ ...tradingData, p2pEnabled: checked })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="minPrice">Minimum Price (per kWh)</Label>
                    <Input
                      id="minPrice"
                      type="number"
                      placeholder="e.g., 200"
                      value={tradingData.minPrice}
                      onChange={(e) => setTradingData({ ...tradingData, minPrice: e.target.value })}
                    />
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="maxPrice">Maximum Price (per kWh)</Label>
                    <Input
                      id="maxPrice"
                      type="number"
                      placeholder="e.g., 500"
                      value={tradingData.maxPrice}
                      onChange={(e) => setTradingData({ ...tradingData, maxPrice: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              <div className="flex justify-between gap-2 mt-6">
                <Button type="button" variant="outline" onClick={handleBack}>
                  Back
                </Button>
                <Button type="submit" disabled={updateTradingPreferencesMutation.isPending}>
                  {updateTradingPreferencesMutation.isPending ? "Saving..." : "Continue"}
                </Button>
              </div>
            </form>
          )}

          {/* Step 4: Complete Profile */}
          {currentStep === 4 && (
            <form onSubmit={handleStep4Submit} className="space-y-4">
              <div className="flex items-center gap-3 mb-4">
                <div className="p-3 bg-green-100 rounded-lg">
                  <CheckCircle2 className="h-6 w-6 text-green-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-lg">You're Almost Done!</h3>
                  <p className="text-sm text-muted-foreground">
                    Review your setup and start earning from your solar energy.
                  </p>
                </div>
              </div>

              <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <span className="font-medium">Asset Registered</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <span className="font-medium">Payment Method Connected</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <span className="font-medium">Trading Preferences Set</span>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="font-medium mb-2 flex items-center gap-2">
                  <Zap className="h-5 w-5 text-blue-600" />
                  What's Next?
                </h4>
                <ul className="text-sm space-y-1 text-muted-foreground ml-7">
                  <li>• Monitor your energy production in real-time</li>
                  <li>• Track your earnings from the dashboard</li>
                  <li>• Participate in demand response events for extra rewards</li>
                  <li>• Join the leaderboard and compete with others</li>
                </ul>
              </div>

              <div className="flex justify-between gap-2 mt-6">
                <Button type="button" variant="outline" onClick={handleBack}>
                  Back
                </Button>
                <Button type="submit" disabled={completeOnboardingMutation.isPending}>
                  {completeOnboardingMutation.isPending ? "Completing..." : "Get Started! 🎉"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

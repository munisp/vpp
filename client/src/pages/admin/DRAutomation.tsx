import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { Activity, AlertTriangle, CheckCircle, Loader2, Play, Settings, Zap } from "lucide-react";
import { toast } from "sonner";

export default function DRAutomation() {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const { data: rules, isLoading } = trpc.drAutomation.getRules.useQuery(undefined, {
    enabled: user?.role === 'admin',
  });

  const updateRuleMutation = trpc.drAutomation.updateRule.useMutation({
    onSuccess: () => {
      utils.drAutomation.getRules.invalidate();
      toast.success('Rule updated successfully');
    },
    onError: (error: any) => {
      toast.error(`Failed to update rule: ${error.message}`);
    },
  });

  const simulateMutation = trpc.drAutomation.simulateGridStress.useMutation({
    onSuccess: (data: any) => {
      toast.success(`Simulated ${data.conditions.severity} grid stress`);
    },
    onError: (error: any) => {
      toast.error(`Simulation failed: ${error.message}`);
    },
  });

  const handleToggleRule = async (ruleId: string, enabled: boolean) => {
    await updateRuleMutation.mutateAsync({
      ruleId,
      enabled,
    });
  };

  const handleSimulate = async (severity: 'low' | 'medium' | 'high') => {
    await simulateMutation.mutateAsync({ severity });
  };

  if (user?.role !== 'admin') {
    return (
      <div className="container py-8">
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <p className="text-muted-foreground">Admin access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="container py-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">DR Automation</h1>
          <p className="text-muted-foreground">
            Manage automated demand response event triggering
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => handleSimulate('low')}
            variant="outline"
            size="sm"
            disabled={simulateMutation.isPending}
          >
            <Play className="h-4 w-4 mr-2" />
            Test Low
          </Button>
          <Button
            onClick={() => handleSimulate('medium')}
            variant="outline"
            size="sm"
            disabled={simulateMutation.isPending}
          >
            <Play className="h-4 w-4 mr-2" />
            Test Medium
          </Button>
          <Button
            onClick={() => handleSimulate('high')}
            variant="outline"
            size="sm"
            disabled={simulateMutation.isPending}
          >
            <Play className="h-4 w-4 mr-2" />
            Test High
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Rules</CardTitle>
            <CheckCircle className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {rules?.filter((r: any) => r.enabled).length || 0}
            </div>
            <p className="text-xs text-muted-foreground">Monitoring grid conditions</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Rules</CardTitle>
            <Settings className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{rules?.length || 0}</div>
            <p className="text-xs text-muted-foreground">Configured automation rules</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">System Status</CardTitle>
            <Activity className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">Operational</div>
            <p className="text-xs text-muted-foreground">All systems running</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Automation Rules</CardTitle>
          <CardDescription>
            Configure rules for automatic DR event triggering based on grid conditions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {rules?.map((rule: any) => (
              <div
                key={rule.id}
                className="flex items-start justify-between p-4 rounded-lg border bg-card"
              >
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-full ${
                      rule.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {rule.enabled ? (
                        <Zap className="h-4 w-4" />
                      ) : (
                        <AlertTriangle className="h-4 w-4" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-semibold">{rule.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        Target: {rule.eventConfig.targetReduction} kW | 
                        Duration: {rule.eventConfig.duration} min | 
                        Compensation: {rule.eventConfig.baselineCompensation} TZS/kWh
                      </p>
                    </div>
                  </div>

                  <div className="pl-14 space-y-1">
                    <p className="text-sm">
                      <span className="font-medium">Conditions:</span>
                      {rule.conditions.minLoadLevel && ` Load ≥${rule.conditions.minLoadLevel}%`}
                      {rule.conditions.minTemperature && ` Temp ≥${rule.conditions.minTemperature}°C`}
                      {rule.conditions.maxFrequency && ` Freq ≤${rule.conditions.maxFrequency}Hz`}
                      {rule.conditions.timeOfDay && ` Time: ${rule.conditions.timeOfDay.start}-${rule.conditions.timeOfDay.end}`}
                    </p>
                    <p className="text-sm">
                      <span className="font-medium">Participant Criteria:</span>
                      {rule.participantCriteria.minReliabilityScore && ` Reliability ≥${rule.participantCriteria.minReliabilityScore}%`}
                      {rule.participantCriteria.minCapacity && ` Capacity ≥${rule.participantCriteria.minCapacity} kW`}
                      {rule.participantCriteria.segments && ` Segments: ${rule.participantCriteria.segments.join(', ')}`}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={(checked) => handleToggleRule(rule.id, checked)}
                    disabled={updateRuleMutation.isPending}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

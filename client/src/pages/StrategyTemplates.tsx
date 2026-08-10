import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { 
  Sun, Battery, TrendingUp, Moon, Zap, SunMedium, Shield,
  Copy, ArrowLeft, Sparkles, Target, Clock, DollarSign
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const iconMap = {
  Sun, Battery, TrendingUp, Moon, Zap, SunMedium, Shield
};

const difficultyColors = {
  beginner: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  intermediate: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  advanced: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export default function StrategyTemplates() {
  const [, setLocation] = useLocation();
  const [selectedTemplate, setSelectedTemplate] = useState<any>(null);
  const [isCloning, setIsCloning] = useState(false);

  const { data: templates, isLoading } = trpc.strategyTemplates.list.useQuery();
  const cloneTemplateMutation = trpc.strategyTemplates.clone.useMutation();

  const handleClone = async (templateId: number) => {
    setIsCloning(true);
    try {
      const result = await cloneTemplateMutation.mutateAsync({ templateId });
      toast.success("Strategy created successfully!", {
        description: "You can now customize and activate your new strategy.",
      });
      setSelectedTemplate(null);
      setLocation("/trading/strategies");
    } catch (error: any) {
      toast.error("Failed to clone strategy", {
        description: error.message,
      });
    } finally {
      setIsCloning(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container py-8">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/trading/strategies")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">Strategy Templates</h1>
            <p className="text-muted-foreground">Loading templates...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => setLocation("/trading/strategies")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Sparkles className="h-8 w-8 text-primary" />
            Strategy Templates
          </h1>
          <p className="text-muted-foreground">
            Clone proven trading strategies and customize them to your needs
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {templates?.map((template) => {
          const IconComponent = iconMap[template.icon as keyof typeof iconMap] || Zap;
          
          return (
            <Card key={template.id} className="hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setSelectedTemplate(template)}>
              <CardHeader>
                <div className="flex items-start justify-between mb-2">
                  <div className="p-3 bg-primary/10 rounded-lg">
                    <IconComponent className="h-6 w-6 text-primary" />
                  </div>
                  <Badge className={difficultyColors[template.difficulty as keyof typeof difficultyColors]}>
                    {template.difficulty}
                  </Badge>
                </div>
                <CardTitle className="text-xl">{template.name}</CardTitle>
                <CardDescription className="line-clamp-2">{template.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {/* Expected Performance */}
                  {template.expectedPerformance && (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Target className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Success:</span>
                        <span className="font-medium">{template.expectedPerformance.successRate}%</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Daily:</span>
                        <span className="font-medium">{template.expectedPerformance.avgDailyProfit} TZS</span>
                      </div>
                    </div>
                  )}

                  {/* Tags */}
                  {template.tags && template.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {template.tags.slice(0, 3).map((tag: string) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Clone Stats */}
                  <div className="flex items-center justify-between pt-2 border-t">
                    <span className="text-xs text-muted-foreground">
                      {template.timesCloned} users cloned this
                    </span>
                    <Button size="sm" variant="outline" onClick={(e) => {
                      e.stopPropagation();
                      setSelectedTemplate(template);
                    }}>
                      <Copy className="h-4 w-4 mr-2" />
                      Clone
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Template Detail Dialog */}
      <Dialog open={!!selectedTemplate} onOpenChange={(open) => !open && setSelectedTemplate(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          {selectedTemplate && (
            <>
              <DialogHeader>
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-primary/10 rounded-lg">
                    {(() => {
                      const IconComponent = iconMap[selectedTemplate.icon as keyof typeof iconMap] || Zap;
                      return <IconComponent className="h-8 w-8 text-primary" />;
                    })()}
                  </div>
                  <div className="flex-1">
                    <DialogTitle className="text-2xl">{selectedTemplate.name}</DialogTitle>
                    <DialogDescription className="mt-2">{selectedTemplate.description}</DialogDescription>
                    <div className="flex gap-2 mt-3">
                      <Badge className={difficultyColors[selectedTemplate.difficulty as keyof typeof difficultyColors]}>
                        {selectedTemplate.difficulty}
                      </Badge>
                      <Badge variant="outline">{selectedTemplate.category.replace(/_/g, " ")}</Badge>
                      <Badge variant="outline">{selectedTemplate.tradingMode}</Badge>
                    </div>
                  </div>
                </div>
              </DialogHeader>

              <div className="space-y-6 mt-6">
                {/* Expected Performance */}
                {selectedTemplate.expectedPerformance && (
                  <div>
                    <h3 className="font-semibold mb-3 flex items-center gap-2">
                      <Target className="h-5 w-5" />
                      Expected Performance
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <Card>
                        <CardContent className="pt-4">
                          <div className="text-2xl font-bold text-primary">
                            {selectedTemplate.expectedPerformance.avgDailyProfit} TZS
                          </div>
                          <div className="text-sm text-muted-foreground">Avg Daily Profit</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="pt-4">
                          <div className="text-2xl font-bold text-primary">
                            {selectedTemplate.expectedPerformance.successRate}%
                          </div>
                          <div className="text-sm text-muted-foreground">Success Rate</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="pt-4">
                          <div className="text-2xl font-bold text-primary">
                            {selectedTemplate.expectedPerformance.avgDailyTrades}
                          </div>
                          <div className="text-sm text-muted-foreground">Avg Daily Trades</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="pt-4">
                          <div className="text-2xl font-bold text-primary">
                            {selectedTemplate.expectedPerformance.avgDailyEnergy} kWh
                          </div>
                          <div className="text-sm text-muted-foreground">Avg Daily Energy</div>
                        </CardContent>
                      </Card>
                    </div>
                    {selectedTemplate.expectedPerformance.bestSeason && (
                      <p className="text-sm text-muted-foreground mt-3">
                        <Clock className="h-4 w-4 inline mr-1" />
                        Best season: {selectedTemplate.expectedPerformance.bestSeason}
                      </p>
                    )}
                  </div>
                )}

                {/* Trading Conditions */}
                {selectedTemplate.conditions && (
                  <div>
                    <h3 className="font-semibold mb-3">Trading Conditions</h3>
                    <div className="space-y-3 text-sm">
                      {selectedTemplate.conditions.priceThresholds && (
                        <div className="p-3 bg-muted rounded-lg">
                          <div className="font-medium mb-2">Price Thresholds</div>
                          {selectedTemplate.conditions.priceThresholds.minExportPrice && (
                            <div>Min Export: {selectedTemplate.conditions.priceThresholds.minExportPrice} TZS/kWh</div>
                          )}
                          {selectedTemplate.conditions.priceThresholds.maxExportPrice && (
                            <div>Max Export: {selectedTemplate.conditions.priceThresholds.maxExportPrice} TZS/kWh</div>
                          )}
                          {selectedTemplate.conditions.priceThresholds.minImportPrice && (
                            <div>Min Import: {selectedTemplate.conditions.priceThresholds.minImportPrice} TZS/kWh</div>
                          )}
                          {selectedTemplate.conditions.priceThresholds.maxImportPrice && (
                            <div>Max Import: {selectedTemplate.conditions.priceThresholds.maxImportPrice} TZS/kWh</div>
                          )}
                        </div>
                      )}
                      
                      {selectedTemplate.conditions.batteryLevels && (
                        <div className="p-3 bg-muted rounded-lg">
                          <div className="font-medium mb-2">Battery Levels</div>
                          {selectedTemplate.conditions.batteryLevels.minSOC && (
                            <div>Min SOC to Sell: {selectedTemplate.conditions.batteryLevels.minSOC}%</div>
                          )}
                          {selectedTemplate.conditions.batteryLevels.maxSOC && (
                            <div>Max SOC to Buy: {selectedTemplate.conditions.batteryLevels.maxSOC}%</div>
                          )}
                        </div>
                      )}
                      
                      {selectedTemplate.conditions.timeWindows && (
                        <div className="p-3 bg-muted rounded-lg">
                          <div className="font-medium mb-2">Time Windows</div>
                          {selectedTemplate.conditions.timeWindows.startHour !== undefined && (
                            <div>Hours: {selectedTemplate.conditions.timeWindows.startHour}:00 - {selectedTemplate.conditions.timeWindows.endHour}:00</div>
                          )}
                          {selectedTemplate.conditions.timeWindows.daysOfWeek && (
                            <div>Days: {selectedTemplate.conditions.timeWindows.daysOfWeek.map((d: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')}</div>
                          )}
                        </div>
                      )}
                      
                      {selectedTemplate.conditions.energyLimits && (
                        <div className="p-3 bg-muted rounded-lg">
                          <div className="font-medium mb-2">Energy Limits</div>
                          {selectedTemplate.conditions.energyLimits.minTradeSize && (
                            <div>Min Trade Size: {selectedTemplate.conditions.energyLimits.minTradeSize} kWh</div>
                          )}
                          {selectedTemplate.conditions.energyLimits.maxTradeSize && (
                            <div>Max Trade Size: {selectedTemplate.conditions.energyLimits.maxTradeSize} kWh</div>
                          )}
                          {selectedTemplate.conditions.energyLimits.dailyLimit && (
                            <div>Daily Limit: {selectedTemplate.conditions.energyLimits.dailyLimit} kWh</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Tags */}
                {selectedTemplate.tags && selectedTemplate.tags.length > 0 && (
                  <div>
                    <h3 className="font-semibold mb-3">Tags</h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedTemplate.tags.map((tag: string) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Clone Button */}
                <div className="flex gap-3 pt-4 border-t">
                  <Button
                    className="flex-1"
                    onClick={() => handleClone(selectedTemplate.id)}
                    disabled={isCloning}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    {isCloning ? "Cloning..." : "Clone This Strategy"}
                  </Button>
                  <Button variant="outline" onClick={() => setSelectedTemplate(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

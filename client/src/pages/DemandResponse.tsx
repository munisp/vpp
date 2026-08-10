import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Zap,
  DollarSign,
  TrendingUp,
  Calendar,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function DemandResponse() {
  const [enrollDialogOpen, setEnrollDialogOpen] = useState(false);
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<any>(null);
  const [autoOptIn, setAutoOptIn] = useState(true);
  const [minCompensation, setMinCompensation] = useState("");
  const [maxReduction, setMaxReduction] = useState("");

  const utils = trpc.useUtils();
  
  // Queries
  const { data: enrollment, isLoading: enrollmentLoading } = trpc.demandResponse.getEnrollment.useQuery();
  const { data: upcomingEvents = [], isLoading: eventsLoading } = trpc.demandResponse.getUpcomingEvents.useQuery();
  const { data: myResponses = [], isLoading: responsesLoading } = trpc.demandResponse.getMyResponses.useQuery();
  const { data: compensation = [], isLoading: compensationLoading } = trpc.demandResponse.getMyCompensation.useQuery();
  const { data: analytics } = trpc.demandResponse.getMyAnalytics.useQuery();

  // Mutations
  const enrollMutation = trpc.demandResponse.enroll.useMutation({
    onSuccess: () => {
      toast.success("Successfully enrolled in Demand Response program!");
      utils.demandResponse.getEnrollment.invalidate();
      setEnrollDialogOpen(false);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const updateEnrollmentMutation = trpc.demandResponse.updateEnrollment.useMutation({
    onSuccess: () => {
      toast.success("Enrollment settings updated!");
      utils.demandResponse.getEnrollment.invalidate();
    },
  });

  const respondMutation = trpc.demandResponse.respondToEvent.useMutation({
    onSuccess: () => {
      toast.success("Response recorded!");
      utils.demandResponse.getMyResponses.invalidate();
      setEventDialogOpen(false);
    },
  });

  const enrollInDREventMutation = trpc.orchestrator.enrollInDREvent.useMutation({
    onSuccess: (data) => {
      toast.success("DR event enrollment workflow started!", {
        description: `Workflow ID: ${data.workflowId}`,
      });
      utils.demandResponse.getMyResponses.invalidate();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to enroll in DR event");
    },
  });

  const handleEnroll = () => {
    enrollMutation.mutate({
      autoOptIn,
      minCompensation: minCompensation ? parseInt(minCompensation) : undefined,
      maxReduction: maxReduction ? parseInt(maxReduction) : undefined,
    });
  };

  const handleEventResponse = (participate: boolean) => {
    if (!selectedEvent) return;
    
    respondMutation.mutate({
      eventId: selectedEvent.id,
      participate,
      targetReduction: participate && maxReduction ? parseInt(maxReduction) : undefined,
    });
  };

  const handleEnrollInDREventWorkflow = (eventId: string) => {
    if (window.confirm("Enroll in this DR event using the full workflow orchestration?")) {
      enrollInDREventMutation.mutate({ eventId });
    }
  };

  const totalEarnings = compensation
    .filter((c: any) => c.status === "paid")
    .reduce((sum: number, c: any) => sum + (c.amount || 0), 0);

  if (enrollmentLoading) {
    return (
      <div className="container py-8">
        <Skeleton className="h-8 w-64 mb-6" />
        <div className="grid gap-6 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">Demand Response</h1>
          <p className="text-muted-foreground">
            Earn rewards by reducing energy usage during peak hours
          </p>
        </div>
        {!enrollment && (
          <Button onClick={() => setEnrollDialogOpen(true)} size="lg">
            Enroll Now
          </Button>
        )}
      </div>

      {enrollment ? (
        <>
          {/* Stats */}
          <div className="grid gap-6 md:grid-cols-4 mb-8">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Earnings</CardTitle>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">${(totalEarnings / 100).toFixed(2)}</div>
                <p className="text-xs text-muted-foreground">
                  From {analytics?.participationCount || 0} events
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Events Participated</CardTitle>
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{analytics?.participationCount || 0}</div>
                <p className="text-xs text-muted-foreground">
                  Out of {analytics?.totalEvents || 0} total
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Avg. Reduction</CardTitle>
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {(analytics?.averageReduction || 0).toFixed(1)} kW
                </div>
                <p className="text-xs text-muted-foreground">Per event</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Status</CardTitle>
                <Zap className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold capitalize">{enrollment.status}</div>
                <p className="text-xs text-muted-foreground">
                  Auto opt-in: {enrollment.autoOptIn ? "Yes" : "No"}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Upcoming Events */}
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Upcoming Events</CardTitle>
              <CardDescription>
                Respond to demand response events to earn rewards
              </CardDescription>
            </CardHeader>
            <CardContent>
              {eventsLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-24" />
                  <Skeleton className="h-24" />
                </div>
              ) : upcomingEvents.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No upcoming events at this time
                </p>
              ) : (
                <div className="space-y-4">
                  {upcomingEvents.map((event: any) => (
                    <div
                      key={event.id}
                      className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent cursor-pointer"
                      onClick={() => {
                        setSelectedEvent(event);
                        setEventDialogOpen(true);
                      }}
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold">{event.eventName}</h3>
                          <Badge variant={
                            event.eventType === "emergency" ? "destructive" :
                            event.eventType === "peak_shaving" ? "default" : "secondary"
                          }>
                            {event.eventType.replace("_", " ")}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-4 w-4" />
                            {new Date(event.startTime).toLocaleString()}
                          </span>
                          <span className="flex items-center gap-1">
                            <Zap className="h-4 w-4" />
                            {event.targetReduction} kW
                          </span>
                          <span className="flex items-center gap-1">
                            <DollarSign className="h-4 w-4" />
                            {event.compensationRate}¢/kWh
                          </span>
                        </div>
                      </div>
                      <Button variant="outline">Respond</Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Responses */}
          <Card>
            <CardHeader>
              <CardTitle>Your Responses</CardTitle>
              <CardDescription>History of your event participation</CardDescription>
            </CardHeader>
            <CardContent>
              {responsesLoading ? (
                <Skeleton className="h-32" />
              ) : myResponses.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No responses yet
                </p>
              ) : (
                <div className="space-y-3">
                  {myResponses.slice(0, 5).map((response: any) => (
                    <div
                      key={response.id}
                      className="flex items-center justify-between p-3 border rounded"
                    >
                      <div>
                        <p className="font-medium">Event #{response.eventId}</p>
                        <p className="text-sm text-muted-foreground">
                          {new Date(response.responseTime).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-4">
                        {response.actualReduction && (
                          <span className="text-sm">
                            {response.actualReduction} kW reduced
                          </span>
                        )}
                        <Badge variant={
                          response.participationStatus === "opted_in" ? "default" :
                          response.participationStatus === "auto_enrolled" ? "secondary" :
                          "outline"
                        }>
                          {response.participationStatus.replace("_", " ")}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Join the Demand Response Program</CardTitle>
            <CardDescription>
              Earn money by reducing your energy usage during peak demand periods
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-3 gap-6">
              <div className="text-center">
                <Calendar className="h-12 w-12 mx-auto mb-2 text-primary" />
                <h3 className="font-semibold mb-1">Get Notified</h3>
                <p className="text-sm text-muted-foreground">
                  Receive alerts before peak demand events
                </p>
              </div>
              <div className="text-center">
                <Zap className="h-12 w-12 mx-auto mb-2 text-primary" />
                <h3 className="font-semibold mb-1">Reduce Usage</h3>
                <p className="text-sm text-muted-foreground">
                  Lower your consumption during the event
                </p>
              </div>
              <div className="text-center">
                <DollarSign className="h-12 w-12 mx-auto mb-2 text-primary" />
                <h3 className="font-semibold mb-1">Earn Rewards</h3>
                <p className="text-sm text-muted-foreground">
                  Get paid for every kW you reduce
                </p>
              </div>
            </div>
            <Button onClick={() => setEnrollDialogOpen(true)} size="lg" className="w-full">
              Enroll Now
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Enrollment Dialog */}
      <Dialog open={enrollDialogOpen} onOpenChange={setEnrollDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll in Demand Response</DialogTitle>
            <DialogDescription>
              Configure your participation preferences
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="auto-opt-in">Automatically participate in events</Label>
              <Switch
                id="auto-opt-in"
                checked={autoOptIn}
                onCheckedChange={setAutoOptIn}
              />
            </div>
            <div>
              <Label htmlFor="min-compensation">
                Minimum compensation (¢/kWh)
              </Label>
              <Input
                id="min-compensation"
                type="number"
                placeholder="e.g., 50"
                value={minCompensation}
                onChange={(e) => setMinCompensation(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="max-reduction">
                Maximum reduction willing to provide (kW)
              </Label>
              <Input
                id="max-reduction"
                type="number"
                placeholder="e.g., 5"
                value={maxReduction}
                onChange={(e) => setMaxReduction(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnrollDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEnroll} disabled={enrollMutation.isPending}>
              {enrollMutation.isPending ? "Enrolling..." : "Enroll"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Event Response Dialog */}
      <Dialog open={eventDialogOpen} onOpenChange={setEventDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedEvent?.eventName}</DialogTitle>
            <DialogDescription>
              Respond to this demand response event
            </DialogDescription>
          </DialogHeader>
          {selectedEvent && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Start Time</p>
                  <p className="font-medium">
                    {new Date(selectedEvent.startTime).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">End Time</p>
                  <p className="font-medium">
                    {new Date(selectedEvent.endTime).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Target Reduction</p>
                  <p className="font-medium">{selectedEvent.targetReduction} kW</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Compensation</p>
                  <p className="font-medium">{selectedEvent.compensationRate}¢/kWh</p>
                </div>
              </div>
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-sm">
                  <strong>Estimated earnings:</strong> If you reduce{" "}
                  {enrollment?.maxReduction || 5} kW for the duration, you could earn{" "}
                  <strong>
                    $
                    {(
                      ((enrollment?.maxReduction || 5) *
                        selectedEvent.compensationRate) /
                      100
                    ).toFixed(2)}
                  </strong>
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleEventResponse(false)}
              disabled={respondMutation.isPending}
            >
              Opt Out
            </Button>
            <Button
              onClick={() => handleEventResponse(true)}
              disabled={respondMutation.isPending}
            >
              {respondMutation.isPending ? "Responding..." : "Participate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Zap,
  DollarSign,
  Users,
  Calendar,
  Plus,
  TrendingUp,
  AlertCircle,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function DRManagement() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [eventDetailsOpen, setEventDetailsOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<any>(null);
  
  // Form state
  const [eventName, setEventName] = useState("");
  const [eventType, setEventType] = useState<"peak_shaving" | "load_shifting" | "emergency" | "economic">("peak_shaving");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [targetReduction, setTargetReduction] = useState("");
  const [compensationRate, setCompensationRate] = useState("");
  const [description, setDescription] = useState("");

  const utils = trpc.useUtils();
  
  // Queries
  const eventsQuery = trpc.demandResponse.getAllEvents.useQuery({});
  const participantsQuery = trpc.demandResponse.getAllParticipants.useQuery();
  const analyticsQuery = trpc.demandResponse.getSystemAnalytics.useQuery();
  const { data: allEventsData, isLoading: eventsLoading } = eventsQuery;
  const { data: participantsData, isLoading: participantsLoading } = participantsQuery;
  const { data: analytics } = analyticsQuery;
  // Failed queries stay undefined — never default to an empty list/zero that
  // would present a backend failure as "no events".
  const allEvents = allEventsData ?? [];
  const participants = participantsData ?? [];
  const eventsFailed = eventsQuery.isError;
  const participantsFailed = participantsQuery.isError;
  const analyticsFailed = analyticsQuery.isError;

  // Mutations
  const createEventMutation = trpc.demandResponse.createEvent.useMutation({
    onSuccess: () => {
      toast.success("Demand response event created!");
      utils.demandResponse.getAllEvents.invalidate();
      setCreateDialogOpen(false);
      resetForm();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const resetForm = () => {
    setEventName("");
    setEventType("peak_shaving");
    setStartTime("");
    setEndTime("");
    setTargetReduction("");
    setCompensationRate("");
    setDescription("");
  };

  const handleCreateEvent = () => {
    if (!eventName || !startTime || !endTime || !targetReduction || !compensationRate) {
      toast.error("Please fill in all required fields");
      return;
    }

    createEventMutation.mutate({
      eventName,
      eventType,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      targetReduction: parseInt(targetReduction),
      compensationRate: parseInt(compensationRate),
    });
  };

  const activeEvents = allEvents.filter((e: any) => e.status === "active");
  const upcomingEvents = allEvents.filter((e: any) => e.status === "scheduled");
  const completedEvents = allEvents.filter((e: any) => e.status === "completed");

  const activeParticipants = participants.filter((p: any) => p.status === "active").length;
  const totalParticipants = participants.length;

  return (
    <div className="container py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">Demand Response Management</h1>
          <p className="text-muted-foreground">
            Create and manage demand response events
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} size="lg">
          <Plus className="h-4 w-4 mr-2" />
          Create Event
        </Button>
      </div>

      {(eventsFailed || participantsFailed || analyticsFailed) && (
        <Card className="border-red-200 bg-red-50 mb-8">
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 text-red-600" />
              <p className="text-sm text-red-800">
                {[
                  eventsFailed && `events: ${(eventsQuery.error as any)?.message || 'failed'}`,
                  participantsFailed && `participants: ${(participantsQuery.error as any)?.message || 'failed'}`,
                  analyticsFailed && `analytics: ${(analyticsQuery.error as any)?.message || 'failed'}`,
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                eventsQuery.refetch();
                participantsQuery.refetch();
                analyticsQuery.refetch();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid gap-6 md:grid-cols-4 mb-8">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Events</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{eventsFailed ? "—" : activeEvents.length}</div>
            <p className="text-xs text-muted-foreground">
              {eventsFailed ? "Events unavailable" : `${upcomingEvents.length} upcoming`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Participants</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{participantsFailed ? "—" : activeParticipants}</div>
            <p className="text-xs text-muted-foreground">
              {participantsFailed ? "Participants unavailable" : `Out of ${totalParticipants} enrolled`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Reduction</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {analyticsFailed ? "—" : `${(analytics?.averageReduction || 0).toFixed(1)} kW`}
            </div>
            <p className="text-xs text-muted-foreground">{analyticsFailed ? "Analytics unavailable" : "This month"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Compensation Paid</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {analyticsFailed ? "—" : `$${((analytics?.totalCompensation || 0) / 100).toFixed(2)}`}
            </div>
            <p className="text-xs text-muted-foreground">{analyticsFailed ? "Analytics unavailable" : "This month"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Active Events */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Active Events</CardTitle>
          <CardDescription>Currently running demand response events</CardDescription>
        </CardHeader>
        <CardContent>
          {eventsLoading ? (
            <Skeleton className="h-32" />
          ) : eventsFailed ? (
            <p className="text-center text-red-600 py-8">
              Events unavailable: {(eventsQuery.error as any)?.message || "failed to load"}
            </p>
          ) : activeEvents.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No active events
            </p>
          ) : (
            <div className="space-y-4">
              {activeEvents.map((event: any) => (
                <div
                  key={event.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent cursor-pointer"
                  onClick={() => {
                    setSelectedEvent(event);
                    setEventDetailsOpen(true);
                  }}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold">{event.eventName}</h3>
                      <Badge variant="default">{event.status}</Badge>
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
                        Target: {event.targetReduction} kW
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-4 w-4" />
                        {event.participantCount || 0} participants
                      </span>
                    </div>
                  </div>
                  <Button variant="outline">View Details</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upcoming Events */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Upcoming Events</CardTitle>
          <CardDescription>Scheduled demand response events</CardDescription>
        </CardHeader>
        <CardContent>
          {eventsLoading ? (
            <Skeleton className="h-32" />
          ) : eventsFailed ? (
            <p className="text-center text-red-600 py-8">
              Events unavailable: {(eventsQuery.error as any)?.message || "failed to load"}
            </p>
          ) : upcomingEvents.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No upcoming events
            </p>
          ) : (
            <div className="space-y-4">
              {upcomingEvents.map((event: any) => (
                <div
                  key={event.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent cursor-pointer"
                  onClick={() => {
                    setSelectedEvent(event);
                    setEventDetailsOpen(true);
                  }}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold">{event.eventName}</h3>
                      <Badge variant="outline">{event.status}</Badge>
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
                  <Button variant="outline">Edit</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Participants */}
      <Card>
        <CardHeader>
          <CardTitle>Enrolled Participants</CardTitle>
          <CardDescription>
            Users enrolled in the demand response program
          </CardDescription>
        </CardHeader>
        <CardContent>
          {participantsLoading ? (
            <Skeleton className="h-32" />
          ) : participantsFailed ? (
            <p className="text-center text-red-600 py-8">
              Participants unavailable: {(participantsQuery.error as any)?.message || "failed to load"}
            </p>
          ) : (
            <div className="space-y-3">
              {participants.slice(0, 10).map((participant: any) => (
                <div
                  key={participant.id}
                  className="flex items-center justify-between p-3 border rounded"
                >
                  <div>
                    <p className="font-medium">User #{participant.userId}</p>
                    <p className="text-sm text-muted-foreground">
                      Max reduction: {participant.maxReduction || "N/A"} kW
                    </p>
                  </div>
                  <Badge variant={
                    participant.status === "active" ? "default" :
                    participant.status === "suspended" ? "destructive" : "outline"
                  }>
                    {participant.status}
                  </Badge>
                </div>
              ))}
              {participants.length > 10 && (
                <p className="text-center text-sm text-muted-foreground">
                  And {participants.length - 10} more...
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Event Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Demand Response Event</DialogTitle>
            <DialogDescription>
              Configure a new demand response event for load reduction
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="event-name">Event Name *</Label>
                <Input
                  id="event-name"
                  placeholder="e.g., Peak Hour Reduction"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="event-type">Event Type *</Label>
                <Select value={eventType} onValueChange={(v: any) => setEventType(v)}>
                  <SelectTrigger id="event-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="peak_shaving">Peak Shaving</SelectItem>
                    <SelectItem value="emergency">Emergency</SelectItem>
                    <SelectItem value="frequency_regulation">Frequency Regulation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="start-time">Start Time *</Label>
                <Input
                  id="start-time"
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="end-time">End Time *</Label>
                <Input
                  id="end-time"
                  type="datetime-local"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="target-reduction">Target Reduction (kW) *</Label>
                <Input
                  id="target-reduction"
                  type="number"
                  placeholder="e.g., 100"
                  value={targetReduction}
                  onChange={(e) => setTargetReduction(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="compensation-rate">Compensation Rate (¢/kWh) *</Label>
                <Input
                  id="compensation-rate"
                  type="number"
                  placeholder="e.g., 50"
                  value={compensationRate}
                  onChange={(e) => setCompensationRate(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Event details and instructions for participants"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateEvent} disabled={createEventMutation.isPending}>
              {createEventMutation.isPending ? "Creating..." : "Create Event"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Event Details Dialog */}
      <Dialog open={eventDetailsOpen} onOpenChange={setEventDetailsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedEvent?.eventName}</DialogTitle>
            <DialogDescription>Event details and participation</DialogDescription>
          </DialogHeader>
          {selectedEvent && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge className="mt-1">{selectedEvent.status}</Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Type</p>
                  <Badge variant="outline" className="mt-1">
                    {selectedEvent.eventType.replace("_", " ")}
                  </Badge>
                </div>
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
                  <p className="text-sm text-muted-foreground">Compensation Rate</p>
                  <p className="font-medium">{selectedEvent.compensationRate}¢/kWh</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Participants</p>
                  <p className="font-medium">{selectedEvent.participantCount || 0}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Actual Reduction</p>
                  <p className="font-medium">
                    {selectedEvent.actualReduction || 0} kW
                  </p>
                </div>
              </div>
              {selectedEvent.description && (
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Description</p>
                  <p className="text-sm">{selectedEvent.description}</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEventDetailsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

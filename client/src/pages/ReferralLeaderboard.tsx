import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, Medal, Users } from "lucide-react";

type Period = "daily" | "weekly" | "monthly" | "all_time";

export default function ReferralLeaderboard() {
  const [period, setPeriod] = useState<Period>("monthly");

  const { data: leaderboard = [], isLoading, isError } =
    trpc.gamification.getLeaderboard.useQuery({ period, limit: 100 });
  const { data: myRank } = trpc.gamification.getMyRank.useQuery({ period });

  const getRankIcon = (rank: number) => {
    if (rank === 1) return <Trophy className="h-6 w-6 text-yellow-500" />;
    if (rank === 2) return <Medal className="h-6 w-6 text-gray-400" />;
    if (rank === 3) return <Medal className="h-6 w-6 text-amber-700" />;
    return null;
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .filter(Boolean)
      .join("")
      .toUpperCase()
      .slice(0, 2) || "?";
  };

  const formatCents = (cents: number | null | undefined) =>
    `${((cents ?? 0) / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} TZS`;

  const periodLabel =
    period === "daily"
      ? "today"
      : period === "weekly"
        ? "this week"
        : period === "monthly"
          ? "this month"
          : "all time";

  return (
    <div className="container py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Leaderboard</h1>
          <p className="text-muted-foreground mt-2">
            Top participants ranked by demand-response performance
          </p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Today</SelectItem>
            <SelectItem value="weekly">This Week</SelectItem>
            <SelectItem value="monthly">This Month</SelectItem>
            <SelectItem value="all_time">All Time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* My Rank */}
      {myRank && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Your Rank</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">#{myRank.rank}</p>
            <p className="text-xs text-muted-foreground">
              Score: {myRank.score.toLocaleString()} · Events:{" "}
              {myRank.eventsParticipated} · Earned:{" "}
              {formatCents(myRank.compensationEarned)}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Full Leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle>Full Rankings</CardTitle>
          <CardDescription>Complete leaderboard for {periodLabel}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="text-center py-12">
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">Leaderboard unavailable</h3>
              <p className="text-sm text-muted-foreground">
                The leaderboard could not be loaded. Please try again later.
              </p>
            </div>
          ) : leaderboard.length === 0 ? (
            <div className="text-center py-12">
              <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No rankings yet</h3>
              <p className="text-sm text-muted-foreground">
                There are no leaderboard entries for {periodLabel} yet. Participate
                in demand-response events to appear here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {leaderboard.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex items-center gap-4 p-4 rounded-lg border ${
                    entry.rank <= 3 ? "bg-muted/50" : "hover:bg-muted/50"
                  } transition-colors`}
                >
                  {/* Rank */}
                  <div className="flex items-center justify-center w-12 h-12 rounded-full bg-background border font-bold">
                    {entry.rank <= 3 ? (
                      getRankIcon(entry.rank)
                    ) : (
                      <span className="text-lg">#{entry.rank}</span>
                    )}
                  </div>

                  {/* Avatar & Name */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback>{getInitials(entry.userName)}</AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{entry.userName}</p>
                      <p className="text-xs text-muted-foreground">
                        {entry.eventsParticipated} event
                        {entry.eventsParticipated === 1 ? "" : "s"} participated
                      </p>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="hidden sm:flex items-center gap-6 text-sm">
                    <div className="text-center">
                      <p className="font-semibold">{entry.score.toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground">Score</p>
                    </div>
                    <div className="text-center">
                      <p className="font-semibold">
                        {formatCents(entry.compensationEarned)}
                      </p>
                      <p className="text-xs text-muted-foreground">Earned</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

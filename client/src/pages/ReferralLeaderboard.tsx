import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trophy, Medal, Award, TrendingUp, Users, Gift, Crown, Star, Zap } from "lucide-react";

interface LeaderboardEntry {
  rank: number;
  userId: number;
  name: string;
  avatar?: string;
  totalReferrals: number;
  completedReferrals: number;
  totalRewards: number;
  badges: string[];
  trend: "up" | "down" | "same";
}

export default function ReferralLeaderboard() {
  const [timeframe, setTimeframe] = useState<"weekly" | "monthly" | "alltime">("monthly");

  // Mock leaderboard data
  const leaderboardData: LeaderboardEntry[] = [
    {
      rank: 1,
      userId: 1,
      name: "Sarah Johnson",
      totalReferrals: 45,
      completedReferrals: 42,
      totalRewards: 42000,
      badges: ["top_referrer", "consistent", "milestone_50"],
      trend: "up",
    },
    {
      rank: 2,
      userId: 2,
      name: "Michael Chen",
      totalReferrals: 38,
      completedReferrals: 35,
      totalRewards: 35000,
      badges: ["top_referrer", "milestone_25"],
      trend: "same",
    },
    {
      rank: 3,
      userId: 3,
      name: "Emma Williams",
      totalReferrals: 32,
      completedReferrals: 30,
      totalRewards: 30000,
      badges: ["consistent", "milestone_25"],
      trend: "up",
    },
    {
      rank: 4,
      userId: 4,
      name: "David Brown",
      totalReferrals: 28,
      completedReferrals: 26,
      totalRewards: 26000,
      badges: ["milestone_25"],
      trend: "down",
    },
    {
      rank: 5,
      userId: 5,
      name: "Lisa Anderson",
      totalReferrals: 25,
      completedReferrals: 23,
      totalRewards: 23000,
      badges: ["consistent"],
      trend: "up",
    },
    {
      rank: 6,
      userId: 6,
      name: "James Wilson",
      totalReferrals: 22,
      completedReferrals: 20,
      totalRewards: 20000,
      badges: [],
      trend: "same",
    },
    {
      rank: 7,
      userId: 7,
      name: "Maria Garcia",
      totalReferrals: 19,
      completedReferrals: 18,
      totalRewards: 18000,
      badges: ["consistent"],
      trend: "up",
    },
    {
      rank: 8,
      userId: 8,
      name: "Robert Taylor",
      totalReferrals: 17,
      completedReferrals: 15,
      totalRewards: 15000,
      badges: [],
      trend: "down",
    },
    {
      rank: 9,
      userId: 9,
      name: "Jennifer Martinez",
      totalReferrals: 15,
      completedReferrals: 14,
      totalRewards: 14000,
      badges: [],
      trend: "up",
    },
    {
      rank: 10,
      userId: 10,
      name: "William Lee",
      totalReferrals: 13,
      completedReferrals: 12,
      totalRewards: 12000,
      badges: [],
      trend: "same",
    },
  ];

  const getBadgeInfo = (badgeId: string) => {
    const badges: Record<string, { label: string; icon: any; color: string }> = {
      top_referrer: { label: "Top Referrer", icon: Trophy, color: "text-yellow-600" },
      consistent: { label: "Consistent", icon: Zap, color: "text-blue-600" },
      milestone_50: { label: "50+ Referrals", icon: Crown, color: "text-purple-600" },
      milestone_25: { label: "25+ Referrals", icon: Star, color: "text-orange-600" },
    };
    return badges[badgeId] || { label: badgeId, icon: Award, color: "text-gray-600" };
  };

  const getRankIcon = (rank: number) => {
    if (rank === 1) return <Trophy className="h-6 w-6 text-yellow-500" />;
    if (rank === 2) return <Medal className="h-6 w-6 text-gray-400" />;
    if (rank === 3) return <Medal className="h-6 w-6 text-amber-700" />;
    return null;
  };

  const getTrendIcon = (trend: string) => {
    if (trend === "up") return <TrendingUp className="h-4 w-4 text-green-600" />;
    if (trend === "down") return <TrendingUp className="h-4 w-4 text-red-600 rotate-180" />;
    return null;
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase();
  };

  const formatRewards = (amount: number) => {
    return `${amount.toLocaleString()} Credits`;
  };

  const topThree = leaderboardData.slice(0, 3);
  const restOfLeaderboard = leaderboardData.slice(3);

  return (
    <div className="container py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Referral Leaderboard</h1>
          <p className="text-muted-foreground mt-2">
            Top referrers and their achievements
          </p>
        </div>
        <Select value={timeframe} onValueChange={(v) => setTimeframe(v as typeof timeframe)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="weekly">This Week</SelectItem>
            <SelectItem value="monthly">This Month</SelectItem>
            <SelectItem value="alltime">All Time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Top 3 Podium */}
      <div className="grid gap-4 md:grid-cols-3">
        {topThree.map((entry, index) => {
          const isFirst = entry.rank === 1;
          return (
            <Card
              key={entry.userId}
              className={`${isFirst ? "md:order-2 border-yellow-500/50 shadow-lg" : index === 1 ? "md:order-1" : "md:order-3"}`}
            >
              <CardHeader className="text-center pb-4">
                <div className="flex justify-center mb-2">
                  {getRankIcon(entry.rank)}
                </div>
                <div className="flex justify-center mb-4">
                  <Avatar className={`${isFirst ? "h-24 w-24" : "h-20 w-20"} border-4 ${isFirst ? "border-yellow-500" : "border-border"}`}>
                    <AvatarImage src={entry.avatar} />
                    <AvatarFallback className={isFirst ? "text-2xl" : "text-xl"}>
                      {getInitials(entry.name)}
                    </AvatarFallback>
                  </Avatar>
                </div>
                <CardTitle className={isFirst ? "text-xl" : "text-lg"}>{entry.name}</CardTitle>
                <CardDescription>Rank #{entry.rank}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Referrals</span>
                  <span className="font-semibold">{entry.completedReferrals}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Rewards</span>
                  <span className="font-semibold">{formatRewards(entry.totalRewards)}</span>
                </div>
                {entry.badges.length > 0 && (
                  <div className="flex flex-wrap gap-1 justify-center pt-2">
                    {entry.badges.map((badgeId) => {
                      const badge = getBadgeInfo(badgeId);
                      const Icon = badge.icon;
                      return (
                        <Badge key={badgeId} variant="secondary" className="gap-1">
                          <Icon className={`h-3 w-3 ${badge.color}`} />
                          <span className="text-xs">{badge.label}</span>
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Full Leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle>Full Rankings</CardTitle>
          <CardDescription>
            Complete leaderboard for {timeframe === "weekly" ? "this week" : timeframe === "monthly" ? "this month" : "all time"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {leaderboardData.map((entry) => (
              <div
                key={entry.userId}
                className={`flex items-center gap-4 p-4 rounded-lg border ${entry.rank <= 3 ? "bg-muted/50" : "hover:bg-muted/50"} transition-colors`}
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
                    <AvatarImage src={entry.avatar} />
                    <AvatarFallback>{getInitials(entry.name)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{entry.name}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {entry.badges.slice(0, 2).map((badgeId) => {
                        const badge = getBadgeInfo(badgeId);
                        const Icon = badge.icon;
                        return (
                          <Badge key={badgeId} variant="outline" className="gap-1 text-xs">
                            <Icon className={`h-3 w-3 ${badge.color}`} />
                            {badge.label}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Stats */}
                <div className="hidden sm:flex items-center gap-6 text-sm">
                  <div className="text-center">
                    <p className="font-semibold">{entry.completedReferrals}</p>
                    <p className="text-xs text-muted-foreground">Referrals</p>
                  </div>
                  <div className="text-center">
                    <p className="font-semibold">{formatRewards(entry.totalRewards)}</p>
                    <p className="text-xs text-muted-foreground">Rewards</p>
                  </div>
                  <div className="flex items-center">
                    {getTrendIcon(entry.trend)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Achievement Badges */}
      <Card>
        <CardHeader>
          <CardTitle>Achievement Badges</CardTitle>
          <CardDescription>
            Earn badges by reaching milestones and maintaining consistency
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries({
              top_referrer: "Be in the top 3 referrers",
              consistent: "Maintain steady referrals over time",
              milestone_50: "Reach 50 successful referrals",
              milestone_25: "Reach 25 successful referrals",
            }).map(([badgeId, description]) => {
              const badge = getBadgeInfo(badgeId);
              const Icon = badge.icon;
              return (
                <div key={badgeId} className="flex items-start gap-3 p-4 rounded-lg border">
                  <div className={`p-2 rounded-lg bg-muted ${badge.color}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm">{badge.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">{description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Monthly Rewards */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5" />
            Monthly Rewards
          </CardTitle>
          <CardDescription>
            Top performers receive bonus rewards at the end of each month
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <div className="flex items-center gap-3">
                <Trophy className="h-5 w-5 text-yellow-600" />
                <span className="font-medium">1st Place</span>
              </div>
              <span className="font-bold text-yellow-600">10,000 Bonus Credits</span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-gray-500/10 border border-gray-500/20">
              <div className="flex items-center gap-3">
                <Medal className="h-5 w-5 text-gray-600" />
                <span className="font-medium">2nd Place</span>
              </div>
              <span className="font-bold text-gray-600">5,000 Bonus Credits</span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-amber-700/10 border border-amber-700/20">
              <div className="flex items-center gap-3">
                <Medal className="h-5 w-5 text-amber-700" />
                <span className="font-medium">3rd Place</span>
              </div>
              <span className="font-bold text-amber-700">2,500 Bonus Credits</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

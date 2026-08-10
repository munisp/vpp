import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Trophy, Medal, Award, Zap, TrendingUp, DollarSign } from 'lucide-react';
import { useAuth } from '@/_core/hooks/useAuth';

export default function Leaderboard() {
  const { user } = useAuth();
  const [period, setPeriod] = useState<'daily' | 'weekly' | 'monthly' | 'all_time'>('monthly');

  const { data: leaderboard, isLoading } = trpc.gamification.getLeaderboard.useQuery({
    period,
    limit: 100,
  });

  const { data: myRank } = trpc.gamification.getMyRank.useQuery(
    { period },
    { enabled: !!user }
  );

  const { data: myAchievements } = trpc.gamification.getMyAchievements.useQuery(
    undefined,
    { enabled: !!user }
  );

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Trophy className="h-6 w-6 text-yellow-500" />;
      case 2:
        return <Medal className="h-6 w-6 text-gray-400" />;
      case 3:
        return <Medal className="h-6 w-6 text-amber-600" />;
      default:
        return <span className="text-muted-foreground">#{rank}</span>;
    }
  };

  const getSegmentBadge = (score: number) => {
    if (score >= 85) return <Badge className="bg-purple-500">Platinum</Badge>;
    if (score >= 70) return <Badge className="bg-yellow-500">Gold</Badge>;
    if (score >= 50) return <Badge className="bg-gray-400">Silver</Badge>;
    return <Badge variant="secondary">Bronze</Badge>;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container py-8 space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="p-4 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-full">
              <Trophy className="h-12 w-12 text-white" />
            </div>
          </div>
          <h1 className="text-4xl font-bold">DR Champions Leaderboard</h1>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Compete with other participants and earn rewards for your demand response performance
          </p>
        </div>

        {/* My Rank Card */}
        {user && myRank && (
          <Card className="bg-gradient-to-r from-blue-500 to-purple-600 text-white">
            <CardHeader>
              <CardTitle className="text-white">Your Ranking</CardTitle>
              <CardDescription className="text-blue-100">
                {period.charAt(0).toUpperCase() + period.slice(1).replace('_', ' ')} performance
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-sm text-blue-100">Rank</p>
                  <p className="text-3xl font-bold">#{myRank.rank}</p>
                </div>
                <div>
                  <p className="text-sm text-blue-100">Score</p>
                  <p className="text-3xl font-bold">{myRank.score}</p>
                </div>
                <div>
                  <p className="text-sm text-blue-100">Events</p>
                  <p className="text-3xl font-bold">{myRank.eventsParticipated}</p>
                </div>
                <div>
                  <p className="text-sm text-blue-100">Earned</p>
                  <p className="text-3xl font-bold">
                    {((myRank.compensationEarned || 0) / 100).toFixed(0)} TZS
                  </p>
                </div>
              </div>
              {myRank.rewardAmount && myRank.rewardAmount > 0 && (
                <div className="mt-4 p-3 bg-white/20 rounded-lg">
                  <p className="text-sm text-blue-100">Reward</p>
                  <p className="text-2xl font-bold">
                    {(myRank.rewardAmount / 100).toFixed(0)} TZS
                  </p>
                  {!myRank.rewardPaid && (
                    <Badge variant="secondary" className="mt-2">
                      Pending Payment
                    </Badge>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Period Selector */}
        <Tabs value={period} onValueChange={(v) => setPeriod(v as any)} className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="daily">Daily</TabsTrigger>
            <TabsTrigger value="weekly">Weekly</TabsTrigger>
            <TabsTrigger value="monthly">Monthly</TabsTrigger>
            <TabsTrigger value="all_time">All Time</TabsTrigger>
          </TabsList>

          <TabsContent value={period} className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Top Performers</CardTitle>
                <CardDescription>
                  Ranked by overall performance score
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="text-center py-8">Loading leaderboard...</div>
                ) : !leaderboard || leaderboard.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    No participants yet for this period
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">Rank</TableHead>
                        <TableHead>Participant</TableHead>
                        <TableHead>Tier</TableHead>
                        <TableHead className="text-right">Score</TableHead>
                        <TableHead className="text-right">Events</TableHead>
                        <TableHead className="text-right">Reduction (kW)</TableHead>
                        <TableHead className="text-right">Earned</TableHead>
                        {period !== 'all_time' && <TableHead className="text-right">Reward</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {leaderboard.map((entry) => (
                        <TableRow
                          key={entry.id}
                          className={user?.id === entry.userId ? 'bg-blue-50 dark:bg-blue-950' : ''}
                        >
                          <TableCell className="font-medium">
                            {getRankIcon(entry.rank)}
                          </TableCell>
                          <TableCell className="font-medium">
                            {entry.userName}
                            {user?.id === entry.userId && (
                              <Badge variant="outline" className="ml-2">
                                You
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>{getSegmentBadge(entry.score)}</TableCell>
                          <TableCell className="text-right font-bold">
                            {entry.score}
                          </TableCell>
                          <TableCell className="text-right">
                            {entry.eventsParticipated}
                          </TableCell>
                          <TableCell className="text-right">
                            {(entry.totalReduction / 1000).toFixed(1)}
                          </TableCell>
                          <TableCell className="text-right">
                            {((entry.compensationEarned || 0) / 100).toFixed(0)} TZS
                          </TableCell>
                          {period !== 'all_time' && (
                            <TableCell className="text-right">
                              {entry.rewardAmount && entry.rewardAmount > 0 ? (
                                <span className="font-bold text-green-600">
                                  {(entry.rewardAmount / 100).toFixed(0)} TZS
                                </span>
                              ) : (
                                '-'
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Achievements Section */}
        {user && myAchievements && myAchievements.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Award className="h-5 w-5" />
                Your Achievements
              </CardTitle>
              <CardDescription>
                Unlock achievements by participating in DR events
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {myAchievements.map((ua) => (
                  <Card key={ua.achievement.id} className="bg-gradient-to-br from-yellow-50 to-orange-50 dark:from-gray-800 dark:to-gray-700">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <div className="p-2 bg-yellow-100 dark:bg-yellow-900 rounded-lg">
                            <Award className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
                          </div>
                          <div>
                            <CardTitle className="text-base">{ua.achievement.name}</CardTitle>
                            <CardDescription className="text-xs">
                              {ua.achievement.description}
                            </CardDescription>
                          </div>
                        </div>
                        {ua.achievement.rewardBadge && (
                          <Badge
                            className={
                              ua.achievement.rewardBadge === 'platinum'
                                ? 'bg-purple-500'
                                : ua.achievement.rewardBadge === 'gold'
                                ? 'bg-yellow-500'
                                : ua.achievement.rewardBadge === 'silver'
                                ? 'bg-gray-400'
                                : 'bg-amber-600'
                            }
                          >
                            {ua.achievement.rewardBadge}
                          </Badge>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-xs text-muted-foreground">
                        Unlocked {new Date(ua.unlockedAt).toLocaleDateString()}
                      </p>
                      {ua.achievement.rewardPoints > 0 && (
                        <p className="text-sm font-medium mt-2">
                          +{ua.achievement.rewardPoints} points
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Rewards Info */}
        <Card>
          <CardHeader>
            <CardTitle>Reward Structure</CardTitle>
            <CardDescription>Earn rewards by ranking in the top 3</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="text-center p-4 bg-gradient-to-br from-yellow-50 to-orange-50 dark:from-gray-800 dark:to-gray-700 rounded-lg">
                <Trophy className="h-8 w-8 text-yellow-500 mx-auto mb-2" />
                <h3 className="font-bold text-lg">Daily Top 3</h3>
                <p className="text-sm text-muted-foreground">50, 30, 20 TZS</p>
              </div>
              <div className="text-center p-4 bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-gray-800 dark:to-gray-700 rounded-lg">
                <Medal className="h-8 w-8 text-blue-500 mx-auto mb-2" />
                <h3 className="font-bold text-lg">Weekly Top 3</h3>
                <p className="text-sm text-muted-foreground">200, 120, 80 TZS</p>
              </div>
              <div className="text-center p-4 bg-gradient-to-br from-purple-50 to-pink-50 dark:from-gray-800 dark:to-gray-700 rounded-lg">
                <Award className="h-8 w-8 text-purple-500 mx-auto mb-2" />
                <h3 className="font-bold text-lg">Monthly Top 3</h3>
                <p className="text-sm text-muted-foreground">1,000, 600, 400 TZS</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

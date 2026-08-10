import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Copy, Share2, Mail, MessageSquare, Check, Gift, Users, TrendingUp, Trophy, Download, FileText } from "lucide-react";
import { exportReferralsCSV, exportReferralsPDF } from "@/lib/exportUtils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function Referrals() {
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  // Fetch referral data
  const { data: referralCode, isLoading: codeLoading } = trpc.referrals.getMyReferralCode.useQuery();
  const { data: referrals, isLoading: referralsLoading } = trpc.referrals.getMyReferrals.useQuery();
  const { data: rewards, isLoading: rewardsLoading } = trpc.referrals.getMyRewards.useQuery();
  const { data: stats, isLoading: statsLoading } = trpc.referrals.getMyStats.useQuery();

  // Share mutation
  const shareMutation = trpc.referrals.shareReferralCode.useMutation({
    onSuccess: (data) => {
      if (data.channel === "copy") {
        navigator.clipboard.writeText(data.shareUrl);
        setCopiedCode(true);
        setTimeout(() => setCopiedCode(false), 2000);
        toast.success("Link copied to clipboard!");
      } else {
        toast.success(`Share link generated for ${data.channel}`);
      }
    },
    onError: () => {
      toast.error("Failed to generate share link");
    },
  });

  const handleCopyCode = () => {
    if (referralCode?.referralCode) {
      navigator.clipboard.writeText(referralCode.referralCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
      toast.success("Referral code copied!");
    }
  };

  const handleShare = (channel: "email" | "sms" | "whatsapp" | "copy") => {
    shareMutation.mutate({ channel });
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      pending: "secondary",
      completed: "default",
      rewarded: "default",
      expired: "destructive",
    };
    return <Badge variant={variants[status] || "outline"}>{status}</Badge>;
  };

  const formatDate = (date: Date | null) => {
    if (!date) return "N/A";
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const formatCurrency = (amount: number, currency: string) => {
    if (currency === "CREDITS") {
      return `${amount} Credits`;
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency === "NGN" ? "NGN" : currency === "TZS" ? "TZS" : "USD",
    }).format(amount / 100);
  };

  if (codeLoading || statsLoading) {
    return (
      <div className="container py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-1/3" />
          <div className="grid gap-4 md:grid-cols-3">
            <div className="h-32 bg-muted rounded" />
            <div className="h-32 bg-muted rounded" />
            <div className="h-32 bg-muted rounded" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Referral Program</h1>
          <p className="text-muted-foreground mt-2">
            Invite friends and earn rewards when they join the VPP Platform
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              if (stats && referrals) {
                exportReferralsCSV({
                  referrals,
                  stats,
                });
              }
            }}
            disabled={!referrals || referrals.length === 0}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (stats && referrals) {
                exportReferralsPDF({
                  referrals,
                  stats,
                });
              }
            }}
            disabled={!referrals || referrals.length === 0}
            className="gap-2"
          >
            <FileText className="h-4 w-4" />
            Export PDF
          </Button>
          <Button
            variant="outline"
            onClick={() => window.location.href = "/referral-leaderboard"}
            className="gap-2"
          >
            <Trophy className="h-4 w-4" />
            View Leaderboard
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Referrals</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalReferrals || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.completedReferrals || 0} completed, {stats?.pendingReferrals || 0} pending
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Rewards</CardTitle>
            <Gift className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalRewardsEarned || 0}</div>
            <p className="text-xs text-muted-foreground">
              Credits earned from referrals
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.totalReferrals
                ? Math.round((stats.completedReferrals / stats.totalReferrals) * 100)
                : 0}
              %
            </div>
            <p className="text-xs text-muted-foreground">
              Conversion rate
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Referral Code Card */}
      <Card>
        <CardHeader>
          <CardTitle>Your Referral Code</CardTitle>
          <CardDescription>
            Share this code with friends to earn rewards when they sign up
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 p-4 bg-muted rounded-lg">
                <code className="text-2xl font-mono font-bold flex-1">
                  {referralCode?.referralCode || "Loading..."}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCopyCode}
                  disabled={!referralCode}
                >
                  {copiedCode ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {referralCode?.expiresAt && (
                <p className="text-xs text-muted-foreground mt-2">
                  Expires: {formatDate(referralCode.expiresAt)}
                </p>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={() => setShareDialogOpen(true)} className="gap-2">
              <Share2 className="h-4 w-4" />
              Share Code
            </Button>
            <Button variant="outline" onClick={() => handleShare("copy")} className="gap-2">
              <Copy className="h-4 w-4" />
              Copy Link
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tabs for Referrals and Rewards */}
      <Tabs defaultValue="referrals" className="space-y-4">
        <TabsList>
          <TabsTrigger value="referrals">My Referrals</TabsTrigger>
          <TabsTrigger value="rewards">My Rewards</TabsTrigger>
        </TabsList>

        <TabsContent value="referrals" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Referral History</CardTitle>
              <CardDescription>
                Track the status of your referrals
              </CardDescription>
            </CardHeader>
            <CardContent>
              {referralsLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading...</div>
              ) : !referrals || referrals.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No referrals yet. Start sharing your code to earn rewards!
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reward</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {referrals.map((referral) => (
                      <TableRow key={referral.id}>
                        <TableCell className="font-mono">{referral.referralCode}</TableCell>
                        <TableCell>
                          {referral.refereeEmail || referral.refereePhone || "Pending"}
                        </TableCell>
                        <TableCell>{getStatusBadge(referral.status)}</TableCell>
                        <TableCell>
                          {formatCurrency(referral.rewardAmount, referral.rewardCurrency)}
                        </TableCell>
                        <TableCell>{formatDate(referral.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rewards" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Reward History</CardTitle>
              <CardDescription>
                View all rewards earned from your referrals
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rewardsLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading...</div>
              ) : !rewards || rewards.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No rewards earned yet. Keep referring to earn rewards!
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rewards.map((reward) => (
                      <TableRow key={reward.id}>
                        <TableCell className="capitalize">{reward.rewardType}</TableCell>
                        <TableCell className="font-semibold">
                          {formatCurrency(reward.amount, reward.currency)}
                        </TableCell>
                        <TableCell>{getStatusBadge(reward.status)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {reward.description}
                        </TableCell>
                        <TableCell>{formatDate(reward.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Share Dialog */}
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share Your Referral Code</DialogTitle>
            <DialogDescription>
              Choose how you'd like to share your referral code
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Button
              variant="outline"
              className="justify-start gap-3"
              onClick={() => {
                handleShare("email");
                setShareDialogOpen(false);
              }}
            >
              <Mail className="h-5 w-5" />
              Share via Email
            </Button>
            <Button
              variant="outline"
              className="justify-start gap-3"
              onClick={() => {
                handleShare("sms");
                setShareDialogOpen(false);
              }}
            >
              <MessageSquare className="h-5 w-5" />
              Share via SMS
            </Button>
            <Button
              variant="outline"
              className="justify-start gap-3"
              onClick={() => {
                handleShare("whatsapp");
                setShareDialogOpen(false);
              }}
            >
              <MessageSquare className="h-5 w-5" />
              Share via WhatsApp
            </Button>
            <Button
              variant="outline"
              className="justify-start gap-3"
              onClick={() => {
                handleShare("copy");
                setShareDialogOpen(false);
              }}
            >
              <Copy className="h-5 w-5" />
              Copy Share Link
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

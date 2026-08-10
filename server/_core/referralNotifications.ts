import { notifyOwner } from "./notification";
import { sendEmail } from "./emailService";

/**
 * Referral Notification Service
 * 
 * Handles push notifications for referral program events
 */

export interface ReferralNotificationData {
  userId: number;
  userName: string;
  event: "reward_earned" | "referral_completed" | "leaderboard_change" | "milestone_reached";
  amount?: number;
  currency?: string;
  milestone?: string;
  newRank?: number;
  oldRank?: number;
}

/**
 * Send notification when a user earns a referral reward
 */
export async function notifyReferralReward(data: {
  userId: number;
  userName: string;
  amount: number;
  currency: string;
  referralCode: string;
}) {
  const title = "🎉 Referral Reward Earned!";
  const content = `Congratulations ${data.userName}! You've earned ${data.amount} ${data.currency} from referral code ${data.referralCode}.`;

  try {
    // Send push notification to owner
    await notifyOwner({ title, content });
    
    // Send email notification to user
    await sendEmail({
      to: `user_${data.userId}@vpp.platform`, // In production, fetch actual user email
      subject: title,
      html: `
        <h2>${title}</h2>
        <p>Congratulations ${data.userName}!</p>
        <p>You've earned <strong>${data.amount} ${data.currency}</strong> from referral code <strong>${data.referralCode}</strong>.</p>
        <p>Keep sharing your referral code to earn more rewards!</p>
      `,
    });
    
    return true;
  } catch (error) {
    console.error("[ReferralNotifications] Failed to send reward notification:", error);
    return false;
  }
}

/**
 * Send notification when a referral is completed
 */
export async function notifyReferralCompleted(data: {
  userId: number;
  userName: string;
  refereeEmail?: string;
  refereePhone?: string;
}) {
  const referee = data.refereeEmail || data.refereePhone || "New user";
  const title = "✅ Referral Completed";
  const content = `${referee} has successfully signed up using your referral code!`;

  try {
    // Send push notification
    await notifyOwner({ title, content });
    
    // Send email notification
    await sendEmail({
      to: `user_${data.userId}@vpp.platform`,
      subject: title,
      html: `
        <h2>${title}</h2>
        <p>${referee} has successfully signed up using your referral code!</p>
        <p>Your reward will be processed once they complete their first transaction.</p>
      `,
    });
    
    return true;
  } catch (error) {
    console.error("[ReferralNotifications] Failed to send completion notification:", error);
    return false;
  }
}

/**
 * Send notification when user's leaderboard position changes
 */
export async function notifyLeaderboardChange(data: {
  userId: number;
  userName: string;
  newRank: number;
  oldRank: number;
}) {
  const isImprovement = data.newRank < data.oldRank;
  const title = isImprovement ? "📈 You're Moving Up!" : "📊 Leaderboard Update";
  const content = isImprovement
    ? `Great job ${data.userName}! You've moved up to rank #${data.newRank} on the referral leaderboard!`
    : `Your referral leaderboard position has changed to rank #${data.newRank}.`;

  try {
    await notifyOwner({ title, content });
    return true;
  } catch (error) {
    console.error("[ReferralNotifications] Failed to send leaderboard notification:", error);
    return false;
  }
}

/**
 * Send notification when user reaches a referral milestone
 */
export async function notifyMilestoneReached(data: {
  userId: number;
  userName: string;
  milestone: string;
  totalReferrals: number;
}) {
  const title = "🏆 Milestone Achieved!";
  const content = `Congratulations ${data.userName}! You've reached ${data.totalReferrals} referrals and earned the "${data.milestone}" badge!`;

  try {
    // Send push notification
    await notifyOwner({ title, content });
    
    // Send email notification
    await sendEmail({
      to: `user_${data.userId}@vpp.platform`,
      subject: title,
      html: `
        <h2>${title}</h2>
        <p>Congratulations ${data.userName}!</p>
        <p>You've reached <strong>${data.totalReferrals} referrals</strong> and earned the <strong>"${data.milestone}"</strong> badge!</p>
        <p>Keep up the great work and aim for the next milestone!</p>
      `,
    });
    
    return true;
  } catch (error) {
    console.error("[ReferralNotifications] Failed to send milestone notification:", error);
    return false;
  }
}

/**
 * Send batch notification for monthly leaderboard winners
 */
export async function notifyMonthlyWinners(winners: Array<{
  userId: number;
  userName: string;
  rank: number;
  bonusAmount: number;
}>) {
  const title = "🎊 Monthly Referral Winners Announced!";
  const content = `Congratulations to this month's top referrers:\n${winners
    .map((w) => `#${w.rank}: ${w.userName} - ${w.bonusAmount} bonus credits`)
    .join("\n")}`;

  try {
    await notifyOwner({ title, content });
    return true;
  } catch (error) {
    console.error("[ReferralNotifications] Failed to send monthly winners notification:", error);
    return false;
  }
}

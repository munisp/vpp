import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import ShareButton from '../components/ShareButton';
import { ShareService } from '../services/shareService';
import { HapticService } from '../services/hapticService';

export default function GamificationScreen({ navigation }: any) {
  const [activeTab, setActiveTab] = useState<'leaderboard' | 'achievements'>('leaderboard');
  const [refreshing, setRefreshing] = useState(false);

  const { data: leaderboard, refetch: refetchLeaderboard } = trpc.gamification.getLeaderboard.useQuery({
    timeframe: 'monthly',
    limit: 50,
  });

  const { data: userStats } = trpc.gamification.getUserStats.useQuery();
  const { data: achievements } = trpc.gamification.getAchievements.useQuery();

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await refetchLeaderboard();
    setRefreshing(false);
  };

  const getRankIcon = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  };

  const getRankColor = (rank: number) => {
    if (rank === 1) return '#f59e0b';
    if (rank === 2) return '#9ca3af';
    if (rank === 3) return '#cd7f32';
    return '#6b7280';
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Leaderboard</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* User Stats Card */}
      {userStats && (
        <View style={styles.statsCard}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{userStats.rank || '-'}</Text>
            <Text style={styles.statLabel}>Your Rank</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{userStats.totalPoints || 0}</Text>
            <Text style={styles.statLabel}>Total Points</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{userStats.level || 1}</Text>
            <Text style={styles.statLabel}>Level</Text>
          </View>
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'leaderboard' && styles.activeTab]}
          onPress={async () => {
            await HapticService.buttonPress();
            setActiveTab('leaderboard');
          }}
        >
          <Ionicons
            name="trophy"
            size={20}
            color={activeTab === 'leaderboard' ? '#8b5cf6' : '#6b7280'}
          />
          <Text
            style={[
              styles.tabText,
              activeTab === 'leaderboard' && styles.activeTabText,
            ]}
          >
            Leaderboard
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tab, activeTab === 'achievements' && styles.activeTab]}
          onPress={async () => {
            await HapticService.buttonPress();
            setActiveTab('achievements');
          }}
        >
          <Ionicons
            name="medal"
            size={20}
            color={activeTab === 'achievements' ? '#8b5cf6' : '#6b7280'}
          />
          <Text
            style={[
              styles.tabText,
              activeTab === 'achievements' && styles.activeTabText,
            ]}
          >
            Achievements
          </Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      <ScrollView
        style={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {activeTab === 'leaderboard' && (
          <View style={styles.leaderboardContainer}>
            {leaderboard?.users.map((user, index) => (
              <View
                key={user.id}
                style={[
                  styles.leaderboardItem,
                  user.isCurrentUser && styles.currentUserItem,
                ]}
              >
                <View style={styles.rankContainer}>
                  <Text
                    style={[
                      styles.rankText,
                      { color: getRankColor(user.rank) },
                    ]}
                  >
                    {getRankIcon(user.rank)}
                  </Text>
                </View>

                <View style={styles.userInfo}>
                  <Text style={styles.userName}>
                    {user.name}
                    {user.isCurrentUser && (
                      <Text style={styles.youBadge}> (You)</Text>
                    )}
                  </Text>
                  <View style={styles.userMeta}>
                    <Ionicons name="flash" size={12} color="#f59e0b" />
                    <Text style={styles.energyText}>
                      {user.totalEnergyTraded.toFixed(0)} kWh
                    </Text>
                  </View>
                </View>

                <View style={styles.pointsContainer}>
                  <Text style={styles.pointsText}>{user.totalPoints}</Text>
                  <Text style={styles.pointsLabel}>pts</Text>
                </View>
              </View>
            ))}

            {!leaderboard?.users.length && (
              <View style={styles.emptyState}>
                <Ionicons name="trophy-outline" size={64} color="#d1d5db" />
                <Text style={styles.emptyText}>No leaderboard data yet</Text>
                <Text style={styles.emptyDescription}>
                  Start trading energy to appear on the leaderboard
                </Text>
              </View>
            )}
          </View>
        )}

        {activeTab === 'achievements' && (
          <View style={styles.achievementsContainer}>
            {achievements?.map((achievement) => (
              <View
                key={achievement.id}
                style={[
                  styles.achievementCard,
                  !achievement.unlocked && styles.lockedAchievement,
                ]}
              >
                <View style={styles.achievementIcon}>
                  <Text style={styles.achievementEmoji}>{achievement.icon}</Text>
                  {achievement.unlocked && (
                    <View style={styles.unlockedBadge}>
                      <Ionicons name="checkmark" size={16} color="white" />
                    </View>
                  )}
                </View>

                <View style={styles.achievementInfo}>
                  <Text style={styles.achievementName}>{achievement.name}</Text>
                  <Text style={styles.achievementDescription}>
                    {achievement.description}
                  </Text>
                  <View style={styles.achievementMeta}>
                    <Ionicons name="star" size={12} color="#f59e0b" />
                    <Text style={styles.achievementPoints}>
                      {achievement.points} points
                    </Text>
                  </View>
                </View>

                {achievement.unlocked && (
                  <View style={styles.achievementActions}>
                    {achievement.unlockedAt && (
                      <Text style={styles.unlockedDateText}>
                        {new Date(achievement.unlockedAt).toLocaleDateString()}
                      </Text>
                    )}
                    <ShareButton
                      onPress={() => ShareService.shareAchievement(achievement)}
                      size="small"
                    />
                  </View>
                )}
              </View>
            ))}

            {!achievements?.length && (
              <View style={styles.emptyState}>
                <Ionicons name="medal-outline" size={64} color="#d1d5db" />
                <Text style={styles.emptyText}>No achievements yet</Text>
                <Text style={styles.emptyDescription}>
                  Complete activities to unlock achievements
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 16,
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backButton: {
    padding: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
  },
  statsCard: {
    flexDirection: 'row',
    backgroundColor: 'white',
    marginHorizontal: 16,
    marginVertical: 16,
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#8b5cf6',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  statDivider: {
    width: 1,
    backgroundColor: '#e5e7eb',
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: 'white',
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    padding: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
  },
  activeTab: {
    backgroundColor: '#f3f4f6',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
    marginLeft: 6,
  },
  activeTabText: {
    color: '#8b5cf6',
  },
  content: {
    flex: 1,
  },
  leaderboardContainer: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  leaderboardItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  currentUserItem: {
    borderWidth: 2,
    borderColor: '#8b5cf6',
  },
  rankContainer: {
    width: 40,
    alignItems: 'center',
  },
  rankText: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  userInfo: {
    flex: 1,
    marginLeft: 12,
  },
  userName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  youBadge: {
    color: '#8b5cf6',
    fontSize: 14,
  },
  userMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  energyText: {
    fontSize: 12,
    color: '#6b7280',
    marginLeft: 4,
  },
  pointsContainer: {
    alignItems: 'flex-end',
  },
  pointsText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#8b5cf6',
  },
  pointsLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  achievementsContainer: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  achievementCard: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  lockedAchievement: {
    opacity: 0.6,
  },
  achievementIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  achievementEmoji: {
    fontSize: 32,
  },
  unlockedBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'white',
  },
  achievementInfo: {
    flex: 1,
    marginLeft: 16,
  },
  achievementName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  achievementDescription: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 8,
  },
  achievementMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  achievementPoints: {
    fontSize: 12,
    color: '#f59e0b',
    marginLeft: 4,
    fontWeight: '600',
  },
  unlockedDate: {
    justifyContent: 'center',
  },
  achievementActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  unlockedDateText: {
    fontSize: 12,
    color: '#6b7280',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#6b7280',
    marginTop: 16,
  },
  emptyDescription: {
    fontSize: 14,
    color: '#9ca3af',
    marginTop: 8,
    textAlign: 'center',
  },
});

import { View, Text, SafeAreaView, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useFeed } from '../contexts/FeedContext';
import { router } from 'expo-router';
import LeagueSection from '../components/LeagueSection';
import { useState } from 'react';

export default function HomeScreen() {
  const { leagues, isLoading, error, refreshFeed } = useFeed();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshFeed();
    setRefreshing(false);
  };

  if (isLoading && !refreshing) {
    return (
      <SafeAreaView className="flex-1 bg-slate-900">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text className="text-slate-400 mt-4">Loading feed...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView className="flex-1 bg-slate-900">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-red-400 text-xl font-semibold mb-2">Error Loading Feed</Text>
          <Text className="text-slate-400 text-center mb-6">{error}</Text>
          <TouchableOpacity
            onPress={refreshFeed}
            className="bg-blue-600 px-6 py-3 rounded-xl"
          >
            <Text className="text-white font-semibold">Try Again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <ScrollView
        className="flex-1"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3B82F6" />
        }
      >
        {/* Header */}
        <View className="px-6 py-6">
          <View className="flex-row items-center justify-between mb-4">
            <View>
              <Text className="text-4xl font-bold text-white">
                Live Sports
              </Text>
              <Text className="text-lg text-slate-400 mt-1">
                {leagues.length} leagues available
              </Text>
            </View>
            
            <TouchableOpacity
              onPress={() => router.push('/settings')}
              className="bg-slate-800 p-3 rounded-xl border border-slate-700"
            >
              <Text className="text-white text-lg">⚙️</Text>
            </TouchableOpacity>
          </View>

          {/* Search Button */}
          <TouchableOpacity
            onPress={() => router.push('/search')}
            className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 flex-row items-center"
            activeOpacity={0.7}
          >
            <Text className="text-slate-400 text-base flex-1">
              🔍 Search matches...
            </Text>
          </TouchableOpacity>
        </View>

        {/* League Sections */}
        {leagues.length === 0 ? (
          <View className="px-6 py-12">
            <Text className="text-slate-400 text-center">
              No matches available at the moment
            </Text>
          </View>
        ) : (
          leagues.map((league) => (
            <LeagueSection key={league.name} name={league.name} matches={league.matches} />
          ))
        )}

        {/* Bottom Spacing */}
        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}


import { View, Text, SafeAreaView, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { useFeed } from '../contexts/FeedContext';
import { router } from 'expo-router';
import { useState, useMemo } from 'react';
import Fuse from 'fuse.js';
import { Match } from '../types/feed';
import MatchCard from '../components/MatchCard';

export default function SearchScreen() {
  const { leagues } = useFeed();
  const [searchQuery, setSearchQuery] = useState('');

  // Flatten all matches from all leagues
  const allMatches = useMemo(() => {
    return leagues.flatMap((league) => league.matches);
  }, [leagues]);

  // Setup Fuse.js for fuzzy search
  const fuse = useMemo(() => {
    return new Fuse(allMatches, {
      keys: ['title', 'shortDescription', 'genres'],
      threshold: 0.3, // Lower = more strict, higher = more fuzzy
      includeScore: true,
    });
  }, [allMatches]);

  // Search results
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) {
      return [];
    }
    return fuse.search(searchQuery).map((result) => result.item);
  }, [searchQuery, fuse]);

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <View className="flex-1">
        {/* Header */}
        <View className="px-6 py-4 flex-row items-center border-b border-slate-800">
          <TouchableOpacity
            onPress={() => router.back()}
            className="mr-4 bg-slate-800 p-2 rounded-xl border border-slate-700"
          >
            <Text className="text-white text-lg">←</Text>
          </TouchableOpacity>
          
          <View className="flex-1">
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search matches..."
              placeholderTextColor="#64748B"
              autoFocus
              className="bg-slate-800 text-white px-4 py-3 rounded-xl border border-slate-700"
            />
          </View>

          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              className="ml-3 bg-slate-800 p-3 rounded-xl border border-slate-700"
            >
              <Text className="text-white">✕</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Search Results */}
        <ScrollView className="flex-1">
          {!searchQuery.trim() ? (
            <View className="px-6 py-12">
              <Text className="text-slate-400 text-center text-lg mb-2">
                🔍 Search for matches
              </Text>
              <Text className="text-slate-500 text-center">
                Try searching for a team, league, or sport
              </Text>
            </View>
          ) : searchResults.length === 0 ? (
            <View className="px-6 py-12">
              <Text className="text-slate-400 text-center text-lg mb-2">
                No matches found
              </Text>
              <Text className="text-slate-500 text-center">
                Try a different search term
              </Text>
            </View>
          ) : (
            <View className="px-6 py-4">
              <Text className="text-slate-400 mb-4">
                Found {searchResults.length} {searchResults.length === 1 ? 'match' : 'matches'}
              </Text>
              
              <View className="gap-4">
                {searchResults.map((match) => (
                  <MatchCard key={match.id} match={match} fullWidth />
                ))}
              </View>
            </View>
          )}

          {/* Bottom Spacing */}
          <View className="h-8" />
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}


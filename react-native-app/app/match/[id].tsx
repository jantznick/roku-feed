import { View, Text, SafeAreaView, ScrollView, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useFeed } from '../../contexts/FeedContext';
import { useState, useEffect } from 'react';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Match as MatchType } from '../../types/feed';

export default function MatchDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { leagues } = useFeed();
  const [selectedStreamIndex, setSelectedStreamIndex] = useState(0);

  // Find the match across all leagues
  let match: MatchType | undefined;
  for (const league of leagues) {
    match = league.matches.find((m) => m.id === id);
    if (match) break;
  }

  const streams = match?.content.videos || [];
  const selectedStream = streams[selectedStreamIndex];

  // Create video player
  const player = useVideoPlayer(selectedStream?.url || '', (player) => {
    player.loop = false;
  });

  // Update player source when stream changes
  useEffect(() => {
    if (selectedStream?.url) {
      player.replace(selectedStream.url);
      player.play();
    }
  }, [selectedStreamIndex, selectedStream?.url]);

  if (!match) {
    return (
      <SafeAreaView className="flex-1 bg-slate-900">
        <View className="flex-1 items-center justify-center">
          <Text className="text-white text-xl">Match not found</Text>
          <TouchableOpacity
            onPress={() => router.back()}
            className="mt-4 bg-blue-600 px-6 py-3 rounded-xl"
          >
            <Text className="text-white font-semibold">Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <ScrollView className="flex-1">
        {/* Header */}
        <View className="px-6 py-4 flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="mr-4 bg-slate-800 p-2 rounded-xl border border-slate-700"
          >
            <Text className="text-white text-lg">←</Text>
          </TouchableOpacity>
          <View className="flex-1">
            <Text className="text-white text-lg font-semibold" numberOfLines={1}>
              {match.title}
            </Text>
          </View>
        </View>

        {/* Video Player */}
        {selectedStream && (
          <View className="mx-6 mb-6 bg-black rounded-2xl overflow-hidden border border-slate-700">
            <VideoView
              player={player}
              allowsFullscreen
              allowsPictureInPicture
              style={{
                width: '100%',
                aspectRatio: 16 / 9,
              }}
            />
          </View>
        )}

        {/* Match Info */}
        <View className="px-6 mb-6">
          <Text className="text-white text-2xl font-bold mb-2">
            {match.title}
          </Text>
          <Text className="text-slate-400 text-base mb-4">
            {match.shortDescription}
          </Text>
          
          <View className="flex-row gap-3">
            <View className="bg-blue-600 px-4 py-2 rounded-full">
              <Text className="text-white font-semibold">
                ⏰ {match.startTime}
              </Text>
            </View>
            {match.genres && match.genres.length > 0 && (
              <View className="bg-slate-800 px-4 py-2 rounded-full border border-slate-700">
                <Text className="text-slate-300 capitalize">
                  {match.genres[0]}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Stream Selection */}
        <View className="px-6 mb-6">
          <Text className="text-white text-xl font-semibold mb-3">
            Available Streams ({streams.length})
          </Text>
          
          {streams.length === 0 ? (
            <View className="bg-slate-800 border border-slate-700 rounded-xl p-6 items-center">
              <Text className="text-slate-400 text-center">
                No streams available for this match
              </Text>
            </View>
          ) : (
            <View className="gap-3">
              {streams.map((stream, index) => (
                <TouchableOpacity
                  key={index}
                  onPress={() => {
                    setSelectedStreamIndex(index);
                    // Player will update automatically due to the dependency on selectedStream
                  }}
                  className={`p-4 rounded-xl border ${
                    selectedStreamIndex === index
                      ? 'bg-blue-600 border-blue-500'
                      : 'bg-slate-800 border-slate-700'
                  }`}
                  activeOpacity={0.7}
                >
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1">
                      <Text
                        className={`font-semibold mb-1 ${
                          selectedStreamIndex === index ? 'text-white' : 'text-slate-300'
                        }`}
                      >
                        Stream {index + 1}
                      </Text>
                      <Text
                        className={`text-sm ${
                          selectedStreamIndex === index ? 'text-blue-100' : 'text-slate-400'
                        }`}
                        numberOfLines={1}
                      >
                        {stream.quality}
                      </Text>
                    </View>
                    {selectedStreamIndex === index && (
                      <View className="bg-white px-3 py-1 rounded-full">
                        <Text className="text-blue-600 text-xs font-bold">PLAYING</Text>
                      </View>
                    )}
                  </View>
                  {stream.confirmedAt && (
                    <Text className="text-xs text-slate-500 mt-2">
                      Confirmed: {new Date(stream.confirmedAt).toLocaleTimeString()}
                    </Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Bottom Spacing */}
        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}


import { View, Text, SafeAreaView, ScrollView, TextInput, TouchableOpacity, Alert } from 'react-native';
import { useFeed } from '../contexts/FeedContext';
import { router } from 'expo-router';
import { useState } from 'react';

const DEFAULT_FEED_URL = 'https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json';

export default function SettingsScreen() {
  const { settings, updateSettings } = useFeed();
  const [feedUrl, setFeedUrl] = useState(settings.feedUrl);

  const handleSave = async () => {
    await updateSettings({ feedUrl });
    Alert.alert('Success', 'Settings saved successfully');
    router.back();
  };

  const handleReset = async () => {
    setFeedUrl(DEFAULT_FEED_URL);
    await updateSettings({ feedUrl: DEFAULT_FEED_URL });
    Alert.alert('Success', 'Feed URL reset to default');
  };

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <ScrollView className="flex-1">
        {/* Header */}
        <View className="px-6 py-6 flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="mr-4 bg-slate-800 p-2 rounded-xl border border-slate-700"
          >
            <Text className="text-white text-lg">←</Text>
          </TouchableOpacity>
          <Text className="text-3xl font-bold text-white">
            Settings
          </Text>
        </View>

        {/* Feed URL Section */}
        <View className="px-6 py-4">
          <Text className="text-white text-xl font-semibold mb-2">
            Feed URL
          </Text>
          <Text className="text-slate-400 text-sm mb-4">
            Enter a custom feed URL to load different content
          </Text>
          
          <TextInput
            value={feedUrl}
            onChangeText={setFeedUrl}
            placeholder="https://..."
            placeholderTextColor="#64748B"
            className="bg-slate-800 text-white px-4 py-4 rounded-xl border border-slate-700 mb-4"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <View className="flex-row gap-3">
            <TouchableOpacity
              onPress={handleReset}
              className="flex-1 bg-slate-800 py-4 rounded-xl border border-slate-700"
            >
              <Text className="text-white text-center font-semibold">
                Reset to Default
              </Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              onPress={handleSave}
              className="flex-1 bg-blue-600 py-4 rounded-xl"
            >
              <Text className="text-white text-center font-semibold">
                Save
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Favorite Teams Section (Coming Soon) */}
        <View className="px-6 py-4 mt-4">
          <Text className="text-white text-xl font-semibold mb-2">
            Favorite Teams
          </Text>
          <Text className="text-slate-400 text-sm mb-4">
            Coming soon - mark teams as favorites for quick access
          </Text>
          
          <View className="bg-slate-800 border border-slate-700 rounded-xl p-6 items-center">
            <Text className="text-slate-500 text-center">
              🌟 This feature is under development
            </Text>
          </View>
        </View>

        {/* App Info */}
        <View className="px-6 py-8 mt-8">
          <View className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <Text className="text-slate-400 text-center text-sm">
              Roku Feed v1.0.0
            </Text>
            <Text className="text-slate-500 text-center text-xs mt-2">
              Live Sports Streaming
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}


import { View, Text, Image, TouchableOpacity } from 'react-native';
import { Match } from '../types/feed';
import { router } from 'expo-router';

interface MatchCardProps {
  match: Match;
  fullWidth?: boolean;
}

export default function MatchCard({ match, fullWidth = false }: MatchCardProps) {
  const handlePress = () => {
    router.push(`/match/${match.id}`);
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      className={fullWidth ? 'w-full' : 'mr-4 w-64'}
      activeOpacity={0.7}
    >
      <View className="bg-slate-800 rounded-2xl overflow-hidden border border-slate-700">
        {/* Thumbnail */}
        <Image
          source={{ uri: match.thumbnail }}
          className="w-full h-36 bg-slate-700"
          resizeMode="cover"
        />
        
        {/* Content */}
        <View className="p-4">
          <Text className="text-white font-semibold text-base mb-1" numberOfLines={2}>
            {match.title}
          </Text>
          
          <View className="flex-row items-center justify-between mt-2">
            <View className="bg-blue-600 px-3 py-1 rounded-full">
              <Text className="text-white text-xs font-semibold">
                {match.startTime}
              </Text>
            </View>
            
            {match.content.videos && match.content.videos.length > 0 && (
              <View className="bg-slate-700 px-3 py-1 rounded-full">
                <Text className="text-slate-300 text-xs">
                  {match.content.videos.length} stream{match.content.videos.length !== 1 ? 's' : ''}
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}


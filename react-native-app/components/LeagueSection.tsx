import { View, Text, ScrollView } from 'react-native';
import { Match } from '../types/feed';
import MatchCard from './MatchCard';

interface LeagueSectionProps {
  name: string;
  matches: Match[];
}

export default function LeagueSection({ name, matches }: LeagueSectionProps) {
  // Format league name (convert from uppercase and replace hyphens)
  const formatLeagueName = (name: string) => {
    return name
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  return (
    <View className="mb-6">
      {/* Section Header */}
      <View className="px-6 mb-3">
        <Text className="text-white text-2xl font-bold">
          {formatLeagueName(name)}
        </Text>
        <Text className="text-slate-400 text-sm mt-1">
          {matches.length} {matches.length === 1 ? 'match' : 'matches'} available
        </Text>
      </View>

      {/* Horizontal Scroll */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 24 }}
      >
        {matches.map((match) => (
          <MatchCard key={match.id} match={match} />
        ))}
      </ScrollView>
    </View>
  );
}


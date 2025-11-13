import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feed, Match, Settings } from '../types/feed';

const DEFAULT_FEED_URL = 'https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json';

interface FeedContextType {
  feed: Feed | null;
  leagues: { name: string; matches: Match[] }[];
  isLoading: boolean;
  error: string | null;
  settings: Settings;
  refreshFeed: () => Promise<void>;
  updateSettings: (newSettings: Partial<Settings>) => Promise<void>;
}

const FeedContext = createContext<FeedContextType | undefined>(undefined);

export function FeedProvider({ children }: { children: ReactNode }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [leagues, setLeagues] = useState<{ name: string; matches: Match[] }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>({
    feedUrl: DEFAULT_FEED_URL,
    favoriteTeams: [],
  });

  // Load settings from storage
  useEffect(() => {
    loadSettings();
  }, []);

  // Fetch feed when settings change
  useEffect(() => {
    fetchFeed();
  }, [settings.feedUrl]);

  const loadSettings = async () => {
    try {
      const stored = await AsyncStorage.getItem('settings');
      if (stored) {
        setSettings(JSON.parse(stored));
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  };

  const updateSettings = async (newSettings: Partial<Settings>) => {
    const updated = { ...settings, ...newSettings };
    setSettings(updated);
    try {
      await AsyncStorage.setItem('settings', JSON.stringify(updated));
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  };

  const fetchFeed = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(settings.feedUrl);
      if (!response.ok) {
        throw new Error('Failed to fetch feed');
      }
      
      const data: Feed = await response.json();
      setFeed(data);

      // Parse leagues from feed
      const leagueData: { name: string; matches: Match[] }[] = [];
      
      Object.keys(data).forEach((key) => {
        // Skip metadata fields
        if (['providerName', 'lastUpdated', 'language', 'scriptDuration'].includes(key)) {
          return;
        }

        const matches = data[key];
        if (Array.isArray(matches) && matches.length > 0) {
          leagueData.push({
            name: key,
            matches: matches,
          });
        }
      });

      setLeagues(leagueData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  };

  const refreshFeed = async () => {
    await fetchFeed();
  };

  return (
    <FeedContext.Provider
      value={{
        feed,
        leagues,
        isLoading,
        error,
        settings,
        refreshFeed,
        updateSettings,
      }}
    >
      {children}
    </FeedContext.Provider>
  );
}

export function useFeed() {
  const context = useContext(FeedContext);
  if (context === undefined) {
    throw new Error('useFeed must be used within a FeedProvider');
  }
  return context;
}



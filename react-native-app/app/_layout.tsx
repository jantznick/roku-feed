import { Stack } from 'expo-router';
import { FeedProvider } from '../contexts/FeedContext';
import '../global.css';

export default function RootLayout() {
  return (
    <FeedProvider>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
        <Stack.Screen name="search" options={{ headerShown: false }} />
        <Stack.Screen name="match/[id]" options={{ headerShown: false }} />
      </Stack>
    </FeedProvider>
  );
}


import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  SafeAreaView,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useFeed } from "../contexts/FeedContext";
import { useAuth } from "../contexts/AuthContext";
import { router } from "expo-router";
import { deviceApi, settingsApi } from "../lib/api";

const DEFAULT_FEED_URL =
  "https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json";

export default function SettingsScreen() {
  const { settings, updateSettings } = useFeed();
  const { user, token, isLoggedIn, loading: authLoading, logout } = useAuth();
  const [feedUrl, setFeedUrl] = useState(settings.feedUrl);
  const [defaultFeedUrl, setDefaultFeedUrl] = useState(DEFAULT_FEED_URL);
  const [effectiveFeedUrl, setEffectiveFeedUrl] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingAccount, setLoadingAccount] = useState(false);
  const [status, setStatus] = useState("");

  const loadAccountSettings = useCallback(async () => {
    if (!isLoggedIn || !token) return;
    setLoadingAccount(true);
    try {
      const data = await settingsApi.get(token);
      const s = data.settings;
      setFeedUrl(s.feedUrl ?? "");
      setDefaultFeedUrl(s.defaultFeedUrl || DEFAULT_FEED_URL);
      setEffectiveFeedUrl(s.effectiveFeedUrl || "");
      if (s.effectiveFeedUrl) {
        await updateSettings({ feedUrl: s.effectiveFeedUrl });
      }
    } catch (err: any) {
      setStatus(err.message || "Could not load account settings");
    } finally {
      setLoadingAccount(false);
    }
  }, [isLoggedIn, token, updateSettings]);

  useEffect(() => {
    if (!authLoading && isLoggedIn) {
      loadAccountSettings();
    } else if (!authLoading) {
      setFeedUrl(settings.feedUrl);
    }
  }, [authLoading, isLoggedIn, loadAccountSettings, settings.feedUrl]);

  const handleSave = async () => {
    setBusy(true);
    setStatus("");
    try {
      if (isLoggedIn && token) {
        const data = await settingsApi.update(token, feedUrl.trim());
        const next = data.settings?.feedUrl ?? feedUrl.trim();
        setFeedUrl(next || "");
        if (data.settings?.effectiveFeedUrl) {
          setEffectiveFeedUrl(data.settings.effectiveFeedUrl);
          await updateSettings({ feedUrl: data.settings.effectiveFeedUrl });
        }
        if (data.settings?.defaultFeedUrl) {
          setDefaultFeedUrl(data.settings.defaultFeedUrl);
        }
        setStatus("Saved to your account. Linked Rokus sync on next reload.");
      } else {
        await updateSettings({ feedUrl: feedUrl.trim() || DEFAULT_FEED_URL });
        setStatus("Saved locally on this device.");
      }
    } catch (err: any) {
      setStatus(err.message || "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    setBusy(true);
    setStatus("");
    try {
      if (isLoggedIn && token) {
        const data = await settingsApi.update(token, "");
        setFeedUrl("");
        if (data.settings?.effectiveFeedUrl) {
          setEffectiveFeedUrl(data.settings.effectiveFeedUrl);
          await updateSettings({ feedUrl: data.settings.effectiveFeedUrl });
        }
        setStatus("Reset to default on your account.");
      } else {
        setFeedUrl(DEFAULT_FEED_URL);
        await updateSettings({ feedUrl: DEFAULT_FEED_URL });
        setStatus("Reset local feed URL.");
      }
    } catch (err: any) {
      setStatus(err.message || "Reset failed");
    } finally {
      setBusy(false);
    }
  };

  const handleClaim = async () => {
    if (!token) return;
    setBusy(true);
    setStatus("");
    try {
      const data = await deviceApi.claimPairCode(token, pairCode.trim());
      setPairCode("");
      setStatus(data.message || "TV linked.");
      Alert.alert(
        "Roku linked",
        data.message || "Your TV will finish connecting shortly."
      );
    } catch (err: any) {
      setStatus(err.message || "Could not link TV");
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setStatus("Signed out.");
  };

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <ScrollView className="flex-1">
        <View className="px-6 py-6 flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="mr-4 bg-slate-800 p-2 rounded-xl border border-slate-700"
          >
            <Text className="text-white text-lg">←</Text>
          </TouchableOpacity>
          <Text className="text-3xl font-bold text-white">Settings</Text>
        </View>

        <View className="px-6 py-2 mb-2">
          {authLoading ? (
            <ActivityIndicator color="#14b8a6" />
          ) : isLoggedIn ? (
            <View className="flex-row items-center justify-between bg-slate-800 border border-slate-700 rounded-xl px-4 py-3">
              <View className="flex-1 pr-3">
                <Text className="text-slate-400 text-xs uppercase">Signed in</Text>
                <Text className="text-white font-medium">{user?.email}</Text>
              </View>
              <TouchableOpacity onPress={handleLogout}>
                <Text className="text-teal-400 font-semibold">Log out</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => router.push("/login")}
              className="bg-teal-800 py-4 rounded-xl"
            >
              <Text className="text-white text-center font-semibold">
                Sign in to sync feed & link Roku
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {status ? (
          <View className="mx-6 mb-2 rounded-xl border border-slate-600 bg-slate-800 px-3 py-2">
            <Text className="text-slate-200 text-sm">{status}</Text>
          </View>
        ) : null}

        <View className="px-6 py-4">
          <Text className="text-white text-xl font-semibold mb-2">Feed URL</Text>
          <Text className="text-slate-400 text-sm mb-4">
            {isLoggedIn
              ? "Saved to your account — linked Roku devices use this URL."
              : "Stored on this device only until you sign in."}
          </Text>

          {loadingAccount ? (
            <ActivityIndicator color="#14b8a6" className="mb-4" />
          ) : null}

          <TextInput
            value={feedUrl}
            onChangeText={setFeedUrl}
            placeholder={defaultFeedUrl}
            placeholderTextColor="#64748B"
            className="bg-slate-800 text-white px-4 py-4 rounded-xl border border-slate-700 mb-3"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          {effectiveFeedUrl ? (
            <Text className="text-slate-500 text-xs mb-3">
              Active: {effectiveFeedUrl}
            </Text>
          ) : null}

          <View className="flex-row gap-3">
            <TouchableOpacity
              onPress={handleReset}
              disabled={busy}
              className="flex-1 bg-slate-800 py-4 rounded-xl border border-slate-700"
            >
              <Text className="text-white text-center font-semibold">Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              disabled={busy}
              className="flex-1 bg-blue-600 py-4 rounded-xl"
            >
              <Text className="text-white text-center font-semibold">
                {busy ? "…" : "Save"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {isLoggedIn ? (
          <View className="px-6 py-4 mt-2">
            <Text className="text-white text-xl font-semibold mb-2">
              Link a Roku
            </Text>
            <Text className="text-slate-400 text-sm mb-4">
              On the TV, open Feed Settings (*), choose Link Web Account, then
              enter the 6-digit code here.
            </Text>
            <TextInput
              value={pairCode}
              onChangeText={(v) => setPairCode(v.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="123456"
              placeholderTextColor="#64748B"
              className="bg-slate-800 text-white px-4 py-4 rounded-xl border border-slate-700 mb-3 tracking-widest text-lg"
            />
            <TouchableOpacity
              onPress={handleClaim}
              disabled={busy || pairCode.length !== 6}
              className="bg-slate-100 py-4 rounded-xl"
            >
              <Text className="text-slate-900 text-center font-semibold">
                Link TV
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View className="px-6 py-8 mt-4">
          <View className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <Text className="text-slate-400 text-center text-sm">
              We Like Sports · Expo (iOS / Android)
            </Text>
            <Text className="text-slate-500 text-center text-xs mt-2">
              Web settings live in the separate Vite frontend/
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

import { useEffect, useState } from "react";
import { View, Text, SafeAreaView, ActivityIndicator } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { authApi } from "../../lib/api";
import { useAuth } from "../../contexts/AuthContext";

export default function VerifyMagicLinkScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { setSession } = useAuth();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setError("Missing token");
        return;
      }
      try {
        const data = await authApi.verifyMagicLink(String(token));
        if (cancelled) return;
        await setSession(data.user, data.accessToken);
        router.replace("/settings");
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || "Invalid or expired link");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, setSession]);

  return (
    <SafeAreaView className="flex-1 bg-slate-900 items-center justify-center px-6">
      {error ? (
        <View>
          <Text className="text-rose-300 text-center mb-4">{error}</Text>
          <Text
            className="text-teal-400 text-center"
            onPress={() => router.replace("/login")}
          >
            Back to sign in
          </Text>
        </View>
      ) : (
        <>
          <ActivityIndicator color="#14b8a6" size="large" />
          <Text className="text-slate-300 mt-4">Signing you in…</Text>
        </>
      )}
    </SafeAreaView>
  );
}

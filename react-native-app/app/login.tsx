import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { authApi } from "../lib/api";
import { useAuth } from "../contexts/AuthContext";

export default function LoginScreen() {
  const { setSession, isLoggedIn, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && isLoggedIn) {
      router.replace("/settings");
    }
  }, [loading, isLoggedIn]);

  const requestCode = async () => {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const data = await authApi.requestMagicLink(email.trim());
      setMessage(data.message || "Check your email for a code or magic link.");
      setStep("code");
    } catch (err: any) {
      setError(err.message || "Could not send login code");
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    setError("");
    setBusy(true);
    try {
      const data = await authApi.verifyMagicCode(email.trim(), code.trim());
      await setSession(data.user, data.accessToken);
      router.replace("/settings");
    } catch (err: any) {
      setError(err.message || "Invalid or expired code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-slate-900">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 px-6 justify-center"
      >
        <Text className="text-teal-400 text-sm font-semibold uppercase tracking-wide mb-2">
          Account
        </Text>
        <Text className="text-white text-3xl font-bold mb-2">Sign in</Text>
        <Text className="text-slate-400 text-sm mb-8">
          Use a magic link or 6-digit code — no password required. Same account
          powers your Roku feed sync.
        </Text>

        {error ? (
          <View className="mb-4 rounded-xl border border-rose-700 bg-rose-950 px-3 py-2">
            <Text className="text-rose-200 text-sm">{error}</Text>
          </View>
        ) : null}
        {message ? (
          <View className="mb-4 rounded-xl border border-emerald-700 bg-emerald-950 px-3 py-2">
            <Text className="text-emerald-200 text-sm">{message}</Text>
          </View>
        ) : null}

        <Text className="text-slate-300 text-sm mb-2">Email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder="you@example.com"
          placeholderTextColor="#64748B"
          editable={step === "email" || !busy}
          className="bg-slate-800 text-white px-4 py-4 rounded-xl border border-slate-700 mb-4"
        />

        {step === "code" ? (
          <>
            <Text className="text-slate-300 text-sm mb-2">6-digit code</Text>
            <TextInput
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="123456"
              placeholderTextColor="#64748B"
              className="bg-slate-800 text-white px-4 py-4 rounded-xl border border-slate-700 mb-4 tracking-widest text-lg"
            />
          </>
        ) : null}

        <TouchableOpacity
          onPress={step === "email" ? requestCode : verifyCode}
          disabled={
            busy ||
            !email.trim() ||
            (step === "code" && code.length !== 6)
          }
          className="bg-teal-700 py-4 rounded-xl mb-3"
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text className="text-white text-center font-semibold">
              {step === "email" ? "Email me a code" : "Verify and continue"}
            </Text>
          )}
        </TouchableOpacity>

        {step === "code" ? (
          <TouchableOpacity onPress={() => setStep("email")} className="py-2">
            <Text className="text-slate-400 text-center text-sm">
              Use a different email
            </Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity onPress={() => router.back()} className="py-4 mt-4">
          <Text className="text-slate-500 text-center text-sm">Back</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

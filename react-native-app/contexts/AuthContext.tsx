import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { authApi, PublicUser } from "../lib/api";

const TOKEN_KEY = "authAccessToken";

type AuthContextValue = {
  user: PublicUser | null;
  token: string | null;
  loading: boolean;
  isLoggedIn: boolean;
  checkAuth: () => Promise<PublicUser | null>;
  setSession: (user: PublicUser, accessToken: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const setSession = useCallback(async (nextUser: PublicUser, accessToken: string) => {
    setUser(nextUser);
    setToken(accessToken);
    await AsyncStorage.setItem(TOKEN_KEY, accessToken);
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const stored = await AsyncStorage.getItem(TOKEN_KEY);
      if (!stored) {
        setUser(null);
        setToken(null);
        return null;
      }
      const data = await authApi.me(stored);
      setToken(stored);
      setUser(data.user || null);
      return data.user || null;
    } catch {
      setUser(null);
      setToken(null);
      await AsyncStorage.removeItem(TOKEN_KEY);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout(token);
    } catch {
      // ignore
    }
    setUser(null);
    setToken(null);
    await AsyncStorage.removeItem(TOKEN_KEY);
  }, [token]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        isLoggedIn: Boolean(user && token),
        checkAuth,
        setSession,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

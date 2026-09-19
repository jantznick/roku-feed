const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ||
  "http://localhost:3001";

export function getApiBase() {
  return API_BASE;
}

type ApiOptions = {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
};

export async function apiFetch(path: string, options: ApiOptions = {}) {
  const { method = "GET", body, token, headers = {} } = options;
  const config: RequestInit = {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    config.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, config);
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = new Error(data?.error || data?.message || "Request failed") as Error & {
      status?: number;
      code?: string;
      data?: unknown;
    };
    err.status = response.status;
    err.code = data?.code;
    err.data = data;
    throw err;
  }

  return { response, data };
}

export type PublicUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  feedUrl: string | null;
  effectiveFeedUrl?: string;
  defaultFeedUrl?: string;
};

export const authApi = {
  async me(token: string | null) {
    const { data } = await apiFetch("/auth/me", { token });
    return data as { ok: boolean; user: PublicUser };
  },
  async logout(token: string | null) {
    const { data } = await apiFetch("/auth/logout", { method: "POST", token });
    return data;
  },
  async requestMagicLink(email: string, intent?: string) {
    const { data } = await apiFetch("/auth/magic-link/request", {
      method: "POST",
      body: intent ? { email, intent } : { email },
    });
    return data;
  },
  async verifyMagicLink(token: string) {
    const { data } = await apiFetch(
      `/auth/magic-link/verify?token=${encodeURIComponent(token)}`
    );
    return data as { ok: boolean; user: PublicUser; accessToken: string };
  },
  async verifyMagicCode(email: string, code: string) {
    const { data } = await apiFetch("/auth/magic-code/verify", {
      method: "POST",
      body: { email, code },
    });
    return data as { ok: boolean; user: PublicUser; accessToken: string };
  },
};

export const settingsApi = {
  async get(token: string | null) {
    const { data } = await apiFetch("/user/settings", { token });
    return data as {
      ok: boolean;
      settings: {
        feedUrl: string | null;
        effectiveFeedUrl: string;
        defaultFeedUrl: string;
      };
    };
  },
  async update(token: string | null, feedUrl: string) {
    const { data } = await apiFetch("/user/settings", {
      method: "PUT",
      token,
      body: { feedUrl },
    });
    return data;
  },
};

export const deviceApi = {
  async claimPairCode(token: string | null, code: string) {
    const { data } = await apiFetch("/device/pair/claim", {
      method: "POST",
      token,
      body: { code },
    });
    return data as { ok: boolean; message?: string; deviceId?: string };
  },
};

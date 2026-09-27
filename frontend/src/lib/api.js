const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";

export function getApiBase() {
  return API_BASE;
}

/**
 * fetch wrapper that always sends session cookies (feed.sid).
 */
export async function apiFetch(path, options = {}) {
  const { headers, body, ...rest } = options;
  const config = {
    credentials: "include",
    ...rest,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers
    }
  };
  if (body !== undefined && typeof body !== "string") {
    config.body = JSON.stringify(body);
  } else if (body !== undefined) {
    config.body = body;
  }

  const response = await fetch(`${API_BASE}${path}`, config);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const err = new Error(data?.error || data?.message || "Request failed");
    err.status = response.status;
    err.code = data?.code;
    err.data = data;
    throw err;
  }

  return { response, data };
}

export const authApi = {
  async register(email, password) {
    const { data } = await apiFetch("/auth/register", {
      method: "POST",
      body: { email, password }
    });
    return data;
  },
  async login(email, password) {
    const { data } = await apiFetch("/auth/login", {
      method: "POST",
      body: { email, password }
    });
    return data;
  },
  async logout() {
    const { data } = await apiFetch("/auth/logout", { method: "POST" });
    return data;
  },
  async me() {
    const { data } = await apiFetch("/auth/me");
    return data;
  },
  async requestMagicLink(email, intent) {
    const { data } = await apiFetch("/auth/magic-link/request", {
      method: "POST",
      body: intent ? { email, intent } : { email }
    });
    return data;
  },
  async verifyMagicLink(token) {
    const { data } = await apiFetch(
      `/auth/magic-link/verify?token=${encodeURIComponent(token)}`
    );
    return data;
  },
  async verifyMagicCode(email, code) {
    const { data } = await apiFetch("/auth/magic-code/verify", {
      method: "POST",
      body: { email, code }
    });
    return data;
  }
};

export const settingsApi = {
  async get() {
    const { data } = await apiFetch("/user/settings");
    return data;
  },
  async update(feedUrl) {
    const { data } = await apiFetch("/user/settings", {
      method: "PUT",
      body: { feedUrl }
    });
    return data;
  }
};

export const deviceApi = {
  async claimPairCode(code) {
    const { data } = await apiFetch("/device/pair/claim", {
      method: "POST",
      body: { code }
    });
    return data;
  }
};

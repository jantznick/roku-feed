import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { settingsApi } from "../lib/api";
import { useAuth } from "../context/AuthContext";

export default function SettingsPage() {
  const { user, logout, setUserFromAuth, checkAuth } = useAuth();
  const navigate = useNavigate();
  const [feedUrl, setFeedUrl] = useState("");
  const [defaultFeedUrl, setDefaultFeedUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await settingsApi.get();
      const settings = data.settings || {};
      setFeedUrl(settings.feedUrl ?? user?.feedUrl ?? "");
      setDefaultFeedUrl(settings.defaultFeedUrl ?? "");
    } catch (err) {
      setError(err.message || "Could not load settings");
      if (user?.feedUrl) {
        setFeedUrl(user.feedUrl);
      }
    } finally {
      setLoading(false);
    }
  }, [user?.feedUrl]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const data = await settingsApi.update(feedUrl.trim());
      const next = data.settings?.feedUrl ?? feedUrl.trim();
      setFeedUrl(next);
      if (data.settings?.defaultFeedUrl != null) {
        setDefaultFeedUrl(data.settings.defaultFeedUrl);
      }
      if (user) {
        setUserFromAuth({ ...user, feedUrl: next || null });
      }
      await checkAuth();
      setSuccess("Feed URL saved.");
    } catch (err) {
      setError(err.message || "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const data = await settingsApi.update("");
      const next = data.settings?.feedUrl ?? "";
      setFeedUrl(next);
      if (data.settings?.defaultFeedUrl != null) {
        setDefaultFeedUrl(data.settings.defaultFeedUrl);
      }
      if (user) {
        setUserFromAuth({ ...user, feedUrl: next || null });
      }
      await checkAuth();
      setSuccess("Reset to default feed URL.");
    } catch (err) {
      setError(err.message || "Could not reset feed URL");
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-800">Feed Settings</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Your feed URL</h1>
          <p className="mt-1 text-sm text-slate-600">
            Signed in as <span className="font-medium text-slate-800">{user?.email}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Log out
        </button>
      </header>

      {error ? (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {success}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-600">Loading settings…</p>
      ) : (
        <form
          onSubmit={handleSave}
          className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Custom feed URL</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-mono text-sm text-slate-900 outline-none ring-teal-600/30 transition focus:ring-2"
              type="url"
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              placeholder={defaultFeedUrl || "https://example.com/feed.json"}
              spellCheck={false}
            />
          </label>
          <p className="text-xs text-slate-500">
            Must be an absolute <code className="rounded bg-slate-100 px-1">http://</code> or{" "}
            <code className="rounded bg-slate-100 px-1">https://</code> URL. Leave empty and save, or
            use Reset, to use the default.
          </p>
          {defaultFeedUrl ? (
            <p className="text-xs text-slate-500">
              Default:{" "}
              <code className="break-all rounded bg-slate-100 px-1 py-0.5">{defaultFeedUrl}</code>
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-teal-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={saving}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reset to default
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

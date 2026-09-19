import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "../lib/api";
import { useAuth } from "../context/AuthContext";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage() {
  const { setUserFromAuth } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const handleRequestCode = async (event) => {
    event.preventDefault();
    setError("");
    setInfo("");
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError("Enter a valid email address.");
      return;
    }
    setLoading(true);
    try {
      await authApi.requestMagicLink(trimmed);
      setCodeSent(true);
      setCode("");
      setInfo(
        "Check your email for a six-digit code or click the magic link. If you don’t have an account yet, we’ll create one."
      );
    } catch (err) {
      setError(err.message || "Could not send magic link");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (event) => {
    event.preventDefault();
    setError("");
    setInfo("");
    const trimmed = email.trim();
    const digits = code.replace(/\D/g, "");
    if (digits.length !== 6) {
      setError("Enter the six-digit code from your email.");
      return;
    }
    setLoading(true);
    try {
      const data = await authApi.verifyMagicCode(trimmed, digits);
      setUserFromAuth(data.user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err.message || "Invalid or expired code");
    } finally {
      setLoading(false);
    }
  };

  const resetToEmail = () => {
    setCodeSent(false);
    setCode("");
    setError("");
    setInfo("");
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <header className="mb-8">
        <p className="text-sm font-medium uppercase tracking-wide text-teal-800">Feed Settings</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">Sign in</h1>
        <p className="mt-2 text-sm text-slate-600">
          Use a magic link or one-time code — no password required.
        </p>
      </header>

      {error ? (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      ) : null}
      {info ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {info}
        </div>
      ) : null}

      {!codeSent ? (
        <form onSubmit={handleRequestCode} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Email</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none ring-teal-600/30 transition focus:ring-2"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              autoFocus
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-teal-800 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Sending…" : "Send magic link"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerifyCode} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="text-sm text-slate-600">
            Code sent to <span className="font-medium text-slate-900">{email.trim()}</span>
          </div>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Six-digit code</span>
            <input
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-mono text-lg tracking-widest text-slate-900 outline-none ring-teal-600/30 transition focus:ring-2"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              autoFocus
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-teal-800 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Verifying…" : "Verify code"}
          </button>
          <button
            type="button"
            onClick={resetToEmail}
            className="w-full text-sm text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
          >
            Use a different email
          </button>
        </form>
      )}
    </div>
  );
}

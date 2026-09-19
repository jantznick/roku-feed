import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authApi } from "../lib/api";
import { useAuth } from "../context/AuthContext";

export default function VerifyMagicLinkPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setUserFromAuth } = useAuth();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setError("Missing verification token.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await authApi.verifyMagicLink(token);
        if (cancelled) return;
        setUserFromAuth(data.user);
        setDone(true);
        setTimeout(() => navigate("/", { replace: true }), 800);
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Magic link is invalid or expired.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, navigate, setUserFromAuth]);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-16">
      <h1 className="text-2xl font-semibold text-slate-900">Magic link sign-in</h1>
      {error ? (
        <p className="mt-4 text-sm text-rose-700">{error}</p>
      ) : done ? (
        <p className="mt-4 text-sm text-emerald-700">Signed in. Redirecting…</p>
      ) : (
        <p className="mt-4 text-sm text-slate-600">Verifying your link…</p>
      )}
      <Link to="/login" className="mt-6 text-sm font-medium text-teal-800 hover:underline">
        Back to sign in
      </Link>
    </div>
  );
}

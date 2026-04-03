import { useState } from "react";
import { loginWithEmail, loginWithGoogle } from "../auth";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleEmailLogin(event) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      await loginWithEmail(email, password);
      window.location.href = "/index.html";
    } catch (err) {
      setError(err.message || "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setError("");
    setLoading(true);
    try {
      await loginWithGoogle();
      window.location.href = "/index.html";
    } catch (err) {
      setError(err.message || "Google sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <header className="auth-brand">
          <div className="logo-dot" />
          <div>
            <p className="brand-title">ADA Vision</p>
            <p className="brand-subtitle">Smart ADA Compliance Platform</p>
          </div>
        </header>
        <h1 className="auth-heading">Sign in to continue</h1>
        <form className="auth-form" onSubmit={handleEmailLogin}>
          <label className="input-label">
            Work Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="inspector@agency.gov"
              required
            />
          </label>
          <label className="input-label">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
            />
          </label>
          {error && <p className="status-error">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
        <p className="auth-separator">or</p>
        <button className="btn btn-outline" onClick={handleGoogleLogin} disabled={loading}>
          Continue with Google
        </button>
        <p className="auth-footer">
          No account yet? <a href="/signup.html">Create one</a>
        </p>
      </section>
    </main>
  );
}

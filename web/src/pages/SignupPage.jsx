import { useState } from "react";
import { loginWithGoogle, signupWithEmail } from "../auth";

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSignUp(event) {
    event.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    try {
      await signupWithEmail(email, password);
      localStorage.setItem("adaVisionDisplayName", fullName.trim());
      window.location.href = "/index.html";
    } catch (err) {
      setError(err.message || "Unable to create account.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignUp() {
    setError("");
    setLoading(true);
    try {
      await loginWithGoogle();
      window.location.href = "/index.html";
    } catch (err) {
      setError(err.message || "Google sign up failed.");
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
        <h1 className="auth-heading">Create your account</h1>
        <form className="auth-form" onSubmit={handleSignUp}>
          <label className="input-label">
            Full Name
            <input
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Bilal Salman"
              required
            />
          </label>
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
              placeholder="Create password"
              required
            />
          </label>
          <label className="input-label">
            Confirm Password
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Confirm password"
              required
            />
          </label>
          {error && <p className="status-error">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>
        <p className="auth-separator">or</p>
        <button className="btn btn-outline" onClick={handleGoogleSignUp} disabled={loading}>
          Sign up with Google
        </button>
        <p className="auth-footer">
          Already have an account? <a href="/login.html">Sign in</a>
        </p>
      </section>
    </main>
  );
}

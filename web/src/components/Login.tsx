import { useState, type FormEvent } from "react";
import { checkToken, setToken } from "../api";

export function Login({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError("");
    const result = await checkToken(token);
    setBusy(false);
    if (result === "ok") {
      setToken(token);
      onDone();
    } else if (result === "wrong") {
      setError("That token isn't right. Compare it with API_TOKEN in backend/.env.");
    } else {
      setError("Can't reach the backend. Check that it's running on port 3100.");
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <h1>psytonik base</h1>
        <p>Enter the access token from backend/.env to view the camera.</p>
        <label htmlFor="token">Access token</label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={error ? "token-error" : undefined}
          aria-invalid={error ? true : undefined}
        />
        {error && (
          <p id="token-error" className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !value.trim()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </main>
  );
}

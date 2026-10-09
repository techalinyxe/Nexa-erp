import { useState, type FormEvent } from "react";
import { api, ApiError, NetworkError } from "../api";
import type { Session } from "../types";

export default function Login({ onLogin }: { onLogin: (session: Session) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>("POST", "/auth/login", { body: { email, password } });
      await onLogin(session);
    } catch (e) {
      if (e instanceof NetworkError) {
        setError("Connexion impossible : la première connexion nécessite un accès au serveur.");
      } else if (e instanceof ApiError && e.status === 401) {
        setError("E-mail ou mot de passe incorrect.");
      } else {
        setError("Une erreur est survenue. Réessayez.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <h1>Nexa</h1>
        <p className="muted">Connectez-vous pour accéder à votre espace de gestion.</p>
        <label>
          E-mail
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Mot de passe
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? "Connexion…" : "Se connecter"}</button>
      </form>
    </main>
  );
}

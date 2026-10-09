import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, NetworkError } from "../api";
import type { ManagedUser, Role, Session } from "../types";

export default function UsersPage({ session }: { session: Session }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", full_name: "", password: "", role: "vendeur" });
  const token = session.token;

  const load = useCallback(async () => {
    try {
      const [loadedUsers, loadedRoles] = await Promise.all([
        api<ManagedUser[]>("GET", "/users", { token }),
        api<Role[]>("GET", "/roles", { token }),
      ]);
      setUsers(loadedUsers);
      setRoles(loadedRoles);
      setError(null);
    } catch (e) {
      setError(e instanceof NetworkError
        ? "La gestion des utilisateurs nécessite une connexion au serveur."
        : e instanceof ApiError ? e.message : "Chargement impossible.");
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof NetworkError ? "Serveur injoignable." : e instanceof ApiError ? e.message : "Action impossible.");
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api("POST", "/users", { token, body: form });
      setForm({ email: "", full_name: "", password: "", role: form.role });
    });
  }

  return (
    <>
      <header className="page-head"><h2>Utilisateurs</h2></header>
      <p className="muted">La gestion des comptes se fait uniquement en ligne, pour que les accès soient appliqués immédiatement.</p>

      <form className="panel form-grid" onSubmit={create}>
        <h3>Nouvel utilisateur</h3>
        <label>E-mail<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Nom complet<input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></label>
        <label>Mot de passe (10 caractères minimum)<input type="password" autoComplete="new-password" minLength={10} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label>Rôle
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {roles.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </label>
        <div className="actions"><button className="primary">Créer l'utilisateur</button></div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>État</th><th /></tr></thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === session.user.id;
              return (
                <tr key={u.id}>
                  <td>{u.full_name}</td><td>{u.email}</td>
                  <td>
                    <select value={u.role} disabled={self} aria-label={`Rôle de ${u.full_name}`}
                      onChange={(e) => void run(() => api("PATCH", `/users/${u.id}`, { token, body: { role: e.target.value } }))}>
                      {roles.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
                    </select>
                  </td>
                  <td>{u.active ? "Actif" : "Désactivé"}</td>
                  <td>
                    <button disabled={self} onClick={() => void run(() => api("PATCH", `/users/${u.id}`, { token, body: { active: !u.active } }))}>
                      {u.active ? "Désactiver" : "Réactiver"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

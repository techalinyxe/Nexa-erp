import { useEffect, useState } from "react";
import { clearLocalData, db } from "./db";
import Login from "./components/Login";
import SyncBar from "./components/SyncBar";
import ItemsPage from "./pages/ItemsPage";
import SalesPage from "./pages/SalesPage";
import StockPage from "./pages/StockPage";
import UsersPage from "./pages/UsersPage";
import { can, clearSession, getSession, saveSession } from "./session";
import { startAutoSync } from "./sync";
import type { Session } from "./types";

type TabId = "items" | "stock" | "sales" | "users";

const LAST_USER_KEY = "nexa.lastUser";

export default function App() {
  const [session, setSession] = useState<Session | null>(() => getSession());
  const [tab, setTab] = useState<TabId | null>(null);

  useEffect(() => {
    if (!session) return;
    return startAutoSync();
  }, [session]);

  async function handleLogin(next: Session) {
    // Un autre utilisateur ne doit jamais voir les données locales du précédent.
    const last = localStorage.getItem(LAST_USER_KEY);
    if (last && last !== next.user.id) await clearLocalData();
    localStorage.setItem(LAST_USER_KEY, next.user.id);
    saveSession(next);
    setTab(null);
    setSession(next);
  }

  async function logout() {
    const pending = await db.outbox.where("status").equals("pending").count();
    if (
      pending > 0 &&
      !window.confirm(
        `${pending} opération(s) ne sont pas encore synchronisées. Elles resteront sur cet appareil jusqu'à votre prochaine connexion. Se déconnecter ?`,
      )
    ) {
      return;
    }
    if (pending === 0) await clearLocalData();
    clearSession();
    setSession(null);
  }

  if (!session) return <Login onLogin={handleLogin} />;

  const tabs: { id: TabId; label: string; allowed: boolean }[] = [
    { id: "items", label: "Articles", allowed: can(session, "stock.read") || can(session, "sales.read") },
    { id: "stock", label: "Stock", allowed: can(session, "stock.read") },
    { id: "sales", label: "Ventes", allowed: can(session, "sales.read") },
    { id: "users", label: "Utilisateurs", allowed: can(session, "users.manage") },
  ];
  const allowedTabs = tabs.filter((t) => t.allowed);
  const current = allowedTabs.find((t) => t.id === tab)?.id ?? allowedTabs[0]?.id;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">Nexa</div>
        <nav aria-label="Modules">
          {allowedTabs.map((t) => (
            <button key={t.id} className={t.id === current ? "nav active" : "nav"} aria-current={t.id === current ? "page" : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="who">
          <strong>{session.user.full_name}</strong>
          <small>{session.user.role}</small>
          <button onClick={() => void logout()}>Se déconnecter</button>
        </div>
      </aside>
      <main className="content">
        <SyncBar onReconnect={() => void logout()} />
        {current === "items" && <ItemsPage canWrite={can(session, "stock.write")} />}
        {current === "stock" && <StockPage canWrite={can(session, "stock.write")} />}
        {current === "sales" && <SalesPage canWrite={can(session, "sales.write")} />}
        {current === "users" && <UsersPage session={session} />}
        {!current && <p className="empty">Votre rôle ne donne accès à aucun module. Contactez un administrateur.</p>}
      </main>
    </div>
  );
}

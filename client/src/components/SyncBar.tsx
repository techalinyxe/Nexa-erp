import { useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { getSyncStatus, subscribeSync, syncNow } from "../sync";
import type { OpType } from "../types";

const OP_LABELS: Record<OpType, string> = {
  "warehouse.upsert": "Entrepôt",
  "item.upsert": "Article",
  "customer.upsert": "Client",
  "stock.adjust": "Ajustement de stock",
  "sale.create": "Vente",
};

export default function SyncBar({ onReconnect }: { onReconnect: () => void }) {
  const status = useSyncExternalStore(subscribeSync, getSyncStatus);
  const outbox = useLiveQuery(() => db.outbox.toArray(), []) ?? [];
  const pending = outbox.filter((op) => op.status === "pending").length;
  const rejected = outbox.filter((op) => op.status === "rejected");

  return (
    <section className="syncbar" aria-label="Synchronisation">
      <div className="syncbar-row">
        <span className={status.online ? "chip ok" : "chip off"}>{status.online ? "En ligne" : "Hors ligne"}</span>
        {pending > 0 && (
          <span className="chip wait">
            {pending} opération{pending > 1 ? "s" : ""} en attente d'envoi
          </span>
        )}
        {status.lastSyncAt && (
          <span className="muted small">
            Dernière synchronisation à {new Date(status.lastSyncAt).toLocaleTimeString("fr-FR", { timeStyle: "short" })}
          </span>
        )}
        <button onClick={() => void syncNow()} disabled={status.running || !status.online}>
          {status.running ? "Synchronisation…" : "Synchroniser"}
        </button>
      </div>
      {status.error && (
        <p className="error" role="alert">
          {status.error}{" "}
          {status.authExpired && <button onClick={onReconnect}>Se reconnecter</button>}
        </p>
      )}
      {rejected.length > 0 && (
        <details className="rejected" open>
          <summary>{rejected.length} opération{rejected.length > 1 ? "s" : ""} refusée{rejected.length > 1 ? "s" : ""} par le serveur</summary>
          <ul>
            {rejected.map((op) => (
              <li key={op.op_id}>
                <strong>{OP_LABELS[op.type]}</strong> : {op.error}. Les modifications locales correspondantes ont été annulées.{" "}
                <button onClick={() => void db.outbox.delete(op.op_id)}>Retirer</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

import { api, ApiError, NetworkError } from "./api";
import { db } from "./db";
import { getSession } from "./session";
import type { OutboxOp } from "./types";

// ---------------------------------------------------------------------------
// État de synchronisation observable par l'interface
// ---------------------------------------------------------------------------

export type SyncStatus = {
  online: boolean;
  running: boolean;
  lastSyncAt: number | null;
  error: string | null;
  authExpired: boolean;
};

let status: SyncStatus = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  running: false,
  lastSyncAt: null,
  error: null,
  authExpired: false,
};
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribeSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSyncStatus(): SyncStatus {
  return status;
}

// ---------------------------------------------------------------------------
// Envoi des opérations en attente
// ---------------------------------------------------------------------------

type PushResult = {
  op_id: string;
  status: "applied" | "duplicate" | "rejected" | "error";
  error?: string;
};

const PUSH_BATCH_SIZE = 100;

/** Annule l'effet local d'une opération refusée par le serveur. */
async function revertLocal(op: OutboxOp): Promise<void> {
  const id = String(op.payload.id);
  switch (op.type) {
    case "sale.create":
      await db.sales_orders.delete(id);
      break;
    case "stock.adjust":
      await db.stock_movements.delete(id);
      break;
    case "item.upsert":
      if (op.before) await db.items.put(op.before as never);
      else await db.items.delete(id);
      break;
    case "warehouse.upsert":
      if (op.before) await db.warehouses.put(op.before as never);
      else await db.warehouses.delete(id);
      break;
    case "customer.upsert":
      if (op.before) await db.customers.put(op.before as never);
      else await db.customers.delete(id);
      break;
  }
}

async function pushPending(token: string): Promise<void> {
  for (;;) {
    const pending = await db.outbox.where("status").equals("pending").sortBy("created_at");
    if (pending.length === 0) return;

    const batch = pending.slice(0, PUSH_BATCH_SIZE);
    const response = await api<{ results: PushResult[] }>("POST", "/sync/push", {
      token,
      body: { ops: batch.map(({ op_id, type, payload }) => ({ op_id, type, payload })) },
    });

    let progressed = false;
    let serverError = false;
    for (const result of response.results) {
      const op = batch.find((candidate) => candidate.op_id === result.op_id);
      if (!op) continue;
      if (result.status === "applied" || result.status === "duplicate") {
        await db.outbox.update(op.op_id, { status: "applied" });
        progressed = true;
      } else if (result.status === "rejected") {
        await db.transaction("rw", [db.outbox, db.items, db.warehouses, db.customers, db.sales_orders, db.stock_movements], async () => {
          await revertLocal(op);
          await db.outbox.update(op.op_id, {
            status: "rejected",
            error: result.error ?? "Refusée par le serveur",
          });
        });
        progressed = true;
      } else {
        serverError = true;
      }
    }
    if (serverError) {
      throw new Error("Le serveur a signalé une erreur interne ; nouvelle tentative plus tard.");
    }
    if (!progressed) throw new Error("Réponse de synchronisation inattendue.");
  }
}

// ---------------------------------------------------------------------------
// Lecture des changements du serveur
// ---------------------------------------------------------------------------

type Change = { seq: number; entity: string; data: Record<string, unknown> & { id: string } };
type PullPage = { changes: Change[]; cursor: number; has_more: boolean };

async function applyChanges(page: PullPage): Promise<void> {
  await db.transaction(
    "rw",
    [db.items, db.warehouses, db.customers, db.sales_orders, db.stock_movements, db.anomalies, db.outbox, db.meta],
    async () => {
      // Une modification locale pas encore envoyée l'emporte sur la version du serveur.
      const pendingIds = new Set(
        (await db.outbox.where("status").equals("pending").toArray()).map((op) => String(op.payload.id)),
      );
      const rowsFor = (entity: string) =>
        page.changes
          .filter((change) => change.entity === entity && !pendingIds.has(change.data.id))
          .map((change) => change.data);

      await db.items.bulkPut(rowsFor("item") as never[]);
      await db.warehouses.bulkPut(rowsFor("warehouse") as never[]);
      await db.customers.bulkPut(rowsFor("customer") as never[]);
      await db.sales_orders.bulkPut(rowsFor("sales_order") as never[]);
      await db.stock_movements.bulkPut(rowsFor("stock_movement") as never[]);
      await db.anomalies.bulkPut(rowsFor("anomaly") as never[]);
      await db.meta.put({ key: "cursor", value: page.cursor });

      if (!page.has_more) {
        // Les opérations acceptées sont désormais reflétées par les données lues.
        await db.outbox.where("status").equals("applied").delete();
      }
    },
  );
}

async function pullAll(token: string): Promise<void> {
  const stored = await db.meta.get("cursor");
  let cursor = typeof stored?.value === "number" ? stored.value : 0;
  for (;;) {
    const page = await api<PullPage>("GET", `/sync/pull?cursor=${cursor}`, { token });
    await applyChanges(page);
    cursor = page.cursor;
    if (!page.has_more) return;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

let inflight: Promise<void> | null = null;

async function run(): Promise<void> {
  const session = getSession();
  if (!session) return;
  setStatus({ running: true, error: null });
  try {
    await pushPending(session.token);
    await pullAll(session.token);
    setStatus({ lastSyncAt: Date.now(), authExpired: false, online: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setStatus({
        authExpired: true,
        error: "Session expirée : reconnectez-vous pour synchroniser.",
      });
    } else if (error instanceof NetworkError) {
      setStatus({ online: false, error: null });
    } else {
      setStatus({ error: error instanceof Error ? error.message : "Erreur de synchronisation" });
    }
  } finally {
    setStatus({ running: false });
  }
}

export function syncNow(): Promise<void> {
  if (!inflight) {
    inflight = run().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function syncSoon(): void {
  if (navigator.onLine) void syncNow();
}

const SYNC_INTERVAL_MS = 30_000;

/** Démarre la synchronisation automatique ; renvoie la fonction d'arrêt. */
export function startAutoSync(): () => void {
  const onOnline = () => {
    setStatus({ online: true });
    void syncNow();
  };
  const onOffline = () => setStatus({ online: false });
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  const timer = window.setInterval(() => {
    if (navigator.onLine) void syncNow();
  }, SYNC_INTERVAL_MS);
  void syncNow();
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    window.clearInterval(timer);
  };
}

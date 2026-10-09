// Test d'intégration : nécessite un serveur lancé.
//   TEST_API_URL=http://localhost:8080 ADMIN_EMAIL=… ADMIN_PASSWORD=… npm test
import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const apiUrl = process.env.TEST_API_URL;
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const enabled = Boolean(apiUrl && email && password);

describe.skipIf(!enabled)("synchronisation hors ligne", () => {
  const realFetch = globalThis.fetch;
  let mods: {
    db: typeof import("./db").db;
    ops: typeof import("./ops");
    sync: typeof import("./sync");
    stock: typeof import("./stock");
  };

  beforeAll(async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubEnv("VITE_API_URL", apiUrl!);

    const { api } = await import("./api");
    const session = await api<import("./types").Session>("POST", "/auth/login", { body: { email, password } });
    (await import("./session")).saveSession(session);

    mods = {
      db: (await import("./db")).db,
      ops: await import("./ops"),
      sync: await import("./sync"),
      stock: await import("./stock"),
    };
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("met les opérations en file hors ligne puis les synchronise", async () => {
    const { db, ops, sync, stock } = mods;
    const suffix = crypto.randomUUID().slice(0, 8);

    // Hors ligne : toute requête réseau échoue.
    globalThis.fetch = (() => Promise.reject(new TypeError("réseau coupé"))) as typeof fetch;

    await ops.saveWarehouse({ name: `Dépôt ${suffix}` });
    await ops.saveItem({ sku: `SKU-${suffix}`, name: `Article ${suffix}`, unit: "unité", price_cents: 500, active: true });
    const warehouse = (await db.warehouses.toArray())[0];
    const item = (await db.items.toArray())[0];
    await ops.adjustStock({ item_id: item.id, warehouse_id: warehouse.id, qty_change: 5, reason: "Stock initial" });
    const customerId = await ops.saveCustomer({ name: `Client ${suffix}` });
    await ops.createSale({
      customer_id: customerId,
      warehouse_id: warehouse.id,
      lines: [{ item_id: item.id, qty: 7, unit_price_cents: 500 }],
    });

    await sync.syncNow();
    expect(sync.getSyncStatus().online).toBe(false);
    expect(await db.outbox.where("status").equals("pending").count()).toBe(5);

    // Stock local : +5 - 7 = -2 (vente acceptée, anomalie attendue ensuite)
    const offlineBalances = stock.computeBalances(await db.stock_movements.toArray(), await db.outbox.toArray());
    expect(offlineBalances.get(stock.balanceKey(item.id, warehouse.id))).toBe(-2);

    // Retour du réseau.
    globalThis.fetch = realFetch;
    await sync.syncNow();

    expect(sync.getSyncStatus().error).toBeNull();
    expect(await db.outbox.count()).toBe(0);
    const order = (await db.sales_orders.toArray())[0];
    expect(order.number).toMatch(/^VE-\d{6}$/);
    expect((await db.anomalies.toArray()).length).toBeGreaterThanOrEqual(1);

    // Pas de double comptage après synchronisation.
    const onlineBalances = stock.computeBalances(await db.stock_movements.toArray(), await db.outbox.toArray());
    expect(onlineBalances.get(stock.balanceKey(item.id, warehouse.id))).toBe(-2);

    // Un SKU en double est refusé et l'effet local est annulé.
    const itemsBefore = await db.items.count();
    await ops.saveItem({ sku: `SKU-${suffix}`, name: "Doublon", unit: "unité", price_cents: 100, active: true });
    expect(await db.items.count()).toBe(itemsBefore + 1);
    await sync.syncNow();
    expect(await db.items.count()).toBe(itemsBefore);
    const rejected = await db.outbox.where("status").equals("rejected").toArray();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].error).toMatch(/existante/);
  });
});

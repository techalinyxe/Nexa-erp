// Test de bout en bout du serveur : node scripts/smoke.mjs
// Variables : API_URL (défaut http://localhost:8080), ADMIN_EMAIL, ADMIN_PASSWORD
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const API = process.env.API_URL ?? "http://localhost:8080";
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error("ADMIN_EMAIL et ADMIN_PASSWORD sont requis");
  process.exit(1);
}

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const op = (type, payload) => ({ op_id: randomUUID(), type, payload });

const login = await call("POST", "/auth/login", null, { email, password });
assert.equal(login.status, 200, "connexion admin");
const admin = login.json.token;

assert.equal((await call("POST", "/auth/login", null, { email, password: "mauvais-mot-de-passe" })).status, 401);
assert.equal((await call("GET", "/users", null)).status, 401);

// Utilisateurs et permissions
const sellerEmail = `vendeur-${Date.now()}@example.com`;
const sellerPassword = "mot-de-passe-vendeur-1";
const created = await call("POST", "/users", admin, { email: sellerEmail, full_name: "Vendeur Test", password: sellerPassword, role: "vendeur" });
assert.equal(created.status, 200, "création du vendeur");
const seller = (await call("POST", "/auth/login", null, { email: sellerEmail, password: sellerPassword })).json.token;
assert.equal((await call("GET", "/users", seller)).status, 403, "un vendeur ne gère pas les utilisateurs");

// Données de référence
const warehouseId = randomUUID();
const itemId = randomUUID();
const customerId = randomUUID();
const setup = [
  op("warehouse.upsert", { id: warehouseId, name: `Entrepôt ${warehouseId.slice(0, 8)}` }),
  op("item.upsert", { id: itemId, sku: `SKU-${itemId.slice(0, 8)}`, name: "Article test", unit: "unité", price_cents: 1250, active: true }),
  op("customer.upsert", { id: customerId, name: "Client Test", email: null, phone: null }),
  op("stock.adjust", { id: randomUUID(), item_id: itemId, warehouse_id: warehouseId, qty_change: 5, reason: "Stock initial" }),
];
const pushed = await call("POST", "/sync/push", admin, { ops: setup });
assert.deepEqual(pushed.json.results.map((r) => r.status), ["applied", "applied", "applied", "applied"]);

// Idempotence : le même op_id rejoué est ignoré
const replay = await call("POST", "/sync/push", admin, { ops: [setup[3]] });
assert.equal(replay.json.results[0].status, "duplicate");

// Le vendeur peut vendre mais pas ajuster le stock
const denied = await call("POST", "/sync/push", seller, { ops: [op("stock.adjust", { id: randomUUID(), item_id: itemId, warehouse_id: warehouseId, qty_change: 1, reason: "Interdit" })] });
assert.equal(denied.json.results[0].status, "rejected");

// Deux ventes hors ligne : 3 + 4 = 7 articles pour 5 en stock -> anomalie de stock négatif
const sale = (qty) => op("sale.create", {
  id: randomUUID(), customer_id: customerId, warehouse_id: warehouseId,
  ordered_at: new Date().toISOString(),
  lines: [{ id: randomUUID(), item_id: itemId, qty, unit_price_cents: 1250 }],
});
const sales = await call("POST", "/sync/push", seller, { ops: [sale(3), sale(4)] });
assert.deepEqual(sales.json.results.map((r) => r.status), ["applied", "applied"], "les ventes sont acceptées");

// Référence inconnue -> rejet définitif
const bad = await call("POST", "/sync/push", seller, { ops: [op("sale.create", {
  id: randomUUID(), customer_id: randomUUID(), warehouse_id: warehouseId,
  ordered_at: new Date().toISOString(),
  lines: [{ id: randomUUID(), item_id: itemId, qty: 1, unit_price_cents: 100 }],
})] });
assert.equal(bad.json.results[0].status, "rejected");

// Lecture incrémentale
let cursor = 0, changes = [];
for (;;) {
  const page = await call("GET", `/sync/pull?cursor=${cursor}&limit=2`, seller);
  assert.equal(page.status, 200);
  changes.push(...page.json.changes);
  cursor = page.json.cursor;
  if (!page.json.has_more) break;
}
const count = (entity) => changes.filter((c) => c.entity === entity).length;
assert.ok(count("sales_order") >= 2, "commandes synchronisées");
assert.ok(count("anomaly") >= 1, "anomalie de stock négatif signalée");
const order = changes.find((c) => c.entity === "sales_order");
assert.match(order.data.number, /^VE-\d{6}$/, "numéro attribué par le serveur");
assert.equal(order.data.lines.length, 1);

const again = await call("GET", `/sync/pull?cursor=${cursor}`, seller);
assert.equal(again.json.changes.length, 0, "rien de nouveau après le curseur");

console.log("OK : tous les contrôles ont réussi");

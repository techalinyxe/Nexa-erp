import { useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { formatDate, formatMoney } from "../format";
import { createSale, saveCustomer } from "../ops";
import { balanceKey, useBalances } from "../stock";

type DraftLine = { item_id: string; qty: string };

export default function SalesPage({ canWrite }: { canWrite: boolean }) {
  const orders = useLiveQuery(() => db.sales_orders.orderBy("ordered_at").reverse().toArray(), []) ?? [];
  const customers = useLiveQuery(() => db.customers.orderBy("name").toArray(), []) ?? [];
  const items = useLiveQuery(() => db.items.orderBy("name").toArray(), []) ?? [];
  const warehouses = useLiveQuery(() => db.warehouses.orderBy("name").toArray(), []) ?? [];
  const balances = useBalances();

  const [customerId, setCustomerId] = useState("");
  const [newCustomer, setNewCustomer] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ item_id: "", qty: "1" }]);
  const [error, setError] = useState<string | null>(null);

  const itemById = new Map(items.map((item) => [item.id, item]));
  const customerName = (id: string) => customers.find((c) => c.id === id)?.name ?? "Client inconnu";

  const parsed = lines.map((line) => ({ item: itemById.get(line.item_id), qty: Number(line.qty) }));
  const validLines = parsed.filter((l) => l.item && Number.isInteger(l.qty) && l.qty > 0);
  const total = validLines.reduce((sum, l) => sum + l.qty * (l.item?.price_cents ?? 0), 0);

  const warnings: string[] = [];
  if (warehouseId) {
    const requested = new Map<string, number>();
    for (const l of validLines) requested.set(l.item!.id, (requested.get(l.item!.id) ?? 0) + l.qty);
    for (const [id, qty] of requested) {
      const available = balances.get(balanceKey(id, warehouseId)) ?? 0;
      if (qty > available) warnings.push(`${itemById.get(id)?.name} : ${qty} demandé, ${available} en stock localement.`);
    }
  }

  async function addCustomer() {
    const name = newCustomer.trim();
    if (!name) return;
    setCustomerId(await saveCustomer({ name }));
    setNewCustomer("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!customerId || !warehouseId) return setError("Choisissez un client et un entrepôt.");
    if (validLines.length === 0 || validLines.length !== lines.length) {
      return setError("Chaque ligne doit avoir un article et une quantité entière positive.");
    }
    await createSale({
      customer_id: customerId,
      warehouse_id: warehouseId,
      lines: validLines.map((l) => ({ item_id: l.item!.id, qty: l.qty, unit_price_cents: l.item!.price_cents })),
    });
    setLines([{ item_id: "", qty: "1" }]);
    setError(null);
  }

  return (
    <>
      <header className="page-head"><h2>Ventes</h2></header>

      {canWrite && (
        <form className="panel form-grid" onSubmit={submit}>
          <h3>Nouvelle vente</h3>
          <label>Client
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Choisir…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div className="inline">
            <label>Nouveau client<input value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} /></label>
            <button type="button" onClick={() => void addCustomer()}>Ajouter le client</button>
          </div>
          <label>Entrepôt de sortie
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">Choisir…</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>

          {lines.map((line, index) => (
            <div className="inline" key={index}>
              <label>Article
                <select value={line.item_id} onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, item_id: e.target.value } : l)))}>
                  <option value="">Choisir…</option>
                  {items.filter((i) => i.active).map((item) => <option key={item.id} value={item.id}>{item.name} · {formatMoney(item.price_cents)}</option>)}
                </select>
              </label>
              <label>Quantité
                <input inputMode="numeric" value={line.qty} onChange={(e) => setLines(lines.map((l, i) => (i === index ? { ...l, qty: e.target.value } : l)))} />
              </label>
              {lines.length > 1 && <button type="button" onClick={() => setLines(lines.filter((_, i) => i !== index))}>Retirer la ligne</button>}
            </div>
          ))}
          <div className="actions"><button type="button" onClick={() => setLines([...lines, { item_id: "", qty: "1" }])}>Ajouter une ligne</button></div>

          <p className="total">Total : <strong>{formatMoney(total)}</strong></p>
          {warnings.length > 0 && (
            <div className="warn" role="status">
              <strong>Stock local insuffisant.</strong> La vente sera enregistrée et signalée comme anomalie :
              <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions"><button className="primary">Enregistrer la vente</button></div>
        </form>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Numéro</th><th>Date</th><th>Client</th><th>Articles</th><th className="num">Total</th></tr></thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>{order.number ?? <span className="chip wait">En attente d'envoi</span>}</td>
                <td>{formatDate(order.ordered_at)}</td>
                <td>{customerName(order.customer_id)}</td>
                <td>{order.lines.map((l) => `${l.qty} × ${itemById.get(l.item_id)?.name ?? "Article inconnu"}`).join(", ")}</td>
                <td className="num">{formatMoney(order.total_cents)}</td>
              </tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={5} className="empty">Aucune vente enregistrée.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

import { useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { formatDate } from "../format";
import { adjustStock, saveWarehouse } from "../ops";
import { balanceKey, useBalances } from "../stock";

export default function StockPage({ canWrite }: { canWrite: boolean }) {
  const items = useLiveQuery(() => db.items.orderBy("name").toArray(), []) ?? [];
  const warehouses = useLiveQuery(() => db.warehouses.orderBy("name").toArray(), []) ?? [];
  const anomalies = useLiveQuery(() => db.anomalies.orderBy("created_at").reverse().toArray(), []) ?? [];
  const balances = useBalances();

  const [warehouseName, setWarehouseName] = useState("");
  const [itemId, setItemId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const itemName = (id: string | null) => items.find((item) => item.id === id)?.name ?? "Article inconnu";
  const warehouseLabel = (id: string | null) => warehouses.find((w) => w.id === id)?.name ?? "Entrepôt inconnu";

  const rows = [...balances.entries()]
    .map(([key, value]) => {
      const [item, warehouse] = key.split("|");
      return { key, item, warehouse, value };
    })
    .sort((a, b) => itemName(a.item).localeCompare(itemName(b.item), "fr"));

  async function addWarehouse(event: FormEvent) {
    event.preventDefault();
    const name = warehouseName.trim();
    if (!name) return;
    if (warehouses.some((w) => w.name.toLowerCase() === name.toLowerCase())) return setError("Cet entrepôt existe déjà.");
    await saveWarehouse({ name });
    setWarehouseName("");
    setError(null);
  }

  async function adjust(event: FormEvent) {
    event.preventDefault();
    const change = Number(qty);
    if (!itemId || !warehouseId) return setError("Choisissez un article et un entrepôt.");
    if (!Number.isInteger(change) || change === 0) return setError("La quantité doit être un entier différent de zéro (négatif pour une sortie).");
    if (!reason.trim()) return setError("Le motif est obligatoire.");
    await adjustStock({ item_id: itemId, warehouse_id: warehouseId, qty_change: change, reason });
    setQty("");
    setReason("");
    setError(null);
  }

  return (
    <>
      <header className="page-head"><h2>Stock</h2></header>

      {canWrite && (
        <div className="split">
          <form className="panel form-grid" onSubmit={addWarehouse}>
            <h3>Nouvel entrepôt</h3>
            <label>Nom<input value={warehouseName} onChange={(e) => setWarehouseName(e.target.value)} /></label>
            <div className="actions"><button className="primary">Ajouter l'entrepôt</button></div>
          </form>
          <form className="panel form-grid" onSubmit={adjust}>
            <h3>Ajuster le stock</h3>
            <label>Article
              <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <option value="">Choisir…</option>
                {items.filter((i) => i.active).map((item) => <option key={item.id} value={item.id}>{item.name} ({item.sku})</option>)}
              </select>
            </label>
            <label>Entrepôt
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">Choisir…</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label>Variation<input inputMode="numeric" placeholder="+10 ou -3" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            <label>Motif<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <div className="actions"><button className="primary">Enregistrer l'ajustement</button></div>
          </form>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Article</th><th>Entrepôt</th><th className="num">Quantité</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={balanceKey(row.item, row.warehouse)}>
                <td>{itemName(row.item)}</td><td>{warehouseLabel(row.warehouse)}</td>
                <td className={row.value < 0 ? "num neg" : "num"}>{row.value}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={3} className="empty">Aucun mouvement de stock pour l'instant.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">Anomalies de stock</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Article</th><th>Entrepôt</th><th>Détail</th></tr></thead>
          <tbody>
            {anomalies.map((a) => (
              <tr key={a.id}><td>{formatDate(a.created_at)}</td><td>{itemName(a.item_id)}</td><td>{warehouseLabel(a.warehouse_id)}</td><td>{a.detail}</td></tr>
            ))}
            {anomalies.length === 0 && <tr><td colSpan={4} className="empty">Aucune anomalie signalée.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

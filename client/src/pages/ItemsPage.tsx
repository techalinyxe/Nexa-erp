import { useState, type FormEvent } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { formatMoney, moneyToInput, parseMoney } from "../format";
import { saveItem } from "../ops";
import type { Item } from "../types";

type FormState = { id?: string; sku: string; name: string; unit: string; price: string; active: boolean };
const EMPTY: FormState = { sku: "", name: "", unit: "unité", price: "", active: true };

export default function ItemsPage({ canWrite }: { canWrite: boolean }) {
  const items = useLiveQuery(() => db.items.orderBy("name").toArray(), []) ?? [];
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const visible = items.filter(
    (item) => !needle || item.name.toLowerCase().includes(needle) || item.sku.toLowerCase().includes(needle),
  );

  function edit(item: Item) {
    setForm({ id: item.id, sku: item.sku, name: item.name, unit: item.unit, price: moneyToInput(item.price_cents), active: item.active });
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const price = parseMoney(form.price);
    if (!form.sku.trim() || !form.name.trim() || !form.unit.trim()) return setError("SKU, nom et unité sont obligatoires.");
    if (price === null) return setError("Le prix doit être un nombre positif.");
    if (items.some((item) => item.id !== form.id && item.sku.toLowerCase() === form.sku.trim().toLowerCase())) {
      return setError("Ce SKU existe déjà.");
    }
    await saveItem({ id: form.id, sku: form.sku, name: form.name, unit: form.unit, price_cents: price, active: form.active });
    setForm(EMPTY);
    setError(null);
  }

  return (
    <>
      <header className="page-head">
        <h2>Articles</h2>
        <input type="search" placeholder="Rechercher par nom ou SKU" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher un article" />
      </header>

      {canWrite && (
        <form className="panel form-grid" onSubmit={submit}>
          <h3>{form.id ? "Modifier l'article" : "Nouvel article"}</h3>
          <label>SKU<input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></label>
          <label>Nom<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Unité<input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></label>
          <label>Prix<input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />Actif</label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button className="primary">{form.id ? "Enregistrer les modifications" : "Ajouter l'article"}</button>
            {form.id && <button type="button" onClick={() => { setForm(EMPTY); setError(null); }}>Annuler</button>}
          </div>
        </form>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr><th>SKU</th><th>Nom</th><th>Unité</th><th className="num">Prix</th><th>État</th>{canWrite && <th />}</tr></thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id}>
                <td>{item.sku}</td><td>{item.name}</td><td>{item.unit}</td>
                <td className="num">{formatMoney(item.price_cents)}</td>
                <td>{item.active ? "Actif" : "Inactif"}</td>
                {canWrite && <td><button onClick={() => edit(item)}>Modifier</button></td>}
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={canWrite ? 6 : 5} className="empty">{items.length === 0 ? "Aucun article. Ajoutez le premier pour commencer." : "Aucun article ne correspond à la recherche."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

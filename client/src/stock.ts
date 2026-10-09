import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import type { OutboxOp, SalePayload, StockMovement } from "./types";

export const balanceKey = (itemId: string, warehouseId: string) => `${itemId}|${warehouseId}`;

/**
 * Stock = somme des mouvements connus + ventes locales dont le serveur n'a pas encore
 * renvoyé les mouvements (le registre n'est jamais modifié, seulement complété).
 */
export function computeBalances(
  movements: StockMovement[],
  outbox: OutboxOp[],
): Map<string, number> {
  const balances = new Map<string, number>();
  const add = (itemId: string, warehouseId: string, qty: number) => {
    const key = balanceKey(itemId, warehouseId);
    balances.set(key, (balances.get(key) ?? 0) + qty);
  };

  const confirmedOrders = new Set<string>();
  for (const movement of movements) {
    add(movement.item_id, movement.warehouse_id, movement.qty_change);
    if (movement.ref_order_id) confirmedOrders.add(movement.ref_order_id);
  }

  for (const op of outbox) {
    if (op.type !== "sale.create" || op.status === "rejected") continue;
    const sale = op.payload as unknown as SalePayload;
    if (confirmedOrders.has(sale.id)) continue;
    for (const line of sale.lines) add(line.item_id, sale.warehouse_id, -line.qty);
  }
  return balances;
}

export function useBalances(): Map<string, number> {
  return (
    useLiveQuery(async () => {
      const [movements, outbox] = await Promise.all([db.stock_movements.toArray(), db.outbox.toArray()]);
      return computeBalances(movements, outbox);
    }, []) ?? new Map<string, number>()
  );
}

import Dexie, { type EntityTable } from "dexie";
import type {
  Anomaly,
  Customer,
  Item,
  OutboxOp,
  SalesOrder,
  StockMovement,
  Warehouse,
} from "./types";

export type MetaRow = { key: string; value: unknown };

class NexaDatabase extends Dexie {
  items!: EntityTable<Item, "id">;
  warehouses!: EntityTable<Warehouse, "id">;
  customers!: EntityTable<Customer, "id">;
  sales_orders!: EntityTable<SalesOrder, "id">;
  stock_movements!: EntityTable<StockMovement, "id">;
  anomalies!: EntityTable<Anomaly, "id">;
  outbox!: EntityTable<OutboxOp, "op_id">;
  meta!: EntityTable<MetaRow, "key">;

  constructor() {
    super("nexa");
    this.version(1).stores({
      items: "id, sku, name",
      warehouses: "id, name",
      customers: "id, name",
      sales_orders: "id, number, ordered_at",
      stock_movements: "id, item_id, warehouse_id, ref_order_id",
      anomalies: "id, created_at",
      outbox: "op_id, created_at, status",
      meta: "key",
    });
  }
}

export const db = new NexaDatabase();

export async function clearLocalData(): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()));
}

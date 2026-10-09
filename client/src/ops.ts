import { db } from "./db";
import { syncSoon } from "./sync";
import type { Customer, Item, OpType, SaleLine, SalesOrder, StockMovement, Warehouse } from "./types";

function newOp(type: OpType, payload: Record<string, unknown>, before?: Record<string, unknown>) {
  return {
    op_id: crypto.randomUUID(),
    type,
    payload,
    created_at: Date.now(),
    status: "pending" as const,
    ...(before ? { before } : {}),
  };
}

export async function saveWarehouse(input: { id?: string; name: string }): Promise<void> {
  const row: Warehouse = { id: input.id ?? crypto.randomUUID(), name: input.name.trim() };
  const before = await db.warehouses.get(row.id);
  await db.transaction("rw", db.warehouses, db.outbox, async () => {
    await db.warehouses.put(row);
    await db.outbox.add(newOp("warehouse.upsert", { ...row }, before && { ...before }));
  });
  syncSoon();
}

export async function saveItem(input: Omit<Item, "id"> & { id?: string }): Promise<void> {
  const row: Item = {
    id: input.id ?? crypto.randomUUID(),
    sku: input.sku.trim(),
    name: input.name.trim(),
    unit: input.unit.trim(),
    price_cents: input.price_cents,
    active: input.active,
  };
  const before = await db.items.get(row.id);
  await db.transaction("rw", db.items, db.outbox, async () => {
    await db.items.put(row);
    await db.outbox.add(newOp("item.upsert", { ...row }, before && { ...before }));
  });
  syncSoon();
}

export async function saveCustomer(
  input: { id?: string; name: string; email?: string; phone?: string },
): Promise<string> {
  const row: Customer = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name.trim(),
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
  };
  const before = await db.customers.get(row.id);
  await db.transaction("rw", db.customers, db.outbox, async () => {
    await db.customers.put(row);
    await db.outbox.add(newOp("customer.upsert", { ...row }, before && { ...before }));
  });
  syncSoon();
  return row.id;
}

export async function adjustStock(input: {
  item_id: string;
  warehouse_id: string;
  qty_change: number;
  reason: string;
}): Promise<void> {
  const movement: StockMovement = {
    id: crypto.randomUUID(),
    item_id: input.item_id,
    warehouse_id: input.warehouse_id,
    qty_change: input.qty_change,
    reason: input.reason.trim(),
    ref_order_id: null,
    created_at: new Date().toISOString(),
  };
  await db.transaction("rw", db.stock_movements, db.outbox, async () => {
    await db.stock_movements.put(movement);
    await db.outbox.add(
      newOp("stock.adjust", {
        id: movement.id,
        item_id: movement.item_id,
        warehouse_id: movement.warehouse_id,
        qty_change: movement.qty_change,
        reason: movement.reason,
      }),
    );
  });
  syncSoon();
}

export async function createSale(input: {
  customer_id: string;
  warehouse_id: string;
  lines: Omit<SaleLine, "id">[];
}): Promise<void> {
  const lines: SaleLine[] = input.lines.map((line) => ({ ...line, id: crypto.randomUUID() }));
  const order: SalesOrder = {
    id: crypto.randomUUID(),
    number: null,
    customer_id: input.customer_id,
    warehouse_id: input.warehouse_id,
    total_cents: lines.reduce((sum, line) => sum + line.qty * line.unit_price_cents, 0),
    ordered_at: new Date().toISOString(),
    lines,
  };
  await db.transaction("rw", db.sales_orders, db.outbox, async () => {
    await db.sales_orders.put(order);
    await db.outbox.add(
      newOp("sale.create", {
        id: order.id,
        customer_id: order.customer_id,
        warehouse_id: order.warehouse_id,
        ordered_at: order.ordered_at,
        lines,
      }),
    );
  });
  syncSoon();
}

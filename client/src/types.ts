export type Item = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  price_cents: number;
  active: boolean;
};

export type Warehouse = { id: string; name: string };

export type Customer = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
};

export type SaleLine = {
  id: string;
  item_id: string;
  qty: number;
  unit_price_cents: number;
};

export type SalesOrder = {
  id: string;
  /** null tant que le serveur n'a pas attribué le numéro officiel. */
  number: string | null;
  customer_id: string;
  warehouse_id: string;
  total_cents: number;
  ordered_at: string;
  lines: SaleLine[];
};

export type StockMovement = {
  id: string;
  item_id: string;
  warehouse_id: string;
  qty_change: number;
  reason: string;
  ref_order_id: string | null;
  created_at: string;
};

export type Anomaly = {
  id: string;
  kind: string;
  item_id: string | null;
  warehouse_id: string | null;
  detail: string;
  created_at: string;
};

export type OpType =
  | "warehouse.upsert"
  | "item.upsert"
  | "customer.upsert"
  | "stock.adjust"
  | "sale.create";

export type OutboxOp = {
  op_id: string;
  type: OpType;
  payload: Record<string, unknown>;
  created_at: number;
  /** pending : à envoyer · applied : accepté, en attente de la lecture des changements · rejected : refusé */
  status: "pending" | "applied" | "rejected";
  error?: string;
  /** État local avant une modification, pour l'annuler en cas de refus. */
  before?: Record<string, unknown>;
};

export type SalePayload = {
  id: string;
  customer_id: string;
  warehouse_id: string;
  ordered_at: string;
  lines: SaleLine[];
};

export type UserInfo = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  permissions: string[];
};

export type Session = { token: string; user: UserInfo };

export type ManagedUser = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  active: boolean;
};

export type Role = { name: string; permissions: string[] };

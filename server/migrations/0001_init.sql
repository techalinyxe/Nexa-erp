-- Rôles et utilisateurs ------------------------------------------------------
CREATE TABLE roles (
    name        text PRIMARY KEY,
    permissions text[] NOT NULL
);

INSERT INTO roles (name, permissions) VALUES
    ('admin',      ARRAY['users.manage', 'stock.read', 'stock.write', 'sales.read', 'sales.write']),
    ('vendeur',    ARRAY['sales.read', 'sales.write', 'stock.read']),
    ('magasinier', ARRAY['stock.read', 'stock.write', 'sales.read']);

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    full_name     text NOT NULL,
    password_hash text NOT NULL,
    role          text NOT NULL REFERENCES roles (name),
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Données de référence --------------------------------------------------------
CREATE TABLE warehouses (
    id         uuid PRIMARY KEY,
    name       text NOT NULL UNIQUE,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE items (
    id          uuid PRIMARY KEY,
    sku         text NOT NULL UNIQUE,
    name        text NOT NULL,
    unit        text NOT NULL DEFAULT 'unité',
    price_cents bigint NOT NULL CHECK (price_cents >= 0),
    active      boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    email      text,
    phone      text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Ventes ----------------------------------------------------------------------
CREATE SEQUENCE sales_order_number_seq;

CREATE TABLE sales_orders (
    id           uuid PRIMARY KEY,
    number       text NOT NULL UNIQUE
                 DEFAULT ('VE-' || lpad(nextval('sales_order_number_seq')::text, 6, '0')),
    customer_id  uuid NOT NULL REFERENCES customers (id),
    warehouse_id uuid NOT NULL REFERENCES warehouses (id),
    total_cents  bigint NOT NULL CHECK (total_cents >= 0),
    ordered_at   timestamptz NOT NULL,
    created_by   uuid NOT NULL REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_order_lines (
    id               uuid PRIMARY KEY,
    order_id         uuid NOT NULL REFERENCES sales_orders (id) ON DELETE CASCADE,
    item_id          uuid NOT NULL REFERENCES items (id),
    qty              integer NOT NULL CHECK (qty > 0),
    unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0)
);

-- Stock : registre de mouvements en ajout seulement ----------------------------
CREATE TABLE stock_movements (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id      uuid NOT NULL REFERENCES items (id),
    warehouse_id uuid NOT NULL REFERENCES warehouses (id),
    qty_change   integer NOT NULL CHECK (qty_change <> 0),
    reason       text NOT NULL,
    ref_order_id uuid REFERENCES sales_orders (id),
    created_by   uuid NOT NULL REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_balance_idx ON stock_movements (item_id, warehouse_id);

CREATE TABLE anomalies (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         text NOT NULL,
    item_id      uuid REFERENCES items (id),
    warehouse_id uuid REFERENCES warehouses (id),
    detail       text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Synchronisation -------------------------------------------------------------
-- Idempotence : une opération client (op_id) n'est appliquée qu'une seule fois.
CREATE TABLE sync_ops (
    op_id      uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id),
    op_type    text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);

-- Journal des changements lu par les clients (curseur = seq).
CREATE TABLE change_log (
    seq        bigserial PRIMARY KEY,
    entity     text NOT NULL,
    entity_id  uuid NOT NULL,
    data       jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

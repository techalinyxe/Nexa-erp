use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use crate::{auth::AuthUser, error::AppError, AppState};

/// Verrou consultatif : les opérations sont appliquées une par une, donc l'ordre
/// des `seq` du journal correspond à l'ordre de validation des transactions.
/// Un client qui lit jusqu'à un curseur ne peut ainsi manquer aucun changement.
const SYNC_LOCK_KEY: i64 = 7_240_001;
const MAX_OPS_PER_PUSH: usize = 200;
const MAX_LINES_PER_SALE: usize = 200;
const MAX_PULL_LIMIT: i64 = 500;

// ---------------------------------------------------------------------------
// Types d'échange
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PushBody {
    ops: Vec<IncomingOp>,
}

#[derive(Deserialize)]
struct IncomingOp {
    op_id: Uuid,
    #[serde(rename = "type")]
    op_type: String,
    payload: Value,
}

#[derive(Serialize)]
struct OpResult {
    op_id: Uuid,
    /// "applied" | "duplicate" | "rejected" (définitif) | "error" (à réessayer)
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
pub struct PushResponse {
    results: Vec<OpResult>,
}

#[derive(Deserialize)]
pub struct PullQuery {
    cursor: Option<i64>,
    limit: Option<i64>,
}

#[derive(Serialize)]
struct Change {
    seq: i64,
    entity: String,
    data: Value,
}

#[derive(Serialize)]
pub struct PullResponse {
    changes: Vec<Change>,
    cursor: i64,
    has_more: bool,
}

// ---------------------------------------------------------------------------
// Erreurs d'opération
// ---------------------------------------------------------------------------

enum OpError {
    /// Refus définitif : le client ne doit pas réessayer.
    Rejected(String),
    /// Incident serveur : le client peut réessayer plus tard.
    Internal,
}

impl From<sqlx::Error> for OpError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &e {
            if db.is_unique_violation() {
                return OpError::Rejected(
                    "Valeur déjà existante (SKU, nom ou identifiant en double)".into(),
                );
            }
            if db.is_foreign_key_violation() {
                return OpError::Rejected(
                    "Référence inconnue (article, client ou entrepôt absent du serveur)".into(),
                );
            }
            if db.is_check_violation() {
                return OpError::Rejected("Valeur invalide".into());
            }
        }
        tracing::error!(error = %e, "erreur base de données pendant une opération");
        OpError::Internal
    }
}

fn rejected<T>(message: &str) -> Result<T, OpError> {
    Err(OpError::Rejected(message.to_string()))
}

fn require(user: &AuthUser, permission: &str) -> Result<(), OpError> {
    if user.can(permission) {
        Ok(())
    } else {
        rejected("Permission insuffisante pour cette opération")
    }
}

fn parse<T: serde::de::DeserializeOwned>(payload: &Value) -> Result<T, OpError> {
    serde_json::from_value(payload.clone())
        .map_err(|e| OpError::Rejected(format!("Données invalides : {e}")))
}

// ---------------------------------------------------------------------------
// Charges utiles
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct WarehousePayload {
    id: Uuid,
    name: String,
}

#[derive(Deserialize)]
struct ItemPayload {
    id: Uuid,
    sku: String,
    name: String,
    unit: String,
    price_cents: i64,
    active: bool,
}

#[derive(Deserialize)]
struct CustomerPayload {
    id: Uuid,
    name: String,
    email: Option<String>,
    phone: Option<String>,
}

#[derive(Deserialize)]
struct AdjustPayload {
    id: Uuid,
    item_id: Uuid,
    warehouse_id: Uuid,
    qty_change: i32,
    reason: String,
}

#[derive(Deserialize)]
struct SaleLinePayload {
    id: Uuid,
    item_id: Uuid,
    qty: i32,
    unit_price_cents: i64,
}

#[derive(Deserialize)]
struct SalePayload {
    id: Uuid,
    customer_id: Uuid,
    warehouse_id: Uuid,
    ordered_at: DateTime<Utc>,
    lines: Vec<SaleLinePayload>,
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

pub async fn push(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<PushBody>,
) -> Result<Json<PushResponse>, AppError> {
    if body.ops.len() > MAX_OPS_PER_PUSH {
        return Err(AppError::BadRequest(format!(
            "Maximum {MAX_OPS_PER_PUSH} opérations par envoi"
        )));
    }

    let mut results = Vec::with_capacity(body.ops.len());
    for op in &body.ops {
        let result = match apply_op(&state.pool, &user, op).await {
            Ok(Outcome::Applied) => OpResult {
                op_id: op.op_id,
                status: "applied",
                error: None,
            },
            Ok(Outcome::Duplicate) => OpResult {
                op_id: op.op_id,
                status: "duplicate",
                error: None,
            },
            Err(OpError::Rejected(message)) => OpResult {
                op_id: op.op_id,
                status: "rejected",
                error: Some(message),
            },
            Err(OpError::Internal) => OpResult {
                op_id: op.op_id,
                status: "error",
                error: Some("Erreur interne du serveur, nouvelle tentative plus tard".into()),
            },
        };
        results.push(result);
    }
    Ok(Json(PushResponse { results }))
}

enum Outcome {
    Applied,
    Duplicate,
}

async fn apply_op(pool: &PgPool, user: &AuthUser, op: &IncomingOp) -> Result<Outcome, OpError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(SYNC_LOCK_KEY)
        .execute(&mut *tx)
        .await?;

    let inserted = sqlx::query(
        "INSERT INTO sync_ops (op_id, user_id, op_type) VALUES ($1, $2, $3) \
         ON CONFLICT (op_id) DO NOTHING",
    )
    .bind(op.op_id)
    .bind(user.id)
    .bind(&op.op_type)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if inserted == 0 {
        return Ok(Outcome::Duplicate);
    }

    match op.op_type.as_str() {
        "warehouse.upsert" => {
            require(user, "stock.write")?;
            upsert_warehouse(&mut tx, parse(&op.payload)?).await?;
        }
        "item.upsert" => {
            require(user, "stock.write")?;
            upsert_item(&mut tx, parse(&op.payload)?).await?;
        }
        "customer.upsert" => {
            require(user, "sales.write")?;
            upsert_customer(&mut tx, parse(&op.payload)?).await?;
        }
        "stock.adjust" => {
            require(user, "stock.write")?;
            adjust_stock(&mut tx, user, op.op_id, parse(&op.payload)?).await?;
        }
        "sale.create" => {
            require(user, "sales.write")?;
            create_sale(&mut tx, user, op.op_id, parse(&op.payload)?).await?;
        }
        other => return rejected(&format!("Type d'opération inconnu : {other}")),
    }

    tx.commit().await?;
    Ok(Outcome::Applied)
}

async fn log_row(
    conn: &mut PgConnection,
    entity: &'static str,
    table: &'static str,
    id: Uuid,
) -> Result<(), sqlx::Error> {
    // `table` provient uniquement de constantes internes (jamais d'une entrée client).
    let sql = format!(
        "INSERT INTO change_log (entity, entity_id, data) \
         SELECT $1::text, t.id, to_jsonb(t) FROM {table} t WHERE t.id = $2"
    );
    sqlx::query(&sql).bind(entity).bind(id).execute(conn).await?;
    Ok(())
}

async fn upsert_warehouse(conn: &mut PgConnection, p: WarehousePayload) -> Result<(), OpError> {
    let name = p.name.trim();
    if name.is_empty() {
        return rejected("Le nom de l'entrepôt est obligatoire");
    }
    sqlx::query(
        "INSERT INTO warehouses (id, name) VALUES ($1, $2) \
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()",
    )
    .bind(p.id)
    .bind(name)
    .execute(&mut *conn)
    .await?;
    log_row(conn, "warehouse", "warehouses", p.id).await?;
    Ok(())
}

async fn upsert_item(conn: &mut PgConnection, p: ItemPayload) -> Result<(), OpError> {
    let sku = p.sku.trim();
    let name = p.name.trim();
    let unit = p.unit.trim();
    if sku.is_empty() || name.is_empty() || unit.is_empty() {
        return rejected("SKU, nom et unité sont obligatoires");
    }
    if p.price_cents < 0 {
        return rejected("Le prix ne peut pas être négatif");
    }
    sqlx::query(
        "INSERT INTO items (id, sku, name, unit, price_cents, active) VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (id) DO UPDATE SET sku = EXCLUDED.sku, name = EXCLUDED.name, \
            unit = EXCLUDED.unit, price_cents = EXCLUDED.price_cents, \
            active = EXCLUDED.active, updated_at = now()",
    )
    .bind(p.id)
    .bind(sku)
    .bind(name)
    .bind(unit)
    .bind(p.price_cents)
    .bind(p.active)
    .execute(&mut *conn)
    .await?;
    log_row(conn, "item", "items", p.id).await?;
    Ok(())
}

async fn upsert_customer(conn: &mut PgConnection, p: CustomerPayload) -> Result<(), OpError> {
    let name = p.name.trim();
    if name.is_empty() {
        return rejected("Le nom du client est obligatoire");
    }
    let email = p.email.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let phone = p.phone.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    sqlx::query(
        "INSERT INTO customers (id, name, email, phone) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, \
            phone = EXCLUDED.phone, updated_at = now()",
    )
    .bind(p.id)
    .bind(name)
    .bind(email)
    .bind(phone)
    .execute(&mut *conn)
    .await?;
    log_row(conn, "customer", "customers", p.id).await?;
    Ok(())
}

/// Ajoute un mouvement au registre et signale un stock négatif le cas échéant.
/// La vente n'est jamais bloquée : l'anomalie est enregistrée et synchronisée.
#[allow(clippy::too_many_arguments)]
async fn insert_movement(
    conn: &mut PgConnection,
    user: &AuthUser,
    op_id: Uuid,
    id: Option<Uuid>,
    item_id: Uuid,
    warehouse_id: Uuid,
    qty_change: i32,
    reason: &str,
    ref_order_id: Option<Uuid>,
) -> Result<(), OpError> {
    let movement_id: Uuid = sqlx::query_scalar(
        "INSERT INTO stock_movements (id, item_id, warehouse_id, qty_change, reason, ref_order_id, created_by) \
         VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(id)
    .bind(item_id)
    .bind(warehouse_id)
    .bind(qty_change)
    .bind(reason)
    .bind(ref_order_id)
    .bind(user.id)
    .fetch_one(&mut *conn)
    .await?;
    log_row(&mut *conn, "stock_movement", "stock_movements", movement_id).await?;

    if qty_change < 0 {
        let balance: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(qty_change), 0)::bigint FROM stock_movements \
             WHERE item_id = $1 AND warehouse_id = $2",
        )
        .bind(item_id)
        .bind(warehouse_id)
        .fetch_one(&mut *conn)
        .await?;

        if balance < 0 {
            let anomaly_id: Uuid = sqlx::query_scalar(
                "INSERT INTO anomalies (kind, item_id, warehouse_id, detail) \
                 VALUES ('negative_stock', $1, $2, $3) RETURNING id",
            )
            .bind(item_id)
            .bind(warehouse_id)
            .bind(format!(
                "Stock négatif ({balance}) après l'opération {op_id}"
            ))
            .fetch_one(&mut *conn)
            .await?;
            log_row(conn, "anomaly", "anomalies", anomaly_id).await?;
        }
    }
    Ok(())
}

async fn adjust_stock(
    conn: &mut PgConnection,
    user: &AuthUser,
    op_id: Uuid,
    p: AdjustPayload,
) -> Result<(), OpError> {
    let reason = p.reason.trim();
    if p.qty_change == 0 {
        return rejected("La quantité à ajuster ne peut pas être nulle");
    }
    if reason.is_empty() || reason.chars().count() > 200 {
        return rejected("Le motif est obligatoire (200 caractères maximum)");
    }
    insert_movement(
        conn,
        user,
        op_id,
        Some(p.id),
        p.item_id,
        p.warehouse_id,
        p.qty_change,
        reason,
        None,
    )
    .await
}

async fn create_sale(
    conn: &mut PgConnection,
    user: &AuthUser,
    op_id: Uuid,
    p: SalePayload,
) -> Result<(), OpError> {
    if p.lines.is_empty() || p.lines.len() > MAX_LINES_PER_SALE {
        return rejected("Une vente doit contenir entre 1 et 200 lignes");
    }

    let mut total: i64 = 0;
    for line in &p.lines {
        if line.qty <= 0 || line.unit_price_cents < 0 {
            return rejected("Quantité ou prix invalide dans une ligne de vente");
        }
        total = match line
            .unit_price_cents
            .checked_mul(i64::from(line.qty))
            .and_then(|amount| total.checked_add(amount))
        {
            Some(value) => value,
            None => return rejected("Montant total trop élevé"),
        };
    }

    sqlx::query(
        "INSERT INTO sales_orders (id, customer_id, warehouse_id, total_cents, ordered_at, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(p.id)
    .bind(p.customer_id)
    .bind(p.warehouse_id)
    .bind(total)
    .bind(p.ordered_at)
    .bind(user.id)
    .execute(&mut *conn)
    .await?;

    for line in &p.lines {
        sqlx::query(
            "INSERT INTO sales_order_lines (id, order_id, item_id, qty, unit_price_cents) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(line.id)
        .bind(p.id)
        .bind(line.item_id)
        .bind(line.qty)
        .bind(line.unit_price_cents)
        .execute(&mut *conn)
        .await?;

        insert_movement(
            &mut *conn,
            user,
            op_id,
            None,
            line.item_id,
            p.warehouse_id,
            -line.qty,
            "sale",
            Some(p.id),
        )
        .await?;
    }

    sqlx::query(
        "INSERT INTO change_log (entity, entity_id, data) \
         SELECT 'sales_order', o.id, to_jsonb(o) || jsonb_build_object('lines', \
            COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) \
                      FROM sales_order_lines l WHERE l.order_id = o.id), '[]'::jsonb)) \
         FROM sales_orders o WHERE o.id = $1",
    )
    .bind(p.id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

fn readable_entities(user: &AuthUser) -> Vec<String> {
    let mut entities: Vec<&str> = Vec::new();
    if user.can("stock.read") || user.can("sales.read") {
        entities.extend(["item", "warehouse"]);
    }
    if user.can("sales.read") {
        entities.extend(["customer", "sales_order"]);
    }
    if user.can("stock.read") {
        entities.extend(["stock_movement", "anomaly"]);
    }
    entities.into_iter().map(String::from).collect()
}

pub async fn pull(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<PullQuery>,
) -> Result<Json<PullResponse>, AppError> {
    let cursor = query.cursor.unwrap_or(0).max(0);
    let limit = query.limit.unwrap_or(MAX_PULL_LIMIT).clamp(1, MAX_PULL_LIMIT);
    let entities = readable_entities(&user);

    // Même instantané pour la lecture des lignes et du curseur maximal.
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;

    let mut rows = sqlx::query_as::<_, (i64, String, Value)>(
        "SELECT seq, entity, data FROM change_log \
         WHERE seq > $1 AND entity = ANY($2) ORDER BY seq LIMIT $3",
    )
    .bind(cursor)
    .bind(&entities)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;

    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);

    let new_cursor = if has_more {
        rows.last().map(|row| row.0).unwrap_or(cursor)
    } else {
        let max_seq: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM change_log")
            .fetch_one(&mut *tx)
            .await?;
        max_seq.max(cursor)
    };
    tx.commit().await?;

    Ok(Json(PullResponse {
        changes: rows
            .into_iter()
            .map(|(seq, entity, data)| Change { seq, entity, data })
            .collect(),
        cursor: new_cursor,
        has_more,
    }))
}

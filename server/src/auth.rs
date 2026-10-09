use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    async_trait,
    extract::{FromRequestParts, Path, State},
    http::{header::AUTHORIZATION, request::Parts},
    Json,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::AppError, AppState};

const TOKEN_LIFETIME_SECONDS: u64 = 60 * 60 * 24 * 14;
const MIN_PASSWORD_LENGTH: usize = 10;

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: Uuid,
    exp: u64,
}

#[derive(Clone, Serialize)]
pub struct AuthUser {
    pub id: Uuid,
    pub email: String,
    pub full_name: String,
    pub role: String,
    pub permissions: Vec<String>,
}

impl AuthUser {
    pub fn can(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }

    pub fn require(&self, permission: &str) -> Result<(), AppError> {
        if self.can(permission) {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }
}

#[derive(sqlx::FromRow)]
struct UserRow {
    id: Uuid,
    email: String,
    full_name: String,
    role: String,
    permissions: Vec<String>,
}

/// Charge un utilisateur actif avec ses permissions (relues à chaque requête :
/// un compte désactivé ou un rôle modifié prend effet immédiatement).
async fn load_active_user(pool: &PgPool, id: Uuid) -> Result<Option<AuthUser>, AppError> {
    let row = sqlx::query_as::<_, UserRow>(
        "SELECT u.id, u.email, u.full_name, u.role, r.permissions \
         FROM users u JOIN roles r ON r.name = u.role \
         WHERE u.id = $1 AND u.active",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| AuthUser {
        id: r.id,
        email: r.email,
        full_name: r.full_name,
        role: r.role,
        permissions: r.permissions,
    }))
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or(AppError::Unauthorized)?;

        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|_| AppError::Unauthorized)?;

        load_active_user(&state.pool, data.claims.sub)
            .await?
            .ok_or(AppError::Unauthorized)
    }
}

pub async fn hash_password(password: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|_| AppError::Internal)
    })
    .await
    .map_err(|_| AppError::Internal)?
}

async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash)
            .map(|parsed| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

fn issue_token(secret: &str, user_id: Uuid) -> Result<String, AppError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| AppError::Internal)?
        .as_secs();
    encode(
        &Header::default(),
        &Claims {
            sub: user_id,
            exp: now + TOKEN_LIFETIME_SECONDS,
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| AppError::Internal)
}

/// Crée le premier administrateur si la table des utilisateurs est vide.
pub async fn bootstrap_admin(pool: &PgPool, email: &str, password: &str) -> Result<(), AppError> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;
    if count > 0 {
        return Ok(());
    }
    if password.len() < MIN_PASSWORD_LENGTH {
        tracing::error!("ADMIN_PASSWORD trop court : {MIN_PASSWORD_LENGTH} caractères minimum");
        return Err(AppError::Internal);
    }
    let hash = hash_password(password.to_string()).await?;
    sqlx::query(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Administrateur', $2, 'admin')",
    )
    .bind(email.trim().to_lowercase())
    .bind(hash)
    .execute(pool)
    .await?;
    tracing::info!("administrateur initial créé");
    Ok(())
}

#[derive(Deserialize)]
pub struct LoginBody {
    email: String,
    password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    token: String,
    user: AuthUser,
}

pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginBody>,
) -> Result<Json<LoginResponse>, AppError> {
    let email = body.email.trim().to_lowercase();
    let row = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, password_hash FROM users WHERE email = $1 AND active",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    let (id, hash) = row.ok_or(AppError::Unauthorized)?;
    if !verify_password(body.password, hash).await {
        return Err(AppError::Unauthorized);
    }
    let user = load_active_user(&state.pool, id)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let token = issue_token(&state.jwt_secret, id)?;
    Ok(Json(LoginResponse { token, user }))
}

pub async fn me(user: AuthUser) -> Json<AuthUser> {
    Json(user)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct RoleSummary {
    name: String,
    permissions: Vec<String>,
}

pub async fn list_roles(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<RoleSummary>>, AppError> {
    user.require("users.manage")?;
    let roles = sqlx::query_as::<_, RoleSummary>("SELECT name, permissions FROM roles ORDER BY name")
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(roles))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct UserSummary {
    id: Uuid,
    email: String,
    full_name: String,
    role: String,
    active: bool,
}

pub async fn list_users(
    State(state): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<UserSummary>>, AppError> {
    user.require("users.manage")?;
    let users = sqlx::query_as::<_, UserSummary>(
        "SELECT id, email, full_name, role, active FROM users ORDER BY email",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(users))
}

#[derive(Deserialize)]
pub struct CreateUserBody {
    email: String,
    full_name: String,
    password: String,
    role: String,
}

pub async fn create_user(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateUserBody>,
) -> Result<Json<UserSummary>, AppError> {
    user.require("users.manage")?;
    let email = body.email.trim().to_lowercase();
    let full_name = body.full_name.trim().to_string();
    if !email.contains('@') || full_name.is_empty() {
        return Err(AppError::BadRequest(
            "E-mail et nom complet sont obligatoires".into(),
        ));
    }
    if body.password.len() < MIN_PASSWORD_LENGTH {
        return Err(AppError::BadRequest(format!(
            "Le mot de passe doit contenir au moins {MIN_PASSWORD_LENGTH} caractères"
        )));
    }
    let hash = hash_password(body.password).await?;
    let created = sqlx::query_as::<_, UserSummary>(
        "INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, $2, $3, $4) \
         RETURNING id, email, full_name, role, active",
    )
    .bind(email)
    .bind(full_name)
    .bind(hash)
    .bind(body.role)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(created))
}

#[derive(Deserialize)]
pub struct UpdateUserBody {
    full_name: Option<String>,
    role: Option<String>,
    active: Option<bool>,
    password: Option<String>,
}

pub async fn update_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateUserBody>,
) -> Result<Json<UserSummary>, AppError> {
    user.require("users.manage")?;

    if id == user.id && (body.active == Some(false) || body.role.is_some()) {
        return Err(AppError::BadRequest(
            "Vous ne pouvez pas désactiver votre compte ni changer votre propre rôle".into(),
        ));
    }

    let password_hash = match body.password {
        Some(p) if p.len() < MIN_PASSWORD_LENGTH => {
            return Err(AppError::BadRequest(format!(
                "Le mot de passe doit contenir au moins {MIN_PASSWORD_LENGTH} caractères"
            )))
        }
        Some(p) => Some(hash_password(p).await?),
        None => None,
    };

    let updated = sqlx::query_as::<_, UserSummary>(
        "UPDATE users SET \
            full_name = COALESCE($2, full_name), \
            role = COALESCE($3, role), \
            active = COALESCE($4, active), \
            password_hash = COALESCE($5, password_hash) \
         WHERE id = $1 \
         RETURNING id, email, full_name, role, active",
    )
    .bind(id)
    .bind(body.full_name.map(|n| n.trim().to_string()))
    .bind(body.role)
    .bind(body.active)
    .bind(password_hash)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;
    Ok(Json(updated))
}

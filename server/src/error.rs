use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    Unauthorized,
    Forbidden,
    NotFound,
    BadRequest(String),
    Conflict(String),
    Internal,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "Authentification requise ou invalide".to_string(),
            ),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "Permission insuffisante".to_string()),
            AppError::NotFound => (StatusCode::NOT_FOUND, "Ressource introuvable".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            AppError::Conflict(m) => (StatusCode::CONFLICT, m),
            AppError::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Erreur interne".to_string(),
            ),
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &e {
            if db.is_unique_violation() {
                return AppError::Conflict("Cette valeur existe déjà".into());
            }
            if db.is_foreign_key_violation() {
                return AppError::BadRequest("Référence inconnue".into());
            }
            if db.is_check_violation() {
                return AppError::BadRequest("Valeur invalide".into());
            }
        }
        tracing::error!(error = %e, "erreur base de données");
        AppError::Internal
    }
}

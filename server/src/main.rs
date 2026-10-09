mod auth;
mod error;
mod sync;

use std::{env, net::SocketAddr, sync::Arc};

use axum::{
    http::{header, Method},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub jwt_secret: Arc<str>,
}

fn required_env(name: &str) -> String {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            eprintln!("Variable d'environnement obligatoire manquante : {name}");
            std::process::exit(1);
        }
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("arrêt demandé");
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = required_env("DATABASE_URL");
    let jwt_secret = required_env("JWT_SECRET");
    if jwt_secret.len() < 32 {
        eprintln!("JWT_SECRET doit contenir au moins 32 caractères");
        std::process::exit(1);
    }
    let admin_email = required_env("ADMIN_EMAIL");
    let admin_password = required_env("ADMIN_PASSWORD");
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .expect("connexion à PostgreSQL impossible");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("échec des migrations");

    if auth::bootstrap_admin(&pool, &admin_email, &admin_password)
        .await
        .is_err()
    {
        eprintln!("Création de l'administrateur initial impossible");
        std::process::exit(1);
    }

    let state = AppState {
        pool,
        jwt_secret: Arc::from(jwt_secret),
    };

    // L'authentification utilise un jeton Bearer (pas de cookies) : autoriser toutes
    // les origines n'expose donc pas à des requêtes inter-sites forgées.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    let app = Router::new()
        .route("/health", get(health))
        .route("/auth/login", post(auth::login))
        .route("/auth/me", get(auth::me))
        .route("/roles", get(auth::list_roles))
        .route("/users", get(auth::list_users).post(auth::create_user))
        .route("/users/:id", patch(auth::update_user))
        .route("/sync/push", post(sync::push))
        .route("/sync/pull", get(sync::pull))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("impossible d'ouvrir le port");
    tracing::info!("serveur à l'écoute sur {address}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("erreur du serveur");
}

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use sea_orm::DbErr;
use serde_json::json;

pub mod problem;
use problem::Problem;

#[derive(Debug)]
pub enum Error {
    NotFound,
    BadRequest(Problem),
    Invalid(String),
    Conflict(Problem),
    Unauthorized,
    Busy,
    Internal(anyhow::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<DbErr> for Error {
    fn from(error: DbErr) -> Self {
        Self::Internal(error.into())
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::NotFound => return StatusCode::NOT_FOUND.into_response(),
            Self::BadRequest(problem) => return problem_response(StatusCode::BAD_REQUEST, problem),
            Self::Invalid(message) => {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": message })))
                    .into_response();
            }
            Self::Conflict(problem) => return problem_response(StatusCode::CONFLICT, problem),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "The email or password is incorrect.",
            ),
            Self::Busy => (
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests. Try again shortly.",
            ),
            Self::Internal(error) => {
                tracing::error!(%error, "Board request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "The server could not process the request. Try again shortly.",
                )
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

fn problem_response(status: StatusCode, problem: Problem) -> Response {
    (
        status,
        Json(json!({ "error": problem.message, "code": problem.code })),
    )
        .into_response()
}

use codex_app_server_transport::RemoteControlHandle;
use serde_json::{Value, json};

/// The only methods the relay answers itself, from the SDK's remote-control handle. Every other client
/// request, `thread/list` and `model/list` included, goes to the gateway's app-server router in the
/// session's child, so the phone sees the router's chat list and its routing.
pub const RELAY_METHODS: [&str; 7] = [
    "remoteControl/status/read",
    "remoteControl/enable",
    "remoteControl/disable",
    "remoteControl/pairing/start",
    "remoteControl/pairing/status",
    "remoteControl/clients/list",
    "remoteControl/clients/revoke",
];

pub fn answers(method: &str) -> bool {
    RELAY_METHODS.contains(&method)
}

pub async fn response(handle: &RemoteControlHandle, request: &Value) -> Option<Value> {
    let method = request.get("method")?.as_str()?;
    if !answers(method) {
        return None;
    }
    let id = request.get("id")?;
    let params = request.get("params").cloned().unwrap_or(json!({}));
    let result: Result<Value, String> = match method {
        "remoteControl/status/read" => Ok(serde_json::to_value(handle.status()).unwrap()),
        "remoteControl/enable" => {
            if params
                .get("ephemeral")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                handle
                    .enable_ephemeral()
                    .map(|value| serde_json::to_value(value).unwrap())
                    .map_err(|_| "Remote control cannot be enabled".into())
            } else {
                handle
                    .enable(None)
                    .await
                    .map(|value| serde_json::to_value(value).unwrap())
                    .map_err(|_| "Remote control cannot be enabled".into())
            }
        }
        "remoteControl/disable" => {
            if params
                .get("ephemeral")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                Ok(serde_json::to_value(handle.disable_ephemeral().await).unwrap())
            } else {
                handle
                    .disable(None)
                    .await
                    .map(|value| serde_json::to_value(value).unwrap())
                    .map_err(|_| "Remote control cannot be disabled".into())
            }
        }
        "remoteControl/pairing/start" => match serde_json::from_value(params) {
            Ok(params) => handle
                .start_pairing(params, None)
                .await
                .map(|value| serde_json::to_value(value).unwrap())
                .map_err(|_| "Pairing failed".into()),
            Err(_) => Err("Invalid pairing parameters".into()),
        },
        "remoteControl/pairing/status" => match serde_json::from_value(params) {
            Ok(params) => handle
                .pairing_status(params)
                .await
                .map(|value| serde_json::to_value(value).unwrap())
                .map_err(|_| "Pairing status unavailable".into()),
            Err(_) => Err("Invalid pairing status parameters".into()),
        },
        "remoteControl/clients/list" => match serde_json::from_value(params) {
            Ok(params) => handle
                .list_clients(params)
                .await
                .map(|value| serde_json::to_value(value).unwrap())
                .map_err(|_| "Client list unavailable".into()),
            Err(_) => Err("Invalid client list parameters".into()),
        },
        "remoteControl/clients/revoke" => match serde_json::from_value(params) {
            Ok(params) => handle
                .revoke_client(params)
                .await
                .map(|value| serde_json::to_value(value).unwrap())
                .map_err(|_| "Client revocation failed".into()),
            Err(_) => Err("Invalid client revocation parameters".into()),
        },
        _ => return None,
    };
    Some(match result {
        Ok(result) => json!({"id": id, "result": result}),
        Err(message) => json!({"id": id, "error": {"code": -32603, "message": message}}),
    })
}

// Network clients sign on their own device. Never delegate host biometric operations to stdio.
pub fn network_guard(request: &Value) -> Option<Value> {
    let method = request.get("method")?.as_str()?;
    if !matches!(
        method,
        "userVerification/enroll" | "userVerification/delete" | "userVerification/verify"
    ) {
        return None;
    }
    Some(
        json!({"id": request.get("id").unwrap_or(&Value::Null), "error": {
            "code": -32603, "message": "User verification is not available in this build or account.",
            "data": {"type": "unavailable", "reason": "providerUnavailable"}
        }}),
    )
}

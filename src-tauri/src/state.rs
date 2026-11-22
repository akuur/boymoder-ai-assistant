use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HitboxRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct AppState {
    pub hitboxes: Mutex<Vec<HitboxRect>>,
    pub overlay_visible: AtomicBool,
    pub cursor_ignored: AtomicBool,
    pub force_interactive: AtomicBool,
    pub opencode_child: Mutex<Option<Child>>,
    pub agent_clis: Arc<Mutex<HashMap<String, Child>>>,
    pub server_password: Mutex<Option<String>>,
    pub server_port: Mutex<Option<u16>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            hitboxes: Mutex::new(Vec::new()),
            overlay_visible: AtomicBool::new(false),
            cursor_ignored: AtomicBool::new(false),
            force_interactive: AtomicBool::new(false),
            opencode_child: Mutex::new(None),
            agent_clis: Arc::new(Mutex::new(HashMap::new())),
            server_password: Mutex::new(None),
            server_port: Mutex::new(None),
        }
    }
}

use serde_json::Value;
use std::{fs, io::Write, path::PathBuf, sync::Mutex};

pub struct WorkspaceStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl WorkspaceStore {
    pub fn new(path: PathBuf) -> Self { Self { path, lock: Mutex::new(()) } }
    pub fn load(&self) -> Result<Option<Value>, String> {
        let _guard = self.lock.lock().map_err(|_| "Workspace lock unavailable.")?;
        if !self.path.exists() { return Ok(None); }
        let bytes = fs::read(&self.path).map_err(|e| format!("Could not read workspace: {e}"))?;
        let data: Value = serde_json::from_slice(&bytes).map_err(|e| format!("Saved workspace is invalid; the file was preserved: {e}"))?;
        Self::validate(&data)?;
        Ok(Some(data))
    }
    pub fn save(&self, data: &Value) -> Result<(), String> {
        Self::validate(data)?;
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        if bytes.len() > 8 * 1024 * 1024 { return Err("Workspace exceeds the 8 MiB storage limit. Clear old history or reduce request bodies.".into()); }
        let _guard = self.lock.lock().map_err(|_| "Workspace lock unavailable.")?;
        let parent = self.path.parent().ok_or("Invalid workspace location.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(&self.path).map_err(|e| format!("Could not save workspace: {}", e.error))?;
        Ok(())
    }
    fn validate(data: &Value) -> Result<(), String> {
        if data.get("schemaVersion").and_then(Value::as_u64) != Some(1) { return Err("Unsupported workspace format. The saved file was preserved.".into()); }
        for key in ["tabs", "collections", "history", "environments"] {
            if !data.get(key).is_some_and(Value::is_array) { return Err(format!("Workspace is missing {key}. The saved file was preserved.")); }
        }
        Ok(())
    }
}

//! One cached preference snapshot and serialized updates for every project window.
use crate::{
    dto::Settings,
    error::{AppError, Result},
};
use std::sync::{Mutex, RwLock};
#[derive(Clone)]
pub(crate) struct Snapshot {
    pub generation: u64,
    pub settings: Settings,
    pub issue: Option<String>,
}
pub(crate) struct Preferences {
    pub gate: Mutex<()>,
    value: RwLock<Snapshot>,
}
impl Preferences {
    pub fn new(settings: Settings, issue: Option<String>) -> Self {
        Self {
            gate: Mutex::new(()),
            value: RwLock::new(Snapshot {
                generation: 0,
                settings,
                issue,
            }),
        }
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.value
            .read()
            .map(|s| s.clone())
            .map_err(|_| AppError::new("internal", "Preferences unavailable"))
    }
    pub fn changed_since(&self, generation: u64) -> Result<Option<Snapshot>> {
        let current = self
            .value
            .read()
            .map_err(|_| AppError::new("internal", "Preferences unavailable"))?;
        Ok((current.generation != generation).then(|| current.clone()))
    }
    pub fn publish(&self, settings: Settings, issue: Option<String>) -> Result<u64> {
        let mut value = self
            .value
            .write()
            .map_err(|_| AppError::new("internal", "Preferences unavailable"))?;
        let generation = value.generation.wrapping_add(1);
        *value = Snapshot {
            generation,
            settings,
            issue,
        };
        Ok(generation)
    }
}

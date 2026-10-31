//! Exclusive project ownership bound to directory identity. Reservations roll
//! back on failure; moving a folder cannot give two windows its private state.
use crate::{
    error::{AppError, Result},
    security,
};
use cap_std::fs::Dir;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
#[derive(Default)]
pub(crate) struct ProjectWindows(Mutex<HashMap<String, String>>);
fn key(dir: &Dir) -> Result<String> {
    security::identity_of_dir(Path::new(""), dir)
}
pub(crate) struct Reservation {
    claims: Arc<ProjectWindows>,
    key: String,
    owner: String,
    added: bool,
    committed: bool,
}
impl ProjectWindows {
    pub fn reserve(self: &Arc<Self>, owner: &str, dir: &Dir) -> Result<Reservation> {
        let key = key(dir)?;
        let mut claims = self
            .0
            .lock()
            .map_err(|_| AppError::new("internal", "Project windows unavailable"))?;
        let added = match claims.get(&key) {
            Some(current) if current != owner => {
                return Err(AppError::new(
                    "projectAlreadyOpen",
                    "This folder is already open in another Workspace window.",
                ));
            }
            Some(_) => false,
            None => {
                claims.insert(key.clone(), owner.into());
                true
            }
        };
        Ok(Reservation {
            claims: self.clone(),
            key,
            owner: owner.into(),
            added,
            committed: false,
        })
    }
    pub fn owner(&self, path: &Path) -> Result<Option<String>> {
        let canonical = path.canonicalize()?;
        let dir = Dir::open_ambient_dir(canonical, cap_std::ambient_authority())?;
        Ok(self
            .0
            .lock()
            .map_err(|_| AppError::new("internal", "Project windows unavailable"))?
            .get(&key(&dir)?)
            .cloned())
    }
    pub fn release(&self, owner: &str) {
        if let Ok(mut claims) = self.0.lock() {
            claims.retain(|_, value| value != owner);
        }
    }
}
impl Reservation {
    pub fn commit(mut self) {
        if let Ok(mut claims) = self.claims.0.lock() {
            claims.retain(|key, owner| owner != &self.owner || key == &self.key);
            self.committed = true;
        }
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if self.added && !self.committed {
            if let Ok(mut claims) = self.claims.0.lock() {
                if claims.get(&self.key) == Some(&self.owner) {
                    claims.remove(&self.key);
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_transitions_keep_the_old_owner_and_release_only_the_new_reservation() {
        let t = tempfile::tempdir().unwrap();
        let a = t.path().join("a");
        let b = t.path().join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let da = Dir::open_ambient_dir(&a, cap_std::ambient_authority()).unwrap();
        let db = Dir::open_ambient_dir(&b, cap_std::ambient_authority()).unwrap();
        let claims = Arc::new(ProjectWindows::default());
        claims.reserve("first", &da).unwrap().commit();
        drop(claims.reserve("first", &db).unwrap());
        assert_eq!(claims.owner(&a).unwrap().as_deref(), Some("first"));
        assert!(claims.owner(&b).unwrap().is_none());
        assert!(claims.reserve("second", &da).is_err());
        claims.reserve("first", &db).unwrap().commit();
        assert!(claims.owner(&a).unwrap().is_none());
        assert_eq!(claims.owner(&b).unwrap().as_deref(), Some("first"));
        claims.reserve("second", &da).unwrap().commit();
    }
}

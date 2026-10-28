use crate::{
    dto::{DockLayout, DockNode},
    error::{AppError, Result},
};
use std::collections::HashSet;
pub fn validate(layout: &DockLayout) -> Result<()> {
    if !(1..=2).contains(&layout.version) {
        return Err(AppError::new(
            "stateVersion",
            "Unsupported panel layout version",
        ));
    }
    fn walk(
        node: &DockNode,
        depth: usize,
        panels: &mut HashSet<crate::dto::DockPanel>,
        splits: &mut HashSet<String>,
    ) -> Result<()> {
        if depth > 6 {
            return Err(AppError::new("stateVersion", "Panel layout is too deep"));
        }
        match node {
            DockNode::Panel { panel } => {
                if !panels.insert(*panel) {
                    return Err(AppError::new(
                        "stateVersion",
                        "Duplicate panel in saved layout",
                    ));
                }
            }
            DockNode::Split {
                id,
                ratio,
                first,
                second,
                ..
            } => {
                if id.is_empty()
                    || id.len() > 64
                    || !splits.insert(id.clone())
                    || !ratio.is_finite()
                    || !(0.05..=0.95).contains(ratio)
                {
                    return Err(AppError::new(
                        "stateVersion",
                        "Invalid saved panel geometry",
                    ));
                }
                walk(first, depth + 1, panels, splits)?;
                walk(second, depth + 1, panels, splits)?;
            }
        }
        Ok(())
    }
    let mut panels = HashSet::new();
    if let Some(root) = &layout.root {
        walk(root, 0, &mut panels, &mut HashSet::new())?;
    }
    let hidden: HashSet<_> = layout.hidden.iter().copied().collect();
    if hidden.len() != layout.hidden.len() || !hidden.is_subset(&panels) {
        return Err(AppError::new(
            "stateVersion",
            "Invalid hidden panel references",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{DockDirection, DockPanel};
    #[test]
    fn refuses_duplicate_panels_and_invalid_sizes_without_repairing_silently() {
        let panel = || {
            Box::new(DockNode::Panel {
                panel: DockPanel::Editor,
            })
        };
        let duplicate = DockLayout {
            version: 1,
            hidden: vec![],
            root: Some(DockNode::Split {
                id: "a".into(),
                direction: DockDirection::Horizontal,
                ratio: 0.5,
                first: panel(),
                second: panel(),
            }),
        };
        assert!(validate(&duplicate).is_err());
        let mut valid = DockLayout {
            version: 1,
            hidden: vec![],
            root: Some(DockNode::Split {
                id: "a".into(),
                direction: DockDirection::Vertical,
                ratio: 0.7,
                first: panel(),
                second: Box::new(DockNode::Panel {
                    panel: DockPanel::Terminal,
                }),
            }),
        };
        validate(&valid).unwrap();
        if let Some(DockNode::Split { ratio, .. }) = &mut valid.root {
            *ratio = f64::NAN;
        }
        assert!(validate(&valid).is_err());
    }
}

use std::io;

use super::{Engine, EngineEvent};
use crate::surfaces::Rect;
use crate::terminal::{Mouse, MouseKind};
use crate::tree::PxRect;

fn offset(rect: Rect, abs: PxRect, visible: PxRect) -> Rect {
    let x1 = (abs.x.max(0.0) as u32 + rect.x).max(visible.x.max(0.0) as u32);
    let y1 = (abs.y.max(0.0) as u32 + rect.y).max(visible.y.max(0.0) as u32);
    let x2 = (abs.x.max(0.0) as u32 + rect.x + rect.w).min((visible.x + visible.w).max(0.0) as u32);
    let y2 = (abs.y.max(0.0) as u32 + rect.y + rect.h).min((visible.y + visible.h).max(0.0) as u32);
    if x2 <= x1 || y2 <= y1 {
        return Rect::default();
    }
    Rect {
        x: x1,
        y: y1,
        w: x2 - x1,
        h: y2 - y1,
    }
}

fn scaled_offset(rect: Rect, source: (u32, u32), abs: PxRect, visible: PxRect) -> Rect {
    if rect.is_empty() || source.0 == 0 || source.1 == 0 {
        return Rect::default();
    }
    let sx = abs.w / source.0 as f32;
    let sy = abs.h / source.1 as f32;
    let x1 = (abs.x + rect.x as f32 * sx).floor() - 1.0;
    let y1 = (abs.y + rect.y as f32 * sy).floor() - 1.0;
    let x2 = (abs.x + (rect.x + rect.w) as f32 * sx).ceil() + 1.0;
    let y2 = (abs.y + (rect.y + rect.h) as f32 * sy).ceil() + 1.0;
    let x1 = x1.max(visible.x).max(0.0) as u32;
    let y1 = y1.max(visible.y).max(0.0) as u32;
    let x2 = x2.min(visible.x + visible.w).max(0.0) as u32;
    let y2 = y2.min(visible.y + visible.h).max(0.0) as u32;
    if x2 <= x1 || y2 <= y1 {
        return Rect::default();
    }
    Rect {
        x: x1,
        y: y1,
        w: x2 - x1,
        h: y2 - y1,
    }
}

impl Engine {
    pub fn draw_surface(
        &mut self,
        surface: u32,
        width: u32,
        height: u32,
        bgra: &[u8],
        stride: usize,
        damage: Option<Rect>,
    ) -> io::Result<usize> {
        let row_bytes = width as usize * 4;
        if width == 0 || height == 0 || stride < row_bytes || bgra.len() < stride * height as usize
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "surface dimensions do not match its pixels",
            ));
        }
        let changed = crate::profiler::span("surface.convert", || {
            crate::surfaces::write(surface, width, height, damage, bgra, stride)
        });
        crate::profiler::count("surface.rows", u64::from(changed.h));
        self.damage_surface_views(surface, changed);
        Ok(row_bytes * height as usize)
    }

    pub fn delete_surface(&mut self, surface: u32) -> io::Result<()> {
        crate::surfaces::remove(surface);
        for view in self.comp.active_views() {
            let tree = &mut self.comp.views[view].tree;
            if tree.uses_surface(surface) {
                tree.mark_paint();
            }
        }
        Ok(())
    }

    fn damage_surface_views(&mut self, surface: u32, changed: Rect) {
        let size = crate::surfaces::with(surface, |s| (s.width, s.height));
        let Some((surface_w, surface_h)) = size else {
            return;
        };
        for view in self.comp.active_views() {
            let view_size = self.comp.views[view].size;
            let tree = &self.comp.views[view].tree;
            let mut damage = Rect::default();
            for (abs, visible) in tree.surface_rects(surface) {
                let mapped =
                    if abs.w.round() as u32 == surface_w && abs.h.round() as u32 == surface_h {
                        offset(changed, abs, visible)
                    } else {
                        scaled_offset(changed, (surface_w, surface_h), abs, visible)
                    };
                damage = damage.union(mapped);
            }
            let damage = damage.clamped(view_size.0, view_size.1);
            if !damage.is_empty() {
                self.comp.views[view].damage = self.comp.views[view].damage.union(damage);
            }
        }
    }

    pub(super) fn forward_pointer(
        &mut self,
        mouse: Mouse,
        point: (f32, f32),
        out: &mut Vec<EngineEvent>,
    ) -> bool {
        if self.drag.is_some() {
            return false;
        }
        let target = match mouse.kind {
            MouseKind::Down => {
                let view = self.comp.view_at(point.0);
                let local = self.comp.to_local(view, point);
                let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1) else {
                    return false;
                };
                self.active_view = view;
                self.set_focus(view, None);
                self.key_passthrough = true;
                self.pointer_capture = Some((view, node));
                (view, node)
            }
            MouseKind::Move => match self.pointer_capture {
                Some(target) => target,
                None => {
                    let view = self.comp.view_at(point.0);
                    let local = self.comp.to_local(view, point);
                    self.update_hover_target(view, local, out);
                    let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1)
                    else {
                        return false;
                    };
                    (view, node)
                }
            },
            MouseKind::Up => match self.pointer_capture.take() {
                Some(target) => target,
                None => {
                    let view = self.comp.view_at(point.0);
                    let local = self.comp.to_local(view, point);
                    let Some(node) = self.comp.views[view].tree.hit_pointer(local.0, local.1)
                    else {
                        return false;
                    };
                    (view, node)
                }
            },
            _ => return false,
        };
        let (view, node) = target;
        let local = self.comp.to_local(view, point);
        let rect = self.comp.views[view]
            .tree
            .rect(node)
            .unwrap_or(PxRect::ZERO);
        out.push(EngineEvent::Pointer {
            view,
            node,
            key: self.comp.views[view].tree.key_of(node).map(str::to_string),
            kind: mouse.kind,
            button: mouse.button,
            mods: mouse.mods,
            x: local.0 - rect.x,
            y: local.1 - rect.y,
        });
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaled_damage_maps_into_the_destination() {
        let damage = scaled_offset(
            Rect {
                x: 500,
                y: 250,
                w: 100,
                h: 50,
            },
            (2000, 1000),
            PxRect {
                x: 10.0,
                y: 20.0,
                w: 1000.0,
                h: 500.0,
            },
            PxRect {
                x: 10.0,
                y: 20.0,
                w: 1000.0,
                h: 500.0,
            },
        );
        assert_eq!(
            damage,
            Rect {
                x: 259,
                y: 144,
                w: 52,
                h: 27,
            }
        );
    }

    #[test]
    fn scaled_damage_is_clipped_to_the_visible_rect() {
        let damage = scaled_offset(
            Rect::sized(100, 100),
            (100, 100),
            PxRect {
                x: 0.0,
                y: 0.0,
                w: 200.0,
                h: 200.0,
            },
            PxRect {
                x: 50.0,
                y: 60.0,
                w: 80.0,
                h: 70.0,
            },
        );
        assert_eq!(
            damage,
            Rect {
                x: 50,
                y: 60,
                w: 80,
                h: 70
            }
        );
    }
}

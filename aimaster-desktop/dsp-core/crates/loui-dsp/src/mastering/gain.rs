//! Simple gain stage — multiply by a linear factor.  Realtime-safe.

use super::config::db_to_lin;

/// Constant-gain stereo stage.
#[derive(Debug, Clone, Copy)]
pub struct Gain {
    factor: f32,
}

impl Gain {
    /// Build a gain stage from a dB value.
    pub fn from_db(db: f64) -> Self {
        Self { factor: db_to_lin(db) as f32 }
    }

    /// Update the gain (dB).
    pub fn set_db(&mut self, db: f64) {
        self.factor = db_to_lin(db) as f32;
    }

    /// Apply to a planar stereo pair in place.
    pub fn process_stereo(&self, left: &mut [f32], right: &mut [f32]) {
        if (self.factor - 1.0).abs() < f32::EPSILON {
            return;
        }
        for x in left.iter_mut() { *x *= self.factor; }
        for x in right.iter_mut() { *x *= self.factor; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unity_gain_is_passthrough() {
        let g = Gain::from_db(0.0);
        let mut l = [0.5f32, -0.25, 1.0];
        let mut r = [0.1f32, 0.2, 0.3];
        g.process_stereo(&mut l, &mut r);
        assert_eq!(l, [0.5, -0.25, 1.0]);
        assert_eq!(r, [0.1, 0.2, 0.3]);
    }

    #[test]
    fn minus_six_db_halves_amplitude() {
        let g = Gain::from_db(-6.0206);
        let mut l = [1.0f32];
        let mut r = [1.0f32];
        g.process_stereo(&mut l, &mut r);
        assert!((l[0] - 0.5).abs() < 1e-3, "got {}", l[0]);
        assert!((r[0] - 0.5).abs() < 1e-3);
    }
}

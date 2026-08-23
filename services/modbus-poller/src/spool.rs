//! Bounded spool for readings the platform could not accept yet.
//!
//! When the ingest endpoint is unreachable the measurements themselves are still
//! valid: each reading carries the timestamp of the register read, so delivering
//! it late is accurate, while dropping it loses the only record that the meter
//! was ever read. Settlement depends on those figures, so the poller keeps them
//! until the platform accepts them.
//!
//! The spool is deliberately bounded and lossy at the *oldest* end, and every
//! discarded reading is counted. An operator reading `dropped_total > 0` knows
//! there is a hole in the meter history; a spool that silently overwrote itself
//! would leave a settlement gap that looks like a quiet device.

use std::collections::VecDeque;

use crate::platform::Reading;

pub struct Spool {
    capacity: usize,
    queue: VecDeque<Reading>,
    dropped_total: u64,
}

impl Spool {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            queue: VecDeque::new(),
            dropped_total: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// Readings discarded since start because the spool was full.
    pub fn dropped_total(&self) -> u64 {
        self.dropped_total
    }

    /// Returns how many readings this call had to discard to make room.
    pub fn push(&mut self, readings: Vec<Reading>) -> usize {
        let mut dropped = 0usize;
        for reading in readings {
            if self.capacity == 0 {
                dropped += 1;
                continue;
            }
            if self.queue.len() == self.capacity {
                // Oldest first: the newest measurement is the one an operator is
                // most likely to still be able to act on.
                self.queue.pop_front();
                dropped += 1;
            }
            self.queue.push_back(reading);
        }
        self.dropped_total += dropped as u64;
        dropped
    }

    /// Removes up to `max` of the oldest readings for a delivery attempt. They
    /// are only truly gone once the platform has accepted them, so a failed
    /// attempt must hand them back through [`Spool::requeue`].
    pub fn take(&mut self, max: usize) -> Vec<Reading> {
        let count = max.min(self.queue.len());
        self.queue.drain(..count).collect()
    }

    /// Returns readings a failed delivery still owns to the front of the spool,
    /// preserving their order. Overflow is charged to the newest readings here:
    /// the ones being retried are the oldest and are already at risk.
    pub fn requeue(&mut self, readings: Vec<Reading>) -> usize {
        let mut dropped = 0usize;
        for reading in readings.into_iter().rev() {
            if self.capacity == 0 {
                dropped += 1;
                continue;
            }
            if self.queue.len() == self.capacity {
                self.queue.pop_back();
                dropped += 1;
            }
            self.queue.push_front(reading);
        }
        self.dropped_total += dropped as u64;
        dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(timestamp_ms: i64) -> Reading {
        Reading {
            device_id: "inverter-1".to_string(),
            name: "active_power_w".to_string(),
            value: 1234.0,
            unit: "W".to_string(),
            address: 40083,
            timestamp_ms,
        }
    }

    #[test]
    fn keeps_readings_in_order_for_replay() {
        let mut spool = Spool::new(10);
        assert_eq!(spool.push(vec![reading(1), reading(2)]), 0);
        assert_eq!(spool.push(vec![reading(3)]), 0);
        let batch = spool.take(10);
        assert_eq!(
            batch.iter().map(|r| r.timestamp_ms).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(spool.is_empty());
        assert_eq!(spool.dropped_total(), 0);
    }

    #[test]
    fn counts_every_reading_it_discards() {
        let mut spool = Spool::new(2);
        assert_eq!(spool.push(vec![reading(1), reading(2)]), 0);
        assert_eq!(spool.push(vec![reading(3)]), 1);
        assert_eq!(spool.dropped_total(), 1);
        // The oldest reading is the one that went.
        assert_eq!(
            spool
                .take(2)
                .iter()
                .map(|r| r.timestamp_ms)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    #[test]
    fn a_zero_capacity_spool_drops_visibly_rather_than_buffering() {
        let mut spool = Spool::new(0);
        assert_eq!(spool.push(vec![reading(1), reading(2)]), 2);
        assert!(spool.is_empty());
        assert_eq!(spool.dropped_total(), 2);
    }

    #[test]
    fn a_failed_delivery_gets_its_readings_back_at_the_front() {
        let mut spool = Spool::new(10);
        spool.push(vec![reading(1), reading(2), reading(3)]);
        let attempt = spool.take(2);
        spool.push(vec![reading(4)]);
        assert_eq!(spool.requeue(attempt), 0);
        assert_eq!(
            spool
                .take(10)
                .iter()
                .map(|r| r.timestamp_ms)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
    }

    #[test]
    fn requeue_into_a_full_spool_drops_the_newest_and_counts_it() {
        let mut spool = Spool::new(3);
        spool.push(vec![reading(10), reading(11), reading(12)]);
        assert_eq!(spool.requeue(vec![reading(1), reading(2)]), 2);
        assert_eq!(spool.dropped_total(), 2);
        assert_eq!(
            spool
                .take(3)
                .iter()
                .map(|r| r.timestamp_ms)
                .collect::<Vec<_>>(),
            vec![1, 2, 10]
        );
    }
}

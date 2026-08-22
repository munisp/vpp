//! Register decoding. Anything the wire does not contain is an error rather
//! than a zero: a fabricated zero reading is indistinguishable from a device
//! that is genuinely idle.

use anyhow::{bail, Result};

use crate::config::{DataType, RegisterConfig, WordOrder};

/// Decodes the raw words of one register into its scaled physical value.
pub fn decode(register: &RegisterConfig, words: &[u16]) -> Result<f64> {
    let expected = register.data_type.word_count() as usize;
    if words.len() != expected {
        bail!(
            "register {} expected {} word(s) but the device returned {}",
            register.name,
            expected,
            words.len()
        );
    }

    let raw = match register.data_type {
        DataType::U16 => f64::from(words[0]),
        DataType::I16 => f64::from(words[0] as i16),
        DataType::U32 => f64::from(combine(words, register.word_order)),
        DataType::I32 => f64::from(combine(words, register.word_order) as i32),
        DataType::F32 => {
            let value = f32::from_bits(combine(words, register.word_order));
            if !value.is_finite() {
                bail!(
                    "register {} returned a non-finite float ({:08x})",
                    register.name,
                    combine(words, register.word_order)
                );
            }
            f64::from(value)
        }
    };

    let scaled = raw * register.scale;
    if !scaled.is_finite() {
        bail!("register {} scaled to a non-finite value", register.name);
    }
    Ok(scaled)
}

fn combine(words: &[u16], order: WordOrder) -> u32 {
    let (high, low) = match order {
        WordOrder::Big => (words[0], words[1]),
        WordOrder::Little => (words[1], words[0]),
    };
    (u32::from(high) << 16) | u32::from(low)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RegisterKind;

    fn register(data_type: DataType, scale: f64, word_order: WordOrder) -> RegisterConfig {
        RegisterConfig {
            name: "test".to_string(),
            address: 0,
            kind: RegisterKind::Input,
            data_type,
            scale,
            unit: "W".to_string(),
            word_order,
        }
    }

    #[test]
    fn decodes_signed_and_unsigned_values() {
        let u16_reg = register(DataType::U16, 1.0, WordOrder::Big);
        assert_eq!(decode(&u16_reg, &[65_535]).unwrap(), 65_535.0);

        let i16_reg = register(DataType::I16, 1.0, WordOrder::Big);
        assert_eq!(decode(&i16_reg, &[65_535]).unwrap(), -1.0);

        // An exporting inverter reports negative power; sign handling is what
        // decides whether the platform bills or credits the customer.
        let i32_reg = register(DataType::I32, 1.0, WordOrder::Big);
        assert_eq!(decode(&i32_reg, &[0xFFFF, 0xEC78]).unwrap(), -5_000.0);

        let u32_reg = register(DataType::U32, 1.0, WordOrder::Big);
        assert_eq!(decode(&u32_reg, &[0x0001, 0x0000]).unwrap(), 65_536.0);
    }

    #[test]
    fn honours_word_order() {
        let big = register(DataType::U32, 1.0, WordOrder::Big);
        let little = register(DataType::U32, 1.0, WordOrder::Little);
        assert_eq!(decode(&big, &[0x0001, 0x0002]).unwrap(), 65_538.0);
        assert_eq!(decode(&little, &[0x0001, 0x0002]).unwrap(), 131_073.0);
    }

    #[test]
    fn decodes_floats_and_applies_scale() {
        let bits = 1234.5f32.to_bits();
        let f32_reg = register(DataType::F32, 1.0, WordOrder::Big);
        let words = [(bits >> 16) as u16, (bits & 0xFFFF) as u16];
        assert_eq!(decode(&f32_reg, &words).unwrap(), 1234.5);

        let scaled = register(DataType::U16, 0.1, WordOrder::Big);
        let value = decode(&scaled, &[875]).unwrap();
        assert!((value - 87.5).abs() < 1e-9, "unexpected value {value}");
    }

    #[test]
    fn rejects_truncated_and_invalid_responses() {
        let u32_reg = register(DataType::U32, 1.0, WordOrder::Big);
        assert!(decode(&u32_reg, &[1]).is_err());
        assert!(decode(&u32_reg, &[]).is_err());

        let nan = register(DataType::F32, 1.0, WordOrder::Big);
        let bits = f32::NAN.to_bits();
        assert!(decode(&nan, &[(bits >> 16) as u16, (bits & 0xFFFF) as u16]).is_err());
    }
}

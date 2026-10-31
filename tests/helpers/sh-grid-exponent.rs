    // SPZ SH magnitudes are multiples of 1/128 in [0, 1]. Keep the general
    // floating-point path unchanged when the maximum is outside that grid.
    let scaled = max_abs * 128.0;
    let magnitude = scaled as u32;
    let (base, divisor) = if max_abs <= 1.0 && scaled == magnitude as f32 {
        let base = if magnitude == 0 { 0 } else { 40 - (magnitude - 1).leading_zeros() };
        // ceil(log2(magnitude / 128)) + 15; zero keeps the original base 0.
        (base as i32, f32::from_bits((base + 112) << 23) / 255.0)
    } else {
        let base = (max_abs.log2().ceil() + 15.0).clamp(0.0, 31.0).round() as i32;
        (base, ((base - 15) as f32).exp2() / 255.0)
    };

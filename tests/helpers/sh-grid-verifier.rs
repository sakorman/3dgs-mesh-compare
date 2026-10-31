#[no_mangle]
pub extern "C" fn verify_discrete(start: u32, count: u32) -> u32 {
    for key in start..start + count {
        let rgb = [key & 255, (key >> 8) & 255, (key >> 16) & 255]
            .map(|x| (x as f32 - 128.0) / 128.0);
        if original(rgb) != candidate(rgb) { return key + 1; }
    }
    0
}

#[no_mangle]
pub extern "C" fn verify_general(count: u32) -> u32 {
    let special = [0.0, -0.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY,
        f32::MIN_POSITIVE, f32::from_bits(1), f32::MAX, -f32::MAX,
        1.0, -1.0, 1.0 / 128.0, -1.0 / 128.0,
        f32::from_bits(1.0f32.to_bits() - 1), f32::from_bits(1.0f32.to_bits() + 1), 0.9];
    for r in special { for g in special { for b in special {
        if original([r,g,b]) != candidate([r,g,b]) { return 0xffff_ffff; }
    } } }
    let mut seed = 0x9e3779b9u32;
    for i in 0..count {
        let rgb = [0; 3].map(|_| {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            f32::from_bits(seed)
        });
        if original(rgb) != candidate(rgb) { return i + 1; }
        // Non-grid lower channels with an exact grid maximum also take the fast path.
        let magnitude = (i % 129) as f32 / 128.0;
        let rgb = [magnitude, -magnitude * 0.79123, magnitude * 0.19471];
        if original(rgb) != candidate(rgb) { return i + 1; }
        let power = f32::from_bits(((i % 254 + 1) << 23) + (i % 3) - 1);
        let rgb = [power, -power * 0.501, power * 0.499];
        if original(rgb) != candidate(rgb) { return i + 1; }
    }
    0
}

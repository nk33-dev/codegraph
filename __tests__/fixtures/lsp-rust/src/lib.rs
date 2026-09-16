pub fn target_value(input: u32) -> u32 {
    input + 1
}

pub fn caller_one() -> u32 {
    target_value(1)
}

pub fn caller_two() -> u32 {
    target_value(2)
}

// Deliberate type error for the get_diagnostics assertion (rust-analyzer reports E0308).
pub fn broken_type() -> u32 {
    "not a number"
}

//! Bytecode walking: advance over instructions to extract the ones that carry a constant-pool
//! reference (method / field / type), and map an instruction offset to its source line.

pub const INVOKEVIRTUAL: u8 = 0xb6;
pub const INVOKESPECIAL: u8 = 0xb7;
pub const INVOKESTATIC: u8 = 0xb8;
pub const INVOKEINTERFACE: u8 = 0xb9;
pub const GETSTATIC: u8 = 0xb2;
pub const PUTSTATIC: u8 = 0xb3;
pub const GETFIELD: u8 = 0xb4;
pub const PUTFIELD: u8 = 0xb5;
pub const NEW: u8 = 0xbb;
pub const ANEWARRAY: u8 = 0xbd;
pub const CHECKCAST: u8 = 0xc0;
pub const INSTANCEOF: u8 = 0xc1;

pub struct Insn {
    pub offset: usize,
    pub opcode: u8,
    pub cp_index: u16,
}

fn is_method(op: u8) -> bool {
    matches!(op, INVOKEVIRTUAL | INVOKESPECIAL | INVOKESTATIC | INVOKEINTERFACE)
}
fn is_field(op: u8) -> bool {
    matches!(op, GETSTATIC | PUTSTATIC | GETFIELD | PUTFIELD)
}
fn is_type(op: u8) -> bool {
    matches!(op, NEW | ANEWARRAY | CHECKCAST | INSTANCEOF)
}

/// Total length (including the opcode) of the instruction at `pos`. Returns 0 if the stream is
/// malformed, which stops the walk for that method.
fn insn_len(code: &[u8], pos: usize) -> usize {
    let op = code[pos];
    match op {
        0xaa => {
            // tableswitch: pad to 4-byte boundary, then default/low/high + (high-low+1) offsets
            let base = pos + 1;
            let p = base + ((4 - (base % 4)) % 4);
            if p + 12 > code.len() {
                return 0;
            }
            let low = i32::from_be_bytes([code[p + 4], code[p + 5], code[p + 6], code[p + 7]]);
            let high = i32::from_be_bytes([code[p + 8], code[p + 9], code[p + 10], code[p + 11]]);
            let n = (high as i64 - low as i64 + 1).max(0) as usize;
            (p + 12 + n * 4) - pos
        }
        0xab => {
            // lookupswitch: pad, default, npairs, npairs*8
            let base = pos + 1;
            let p = base + ((4 - (base % 4)) % 4);
            if p + 8 > code.len() {
                return 0;
            }
            let npairs = i32::from_be_bytes([code[p + 4], code[p + 5], code[p + 6], code[p + 7]]).max(0) as usize;
            (p + 8 + npairs * 8) - pos
        }
        0xc4 => {
            // wide: iinc takes two extra 16-bit operands, the rest take one
            match code.get(pos + 1) {
                Some(0x84) => 6,
                Some(_) => 4,
                None => 0,
            }
        }
        0xc5 => 4,                 // multianewarray
        0xb9 | 0xba => 5,          // invokeinterface / invokedynamic
        0xc8 | 0xc9 => 5,          // goto_w / jsr_w
        0x11 | 0x13 | 0x14 | 0x84 => 3,
        0xb2..=0xb8 | 0xbb | 0xbd | 0xc0 | 0xc1 => 3,
        0x99..=0xa8 | 0xc6 | 0xc7 => 3,
        0x10 | 0x12 | 0x15..=0x19 | 0x36..=0x3a | 0xa9 | 0xbc => 2,
        _ => 1,
    }
}

/// Collect every method/field/type instruction in a method body, in code order.
pub fn relevant_insns(code: &[u8]) -> Vec<Insn> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < code.len() {
        let op = code[pos];
        if (is_method(op) || is_field(op) || is_type(op)) && pos + 2 < code.len() {
            let cp_index = ((code[pos + 1] as u16) << 8) | code[pos + 2] as u16;
            out.push(Insn { offset: pos, opcode: op, cp_index });
        }
        let len = insn_len(code, pos);
        if len == 0 {
            break;
        }
        pos += len;
    }
    out
}

/// Source line of the instruction at `offset`: the line of the nearest LineNumberTable entry whose
/// start_pc does not exceed it. Mirrors ASM's visitLineNumber semantics; -1 when none applies.
pub fn line_at(lines: &[(u16, u16)], offset: usize) -> i32 {
    let off = offset as i64;
    let mut best_pc = -1i64;
    let mut line = -1i32;
    for &(start_pc, ln) in lines {
        let pc = start_pc as i64;
        if pc <= off && pc > best_pc {
            best_pc = pc;
            line = ln as i32;
        }
    }
    line
}

pub fn insn_kind(op: u8) -> InsnKind {
    if is_method(op) {
        InsnKind::Method
    } else if is_field(op) {
        InsnKind::Field
    } else {
        InsnKind::Type
    }
}

pub enum InsnKind {
    Method,
    Field,
    Type,
}

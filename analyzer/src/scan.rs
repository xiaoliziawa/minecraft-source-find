//! Outline and reference scans over a single jar, emitting the exact TSV the Node layer parses
//! (internal names with '/'). Byte-for-byte compatible with the previous Java/ASM analyzer.

use crate::classfile::{self, Class};
use crate::code::{self, InsnKind};
use crate::jar;
use rayon::prelude::*;
use std::fmt::Write as _;

pub struct RefTarget {
    pub kind: String, // class | method | field
    pub owner: String,
    pub name: String,
    pub desc: String,
}

fn is_class_entry(name: &str, pkg: Option<&str>) -> bool {
    if !name.ends_with(".class") || name == "module-info.class" {
        return false;
    }
    match pkg {
        Some(p) => name.starts_with(p),
        None => true,
    }
}

/// Parse each in-scope class in parallel and concatenate the per-class output. Entries reference
/// disjoint slices of the shared in-memory buffer, so decompression and parsing fan out across cores.
fn scan<F>(jar_path: &str, pkg: Option<&str>, with_code: bool, per_class: F) -> String
where
    F: Fn(&Class, &classfile::Pool, &mut String) + Sync,
{
    let Some(j) = jar::read(jar_path, |n| is_class_entry(n, pkg)) else {
        return String::new();
    };
    j.entries
        .par_iter()
        .map(|e| {
            let mut sb = String::new();
            if let Some(bytes) = jar::class_bytes(&j.data, e) {
                if let Some((c, pool)) = classfile::parse(&bytes, with_code) {
                    per_class(&c, &pool, &mut sb);
                }
            }
            sb
        })
        .collect::<Vec<_>>()
        .concat()
}

pub fn scan_outline(jar_path: &str) -> String {
    scan(jar_path, None, false, |c, _pool, sb| emit_outline(sb, c))
}

pub fn scan_refs(jar_path: &str, target: &RefTarget, pkg: Option<&str>) -> String {
    let needle = format!("L{};", target.owner);
    scan(jar_path, pkg, true, move |c, pool, sb| emit_refs(sb, c, pool, target, &needle))
}

fn emit_outline(sb: &mut String, c: &Class) {
    let ifaces = c.interfaces.join(",");
    let _ = writeln!(sb, "C\t{}\t{}\t{}\t{}", c.name, c.super_name, ifaces, c.access);
    for m in &c.methods {
        let _ = writeln!(sb, "m\t{}\t{}\t{}", m.name, m.desc, m.access);
    }
    for f in &c.fields {
        let _ = writeln!(sb, "f\t{}\t{}\t{}", f.name, f.desc, f.access);
    }
}

fn emit_refs(sb: &mut String, c: &Class, pool: &classfile::Pool, t: &RefTarget, needle: &str) {
    let cur = &c.name;
    let is_class = t.kind == "class";

    if is_class {
        if t.owner == c.super_name {
            emit(sb, cur, "", "", -1, "extends", &t.owner, &t.name, &t.desc);
        }
        for i in &c.interfaces {
            if &t.owner == i {
                emit(sb, cur, "", "", -1, "implements", &t.owner, &t.name, &t.desc);
            }
        }
        for f in &c.fields {
            if f.desc.contains(needle) {
                emit(sb, cur, "", "", -1, "field-type", &t.owner, &t.name, &t.desc);
            }
        }
        for m in &c.methods {
            if m.desc.contains(needle) {
                emit(sb, cur, &m.name, &m.desc, -1, "signature", &t.owner, &t.name, &t.desc);
            }
        }
    }

    for m in &c.methods {
        let Some(body) = &m.code else { continue };
        for insn in code::relevant_insns(&body.bytes) {
            let line = code::line_at(&body.lines, insn.offset);
            match code::insn_kind(insn.opcode) {
                InsnKind::Method => {
                    let (owner, name, desc) = pool.ref_parts(insn.cp_index);
                    let hit = if is_class {
                        owner == t.owner
                    } else if t.kind == "method" {
                        name == t.name && (t.desc.is_empty() || desc == t.desc)
                    } else {
                        false
                    };
                    if hit {
                        emit(sb, cur, &m.name, &m.desc, line, "invoke", &owner, &name, &desc);
                    }
                }
                InsnKind::Field => {
                    let (owner, name, desc) = pool.ref_parts(insn.cp_index);
                    let write = insn.opcode == code::PUTFIELD || insn.opcode == code::PUTSTATIC;
                    let kind = if write { "field-write" } else { "field-read" };
                    let hit = if is_class {
                        owner == t.owner
                    } else if t.kind == "field" {
                        name == t.name && (t.desc.is_empty() || desc == t.desc)
                    } else {
                        false
                    };
                    if hit {
                        emit(sb, cur, &m.name, &m.desc, line, kind, &owner, &name, &desc);
                    }
                }
                InsnKind::Type => {
                    if is_class {
                        let ty = pool.class_name(insn.cp_index);
                        if ty == t.owner {
                            let kind = match insn.opcode {
                                code::NEW => "new",
                                code::INSTANCEOF => "instanceof",
                                code::CHECKCAST => "cast",
                                _ => "type",
                            };
                            emit(sb, cur, &m.name, &m.desc, line, kind, &t.owner, &t.name, &t.desc);
                        }
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn emit(
    sb: &mut String,
    caller: &str,
    method: &str,
    mdesc: &str,
    line: i32,
    kind: &str,
    owner: &str,
    name: &str,
    desc: &str,
) {
    let _ = writeln!(
        sb,
        "R\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        caller, method, mdesc, line, kind, owner, name, desc
    );
}

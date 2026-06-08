//! Lean zip reader tuned for jars dominated by non-class entries (the Minecraft jar holds ~30k
//! entries but only ~10k classes). The whole file is read into memory once; the central directory is
//! walked with byte comparisons so non-class entries cost nothing (no String/HashMap allocation), and
//! class data lives at known offsets in the shared buffer so entries can be inflated in parallel
//! without any file-handle contention.

use flate2::read::DeflateDecoder;
use std::fs;
use std::io::Read;

const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD_LOCATOR_SIG: u32 = 0x0706_4b50;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const CD_SIG: u32 = 0x0201_4b50;
const LOCAL_SIG: u32 = 0x0403_4b50;
const METHOD_STORED: u16 = 0;
const METHOD_DEFLATE: u16 = 8;

pub struct Entry {
    pub method: u16,
    pub comp_size: usize,
    pub local_offset: usize,
}

pub struct Jar {
    pub data: Vec<u8>,
    pub entries: Vec<Entry>,
}

fn u16le(b: &[u8], o: usize) -> Option<u16> {
    Some((*b.get(o)? as u16) | ((*b.get(o + 1)? as u16) << 8))
}
fn u32le(b: &[u8], o: usize) -> Option<u32> {
    Some((u16le(b, o)? as u32) | ((u16le(b, o + 2)? as u32) << 16))
}
fn u64le(b: &[u8], o: usize) -> Option<u64> {
    Some((u32le(b, o)? as u64) | ((u32le(b, o + 4)? as u64) << 32))
}

/// Read a jar and collect the central-directory records whose name passes `accept`.
pub fn read(path: &str, accept: impl Fn(&str) -> bool) -> Option<Jar> {
    let data = fs::read(path).ok()?;
    let (cd_offset, cd_size) = central_dir_bounds(&data)?;
    let entries = walk_central(&data, cd_offset, cd_size, &accept);
    Some(Jar { data, entries })
}

/// Locate the central directory, honouring a ZIP64 record when the classic EOCD fields are saturated.
fn central_dir_bounds(data: &[u8]) -> Option<(usize, usize)> {
    let eocd = find_eocd(data)?;
    let cd_size = u32le(data, eocd + 12)? as usize;
    let cd_offset = u32le(data, eocd + 16)? as usize;
    if cd_offset != 0xFFFF_FFFF && cd_size != 0xFFFF_FFFF {
        return Some((cd_offset, cd_size));
    }
    // ZIP64: the EOCD locator sits immediately before the classic EOCD.
    let loc = eocd.checked_sub(20)?;
    if u32le(data, loc)? != EOCD_LOCATOR_SIG {
        return Some((cd_offset, cd_size));
    }
    let z64 = u64le(data, loc + 8)? as usize;
    if u32le(data, z64)? != ZIP64_EOCD_SIG {
        return None;
    }
    Some((u64le(data, z64 + 48)? as usize, u64le(data, z64 + 40)? as usize))
}

fn find_eocd(data: &[u8]) -> Option<usize> {
    let n = data.len();
    if n < 22 {
        return None;
    }
    let start = n.saturating_sub(22 + 0xFFFF);
    let mut i = n - 22;
    loop {
        if u32le(data, i) == Some(EOCD_SIG) {
            return Some(i);
        }
        if i == start {
            return None;
        }
        i -= 1;
    }
}

fn walk_central(
    data: &[u8],
    cd_offset: usize,
    cd_size: usize,
    accept: &impl Fn(&str) -> bool,
) -> Vec<Entry> {
    let mut out = Vec::new();
    let end = (cd_offset + cd_size).min(data.len());
    let mut pos = cd_offset;
    while pos + 46 <= end {
        if u32le(data, pos) != Some(CD_SIG) {
            break;
        }
        let name_len = match u16le(data, pos + 28) {
            Some(v) => v as usize,
            None => break,
        };
        let extra_len = u16le(data, pos + 30).unwrap_or(0) as usize;
        let comment_len = u16le(data, pos + 32).unwrap_or(0) as usize;
        let name_start = pos + 46;
        let name_end = name_start + name_len;
        // Cheap byte test first: only class entries pay for a String + the accept() check.
        if let Some(name) = data.get(name_start..name_end) {
            if name.ends_with(b".class") {
                let s = String::from_utf8_lossy(name);
                if accept(&s) {
                    if let (Some(method), Some(comp), Some(local)) = (
                        u16le(data, pos + 10),
                        u32le(data, pos + 20),
                        u32le(data, pos + 42),
                    ) {
                        out.push(Entry {
                            method,
                            comp_size: comp as usize,
                            local_offset: local as usize,
                        });
                    }
                }
            }
        }
        pos = name_end + extra_len + comment_len;
    }
    out
}

/// Decompress one entry's class bytes from the in-memory buffer. Pure read of a shared slice, so it
/// is safe to call concurrently across entries.
pub fn class_bytes(data: &[u8], e: &Entry) -> Option<Vec<u8>> {
    let lo = e.local_offset;
    if u32le(data, lo)? != LOCAL_SIG {
        return None;
    }
    let name_len = u16le(data, lo + 26)? as usize;
    let extra_len = u16le(data, lo + 28)? as usize;
    let start = lo + 30 + name_len + extra_len;
    let comp = data.get(start..start + e.comp_size)?;
    match e.method {
        METHOD_STORED => Some(comp.to_vec()),
        METHOD_DEFLATE => {
            let mut out = Vec::with_capacity(comp.len() * 3);
            DeflateDecoder::new(comp).read_to_end(&mut out).ok()?;
            Some(out)
        }
        _ => None,
    }
}

//! Minimal Java class-file parser: constant pool, members, and (optionally) method bytecode + line
//! numbers. Only what reference/outline analysis needs; intentionally version-agnostic (no major
//! version check), so any future Java release parses without changes.

pub struct Member {
    pub name: String,
    pub desc: String,
    pub access: u16,
}

pub struct Method {
    pub name: String,
    pub desc: String,
    pub access: u16,
    pub code: Option<Code>,
}

pub struct Code {
    pub bytes: Vec<u8>,
    /// (start_pc, line_number) pairs from the LineNumberTable attribute.
    pub lines: Vec<(u16, u16)>,
}

pub struct Class {
    pub access: u16,
    pub name: String,
    pub super_name: String,
    pub interfaces: Vec<String>,
    pub fields: Vec<Member>,
    pub methods: Vec<Method>,
}

enum Const {
    Utf8(String),
    Class(u16),
    NameType(u16, u16),
    /// Field/Method/InterfaceMethod ref: (class_index, name_and_type_index).
    Ref(u16, u16),
    Skip,
}

struct Reader<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Self {
        Reader { b, p: 0 }
    }
    fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.p)?;
        self.p += 1;
        Some(v)
    }
    fn u16(&mut self) -> Option<u16> {
        let hi = self.u8()? as u16;
        let lo = self.u8()? as u16;
        Some((hi << 8) | lo)
    }
    fn u32(&mut self) -> Option<u32> {
        let a = self.u16()? as u32;
        let b = self.u16()? as u32;
        Some((a << 16) | b)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        if self.p + n > self.b.len() {
            return None;
        }
        self.p += n;
        Some(())
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.p..self.p + n)?;
        self.p += n;
        Some(s)
    }
}

pub struct Pool(Vec<Const>);

impl Pool {
    pub fn utf8(&self, i: u16) -> String {
        match self.0.get(i as usize) {
            Some(Const::Utf8(s)) => s.clone(),
            _ => String::new(),
        }
    }
    pub fn class_name(&self, i: u16) -> String {
        match self.0.get(i as usize) {
            Some(Const::Class(n)) => self.utf8(*n),
            _ => String::new(),
        }
    }
    /// Resolve a Field/Method/InterfaceMethod ref to (owner, name, desc).
    pub fn ref_parts(&self, i: u16) -> (String, String, String) {
        if let Some(Const::Ref(c, nt)) = self.0.get(i as usize) {
            let owner = self.class_name(*c);
            if let Some(Const::NameType(n, d)) = self.0.get(*nt as usize) {
                return (owner, self.utf8(*n), self.utf8(*d));
            }
            return (owner, String::new(), String::new());
        }
        (String::new(), String::new(), String::new())
    }
}

fn read_pool(r: &mut Reader) -> Option<Pool> {
    let count = r.u16()? as usize;
    let mut pool: Vec<Const> = Vec::with_capacity(count);
    pool.push(Const::Skip); // slot 0 is unused
    let mut i = 1;
    while i < count {
        let tag = r.u8()?;
        match tag {
            1 => {
                let len = r.u16()? as usize;
                let raw = r.take(len)?;
                pool.push(Const::Utf8(decode_modified_utf8(raw)));
            }
            7 => pool.push(Const::Class(r.u16()?)),
            12 => pool.push(Const::NameType(r.u16()?, r.u16()?)),
            9 | 10 | 11 => pool.push(Const::Ref(r.u16()?, r.u16()?)),
            8 | 16 | 19 | 20 => {
                r.skip(2)?;
                pool.push(Const::Skip);
            }
            15 => {
                r.skip(3)?;
                pool.push(Const::Skip);
            }
            3 | 4 | 17 | 18 => {
                r.skip(4)?;
                pool.push(Const::Skip);
            }
            5 | 6 => {
                r.skip(8)?;
                pool.push(Const::Skip);
                pool.push(Const::Skip); // long/double take two slots
                i += 1;
            }
            _ => return None,
        }
        i += 1;
    }
    Some(Pool(pool))
}

/// Modified-UTF8 is identical to UTF-8 for the ASCII identifiers we read; fall back to lossy for the
/// rare non-ASCII member name rather than failing the whole class.
fn decode_modified_utf8(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(raw).into_owned(),
    }
}

fn read_members(r: &mut Reader, pool: &Pool, with_code: bool) -> Option<Vec<Method>> {
    let count = r.u16()? as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let access = r.u16()?;
        let name = pool.utf8(r.u16()?);
        let desc = pool.utf8(r.u16()?);
        let attr_count = r.u16()? as usize;
        let mut code = None;
        for _ in 0..attr_count {
            let attr_name = pool.utf8(r.u16()?);
            let attr_len = r.u32()? as usize;
            if with_code && attr_name == "Code" {
                code = read_code(r, pool, attr_len);
            } else {
                r.skip(attr_len)?;
            }
        }
        out.push(Method { name, desc, access, code });
    }
    Some(out)
}

fn read_code(r: &mut Reader, pool: &Pool, attr_len: usize) -> Option<Code> {
    let end = r.p + attr_len;
    r.skip(4)?; // max_stack, max_locals
    let code_len = r.u32()? as usize;
    let bytes = r.take(code_len)?.to_vec();
    let ex_len = r.u16()? as usize;
    r.skip(ex_len * 8)?;
    let mut lines = Vec::new();
    let attr_count = r.u16()? as usize;
    for _ in 0..attr_count {
        let an = pool.utf8(r.u16()?);
        let al = r.u32()? as usize;
        if an == "LineNumberTable" {
            let n = r.u16()? as usize;
            for _ in 0..n {
                lines.push((r.u16()?, r.u16()?));
            }
        } else {
            r.skip(al)?;
        }
    }
    // Defensive: realign to the declared attribute end in case of unexpected sub-attributes.
    if r.p != end && end <= r.b.len() {
        r.p = end;
    }
    Some(Code { bytes, lines })
}

pub fn parse(bytes: &[u8], with_code: bool) -> Option<(Class, Pool)> {
    let mut r = Reader::new(bytes);
    if r.u32()? != 0xCAFE_BABE {
        return None;
    }
    r.skip(4)?; // minor + major version — intentionally unchecked
    let pool = read_pool(&mut r)?;
    let access = r.u16()?;
    let this_name = pool.class_name(r.u16()?);
    let super_idx = r.u16()?;
    let super_name = if super_idx == 0 { String::new() } else { pool.class_name(super_idx) };
    let iface_count = r.u16()? as usize;
    let mut interfaces = Vec::with_capacity(iface_count);
    for _ in 0..iface_count {
        interfaces.push(pool.class_name(r.u16()?));
    }
    let raw_fields = read_members(&mut r, &pool, false)?;
    let fields = raw_fields
        .into_iter()
        .map(|m| Member { name: m.name, desc: m.desc, access: m.access })
        .collect();
    let methods = read_members(&mut r, &pool, with_code)?;
    let class = Class { access, name: this_name, super_name, interfaces, fields, methods };
    Some((class, pool))
}

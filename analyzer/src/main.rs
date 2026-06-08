//! Bytecode reference analyzer for the Minecraft Source MCP (Rust port of McpAnalyzer.java).
//!
//! Usage: mcp-analyzer <optionsFile>
//!
//! Options file (KEY=VALUE lines; multiple JAR= lines) and TSV output are identical to the previous
//! Java analyzer, so the Node layer parses both the same way.

mod classfile;
mod code;
mod jar;
mod scan;

use scan::RefTarget;
use std::collections::HashMap;
use std::io::{BufWriter, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("missing options file");
        std::process::exit(2);
    }
    let text = match std::fs::read_to_string(&args[1]) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read options: {e}");
            std::process::exit(2);
        }
    };

    let mut opt: HashMap<String, String> = HashMap::new();
    let mut jars: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some(eq) = line.find('=') else { continue };
        if eq == 0 {
            continue;
        }
        let (k, v) = (&line[..eq], &line[eq + 1..]);
        if k == "JAR" {
            jars.push(v.to_string());
        } else {
            opt.insert(k.to_string(), v.to_string());
        }
    }

    let cmd = opt.get("CMD").map(String::as_str).unwrap_or("outline");
    // Inflate is CPU-bound, so use every core. THREADS in the options file is honoured only as an
    // upper bound when it is smaller than the machine's parallelism.
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
    let threads = opt
        .get("THREADS")
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&t| t > 0)
        .map(|t| t.max(cores))
        .unwrap_or(cores);
    let pkg = opt.get("PKG").cloned();

    let target = RefTarget {
        kind: opt.get("TKIND").cloned().unwrap_or_else(|| "class".to_string()),
        owner: opt.get("TOWNER").cloned().unwrap_or_default(),
        name: opt.get("TNAME").cloned().unwrap_or_default(),
        desc: opt.get("TDESC").cloned().unwrap_or_default(),
    };
    let refs = cmd == "refs";
    let pkg_ref = pkg.as_deref();

    // Jars are processed serially; parallelism lives inside each jar (per class entry), so the one
    // dominant Minecraft jar saturates all cores instead of competing with tiny mod jars.
    let run = |jar: &String| -> String {
        if refs {
            scan::scan_refs(jar, &target, pkg_ref)
        } else {
            scan::scan_outline(jar)
        }
    };
    let collect = || jars.iter().map(run).collect::<Vec<_>>();
    let chunks: Vec<String> = match rayon::ThreadPoolBuilder::new().num_threads(threads).build() {
        Ok(p) => p.install(collect),
        Err(_) => collect(),
    };

    let stdout = std::io::stdout();
    let mut out = BufWriter::with_capacity(1 << 20, stdout.lock());
    for chunk in chunks {
        if !chunk.is_empty() {
            let _ = out.write_all(chunk.as_bytes());
        }
    }
    let _ = out.flush();
}

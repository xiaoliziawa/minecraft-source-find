import org.objectweb.asm.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.*;

/**
 * Bytecode reference analyzer for the Minecraft Source MCP.
 *
 * Usage: java -cp asm.jar;<thisDir> McpAnalyzer <optionsFile>
 *
 * Options file (KEY=VALUE lines; multiple JAR= lines):
 *   CMD=outline | refs
 *   THREADS=8
 *   PKG=net/minecraft           (optional caller package filter, internal form)
 *   TKIND=class|method|field    (refs only)
 *   TOWNER=net/minecraft/world/item/ItemStack
 *   TNAME=getCount              (method/field targets)
 *   TDESC=()I                   (optional exact descriptor)
 *   JAR=/abs/path/a.jar
 *   ...
 *
 * Output (TSV, internal names with '/'):
 *   outline:  C<TAB>name<TAB>super<TAB>iface,iface<TAB>access
 *             m<TAB>mname<TAB>mdesc<TAB>maccess        (members follow their C line)
 *             f<TAB>fname<TAB>fdesc<TAB>faccess
 *   refs:     R<TAB>caller<TAB>callerMethod<TAB>callerDesc<TAB>line<TAB>kind<TAB>owner<TAB>name<TAB>desc
 */
public final class McpAnalyzer {

  public static void main(String[] args) throws Exception {
    if (args.length < 1) { System.err.println("missing options file"); System.exit(2); }
    Map<String, String> opt = new HashMap<>();
    List<String> jars = new ArrayList<>();
    try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(args[0]), "UTF-8"))) {
      String line;
      while ((line = r.readLine()) != null) {
        int eq = line.indexOf('=');
        if (eq <= 0) continue;
        String k = line.substring(0, eq), v = line.substring(eq + 1);
        if (k.equals("JAR")) jars.add(v); else opt.put(k, v);
      }
    }
    String cmd = opt.getOrDefault("CMD", "outline");
    int threads = Integer.parseInt(opt.getOrDefault("THREADS", "8"));

    Writer out = new BufferedWriter(new OutputStreamWriter(System.out, "UTF-8"), 1 << 20);
    ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, threads));
    List<Future<String>> futures = new ArrayList<>();

    for (String jar : jars) {
      final String jarPath = jar;
      futures.add(pool.submit(() -> cmd.equals("refs") ? scanRefs(jarPath, opt) : scanOutline(jarPath, opt)));
    }
    for (Future<String> f : futures) {
      String chunk = f.get();
      if (!chunk.isEmpty()) out.write(chunk);
    }
    pool.shutdown();
    out.flush();
  }

  private static List<byte[]> readClasses(String jarPath, String pkgFilter, List<String> names) {
    List<byte[]> result = new ArrayList<>();
    try (ZipFile zf = new ZipFile(jarPath)) {
      Enumeration<? extends ZipEntry> en = zf.entries();
      while (en.hasMoreElements()) {
        ZipEntry e = en.nextElement();
        if (e.isDirectory() || !e.getName().endsWith(".class")) continue;
        if (e.getName().equals("module-info.class")) continue;
        if (pkgFilter != null && !e.getName().startsWith(pkgFilter)) continue;
        try (InputStream is = zf.getInputStream(e)) {
          byte[] b = is.readAllBytes();
          capClassVersion(b);
          result.add(b);
          names.add(e.getName());
        }
      }
    } catch (IOException ignored) {}
    return result;
  }

  /** Highest class-file major version ASM is built against; classes newer than this are read by
   *  temporarily lowering the recorded major version. We never read stack-map frames (all callers
   *  pass SKIP_FRAMES) so the version field is irrelevant to what we extract. */
  private static final int SAFE_MAJOR = 52; // Java 8

  /** If a class declares a major version newer than ASM understands, cap it so ClassReader accepts it. */
  private static void capClassVersion(byte[] b) {
    if (b.length < 8) return;
    int major = ((b[6] & 0xFF) << 8) | (b[7] & 0xFF);
    if (major > SAFE_MAJOR) {
      b[6] = (byte) ((SAFE_MAJOR >> 8) & 0xFF);
      b[7] = (byte) (SAFE_MAJOR & 0xFF);
    }
  }

  private static String scanOutline(String jarPath, Map<String, String> opt) {
    StringBuilder sb = new StringBuilder();
    List<String> names = new ArrayList<>();
    for (byte[] bytes : readClasses(jarPath, null, names)) {
      try {
        new ClassReader(bytes).accept(new OutlineVisitor(sb), ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
      } catch (Throwable ignored) {}
    }
    return sb.toString();
  }

  private static String scanRefs(String jarPath, Map<String, String> opt) {
    String tkind = opt.getOrDefault("TKIND", "class");
    String towner = opt.getOrDefault("TOWNER", "");
    String tname = opt.getOrDefault("TNAME", "");
    String tdesc = opt.getOrDefault("TDESC", "");
    String pkg = opt.get("PKG");
    StringBuilder sb = new StringBuilder();
    List<String> names = new ArrayList<>();
    for (byte[] bytes : readClasses(jarPath, pkg, names)) {
      try {
        new ClassReader(bytes).accept(new RefVisitor(sb, tkind, towner, tname, tdesc), ClassReader.SKIP_FRAMES);
      } catch (Throwable ignored) {}
    }
    return sb.toString();
  }

  // ---- outline ----
  static final class OutlineVisitor extends ClassVisitor {
    final StringBuilder sb;
    OutlineVisitor(StringBuilder sb) { super(Opcodes.ASM9); this.sb = sb; }
    @Override public void visit(int v, int access, String name, String sig, String superName, String[] ifaces) {
      sb.append("C\t").append(name).append('\t').append(superName == null ? "" : superName)
        .append('\t').append(ifaces == null ? "" : String.join(",", ifaces))
        .append('\t').append(access).append('\n');
    }
    @Override public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] ex) {
      sb.append("m\t").append(name).append('\t').append(desc).append('\t').append(access).append('\n');
      return null;
    }
    @Override public FieldVisitor visitField(int access, String name, String desc, String sig, Object val) {
      sb.append("f\t").append(name).append('\t').append(desc).append('\t').append(access).append('\n');
      return null;
    }
  }

  // ---- refs ----
  static final class RefVisitor extends ClassVisitor {
    final StringBuilder sb;
    final String tkind, towner, tname, tdesc;
    final String typeNeedle; // "Lowner;" for class-type descriptor matching
    String cur = "";
    RefVisitor(StringBuilder sb, String tkind, String towner, String tname, String tdesc) {
      super(Opcodes.ASM9);
      this.sb = sb; this.tkind = tkind; this.towner = towner; this.tname = tname; this.tdesc = tdesc;
      this.typeNeedle = "L" + towner + ";";
    }
    @Override public void visit(int v, int access, String name, String sig, String superName, String[] ifaces) {
      cur = name;
      if (tkind.equals("class")) {
        if (towner.equals(superName)) emit("", "", -1, "extends");
        if (ifaces != null) for (String i : ifaces) if (towner.equals(i)) emit("", "", -1, "implements");
      }
    }
    @Override public FieldVisitor visitField(int access, String name, String desc, String sig, Object val) {
      if (tkind.equals("class") && desc.contains(typeNeedle)) emit("", "", -1, "field-type");
      return null;
    }
    @Override public MethodVisitor visitMethod(int access, String mname, String mdesc, String sig, String[] ex) {
      if (tkind.equals("class") && mdesc.contains(typeNeedle)) emit(mname, mdesc, -1, "signature");
      return new MethodVisitor(Opcodes.ASM9) {
        int line = -1;
        @Override public void visitLineNumber(int l, Label start) { line = l; }
        @Override public void visitTypeInsn(int op, String type) {
          if (tkind.equals("class") && towner.equals(type)) {
            String k = op == Opcodes.NEW ? "new" : op == Opcodes.INSTANCEOF ? "instanceof"
                     : op == Opcodes.CHECKCAST ? "cast" : "type";
            emit(mname, mdesc, line, k);
          }
        }
        @Override public void visitMethodInsn(int op, String owner, String name, String desc, boolean itf) {
          if (tkind.equals("class")) {
            if (towner.equals(owner)) emitT(mname, mdesc, line, "invoke", owner, name, desc);
          } else if (tkind.equals("method")) {
            if (tname.equals(name) && (tdesc.isEmpty() || tdesc.equals(desc)))
              emitT(mname, mdesc, line, "invoke", owner, name, desc);
          }
        }
        @Override public void visitFieldInsn(int op, String owner, String name, String desc) {
          boolean write = op == Opcodes.PUTFIELD || op == Opcodes.PUTSTATIC;
          String k = write ? "field-write" : "field-read";
          if (tkind.equals("class")) {
            if (towner.equals(owner)) emitT(mname, mdesc, line, k, owner, name, desc);
          } else if (tkind.equals("field")) {
            if (tname.equals(name) && (tdesc.isEmpty() || tdesc.equals(desc)))
              emitT(mname, mdesc, line, k, owner, name, desc);
          }
        }
      };
    }
    void emit(String m, String md, int line, String kind) { emitT(m, md, line, kind, towner, tname, tdesc); }
    void emitT(String m, String md, int line, String kind, String owner, String name, String desc) {
      sb.append("R\t").append(cur).append('\t').append(m).append('\t').append(md)
        .append('\t').append(line).append('\t').append(kind)
        .append('\t').append(owner).append('\t').append(name == null ? "" : name)
        .append('\t').append(desc == null ? "" : desc).append('\n');
    }
  }
}

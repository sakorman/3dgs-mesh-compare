import { instrumentSparkWorker } from "./worker-profile";

/** Observe array-boundary traffic in the pinned binary; never replace an import's result. */
export function instrumentWasmImports(source: string) {
  let worker = instrumentSparkWorker(source);
  const replace = (before: string, after: string) => {
    if (worker.split(before).length !== 2) throw new Error("Unexpected import probe boundary: " + before.slice(0, 60));
    worker = worker.replace(before, after);
  };
  replace("let profileActive = null;", `let profileActive = null;
  let profilePhase = "handler";
  function profileImports(imports) {
    const specs = {
      __wbg_prototypesetcall_3e05eb9545565046: ["jsToWasmU8", a => a[2].byteLength],
      __wbg_prototypesetcall_64c287a27cc24d27: ["jsToWasmU16", a => a[2].byteLength],
      __wbg_prototypesetcall_e42275e601e14eeb: ["jsToWasmU32", a => a[2].byteLength],
      __wbg_set_448126769bf7c181: ["wasmToJsU32", a => (a[2] >>> 0) * 4],
      __wbg_set_a98c8da6557e63de: ["wasmToJsF32", a => (a[2] >>> 0) * 4],
      __wbg_new_from_slice_2580ff33d0d10520: ["wasmToNewJsU8", a => a[1] >>> 0],
      __wbg_new_with_length_41a22191b9bdfd66: ["allocateU32", a => (a[0] >>> 0) * 4],
      __wbg_new_with_length_26bffbe236bf73f9: ["allocateF32", a => (a[0] >>> 0) * 4],
      __wbg_subarray_0f98d3fb634508ad: ["subarrayView", a => 0],
      __wbg_subarray_517cd0f1811ab872: ["subarrayView", a => 0],
      __wbg_subarray_d51e89458b3fdbf6: ["subarrayView", a => 0],
      __wbg_set_81b4174352e6a095: ["jsArraySet", a => a[1].byteLength],
      __wbg_set_index_338a66e40fc45dee: ["scalarWrite", a => 4],
      __wbg_set_6c60b2e8ad0e9383: ["scalarWrite", a => 0]
    };
    const found = new Set();
    for (const module of Object.values(imports)) {
      for (const [name, original] of Object.entries(module)) {
        const spec = specs[name];
        if (spec) found.add(name);
        module[name] = function(...args) {
          if (!profileActive) return original.apply(this, args);
          const key = profilePhase + ":" + name;
          const record = profileActive.imports[key] ??= {phase: profilePhase, name, category: spec?.[0] ?? "other", calls: 0, bytes: 0, bodyMs: 0, errors: 0, timed: !!spec};
          record.calls++;
          if (!spec) return original.apply(this, args);
          record.bytes += spec[1](args);
          const started = performance.now();
          try { return original.apply(this, args); }
          catch (error) { record.errors++; throw error; }
          finally { record.bodyMs += performance.now() - started; }
        };
      }
    }
    if (found.size !== Object.keys(specs).length) throw new Error("WASM import set changed");
    return imports;
  }`);
  replace("const start = performance.now();\n    try { return call(); }", `const start = performance.now();
    const previousPhase = profilePhase;
    profilePhase = name;
    try { return call(); }`);
  replace("const elapsedMs = performance.now() - start;", "const elapsedMs = performance.now() - start;\n      profilePhase = previousPhase;");
  replace('{stages: [], handlerMs: 0}', '{stages: [], handlerMs: 0, imports: {}}');
  replace("const imports = __wbg_get_imports();", "const imports = profileImports(__wbg_get_imports());");
  return worker;
}

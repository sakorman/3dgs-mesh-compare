/** Instrument a pinned Spark worker without altering decoder inputs or results. */
export function instrumentSparkWorker(worker: string) {
  const replace = (before: string, after: string) => {
    if (worker.split(before).length !== 2) throw new Error("Unexpected Spark worker boundary: " + before.slice(0, 60));
    worker = worker.replace(before, after);
  };
  replace("(function() {", `(function() {
  let profileActive = null;
  function profileMeasure(name, call) {
    if (!profileActive) return call();
    const beforeBytes = wasm.memory.buffer.byteLength;
    const start = performance.now();
    try { return call(); }
    finally {
      const elapsedMs = performance.now() - start;
      profileActive.stages.push({name, elapsedMs, beforeBytes, afterBytes: wasm.memory.buffer.byteLength});
    }
  }
`);
  for (const [name, method] of [["push", "chunkdecoder_push"], ["finish", "chunkdecoder_finish"], ["create", "decode_to_extsplats"]]) {
    const matches = worker.match(new RegExp("const ret = wasm\\." + method + "\\([^\\n]+\\);", "g"));
    if (matches?.length !== 1) throw new Error("Missing unique WASM boundary: " + method);
    const call = matches[0].slice("const ret = ".length, -1);
    replace(matches[0], `const ret = profileMeasure("${name}", () => ${call});`);
  }
  replace("function toExtResult(packed) {", `function toExtResult(packed) {
    return profileMeasure("resultLayout", () => profileToExtResult(packed));
  }
  function profileToExtResult(packed) {`);
  replace("const result = await handler(args, { sendStatus });", `const profile = name === "loadExtSplats" ? {stages: [], handlerMs: 0} : null;
      profileActive = profile;
      const profileStart = performance.now();
      const result = await handler(args, { sendStatus });
      if (profile) profile.handlerMs = performance.now() - profileStart;
      profileActive = null;`);
  replace("id,\n\t\t\t\tresult\n", "id,\n\t\t\t\tresult,\n        profile\n");
  // Ensure a failed call cannot contaminate a later unrelated worker RPC.
  replace('console.warn(`Worker error: ${error}`);', 'profileActive = null;\n      console.warn(`Worker error: ${error}`);');
  return worker;
}

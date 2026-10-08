// Runs the engine off the main thread.
importScripts('engine.js');
let MODEL = null;
self.onmessage = e => {
  const { id, rgb, w, h, n, model } = e.data;
  if (model) MODEL = model;
  const t0 = performance.now();
  try {
    const out = self.AppleEngine.measure(rgb, w, h, n, MODEL);
    const ms = performance.now() - t0;
    self.postMessage({ id, ms, out: self.AppleEngine.stripPrivate(out) });
  } catch (err) { self.postMessage({ id, error: String(err) }); }
};

// Run inside the page by tools/shot.mjs --eval: turns the sound on and measures what reaches the output.
(async () => {
  const g = window.__game, a = g.audio;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  a.resume();
  await pause(300);
  const an = a.ctx.createAnalyser();
  an.fftSize = 2048;
  a.master.connect(an);
  const buf = new Float32Array(2048);
  const listen = async (ms) => {
    let sum = 0, n = 0, peak = 0;
    for (let i = 0; i < ms / 30; i++) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) {
        sum += x * x;
        n++;
        peak = Math.max(peak, Math.abs(x));
      }
      await pause(30);
    }
    return (10 * Math.log10(sum / n + 1e-12)).toFixed(1) + ' dB rms, peak ' + peak.toFixed(2);
  };
  const all = () => [...a.files.values()].flat();
  for (let i = 0; i < 80 && a.buffers.size < all().length; i++) await pause(250);
  const missing = all().filter((f) => !a.buffers.has(f));
  const out = { state: a.ctx.state, rate: a.ctx.sampleRate, files: all().length, decoded: a.buffers.size, missing: missing.slice(0, 8), keys: a.files.size, trims: a.trim.size };
  out.loops = [...a.span.entries()].map(([f, s]) => f + ' ' + s.toFixed(3) + ' / ' + (a.buffers.get(f)?.duration ?? 0).toFixed(3));
  out.rooms = [...a.rooms.entries()].map(([k, r]) => k + ':' + (r.node.buffer ? r.node.buffer.duration.toFixed(2) : 'none'));
  await pause(1500);
  out.standing = await listen(2500);
  g.input.keys.add('KeyW');
  await pause(600);
  out.walking = await listen(2500);
  g.input.keys.add('ShiftLeft');
  await pause(600);
  out.sprinting = await listen(2500);
  g.input.keys.delete('KeyW');
  g.input.keys.delete('ShiftLeft');
  await pause(500);
  g.input.inject({ keysDown: ['Mouse0'] });
  out.cut = await listen(900);
  out.distant = g.sound.distant;
  out.error = window.__error ?? null;
  return JSON.stringify(out, null, 1);
})()

// Run inside the page (tools/trace.mjs step "js"): a crude swordsman for exercising the fight.
// Faces the nearest soldier who is after the wearer, cuts when he is in reach, and keeps a tally.
//   window.__bot = { heavy: true|false, shield: true|false, immortal: true|false }
(() => {
  const g = window.__game;
  const opt = (window.__bot = Object.assign({ heavy: false, shield: false, immortal: true, thrust: false }, window.__bot || {}));
  const log = (window.__log = { blows: [], hurts: [], kills: 0 });
  for (const s of g.garrison.soldiers) {
    const struck = s.struck.bind(s);
    s.struck = (strike, part) => {
      const was = s.dead;
      const r = struck(strike, part);
      log.blows.push(`${part}:${r}:${Math.round(s.vitality)}:v${strike.speed.toFixed(0)}p${strike.power.toFixed(1)}`);
      if (!was && s.dead) log.kills++;
      return r;
    };
  }
  const hurt = g.player.hurt.bind(g.player);
  g.player.hurt = (amount, dir) => {
    log.hurts.push(Math.round(amount));
    hurt(amount, dir);
    if (opt.immortal && !g.player.dead) g.player.health = g.player.healthCap = 100;
  };
  if (opt.immortal) g.player.hurt = (amount, dir) => (log.hurts.push(Math.round(amount)), (g.player.health = 1e6), hurt(amount, dir), (g.player.health = g.player.healthCap = 100));
  let held = 0;
  const key = () => (opt.thrust ? 'KeyF' : 'Mouse0');
  setInterval(() => {
    const p = g.player;
    if (p.dead) return;
    let best = null, least = 1e9;
    for (const s of g.garrison.soldiers) {
      if (s.dead) continue;
      const d = Math.hypot(s.position.x - p.position.x, s.position.z - p.position.z);
      if (d < least) (least = d), (best = s);
    }
    if (!best) return;
    const want = Math.atan2(-(best.position.x - p.position.x), -(best.position.z - p.position.z));
    const turn = Math.atan2(Math.sin(want - p.aimYaw), Math.cos(want - p.aimYaw));
    p.aimYaw += turn * 0.5;
    p.aimPitch = -0.1;
    const now = performance.now();
    if (opt.shield && best.striking && least < 2.6) g.input.inject({ keysDown: ['Mouse2'] });
    else g.input.inject({ keysUp: ['Mouse2'] });
    if (held && now > held) {
      g.input.inject({ keysUp: [key()] });
      held = 0;
    } else if (!held && least < 1.75 && g.arms.phase === 'ready' && !g.arms.busy && !(opt.shield && best.striking)) {
      g.input.inject({ keysDown: [key()] });
      held = now + (opt.heavy ? 1250 : 50);
    }
  }, 30);
})();

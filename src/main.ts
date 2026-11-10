import * as THREE from 'three/webgpu';
import { Assets } from './core/assets';
import { Input } from './core/input';
import { BodycamPipeline } from './render/bodycam';
import { FrameStats } from './core/stats';
import { buildKitPreview, buildRigPreview } from './world/kitPreview';
import { Physics } from './physics/physics';
import { buildLevel, type Level } from './world/level';
import { Player } from './game/player';
import { Arms } from './game/weapon';
import { Body } from './game/body';
import { Garrison } from './game/enemy';
import { Effects } from './world/effects';
import { Audio } from './audio/audio';
import { Soundscape } from './audio/soundscape';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const vec = (k: string, d: [number, number, number]) => (params.get(k)?.split(',').map(Number) as [number, number, number]) ?? d;

const $ = (id: string) => document.getElementById(id)!;

async function boot(): Promise<void> {
  const canvas = $('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance' });

  // The recorder's sensor is 1080p; never render more than that however dense the display is.
  const maxHeight = num('res', 1080);
  const fit = () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxHeight / window.innerHeight));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  };
  fit();
  await renderer.init();
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const backend = (renderer.backend as any).isWebGPUBackend ? 'webgpu' : 'webgl2';
  const assets = new Assets(renderer);
  const bar = $('bar').firstElementChild as HTMLElement;
  assets.onProgress = (l, t) => (bar.style.width = `${Math.round((l / Math.max(1, t)) * 100)}%`);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(num('cfov', 80), window.innerWidth / window.innerHeight, 0.05, 600);
  camera.position.set(...vec('pos', [0, 1.4, 0]));
  camera.lookAt(new THREE.Vector3(...vec('look', [0, 1.4, -10])));

  const sky = await assets.sky('overcast_soil_puresky');
  scene.background = sky;
  scene.environment = sky;
  scene.backgroundIntensity = 1;
  scene.environmentIntensity = 1;

  const input = new Input(canvas);
  const mode = params.get('mode') ?? 'game';
  const status = $('status');
  let level: Level | null = null;
  let physics: Physics | null = null;
  let preview: ((time: number) => void) | null = null;
  if (mode === 'kit') await buildKitPreview(scene, assets, params.get('model') ?? 'modular_fort_01');
  else if (mode === 'rig') preview = await buildRigPreview(scene, assets, params.get('model') ?? 'characters/soldier', params.get('pose') ?? 'move');
  else {
    physics = await Physics.create();
    level = await buildLevel(scene, assets, physics, (t) => (status.textContent = t));
    console.log(`light bake ${Math.round(level.bakeMs)} ms`);
    scene.fog = new THREE.FogExp2(new THREE.Color(num('fogr', 0.62), num('fogg', 0.66), num('fogb', 0.7)), num('fog', 0.011));
    if (!params.has('pos')) {
      camera.position.copy(level.spawn.position).add(new THREE.Vector3(0, 1.4, 0));
      camera.lookAt(camera.position.x, 1.4, camera.position.z - 10);
    }
  }

  const bodycam = new BodycamPipeline(renderer, scene, camera, {
    lens: params.get('lens') !== '0',
    ao: params.get('ao') !== '0',
    renderScale: num('scale', 1),
    diagonalFov: num('fov', 122),
  });
  if (params.has('ev')) {
    bodycam.autoExposureMin = bodycam.autoExposureMax = num('ev', 0);
  }
  window.addEventListener('resize', () => {
    fit();
    bodycam.resize();
  });

  const stats = new FrameStats();
  const motion = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(camera.quaternion);
  let last = performance.now();
  let frames = 0;
  const rate = num('speed', 1);

  // `pos=` or `fly=1` gives a free camera for looking at the level; otherwise you wear the camera.
  const fly = !level || params.has('fly') || params.has('pos');
  // `auto=1` runs without pointer lock, for automated checks.
  const auto = params.has('auto') || fly;
  const player = !fly && level && physics ? new Player(physics, level) : null;
  if (player && params.has('spawn')) {
    const [x, z, yaw] = vec('spawn', [0, 0, 0]);
    const y = physics!.raycast(new THREE.Vector3(x, 12, z), new THREE.Vector3(0, -1, 0), 40)?.point.y ?? 0;
    player.teleport(new THREE.Vector3(x, y, z), ((yaw || 0) * Math.PI) / 180);
  }
  player?.frame(1 / 60);
  const effects = physics ? new Effects(scene, physics) : null;
  const arms = player && physics && effects ? await Arms.create(scene, assets, physics, player, effects) : null;
  const body = arms && player && physics && level && params.get('body') !== '0' ? await Body.create(scene, assets, physics, level, player, arms) : null;

  const garrison = arms && player && physics && level && effects && params.get('enemies') !== '0' ? await Garrison.create(scene, assets, physics, level, player, arms, effects) : null;

  const audio = physics ? new Audio(physics) : null;
  const sound = audio && level && player ? new Soundscape(audio, level, player, arms) : null;
  if (garrison) garrison.voice = sound;
  // The library streams in behind the level; nothing waits on it.
  audio?.load();

  const watching = params.has('watch') ? new THREE.Vector3(...vec('from', [2.6, 1.2, -1.2])) : null;
  const third = params.has('third') ? new THREE.Vector3(...vec('third', [0, 1.4, 3])) : null;
  if (third) body?.figure.rig.show('head_', true, true);
  const veil = $('veil'), stamp = $('stamp'), prompt = $('prompt');
  let running = auto;
  let clock = 7 * 3600 + 41 * 60 + 22;
  // Each wearer's recording gets the next number.
  let recording = 217;
  const two = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const writeStamp = () => {
    const d = new Date();
    stamp.textContent = `1403-${two(d.getMonth() + 1)}-${two(d.getDate())} T${two(clock / 3600)}:${two((clock / 60) % 60)}:${two(clock % 60)}Z\nOCULARIUM BODY 3  X6039A${recording}`;
  };
  writeStamp();
  status.textContent = '';

  // The feed: live while the wearer lives, a few seconds of it lying where they fell, then nothing,
  // then the next wearer switching their camera on.
  let feed: 'live' | 'down' | 'dark' = 'live';
  let feedFor = 0;
  let started = false;
  const begin = () => {
    // The recording starts with a hand coming off the camera.
    started = true;
    arms?.stow();
    bodycam.powerOn();
    sound?.feed(true);
  };
  if (player && arms) {
    player.events.death = (direction) => {
      body?.collapse(direction, 1);
      arms.drop();
      sound?.own('voice/death', 0.9);
      bodycam.knock(1);
      feed = 'down';
      feedFor = 0;
    };
    player.events.hurt = (amount) => {
      bodycam.knock(Math.min(1, amount / 45));
      if (!player.dead) sound?.own('voice/pain', 0.5 + Math.min(0.4, amount / 100));
    };
    arms.events.spatter = (amount) => (bodycam.gore.value = Math.min(1, bodycam.gore.value + amount * 0.45));
  }
  const respawn = () => {
    if (!player || !level) return;
    player.revive(level.spawn.position, level.spawn.yaw);
    body?.renew();
    arms?.raise();
    recording++;
    writeStamp();
    feed = 'live';
    begin();
  };

  if (auto) {
    veil.classList.add('hidden');
    if (player) stamp.style.display = 'block';
    if (params.has('intro')) begin();
  } else {
    prompt.textContent = 'CLICK TO BEGIN';
    $('keys').textContent =
      'W A S D  MOVE              SHIFT  RUN\nC  CROUCH                 SPACE  JUMP\nQ / E  LEAN               MOUSE  AIM\nLEFT BUTTON  CUT          F  THRUST\nHOLD EITHER  STRIKE HARDER\nRIGHT BUTTON  SHIELD      ESC  PAUSE';
    veil.addEventListener('click', () => input.requestLock());
    input.onLockChange = (locked) => {
      running = locked;
      if (locked) audio?.resume();
      else audio?.suspend();
      if (locked && !started && player) begin();
      veil.classList.toggle('hidden', locked);
      veil.classList.add('paused');
      prompt.textContent = 'PAUSED. CLICK TO RESUME';
      last = performance.now();
    };
  }

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // `speed=` slows everything down, for looking at fast things.
    const dt = Math.min((now - last) / 1000, 0.1) * rate;
    last = now;
    stats.push(now);

    if (player && physics) {
      if (running && !(window as any).__freeze) {
        // While the hand is still on the camera the wearer is standing still.
        player.control(input, dt, !!arms?.covering);
        physics.update(dt, () => {
          player.fixedStep(physics.step);
          garrison?.fixedStep(physics.step);
        });
        player.frame(dt);
        body?.begin(dt);
        arms?.update(dt, input);
        body?.finish();
        garrison?.update(dt, physics.alpha);
        effects?.update(dt, camera);
        sound?.update(dt, camera);
        const whole = Math.floor(clock);
        clock += dt;
        if (Math.floor(clock) !== whole) writeStamp();

        feedFor += dt;
        if (feed === 'down' && feedFor > 3.4) {
          // Nobody is coming to switch it off. The feed ends.
          bodycam.cut();
          sound?.feed(false);
          feed = 'dark';
          feedFor = 0;
        } else if (feed === 'dark' && feedFor > 2.6) respawn();
      }
      stamp.style.display = running && bodycam.settled ? 'block' : 'none';
      camera.position.copy(player.eye);
      camera.quaternion.copy(player.orientation);
      if (third) {
        // Debug: stand off from the wearer and look at them.
        const bone = params.get('thirdat');
        if (bone && body) {
          // ...or at one of their joints, from close by.
          body.figure.rig.worldPosition(bone, focus);
          camera.position.copy(third).applyAxisAngle(camera.up, player.yaw).add(focus);
          camera.lookAt(focus);
        } else {
          camera.position.copy(third).applyAxisAngle(camera.up, player.yaw).add(player.position);
          camera.lookAt(player.position.x, player.position.y + num('thirdy', 1.05), player.position.z);
        }
      }
      if (watching && garrison) {
        // Debug: stand off from one of the garrison and look at him.
        const s = garrison.soldiers[Number(params.get('watch')) || 0];
        if (s.dead) s.rig.worldPosition('pelvis', focus).setY(s.position.y);
        else focus.copy(s.position);
        camera.position.copy(watching).applyAxisAngle(camera.up, s.yaw).add(focus);
        camera.lookAt(focus.x, focus.y + (s.dead ? 0.3 : 1.05), focus.z);
      }
      motion.copy(running ? player.spin : motion.set(0, 0, 0));
    } else {
      // Free camera.
      const look = input.consumeLook();
      euler.y -= look.x;
      euler.x = THREE.MathUtils.clamp(euler.x - look.y, -1.5, 1.5);
      camera.quaternion.setFromEuler(euler);
      motion.set(-look.y / Math.max(dt, 1e-3), -look.x / Math.max(dt, 1e-3), 0);
      const speed = (input.down('ShiftLeft') ? 12 : 4) * dt;
      const move = new THREE.Vector3(input.axis('KeyA', 'KeyD'), input.axis('KeyQ', 'KeyE'), input.axis('KeyW', 'KeyS'));
      camera.position.add(move.multiplyScalar(speed).applyQuaternion(camera.quaternion));
      physics?.update(dt);
    }

    level?.update(now / 1000, camera);
    preview?.(now / 1000);
    bodycam.render(dt, motion);
    input.endFrame();
    frames++;
    (window as any).__stats = { ...stats.summary(), frames, backend, exposure: bodycam.exposureStops, calls: renderer.info.render.drawCalls, tris: renderer.info.render.triangles };
  });

  if (fly) canvas.addEventListener('click', () => input.requestLock());
  (window as any).__ready = true;
  (window as any).__game = { renderer, scene, camera, bodycam, input, euler, stats, level, physics, player, assets, arms, body, effects, audio, sound, garrison };
}

boot().catch((e) => {
  console.error(e);
  $('error').textContent = String(e?.stack ?? e);
  (window as any).__error = String(e?.stack ?? e);
});

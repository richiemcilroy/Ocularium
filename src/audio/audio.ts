import * as THREE from 'three/webgpu';
import { GROUP, type Physics } from '../physics/physics';

const BASE = `${import.meta.env.BASE_URL}assets/audio/`;

export interface PlayOptions {
  /** World position; omit for sounds made by the wearer (heard at the microphone). */
  position?: THREE.Vector3;
  volume?: number;
  /** Playback rate; a little random spread is always added. */
  rate?: number;
  /** Left/right placement for sounds without a position, -1..1. */
  pan?: number;
  /** Share sent to the room reverb, 0..1. */
  wet?: number;
  delay?: number;
}

export interface Loop {
  setVolume(v: number, glide?: number): void;
  setRate(r: number): void;
  stop(fade?: number): void;
}

interface Voice {
  position: THREE.Vector3;
  filter: BiquadFilterNode;
  gain: GainNode;
  level: number;
  muffle: number;
  until: number;
}

type Room = 'outdoor' | 'hall' | 'small_room';

/**
 * Everything the camera's microphone hears. Sources are placed with HRTF
 * panning, muffled when stone stands between them and the wearer, given the
 * reverberation of the space the wearer is in, and finally pushed through the
 * limited, compressed signal chain of a body-worn recorder.
 */
export class Audio {
  readonly ctx: AudioContext;
  private files = new Map<string, string[]>();
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  private lastPick = new Map<string, number>();
  /** Per file: a gain that evens out recordings of very different density. */
  private trim = new Map<string, number>();
  /** Per looping file: its true length in seconds, without whatever padding the codec added. */
  private span = new Map<string, number>();
  private input: GainNode;
  private dry: GainNode;
  private send: GainNode;
  private rooms = new Map<Room, { node: ConvolverNode; gain: GainNode; level: number }>();
  private room: Room = 'outdoor';
  private voices: Voice[] = [];
  private master: GainNode;
  private ear = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private up = new THREE.Vector3();
  private probe = 0;
  ready = false;

  constructor(private physics: Physics) {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    const ctx = (this.ctx = new Ctx({ latencyHint: 'interactive' }));
    this.input = ctx.createGain();
    this.dry = ctx.createGain();
    this.send = ctx.createGain();
    this.input.connect(this.dry);

    // The recorder: a small electret capsule behind a grille, an automatic gain stage that
    // pumps on anything loud, and a codec that throws away the top octave.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 95;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2600;
    presence.Q.value = 0.8;
    presence.gain.value = 4;
    const boxy = ctx.createBiquadFilter();
    boxy.type = 'peaking';
    boxy.frequency.value = 480;
    boxy.Q.value = 1.1;
    boxy.gain.value = 2.2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7800;
    lp.Q.value = 0.5;
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 1.7) / Math.tanh(1.7);
    }
    drive.curve = curve;
    drive.oversample = '2x';
    const agc = ctx.createDynamicsCompressor();
    agc.threshold.value = -30;
    agc.knee.value = 8;
    agc.ratio.value = 9;
    agc.attack.value = 0.004;
    agc.release.value = 0.42;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.dry.connect(hp);
    hp.connect(presence).connect(boxy).connect(lp).connect(drive).connect(agc).connect(this.master).connect(ctx.destination);

    for (const name of ['outdoor', 'hall', 'small_room'] as Room[]) {
      const node = ctx.createConvolver();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      this.send.connect(node).connect(gain).connect(hp);
      this.rooms.set(name, { node, gain, level: name === 'outdoor' ? 0.32 : name === 'hall' ? 0.85 : 0.7 });
    }
  }

  /** Reads the sound library's index and starts fetching it. Missing audio is not an error: the game runs silent. */
  async load(): Promise<void> {
    let manifest: any;
    try {
      const r = await fetch(`${BASE}manifest.json`);
      if (!r.ok) return;
      manifest = await r.json();
    } catch {
      return;
    }
    const add = (key: string, list: any) => {
      if (!Array.isArray(list)) return;
      const files = list.map((e) => (typeof e === 'string' ? e : e?.file)).filter((f): f is string => typeof f === 'string');
      if (files.length) this.files.set(key, files);
      for (const e of list) this.note(e);
    };
    const walk = (node: any, prefix: string) => {
      for (const [k, v] of Object.entries(node ?? {})) {
        const key = prefix ? `${prefix}/${k}` : k;
        if (Array.isArray(v)) add(key, v);
        else if (typeof v === 'string') this.files.set(key, [v]);
        else if (v && typeof v === 'object') {
          if (typeof (v as any).file === 'string') (this.files.set(key, [(v as any).file]), this.note(v));
          else walk(v, key);
        }
      }
    };
    walk(manifest.categories ?? manifest, '');
    this.ready = true;
    for (const room of this.rooms.keys()) {
      const key = this.find(`ir/${room}`);
      if (key) this.buffer(this.files.get(key)![0]).then((b) => b && (this.rooms.get(room)!.node.buffer = b));
    }
    // Warm the cache in the background, short sounds first.
    const all = [...this.files.entries()].filter(([k]) => !k.startsWith('ir'));
    (async () => {
      for (const [, list] of all) await Promise.all(list.map((f) => this.buffer(f)));
    })();
  }

  /**
   * The library is levelled file by file to the same peak, so a dense cry is far louder than a
   * sharp knock. Half of the difference in average level from a common mark is taken back out.
   */
  private note(entry: any): void {
    if (typeof entry?.file !== 'string') return;
    if (entry.loop && typeof entry.samples === 'number') this.span.set(entry.file, entry.samples / (entry.sampleRate ?? 48000));
    else if (typeof entry.rmsDb === 'number' && !entry.file.startsWith('ir/')) {
      const db = THREE.MathUtils.clamp(0.5 * (-22 - entry.rmsDb), -6, 6);
      this.trim.set(entry.file, 10 ** (db / 20));
    }
  }

  /** Manifest keys may or may not carry a leading group (`loops/amb/wind` vs `amb/wind`). */
  private find(key: string): string | null {
    if (this.files.has(key)) return key;
    for (const k of this.files.keys()) if (k.endsWith(`/${key}`) || k.replace(/\.\w+$/, '') === key || k.replace(/\.\w+$/, '').endsWith(`/${key}`)) return k;
    // A group name stands for any of its members (`gear` → `gear/mail`, `gear/belt`, …).
    const under = [...this.files.keys()].filter((k) => k.startsWith(`${key}/`) || k.includes(`/${key}/`));
    if (under.length) return under[Math.floor(Math.random() * under.length)];
    return null;
  }

  has(key: string): boolean {
    return this.find(key) !== null;
  }

  /** The first of several candidate names that the library actually holds. */
  first(...keys: string[]): string | null {
    for (const k of keys) if (this.find(k)) return k;
    return null;
  }

  /** Every sound whose name contains `part`. */
  matching(part: string): string[] {
    return [...this.files.keys()].filter((k) => k.includes(part));
  }

  private buffer(file: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(file);
    if (have) return Promise.resolve(have);
    let p = this.pending.get(file);
    if (!p) {
      p = fetch(BASE + file)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((a) => this.ctx.decodeAudioData(a))
        .then((b) => (this.buffers.set(file, b), b))
        .catch(() => null);
      this.pending.set(file, p);
    }
    return p;
  }

  /** Call from a user gesture. */
  resume(): void {
    if (this.ctx.state !== 'running') this.ctx.resume();
    this.master.gain.setTargetAtTime(0.9, this.ctx.currentTime, 0.4);
  }

  suspend(): void {
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
  }

  private picked = '';

  private pick(key: string): AudioBuffer | null {
    const k = this.find(key);
    if (!k) return null;
    const list = this.files.get(k)!;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === this.lastPick.get(k)) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
    this.lastPick.set(k, i);
    this.picked = list[i];
    const b = this.buffers.get(list[i]);
    if (!b) this.buffer(list[i]);
    return b ?? null;
  }

  private occluded(p: THREE.Vector3): number {
    this.dir.subVectors(p, this.ear);
    const d = this.dir.length();
    if (d < 0.5) return 0;
    this.dir.divideScalar(d);
    return this.physics.occlusion(this.ear.x, this.ear.y, this.ear.z, this.dir.x, this.dir.y, this.dir.z, d - 0.3) >= 0 ? 1 : 0;
  }

  private chain(o: PlayOptions, looping: boolean): { head: AudioNode; gain: GainNode; voice: Voice | null } {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = o.volume ?? 1;
    let voice: Voice | null = null;
    let tail: AudioNode = gain;
    if (o.position) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      const muffle = this.occluded(o.position);
      filter.frequency.value = muffle ? 750 : 18000;
      const occ = ctx.createGain();
      occ.gain.value = muffle ? 0.45 : 1;
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 1.2;
      pan.rolloffFactor = 1.25;
      pan.maxDistance = 120;
      pan.positionX.value = o.position.x;
      pan.positionY.value = o.position.y;
      pan.positionZ.value = o.position.z;
      gain.connect(filter).connect(occ).connect(pan);
      tail = pan;
      voice = { position: o.position.clone(), filter, gain: occ, level: 1, muffle, until: looping ? Infinity : 0 };
    } else if (o.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = o.pan;
      gain.connect(pan);
      tail = pan;
    }
    tail.connect(this.input);
    const wet = o.wet ?? (o.position ? 0.9 : 0.55);
    if (wet > 0) {
      const s = ctx.createGain();
      s.gain.value = wet;
      // Reverb is fed before the panner's distance loss would starve it, but after occlusion.
      (voice ? voice.gain : gain).connect(s).connect(this.send);
    }
    return { head: gain, gain, voice };
  }

  /** Plays one variation of a sound. Returns its duration, or 0 if nothing played. */
  play(key: string, o: PlayOptions = {}): number {
    const b = this.pick(key);
    if (!b || this.ctx.state !== 'running') return 0;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = (o.rate ?? 1) * (0.95 + Math.random() * 0.1);
    const { head, gain, voice } = this.chain(o, false);
    gain.gain.value *= this.trim.get(this.picked) ?? 1;
    src.connect(head);
    const when = this.ctx.currentTime + (o.delay ?? 0);
    src.start(when);
    if (voice) {
      voice.until = when + b.duration / src.playbackRate.value;
      this.voices.push(voice);
    }
    return b.duration;
  }

  /** Starts a looping sound; it begins as soon as its file has arrived. */
  loop(key: string, o: PlayOptions = {}): Loop {
    const ctx = this.ctx;
    const { head, gain, voice } = this.chain(o, true);
    if (voice) this.voices.push(voice);
    let src: AudioBufferSourceNode | null = null;
    let stopped = false;
    let rate = o.rate ?? 1;
    const k = this.find(key);
    if (k)
      this.buffer(this.files.get(k)![0]).then((b) => {
        if (!b || stopped) return;
        src = ctx.createBufferSource();
        src.buffer = b;
        src.loop = true;
        // A decoder that keeps the codec's lead-in and tail leaves a gap at the seam; loop only the sound itself.
        const file = this.files.get(k)![0];
        const length = Math.min(this.span.get(file) ?? b.duration, b.duration);
        const lead = Math.min(b.duration - length, 1105 / 48000);
        src.loopStart = lead;
        src.loopEnd = lead + length;
        src.playbackRate.value = rate;
        src.connect(head);
        src.start(0, lead + Math.random() * length);
      });
    return {
      setVolume: (v, glide = 0.15) => gain.gain.setTargetAtTime(v, ctx.currentTime, glide),
      setRate: (r) => {
        rate = r;
        src?.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.1);
      },
      stop: (fade = 0.2) => {
        stopped = true;
        gain.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
        if (voice) voice.until = ctx.currentTime + fade;
        src?.stop(ctx.currentTime + fade);
      },
    };
  }

  /** Per frame: move the microphone, pick the room, and re-test what stands between it and each source. */
  update(camera: THREE.Camera, room: Room): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.ear.copy(camera.position);
    this.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = this.ear.x;
      l.positionY.value = this.ear.y;
      l.positionZ.value = this.ear.z;
      l.forwardX.value = this.fwd.x;
      l.forwardY.value = this.fwd.y;
      l.forwardZ.value = this.fwd.z;
      l.upX.value = this.up.x;
      l.upY.value = this.up.y;
      l.upZ.value = this.up.z;
    } else {
      (l as any).setPosition(this.ear.x, this.ear.y, this.ear.z);
      (l as any).setOrientation(this.fwd.x, this.fwd.y, this.fwd.z, this.up.x, this.up.y, this.up.z);
    }
    if (room !== this.room || this.probe === 0) {
      this.room = room;
      for (const [name, r] of this.rooms) r.gain.gain.setTargetAtTime(name === room ? r.level : 0, t, 0.35);
    }
    // A few sources per frame are enough: walls do not move.
    const n = this.voices.length;
    for (let i = 0; i < Math.min(n, 4); i++) {
      const v = this.voices[this.probe++ % n];
      if (!v) continue;
      const m = this.occluded(v.position);
      if (m !== v.muffle) {
        v.muffle = m;
        v.filter.frequency.setTargetAtTime(m ? 750 : 18000, t, 0.12);
        v.gain.gain.setTargetAtTime(m ? 0.45 : 1, t, 0.12);
      }
    }
    if (this.probe % 120 === 0) this.voices = this.voices.filter((v) => v.until > t);
    this.probe++;
  }
}

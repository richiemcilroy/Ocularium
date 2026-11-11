import * as THREE from 'three/webgpu';
import type { Arms } from '../game/weapon';
import type { Player } from '../game/player';
import type { Level, Zone } from '../world/level';
import type { SurfaceKind } from '../world/builder';
import type { Audio, Loop } from './audio';

const FOOT: Record<SurfaceKind, string> = {
  stone: 'foot/stone',
  plaster: 'foot/stone',
  metal: 'foot/stone',
  wood: 'foot/wood',
  dirt: 'foot/dirt',
  grass: 'foot/grass',
  thatch: 'foot/grass',
};

const BLADE: Record<SurfaceKind, string> = {
  stone: 'sword/stone',
  plaster: 'sword/stone',
  metal: 'sword/clash',
  wood: 'sword/wood',
  dirt: 'foot/dirt',
  grass: 'foot/grass',
  thatch: 'foot/grass',
};

const ROOM: Record<Zone, 'outdoor' | 'hall' | 'small_room'> = { open: 'outdoor', yard: 'outdoor', gate: 'small_room', hall: 'hall' };

/** Decides what is heard and when: the wearer's own body and kit, the blade, the fires and the country around the fort. */
export class Soundscape {
  private wind: Loop | null = null;
  private gusts: Loop | null = null;
  private birds: Loop | null = null;
  private indoors: Loop | null = null;
  private winded = false;
  private fires: { position: THREE.Vector3; loop: Loop | null }[] = [];
  private distant: string[] = [];
  private nextDistant = 6;
  private gust = 0;
  private time = 0;
  private started = false;
  private tmp = new THREE.Vector3();

  constructor(
    private audio: Audio,
    private level: Level,
    private player: Player,
    private arms: Arms | null,
  ) {
    for (const f of level.flames) this.fires.push({ position: f.group.getWorldPosition(new THREE.Vector3()), loop: null });

    player.events.footstep = (surface, loudness, left) => {
      const v = 0.16 + 0.5 * loudness;
      audio.play(FOOT[surface] ?? 'foot/dirt', { volume: v, pan: left ? -0.14 : 0.14, rate: 0.96 + loudness * 0.08, wet: 0.5 });
      // Mail, belt and scabbard answer every step; louder the harder the foot comes down.
      if (loudness > 0.3) audio.play('gear', { volume: 0.1 + 0.3 * (loudness - 0.3), pan: left ? 0.1 : -0.1, wet: 0.35, delay: 0.02 });
    };
    player.events.land = (surface, impact) => {
      const v = Math.min(1, 0.35 + impact * 0.12);
      audio.play(audio.first('foot/land') ?? FOOT[surface], { volume: v, wet: 0.5 });
      audio.play(FOOT[surface] ?? 'foot/dirt', { volume: v * 0.8, wet: 0.5, delay: 0.03 });
      audio.play('gear', { volume: v * 0.6, wet: 0.35, delay: 0.015 });
      if (impact > 5) audio.play('voice/effort', { volume: 0.45, wet: 0.3, delay: 0.05 });
    };
    player.events.jump = () => {
      audio.play('gear', { volume: 0.3, wet: 0.35 });
      if (player.stamina < 0.5) audio.play('voice/effort', { volume: 0.35, wet: 0.3 });
    };

    if (arms) {
      arms.events.swing = (thrust, charge) => {
        // A blow with the whole body behind it moves more air, and costs a grunt.
        audio.play('sword/swing', { volume: (thrust ? 0.4 : 0.7) + 0.25 * charge, rate: (thrust ? 1.25 : 1) - 0.12 * charge, pan: 0.2, wet: 0.3, delay: thrust ? 0.02 : 0.06 });
        audio.play('gear', { volume: 0.22 + 0.15 * charge, wet: 0.3 });
        if (charge > 0.5 || player.stamina < 0.45 || Math.random() < 0.25) audio.play('voice/effort', { volume: 0.3 + 0.3 * Math.max(charge, 1 - player.stamina), wet: 0.3, delay: 0.05 });
      };
      arms.events.guard = (raised) => {
        audio.play(audio.first('gear/shield', 'gear') ?? 'gear', { volume: raised ? 0.35 : 0.22, pan: -0.25, wet: 0.3 });
      };
      arms.events.draw = () => audio.play('gear/draw', { volume: 0.7, pan: 0.2, wet: 0.3 });
    }
  }

  /** Steel on whatever it met. */
  blade(surface: SurfaceKind, point: THREE.Vector3, energy: number): void {
    this.audio.play(BLADE[surface] ?? 'sword/stone', { position: point, volume: 0.45 + 0.55 * Math.min(1, energy) });
  }

  /** Somebody else's boot coming down. */
  step(point: THREE.Vector3, surface: SurfaceKind, loudness: number): void {
    this.audio.play(FOOT[surface] ?? 'foot/dirt', { position: point, volume: 0.3 + 0.7 * loudness });
    if (loudness > 0.35) this.audio.play('gear', { position: point, volume: 0.25 * loudness });
  }

  /** The camera coming on or going dead, and the sound with it. */
  feed(on: boolean): void {
    this.audio.feed(on);
    if (on) {
      this.audio.beep(2350, 0.07, 0.1, 0.12);
      this.audio.beep(3100, 0.09, 0.1, 0.24);
    }
  }

  /** Steel into a body. */
  flesh(point: THREE.Vector3, energy = 1): void {
    this.audio.play('sword/flesh', { position: point, volume: 0.6 + 0.4 * Math.min(1, energy) });
  }

  /** Blade on blade. */
  clash(point: THREE.Vector3, energy = 1): void {
    this.audio.play('sword/clash', { position: point, volume: 0.6 + 0.4 * Math.min(1, energy) });
  }

  /** Blade or mace stopped by a shield. */
  shield(point: THREE.Vector3, energy = 1): void {
    this.audio.play('sword/shield', { position: point, volume: 0.6 + 0.4 * Math.min(1, energy) });
  }

  /** An armoured body going down, or a dropped weapon. */
  fall(point: THREE.Vector3, kind: 'body/fall' | 'body/hit' | 'sword/drop' = 'body/fall', volume = 1): void {
    this.audio.play(kind, { position: point, volume });
  }

  /** Someone else's voice or footfall in the world. */
  at(key: string, point: THREE.Vector3, volume = 1, rate = 1): number {
    return this.audio.play(key, { position: point, volume, rate });
  }

  /** The wearer's own voice: carried through the chest to the microphone, so barely any room on it. */
  own(key: string, volume = 1): void {
    this.audio.play(key, { volume, wet: 0.2 });
  }

  private start(): void {
    const a = this.audio;
    const wind = a.first('amb/wind', 'amb/breeze', 'amb/outdoor', 'amb/base');
    const birds = a.first('amb/birds', 'amb/birdsong', 'amb/forest');
    if (wind) this.wind = a.loop(wind, { volume: 0, wet: 0 });
    if (a.has('amb/wind_gusty')) this.gusts = a.loop('amb/wind_gusty', { volume: 0, wet: 0 });
    if (birds) this.birds = a.loop(birds, { volume: 0, wet: 0 });
    if (a.has('amb/room_tone')) this.indoors = a.loop('amb/room_tone', { volume: 0, wet: 0 });
    this.distant = a.matching('amb/').filter((k) => k !== wind && k !== birds && !/wind|breeze|birds|forest|base|outdoor|loop/.test(k));
    this.started = true;
  }

  update(dt: number, camera: THREE.Camera): void {
    const a = this.audio;
    if (!a.ready) return;
    if (!this.started) this.start();
    this.time += dt;
    const zone = this.level.zoneAt(camera.position);
    a.update(camera, ROOM[zone]);

    // Weather: wind comes in slow gusts, and stone walls take most of it away.
    this.gust = 0.5 + 0.3 * Math.sin(this.time * 0.11) + 0.2 * Math.sin(this.time * 0.37 + 1.3);
    const shelter = zone === 'hall' ? 0.22 : zone === 'gate' ? 0.5 : zone === 'yard' ? 0.75 : 1;
    this.wind?.setVolume(0.34 * shelter * (0.55 + 0.45 * this.gust), 0.6);
    this.gusts?.setVolume(0.3 * shelter * Math.max(0, this.gust - 0.55) * 2, 0.9);
    this.birds?.setVolume(0.22 * (zone === 'hall' ? 0.12 : shelter), 0.6);
    // Under a roof what is left is the close, dead air of the room.
    this.indoors?.setVolume(zone === 'hall' ? 0.07 : zone === 'gate' ? 0.04 : 0, 0.8);

    // Things heard from far off: crows, a cock, a dog, somebody at work.
    this.nextDistant -= dt;
    if (this.nextDistant <= 0 && this.distant.length) {
      this.nextDistant = 9 + Math.random() * 22;
      const key = this.distant[Math.floor(Math.random() * this.distant.length)];
      const ang = Math.random() * Math.PI * 2;
      const r = 28 + Math.random() * 40;
      this.tmp.set(camera.position.x + Math.cos(ang) * r, 3 + Math.random() * 14, camera.position.z + Math.sin(ang) * r);
      a.play(key, { position: this.tmp, volume: 1.6 });
    }

    // Fires crackle only where they can be heard.
    for (const f of this.fires) {
      const near = f.position.distanceToSquared(camera.position) < (f.loop ? 26 * 26 : 22 * 22);
      if (near && !f.loop) {
        // A small flame crackles quicker and thinner than a hearth.
        const key = a.first('fire/campfire', 'fire/torch', 'fire/crackle', 'fire/loop', 'fire');
        if (key) f.loop = a.loop(key, { position: f.position, volume: 0.7, rate: 1.08 + Math.random() * 0.2 });
      } else if (!near && f.loop) {
        f.loop.stop(0.5);
        f.loop = null;
      }
    }

    // Breath: one for each time the chest falls, so what is heard is what is seen. Nothing at rest; a quiet
    // breath once the wearer has been working; a hard one when they are blown.
    const p = this.player;
    if (p.exhaled && !p.dead && p.exertion > 0.16) {
      const e = p.exertion;
      const hard = THREE.MathUtils.smoothstep(e, 0.45, 0.8);
      const set = a.slices(Math.random() < hard ? 'voice/breath/heavy' : 'voice/breath/calm');
      if (set.length) a.playSlice(set[Math.floor(Math.random() * set.length)], { volume: 0.05 + 0.4 * (e - 0.16), rate: 0.94 + 0.12 * e, wet: 0.1 });
    }
    // Out of wind altogether: one ragged gasp.
    if (p.winded && !this.winded && a.has('voice/breath/gasp')) a.play('voice/breath/gasp', { volume: 0.5, wet: 0.1 });
    this.winded = p.winded;
  }
}

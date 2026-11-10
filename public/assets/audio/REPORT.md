# Ocularium audio library: build report

Built 2026-11-10 by `scripts/build.py` (work root `/Volumes/CapGPUIBuild/ocularium-work/audio/`).

**Read this first: nothing in this library has been listened to.** I have no way to hear audio. Every judgement below comes from
measurements (duration, peak, RMS, band energies, roll-off, tonality, onset, tail, loop seam, clip detection) and from looking at
waveform + spectrogram contact sheets (`qa/*.png` in the work root). That is enough to catch silence, clipping, wrong length,
slow onsets, band-limited or pitched material and obvious synthesis. It is **not** enough to say that a sound is convincing.
Treat every category as "measured, not auditioned" and budget a listening pass before shipping.

## Totals

- 236 audio files (223 one-shots, 10 loops, 3 impulse responses) + `manifest.json`: **7.02 MB**. With `LICENSES.md` and
  `REPORT.md` the directory is about 7.1 MB (limit 45 MB).
- 51 sources: 37 CC0, 8 public domain (Wikimedia Commons / PDSounds), 3 CC-BY 3.0, 3 CC-BY 4.0. Nothing NC / ND / SA / GPL /
  "personal use" / unstated / AI-generated. Details and the credits block to reproduce are in `LICENSES.md`.
- Every stated minimum is met. `sword/stone` (5) and `prop/pottery_break` (3) are exactly at the minimum.
- No preview-quality or watermarked files were used. 54 outputs do come from lossy (OGG / MP3) originals; see "Source quality".

## Counts

| Category | Min | Delivered | Durations (s) | Sources |
|---|---:|---:|---|---|
| `foot/dirt` | 8 | 10 | 0.16-0.60 | Fantozzi sand 01-06; Vehicle soil/mud 07, 08, 10; TinyWorlds gravel 09 |
| `foot/stone` | 8 | 10 | 0.17-0.36 | Fantozzi stone 01-06; TinyWorlds 07; OwlishMedia "hard" 08-10 |
| `foot/wood` | 8 | 10 | 0.11-0.33 | Vehicle boots 01-04; TinyWorlds 05-07; rubberduck 08-10 |
| `foot/grass` | 6 (optional) | 8 | 0.33-0.60 | OwlishMedia 01-07; TinyWorlds leaves 08 |
| `foot/land` | 3 | 4 | 0.24-0.60 | Vehicle boot jumps 01-03; OwlishMedia stumble 04 |
| `gear` | 8 | 12 | 0.30-1.23 | Vehicle 01-03; artisticdude 04-06; dklon 07; Kenney 08-10; OwlishMedia 11-12 |
| `gear/draw` | 2 | 3 | 0.49-1.38 | Still North weapon textures |
| `gear/sheathe` | 2 | 3 | 1.05-1.50 | Still North weapon textures |
| `sword/swing` | 8 | 12 | 0.16-0.29 | qubodup bamboo-stick swishes (all 12) |
| `sword/clash` | 10 | 12 | 0.20-0.48 | Still North weapon impacts (all 12) |
| `sword/shield` | 6 | 8 | 0.23-0.47 | Still North weapon impacts (all 8) |
| `sword/stone` | 5 | 5 | 0.18-0.53 | spookymodem pick-on-rock 01-02; BMacZero metal clinks 03-05 |
| `sword/wood` | 5 | 6 | 0.18-0.32 | Still North 01-05; Kenney 06 |
| `sword/flesh` | 8 | 10 | 0.20-1.20 | qubodup 01-02; dklon 03-04; Independent.nu 05-08; Vehicle 09; Kenney 10 |
| `sword/drop` | 3 | 5 | 0.64-1.41 | rubberduck 01, 03, 04, 05; bart workshop 02 |
| `body/fall` | 5 | 6 | 0.20-0.38 | dklon (all 6) |
| `body/hit` | 5 | 8 | 0.17-0.69 | dklon chest hits 01-04; qubodup punches 05-08 |
| `voice/effort` | 8 | 10 | 0.23-0.52 | qubodup strain 01-06; HaelDB 07-10 |
| `voice/pain` | 8 | 10 | 0.48-0.90 | Michel Baradari 01-06; thebardofblasphemy 07-10 |
| `voice/death` | 5 | 6 | 0.57-2.02 | Michel Baradari 01-03; thebardofblasphemy 04-06 |
| `voice/alert` | 4 | 5 | 0.38-0.94 | HaelDB yells (all 5) |
| `voice/breath/gasp_NN` | 3 | 4 | 0.68-1.20 | OwlishMedia |
| `door/open` | 3 | 4 | 1.40-3.00 | laleksic 01; rubberduck 02, 04; W. Forster hinge 03 |
| `door/close` | 3 | 4 | 0.26-0.50 | laleksic 01; rubberduck 02; Kenney 03-04 |
| `door/gate` | 2 | 4 | 0.42-1.77 | bart chain winch 01-02; rubberduck chains 03-04 |
| `prop/wood_knock` | 6 | 8 | 0.21-0.60 | bart workshop 01-05; rubberduck 06-07; Kenney 08 |
| `prop/bucket` | 3 | 4 | 0.36-0.67 | Vehicle accessory (all 4) |
| `prop/metal` | 4 | 6 | 0.41-1.14 | bart cast-iron pans 01-05; Vehicle hammer hit 06 |
| `prop/pottery_break` | 3 | 3 | 0.39-0.99 | rubberduck breaking |
| `prop/wood_break` | 3 | 5 | 0.16-0.65 | Vehicle 01-02; rubberduck 03-05 |
| `amb/horse` (one-shot) | - | 1 | 2.17 | Commons "Wiehern" |
| `amb/dog` | - | 5 | 0.27-0.35 | Brandon Morris 01-03; pauliuw 04-05 |
| `amb/chicken` | - | 3 | 1.32-2.81 | PDSounds via Commons |
| `amb/rooster` | - | 2 | 2.23-3.00 | PDSounds via Commons |
| `amb/goat` | - | 2 | 0.58-0.60 | PDSounds via Commons |
| `amb/crow` | - | 5 | 0.54-1.50 | zeroisnotnull 01; Commons hooded crow 02-03; IgnasD 04-05 |

Loops (in `manifest.json` under `"loops"`):

| Loop | Length | Channels | Seam (dB) | Source |
|---|---:|---|---:|---|
| `amb/wind.mp3` | 40.0 s | stereo | -0.9 | Thimras "Park ambiences", wind take |
| `amb/wind_gusty.mp3` | 30.0 s | stereo | +1.7 | same recording, a gustier stretch |
| `amb/birds.mp3` | 32.0 s | stereo | -0.8 | PDSounds "Birdsong mild sunny day" |
| `amb/rain.mp3` | 30.0 s | mono | -0.6 | Ylmir "Rain (loopable)" |
| `amb/crows.mp3` | 40.0 s | mono | +1.4 | **assembled**: park-wind bed + 6 crow calls from 3 sources |
| `amb/room_tone.mp3` | 20.0 s | mono | +1.8 | **assembled**: 21 quiet gaps between foley hits (dklon) |
| `fire/torch.mp3` | 20.0 s | mono | -0.6 | PDSounds "Dry grass burning in open fireplace" |
| `fire/campfire.mp3` | 25.0 s | mono | +0.7 | PagDev "Fireplace Sound loop" |
| `voice/breath/calm.mp3` | 10.0 s | mono | +1.0 | OwlishMedia "breath-male" |
| `voice/breath/heavy.mp3` | 4.2 s | mono | **+4.4** | same take, the faster section |

"Seam" is the RMS level of the first 50 ms relative to the last 50 ms (`seamHeadTailDb`); near 0 means the level does not step
at the loop point. The build fails above 3 dB (6 dB for the two breathing loops, which are cut between breaths).

Impulse responses (under `"ir"`; stereo 48 kHz 16-bit WAV, direct sound within 0.5 ms of t=0, peak -3 dBFS):

| IR | Length | RT60 (est.) | L/R correlation | Source |
|---|---:|---:|---:|---|
| `ir/small_room.wav` | 0.99 s | 0.50 s | 0.27 | Maes Howe (stone chambered cairn), OpenAIR, ORTF stereo pair |
| `ir/hall.wav` | 2.60 s | 1.55 s | 0.70 | Heslington Church, OpenAIR, decoded from B-format |
| `ir/outdoor.wav` | 1.20 s | 0.51 s | 0.94 | Forest in Wheldrake Wood, OpenAIR, decoded from B-format |

## What was done to the audio

No synthesis, no pitch shifting, no time stretching, no compression, no added reverb, no noise reduction. The only processing:

- **One-shots:** event detection and splitting of multi-hit files, leading trim so the first transient is within 5 ms of the start,
  trailing trim, mono, 48 kHz, 3 ms fade in, 15 ms fade out, peak normalised to -1.5 dBFS, `libmp3lame -q:a 2`.
  Takes longer than the category's maximum (3.0 s at most) are skipped, or cut with a fade where the sound has already
  died down by the cut point. `door/open/03` and `amb/rooster/01` are cut at 3.0 s while still sounding.
- **High-pass filters** (rumble and handling-noise removal; 2-pole below 50 Hz, 4-pole from 50 Hz up). Corner frequencies:
  footsteps 70 Hz, landings 50, gear 80, swings 150, flesh 60, body 50, wood knocks 50, bucket 60. Loops: wind 40, gusty wind 60,
  birds 200, rain 40, room tone 80, torch 60, campfire 60, breathing 60. This is the one deliberate spectral change.
- **Loops:** a stretch of the recording is cut and its end is crossfaded into its start (1 s equal-power), with the loop point
  moved by up to 2 s to where the level is steady; peak -6 dBFS. The two breathing loops are instead cut from one quiet point
  between breaths to another, with a 30 ms crossfade, so whole breaths are kept. `amb/wind`, `amb/wind_gusty` and `amb/birds`
  are stereo; the other loops are mono.
- **Two loops are assembled** rather than cut from one continuous take, and are marked `"assembled": true` in the manifest:
  `amb/crows` (a real wind bed with six real crow calls laid over it at irregular intervals) and `amb/room_tone` (the quiet gaps
  between hits in several foley recordings, crossfaded end to end). Both are real recordings, edited. If "no designed sounds" is
  read strictly, these two are the ones to replace.
- **IRs:** trimmed so the direct sound is at t=0, truncated with a fade, 48 kHz 16-bit, -3 dBFS. The hall and outdoor IRs were
  published as first-order B-format; stereo was derived with two virtual cardioids at +-55 degrees. That is a standard decode but
  it is a computation on the recording, not a stereo recording.

Peak tolerances after MP3 encoding: one-shots land within +-0.5 dB of -1.5 dBFS, loops within +-0.35 dB of -6.

### Build-time checks (the build fails if any trip)

Silent output; peak off target; duration outside the category's bounds; late onset; category below its minimum; loop level step
or sample discontinuity at the loop point; decoded loop length not equal to the intended length; IR not stereo 48 kHz or direct
sound not at t=0; total over 45 MB. Candidate takes with flat-topped (clipped) source samples, weak attacks or late onsets are
skipped before that and the next candidate is used. Two files are allowed through the source clip check on purpose and carry
`"clippedSource": true`: `sword/stone/01` and `02` (see below).

**Onsets against the brief's "within about 5 ms":** the measured onset (`onsetMs` in the manifest) is at most 4.1 ms in 28 of the
36 one-shot categories. The worst file per category is 5-9 ms in `foot/wood` (5.4), `foot/dirt` (6.1), `sword/flesh` (6.1),
`foot/land` (6.4), `amb/dog` (6.8), `prop/wood_break` (7.5) and `gear` (8.6). `foot/grass` goes up to **45 ms**: grass steps swell
rather than click, and trimming harder would cut into the sound. If footstep timing feels late on grass, that is why.

The clip check for lossy sources is a heuristic. A decoded OGG/MP3 no longer has flat tops, so those were rejected only when
their decoded peak exceeded +1.5 dBFS. A lossy file that was clipped before encoding and stays under that could have passed.

## Using the files in the game

- `manifest.json`: `{ "<category>": [ { file, duration, peakDb, rmsDb, source, onsetMs, attackDb } ] , "loops": { "<name>": {...} },
  "ir": { "small_room" | "hall" | "outdoor": {...} } }`. `source` is the id used as a heading in `LICENSES.md`.
  Loop entries add `channels`, `samples`, `seamHeadTailDb`, `crossfade`, and `assembled` / `sources` where relevant.
  IR entries add `rt60`, `directMs`, `lrCorrelation`.
- **MP3 looping:** MP3 adds encoder delay and padding. ffmpeg writes a LAME info header and the files decode to exactly `samples`
  samples in ffmpeg (`lengthDeltaSamples: 0`). I did not test browsers. If a browser's `decodeAudioData` ignores the tag the
  buffer will be about 50 ms longer and a naive `loop = true` will click or gap. Set `loopStart = 0` and
  `loopEnd = samples / 48000`, and test Safari specifically.
- **Levels are normalised per file, not mixed.** A footstep and a sword clash both peak at -1.5 dBFS. Relative loudness has to
  be set in the game. Particular cases:
  - `fire/torch`: RMS is -42 dBFS at a -6 dBFS peak because one loud pop sets the peak. It needs a lot of gain, or it will be
    inaudible; the pop will then be prominent.
  - `amb/room_tone`: RMS -19 dBFS. It is noise-floor material normalised up; play it very quietly.
  - `amb/rooster`: RMS -10 dBFS, far denser than everything else; turn it well down.
- `amb/wind` is wide (L/R correlation 0.12). `ir/outdoor` is close to mono (0.94), so it adds slap-back but little width.

## Category notes: what I can and cannot vouch for

"Looks right" below means the waveform and spectrogram look like the named thing: broadband transient with natural decay,
no steady pitched partials, no hard band edge. It does not mean it sounds good.

### Looks right on measurement

- **`sword/clash`** (12): strongest category. Still North recordings of real medieval weapons striking each other, lossless,
  broadband to 16 kHz, sharp onsets, ringing decays. All from one pack, so expect one consistent recording character.
- **`gear/draw`, `gear/sheathe`** (3 each): same team; scrapes with a clear metallic ring. Only one above the minimum each.
- **`foot/stone` 01-06, `foot/dirt` 01-06**: Fantozzi's left/right step sets, lossless, broadband. "Dirt" here is **sand**.
- **`voice/pain`, `voice/death`**: two different male voices (Baradari; thebardofblasphemy), so two voices will be recognisable
  as two people. Baradari's set is CC-BY.
- **`prop/metal` 01-05**: cast-iron pans struck, clean ringing, unclipped takes only. Pans, not armour or tools.
- **IRs**: all three have a clean direct spike and smooth exponential decay.

### Usable but with a stated compromise

- **`sword/swing`: not a sword.** All 12 are a **bamboo stick** swung past a microphone. Energy sits between 70 Hz and 3 kHz
  with no high "air" at all, 0.16-0.29 s long, loudest 40-80 ms in. Real katana swings from the Still North set were tried and
  dropped (the whoosh was barely above the noise floor and started late). Expect a soft low "whup", not a bright blade sound.
- **`sword/shield`: not a shield.** These are blades and axe heads hitting a **wooden haft**. No recording of a blade on a wooden
  or metal shield was found under an acceptable licence.
- **`sword/stone`: weakest combat category, exactly at minimum.** 01-02 are a mining pick on rock (CC-BY) whose source transients
  are clipped (flagged `clippedSource`). 03-05 are short metal clinks from a pack that does not say what was struck, cut off at
  about 0.2 s, with a pitched ring. No recording of a sword on stone was found.
- **`sword/wood`** (6): 01-05 are Still North "haft on blade" takes, a wooden weapon haft struck against a blade. That is the
  same kind of event, from the same session, as the "blade on haft" takes used for `sword/shield`, so the two categories will
  sound alike. 06 is a Kenney "chop" whose recording is not described.
- **`sword/flesh`** (10): 01-02 "impact meat" (qubodup), 03-04 squishes (dklon), 05-08 wet impact splats (Independent.nu, MP3
  originals), 09 **a knife cutting an apple**, 10 a Kenney "knife slice". None is a blade hitting a body. The set is uneven in
  character and length (0.20-1.20 s).
- **`sword/drop`** (5): metal objects falling on a hard floor, not specifically swords. 04 has energy only above 3 kHz and a
  strong pitched component; it may read as a small trinket rather than a weapon.
- **`foot/wood`: dull.** 9 of 10 have 99 % of their energy below 5 kHz; they are low thumps. 01-04 are "boots, leather" steps
  whose surface the pack does not name. 08-10 (rubberduck) roll off between 0.7 and 2.5 kHz and build late. Hollow boards may
  be exactly right for a wooden floor, or they may sound muffled; I cannot tell which.
- **`foot/stone` 07-10** are a different, much sparser and duller character than 01-06: 07 has almost nothing above 3 kHz, and
  08-10 are "hard footstep" files whose surface the pack does not name, a single click with 55-65 % of the energy below 300 Hz.
  If the set sounds inconsistent, use 01-06 only (which is below the minimum of 8).
- **`foot/dirt` 07-10**: 07-08 are very short (0.16-0.23 s) "soil" steps whose spectrograms show hard band edges; 09 is
  **gravel**; 10 is a sparse **mud** step (RMS -34 dBFS, far quieter than the others at the same peak) with a faint steady
  low-frequency line under it. The category mixes sand, soil, gravel and mud.
- **`foot/grass`** (8): 01-07 are one pack; 48-69 % of their energy is in 70-300 Hz and the spectrograms show a steady
  low-frequency band running under each step (rumble or hum left after the 70 Hz filter, I cannot tell which). 08 is dry
  **leaves**, much brighter than the rest. Slowest onsets in the library (see above).
- **`foot/land`** (4): dull thuds (roll-off 1-4 kHz). 02 and 03 have a quieter first touch before the main thud; 04 is a stumble
  with more than one step in it.
- **`gear`** (12): 01-03 leather quiver squeezes, 04-05 chain-mail, 06 light armour, 07 leather rustle, 08-10 cloth and belt
  (Kenney), 11-12 cloth. Five sources, so the character changes from file to file; choosing randomly across all 12 will mix
  leather creak, mail and cloth. 10 ("clothBelt") has ringing partials. Onsets are soft by nature.
- **`body/fall`** (6): all from one CC-BY pack (dklon): 01-04 "body hit on ground", 05-06 "heart to ground" (the pack's own file
  name; I do not know what was dropped). Short thumps (0.20-0.38 s), 4 of 6 dull. Nothing with the length of an armoured body
  collapsing.
- **`body/hit`** (8): chest hits and punches; 6 of 8 have more than 35 % of their energy below 70 Hz. On small speakers they will
  nearly vanish.
- **`voice/effort`** (10) and **`voice/alert`** (5): band-limited (9 of 10 and 4 of 5 roll off below 5 kHz), which suggests
  low-bitrate or low-sample-rate originals. **The "alert" files are wordless yells**, not shouted words. No CC0/CC-BY recording
  of period-appropriate shouted speech was found.
- **`voice/breath`**: calm and heavy are cut from the **same single recording** of one man breathing; "heavy" is just the faster
  section and is only 4.2 s long, so its repetition will be noticed. The level either side of its loop point differs by 4.4 dB;
  between breaths that may be harmless, or it may be heard as a bump. Treat `heavy` as a placeholder. The four gasps
  (`gasp_01`-`gasp_04`) are from the same pack; the first three are consecutive gasps from one file.
- **`door/open`** (4): creaks. 01 has a stretch of digital silence and then clicks; 03 is cut at the 3.0 s limit mid-creak.
- **`door/close`** (4): 01 is trimmed hard to the slam (0.34 s), dropping its quiet lead-in. 02 is a "wood slam", not
  necessarily a door. 03 (Kenney) contains a pitched squeak.
- **`door/gate`: no heavy gate or portcullis.** 01-02 are a hand chain-winch ratchet, with gated (digitally silent) gaps between
  clicks. 03-04 are light chain rattles with energy only above 3 kHz. Nothing here has the weight of an iron gate.
- **`prop/wood_knock`** (8): mostly dull knocks on workshop timber. **`prop/bucket`** (4): 01-03 are a **wooden bowl** being put down
  on wood and 04 is a wooden spoon dropped into it, used as a stand-in; no wooden bucket recording was found. **`prop/metal` 06** is a hammer hit.
- **`prop/pottery_break`** (3, at minimum): files named only "breaking_01-03" in a pack that does not state the material. They
  could be pottery, glass or tile; I cannot tell from the signal.
- **`prop/wood_break`** (5): 01-02 are **twigs** snapping, so small-scale; 03-05 are rubberduck "wood breaking / cracking".
  01, 02 and 04 are trains of cracks with the loudest one about 60 % of the way in, so they do not start with their biggest
  transient. Nothing here is a plank, crate or door being smashed.
- **Animals:** all from lossy originals and all band-limited. **Horse: one whinny only; no snort was found.** It is strongly
  pitched and dull. Dog 04-05 show a hard band edge typical of low-bitrate audio. Both rooster calls have a flat, dense
  envelope (crest factor 6-7 dB) that suggests the recorder's limiter was working; 01 is cut at 3.0 s. Goat 02 ends while still
  loud (the animal had not finished), so it has a fast fade rather than a natural tail.
- **`amb/wind`, `amb/wind_gusty`**: both from one recording made in a park in Adelaide, Australia. The stretches were chosen
  for steady level; birds or distant modern sounds (traffic, aircraft) cannot be ruled out from a spectrogram.
- **`amb/birds`: dense, not sparse.** The brief asked for sparse countryside birds. This is a continuous chorus, from an
  MP3-then-OGG transcode, high-passed at 200 Hz. The species and the recording location are not documented.
- **`amb/rain`**: the source is stereo; it is delivered mono.
- **`amb/crows`**: assembled (see above); the calls are a hooded crow and two packs of unspecified "crows"; none is confirmed to be a rook.
- **`amb/room_tone`: not a stone room.** It is the noise floor of a modern recording room, stitched from gaps between foley
  hits. No real recording of an empty stone interior was found under an acceptable licence.
- **`fire/torch`**: burning dry grass in a fireplace, used as the lighter, cracklier of the two fires. Not a torch.
  **`fire/campfire`**: 89 % of its energy is between 70 and 300 Hz, a low roar with little crackle.

## Not found

- Sword on stone; blade on shield; a real sword swing that survived QA.
- Heavy gate, drawbridge or portcullis.
- Horse snort; additional horse sounds.
- Wooden bucket; pottery of confirmed material.
- Sparse countryside birdsong; rooks specifically.
- Real stone-room tone.
- Shouted alert words; a second breathing recording for "heavy".
- Plate-armour clank; a long armoured body fall; a heavy wooden object breaking.
- Distant village bed as a loop (only animal one-shots are provided).

## Anything synthetic?

Nothing was knowingly included that is synthesised. Items I could not rule out from the page or the signal:

- **Kenney** files (`gear/08-10`, `sword/wood/06`, `sword/flesh/10`, `door/close/03-04`, `prop/wood_knock/08`): the pack pages
  do not describe how the sounds were made. Kenney's mining impacts were rejected because their spectrograms show a few pure
  sustained partials, which looks synthetic; the files kept do not show that.
- **rubberduck** packs (`foot/wood/08-10`, `door/open/02, 04`, `door/close/02`, `door/gate/03-04`, `sword/drop/01, 03-05`,
  `prop/wood_knock/06-07`, `prop/pottery_break`, `prop/wood_break/03-05`): the pages do not describe how the sounds were made
  either, and several files are heavily band-limited.
- `sword/stone/03-05` and `sword/drop/04`: strongly pitched ringing. Consistent with struck metal, but that is the same signature
  a synthesised "ting" would have.

If a strict reading is needed, these are the files to audition first.

## Source quality

54 of 236 outputs derive from OGG or MP3 originals (Kenney, TinyWorlds and rubberduck packs, Independent.nu, IgnasD, Ylmir, all
Wikimedia Commons items; the PDSounds items on Commons are OGG transcodes of MP3). They are re-encoded once more to MP3 here.
Everything else comes from WAV or FLAC.

## Licensing notes

- The OpenAIR site's TLS certificate had expired on the day of the build. I did not bypass certificate checks. The licence
  statements were read from the Internet Archive copy of each page, and the files were downloaded from `webfiles.york.ac.uk`
  (valid certificate). Worth re-reading the three live pages once the certificate is renewed.
- HaelDB's packs are dual-licensed OGA-BY 3.0 / CC0 and are used under CC0.
- Three CC-BY 3.0 packs and three CC-BY 4.0 IRs require credit; the exact text is in `LICENSES.md`. 25 + 3 files depend on it.
  Dropping the CC-BY 3.0 material would remove all of `body/fall` (6), `body/hit/01-04`, `voice/pain/01-06`,
  `voice/death/01-03`, `sword/stone/01-02`, `sword/flesh/03-04`, `gear/07` and the room tone, taking `body/fall`,
  `voice/death` and `sword/stone` below their minimums.
- 36 further sources were catalogued and not used (listed with licences in `scripts/sources.json` in the work root). Among
  them: one CC-BY 3.0 fire loop, two CC-BY 4.0 horse whinnies and two more OpenAIR IRs.

## Rebuilding

```
cd /Volumes/CapGPUIBuild/ocularium-work/audio
export TMPDIR=$PWD/tmp
./venv/bin/python -I scripts/build.py            # full build into ./out, QA sheets into ./qa
./venv/bin/python -I scripts/build.py --publish  # full build, then mirror ./out to public/assets/audio
./venv/bin/python -I scripts/qa_stats.py         # per-file band / roll-off / tonality table
./venv/bin/python -I scripts/docs.py             # regenerate LICENSES.md
```

Selections live in `scripts/selection.py`; source metadata in `scripts/sources.json`. `--publish` uses `rsync --delete` but
leaves `LICENSES.md` and `REPORT.md` in place.

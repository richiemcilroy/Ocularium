# Licences and sources for the soldier character

Everything shipped in this folder (`soldier.glb`, the `soldier_cloth_base_*.jpg` variants, the `preview/` renders) is built from CC0 sources plus geometry and texture layers written for this project. No attribution is legally required. The sources are recorded here anyway.

- No AI-generated meshes or textures were used.
- No source needed a login or an account.
- All downloads were made on 2026-11-10.

## Assets that are part of the shipped files

### MakeHuman system assets: CC0

- URL: https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
- Licence: CC0 1.0
- Used for: the base human mesh and its shape targets (hands, forearms, neck, face), the "game engine" skeleton and its skin weights, the low-poly eyes with `brown_eye.png`, and the `eyebrow001` eyebrows.

### MakeHuman community asset packs: CC0

Each pack is published as `https://files.makehumancommunity.org/asset_packs/<pack>/<pack>_cc0.zip`. The pack page `https://static.makehumancommunity.org/assets/assetpacks/<pack>.html` lists every asset in the pack with its author and licence; all of those used here are marked CC0.

| Pack | Asset | Author | Licence | Used for |
|---|---|---|---|---|
| `skins02` | `jartur69_middleage_slavic_male_with_genitals_and_beard` | jartur69 | CC0 | Skin base colour for the face, neck and hands |
| `hands01` | `jujube_knobby_knuckles` | jujube | CC0 | Hand shape target, strength 0.45 |
| `hands01` | `mindfront_hand_thenar_eminence`, `mindfront_hand_hypothenar` | Mindfront | CC0 | Hand shape targets, strength 0.6 and 0.5 |
| `arms01` | `mindfront_arm_wrist_ulna`, `mindfront_arm_lower_shape` | Mindfront | CC0 | Wrist and forearm shape targets, strength 0.7 and 0.5 |
| `suits02` | `rehmanpolanski_viking_boots` | Rehman Polanski | CC0 | Boot mesh and its `BootsViking.png` colour texture |

### Poly Haven textures: CC0

Asset pages are `https://polyhaven.com/a/<id>`; files were fetched at 2k through `https://api.polyhaven.com/files/<id>`. Licence: CC0 1.0 (https://polyhaven.com/license).

| Asset id | Used for |
|---|---|
| `rough_linen` | Gambeson weave: colour, height and roughness |
| `caban` | Wool cloth of the hose |
| `brown_leather` | Belt, strap, pouch and boot leather detail |
| `rusty_metal_02` | Wear and rust breakup on the helmet steel |
| `farmland_overcast` (HDRI) | Lighting of the preview renders only; not in the GLB |

### ambientCG: CC0

- `Chainmail001`: https://ambientcg.com/view?id=Chainmail001, downloaded from https://ambientcg.com/get?file=Chainmail001_2K-JPG.zip
- Licence: CC0 1.0 (https://docs.ambientcg.com/license/)
- Used for: the mail of the coif (the colour, opacity, displacement and roughness maps). Only the JPEG maps in the archive were used.

### Quaternius Universal Animation Library, Standard tier: CC0

- URL: https://quaternius.com/packs/universalanimationlibrary.html, downloaded from https://quaternius.itch.io/universal-animation-library as `Universal Animation Library[Standard].zip` through itch.io's free download, with no account.
- SHA-256 of the zip: `cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724`
- Licence: CC0 1.0 Universal. The archive's `License.txt` reads "CC0 1.0 Universal ... Models by @Quaternius".
- Used for: the motion of the eight animation clips in `soldier.glb` (`Idle_Loop`, `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop`, `Sword_Idle`, `Sword_Attack`, `Hit_Chest`, `Hit_Head`), retargeted onto this skeleton. No Quaternius mesh or texture is shipped.

### Made for this project

Modelled and textured by script in Blender, with no third-party source beyond the textures above: gambeson, skirt and collar, hose, belt, buckle, strap, pouch, mail coif geometry, kettle helmet, the closed neck stump, the preview sword, all UV layouts, quilting, folds, dirt and wear layers, the skin normal map, and the three outfit colour variants.

## Tools

Tools are not redistributed here, and their licences do not apply to the files they produce.

| Tool | Version | URL | Licence | Used for |
|---|---|---|---|---|
| Blender | 4.5.16 LTS, macOS arm64 | https://download.blender.org/release/Blender4.5/ (`blender-4.5.16-macos-arm64.dmg`, SHA-256 `c5cd40979f30033bc55ca84fccd00f2c1ddebb1d2f41618f220ef1f596d8b0f6`) | GPL-3.0-or-later | Modelling, baking, retargeting, rendering |
| glTF Blender I/O | 4.5.51, bundled with Blender | https://github.com/KhronosGroup/glTF-Blender-IO | Apache-2.0 | GLB export and re-import |
| MPFB | 2.0.18 | https://extensions.blender.org/add-ons/mpfb/ | GPL-3.0-or-later for the code; bundled data CC0 | Generating the MakeHuman body and rig |
| three.js | 0.187.0 (npm) | https://threejs.org/ | MIT | Load and playback verification in Node |
| FFmpeg | system install | https://ffmpeg.org/ | LGPL/GPL | Assembling the animation contact sheets |

## Downloaded but not used in the shipped files

Fetched while evaluating options; nothing from them is in this folder.

- MakeHuman community packs `hats02` and `gloves01` (CC0)
- Poly Haven: `fabric_leather_01`, `fabric_leather_02`, `metal_plate`, `metal_plate_02`, `rusty_metal_04`, `poly_wool_herringbone`, `knitted_fleece`, `hessian_230`, and the HDRI `kloofendal_overcast_puresky` (all CC0)
- ambientCG `Chainmail004` (CC0)

## Sources ruled out

- grab3d "Man Base Mesh": AI-generated and has no finger bones.
- Mixamo, Sketchfab, CGTrader, Renderpeople, ActorCore: login required.
- Quaternius character meshes: too stylised for the body. Only the animation library was used.

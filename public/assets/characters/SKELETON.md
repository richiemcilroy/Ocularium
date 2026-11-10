# soldier.glb: skeleton, meshes, materials, clips

A late 13th / 14th century man-at-arms: quilted linen gambeson, wool hose, leather boots, belt and pouch, mail coif with mantle, kettle helmet.
Every number in this file was read back from the shipped `soldier.glb` (three r187 `GLTFLoader` and the raw glTF JSON), not from the Blender source.

## Conventions

| | |
|---|---|
| Format | glTF 2.0 binary, no extensions, 12.19 MB |
| Units | metres |
| Up | +Y |
| Facing | +Z (toes and face point to +Z) |
| Sides | the character's left is +X, so `_l` bones have positive X |
| Origin | on the ground between the feet; lowest vertex is at y = 0.000 |
| Height | 1.802 m to the top of the helmet; the skull crown is about 1.777 m |
| Bounds (rest) | min (-0.571, 0.000, -0.119), max (0.571, 1.802, 0.374) |
| Skinning | one skin, 55 joints, 4 influences per vertex, normalised |
| Vertex attributes | POSITION, NORMAL, TANGENT, TEXCOORD_0, JOINTS_0, WEIGHTS_0 |

Scene graph: `Armature` (identity transform) holds the six mesh nodes and the root bone `Root`.

## Meshes

| Node | Material | Triangles | Vertices | Contents |
|---|---|---|---|---|
| `body_skin` | skin | 28,906 | 15,748 | Hands (25,536 triangles), wrists and forearms under the cuffs, neck with a closed neck stump |
| `body_clothes` | cloth | 15,144 | 8,121 | Gambeson with skirt and collar, hose |
| `body_gear` | gear | 7,504 | 4,686 | Boots, belt, buckle, strap, pouch |
| `head_face` | skin | 5,752 | 3,056 | Face oval, eyes, eyebrows |
| `head_coif` | gear | 4,284 | 2,233 | Mail coif and its mantle over the shoulders |
| `head_helmet` | gear | 2,448 | 1,604 | Kettle helmet |
| **Total** | | **64,038** | 35,448 | |

The body under the clothing was deleted. Do not hide `body_clothes` or `body_gear`: there is no skin beneath them.

### Hiding the head for the first-person body

Set `visible = false` on the three nodes whose names start with `head_`: `head_face`, `head_coif`, `head_helmet`.
What stays is the gambeson collar and a neck that is closed at the top, so a chest-height camera looking forward and down sees no hole (`preview/first_person_neck_check.png`, `preview/first_person_look_down.png`).
Hiding `head_coif` also removes the mail mantle on the shoulders; the gambeson underneath is complete.

## Materials

Three materials, each with three embedded 2048 x 2048 JPEG textures. Samplers are linear with mipmaps.

| Material | Sides | Base colour (sRGB) | Normal (tangent space, +Y) | ORM (R = occlusion, G = roughness, B = metallic) | Used by |
|---|---|---|---|---|---|
| `skin` | front only | `skin_base` | `skin_normal` | `skin_orm` | `body_skin`, `head_face` |
| `cloth` | double | `cloth_base` | `cloth_normal` | `cloth_orm` | `body_clothes` |
| `gear` | double | `gear_base` | `gear_normal` | `gear_orm` | `body_gear`, `head_coif`, `head_helmet` |

Occlusion, roughness and metallic share one image per material, and occlusion uses `TEXCOORD_0`, so no second UV set is needed. All materials are opaque.

### Outfit colour variants

Alternate base colour maps for the `cloth` material, 2048 x 2048 JPEG, same UV layout as the embedded one:

| File | Look |
|---|---|
| `soldier_cloth_base_linen.jpg` | Undyed linen gambeson, red hose. This is the look embedded in the GLB |
| `soldier_cloth_base_woad.jpg` | Blue-grey gambeson, brown hose (`preview/three_quarter_variant_woad.png`) |
| `soldier_cloth_base_russet.jpg` | Russet gambeson, dark green hose (`preview/three_quarter_variant_russet.png`) |

```js
const tex = await new THREE.TextureLoader().loadAsync('/assets/characters/soldier_cloth_base_woad.jpg');
tex.flipY = false;                        // glTF UV convention
tex.colorSpace = THREE.SRGBColorSpace;
const cloth = soldier.getObjectByName('body_clothes').material.clone();  // clone so each soldier can differ
cloth.map = tex;
soldier.getObjectByName('body_clothes').material = cloth;
```

The normal and ORM maps are shared by all variants.

## Skeleton

55 bones, Unreal-style names (MakeHuman "game engine" rig plus one forearm twist bone per arm).
There are three joints for every finger and thumb, a four-bone spine chain (`pelvis`, `spine_01` to `spine_03`), `neck_01`, `head`, clavicles, and one toe bone per foot (`ball_l`, `ball_r`).

### Hierarchy

```
Root
  pelvis
    spine_01
      spine_02
        spine_03
          clavicle_l
            upperarm_l
              lowerarm_l
                hand_l
                  index_01_l > index_02_l > index_03_l
                  middle_01_l > middle_02_l > middle_03_l
                  pinky_01_l > pinky_02_l > pinky_03_l
                  ring_01_l > ring_02_l > ring_03_l
                  thumb_01_l > thumb_02_l > thumb_03_l
                lowerarm_twist_01_l
          clavicle_r
            upperarm_r
              lowerarm_r
                hand_r
                  index_01_r > index_02_r > index_03_r
                  middle_01_r > middle_02_r > middle_03_r
                  pinky_01_r > pinky_02_r > pinky_03_r
                  ring_01_r > ring_02_r > ring_03_r
                  thumb_01_r > thumb_02_r > thumb_03_r
                lowerarm_twist_01_r
          neck_01
            head
    thigh_l
      calf_l
        foot_l
          ball_l
    thigh_r
      calf_r
        foot_r
          ball_r
```

### Bone axes

Every bone's local **+Y axis points along the bone**, from its own joint toward its child (Blender convention carried through the exporter).
Local X and Z are the two axes across the bone. Measured on the shipped file, a positive rotation about the local axis listed below does this:

| Joint | Axis and sign | Motion |
|---|---|---|
| `index_`, `middle_`, `ring_`, `pinky_` `01` to `03`, both hands | +X | Curls the finger toward the palm |
| `thumb_02` (`thumb_03` is within 21 degrees of the same axis) | -Z on the left, +Z on the right | Curls the thumb toward the index finger |
| `hand_l`, `hand_r` | +X | Flexes the wrist toward the palm |
| `lowerarm_l`, `lowerarm_r` | +X | Flexes the elbow |
| `upperarm_l` / `upperarm_r` | +Z on the left, -Z on the right | Raises the arm sideways |
| `calf_l`, `calf_r` | +X | Flexes the knee |
| `thigh_l`, `thigh_r` | -X | Swings the leg forward |
| `foot_l`, `foot_r` | -X | Lifts the toes (dorsiflexion) |
| `spine_01` to `spine_03`, `neck_01`, `head` | +X | Bends forward |
| any bone | Y | Twists along the bone |

`lowerarm_twist_01_l/r` sits halfway down the forearm, carries the lower-forearm and cuff weights, and has the same orientation as `lowerarm`. For forearm roll, rotate it about its local Y by about half of the wrist's roll; the clips already do this.

`Root` is not an identity bone: it sits at (0, 0, 0.003) and its +Y axis points to -Z. Keep its rest rotation; do not reset bone quaternions to identity. To return to the rest pose call `skeleton.pose()`.

### Rest pose

A relaxed A-pose with bent elbows:

- Upper arms point 49 degrees below horizontal, out to the sides.
- Elbows are bent 46 degrees so the forearms come forward; the hands rest in front of the hips at (±0.49, 1.11, 0.21) with palms facing inward and down, fingers slightly curled.
- Legs are straight, feet 0.39 m apart at the ankles, toes forward.
- Spine and head upright, looking along +Z.

Reference render: `preview/front.png`, `preview/apose_forearm_hand.png`.

### Bone table (rest pose, model space)

Head position is the joint position. Length is the distance to the next joint in the chain, blank for end bones and branch points.

| # | bone | parent | head position (x, y, z) m | bone +Y axis in model space | mostly along | length m |
|---|------|--------|---------------------------|-----------------------------|--------------|----------|
| 0 | Root | (Armature) | 0.000, 0.000, 0.003 | 0.000, 0.000, -1.000 | -Z |  |
| 1 | pelvis | Root | 0.000, 0.970, 0.007 | 0.000, 0.937, -0.349 | +Y | 0.092 |
| 2 | spine_01 | pelvis | 0.000, 1.056, -0.025 | 0.000, 0.991, 0.133 | +Y | 0.069 |
| 3 | spine_02 | spine_01 | 0.000, 1.125, -0.016 | 0.000, 0.984, -0.179 | +Y | 0.063 |
| 4 | spine_03 | spine_02 | 0.000, 1.186, -0.027 | 0.000, 0.989, -0.150 | +Y | 0.350 |
| 5 | clavicle_l | spine_03 | 0.023, 1.458, 0.028 | 0.985, -0.165, -0.051 | +X | 0.171 |
| 6 | upperarm_l | clavicle_l | 0.192, 1.430, 0.019 | 0.661, -0.751, 0.005 | -Y / +X | 0.257 |
| 7 | lowerarm_l | upperarm_l | 0.361, 1.237, 0.021 | 0.506, -0.482, 0.715 | +Z / +X | 0.259 |
| 8 | hand_l | lowerarm_l | 0.492, 1.112, 0.206 | 0.340, -0.445, 0.829 | +Z / -Y | 0.112 |
| 9 | index_01_l | hand_l | 0.522, 1.073, 0.311 | 0.136, -0.575, 0.807 | +Z / -Y | 0.028 |
| 10 | index_02_l | index_01_l | 0.526, 1.056, 0.334 | -0.026, -0.678, 0.735 | +Z / -Y | 0.026 |
| 11 | index_03_l | index_02_l | 0.525, 1.039, 0.353 | -0.130, -0.720, 0.681 | -Y / +Z |  |
| 12 | middle_01_l | hand_l | 0.541, 1.060, 0.292 | 0.209, -0.749, 0.629 | -Y / +Z | 0.037 |
| 13 | middle_02_l | middle_01_l | 0.548, 1.032, 0.316 | 0.088, -0.759, 0.645 | -Y / +Z | 0.030 |
| 14 | middle_03_l | middle_02_l | 0.551, 1.009, 0.335 | 0.001, -0.811, 0.585 | -Y / +Z |  |
| 15 | pinky_01_l | hand_l | 0.550, 1.040, 0.252 | 0.273, -0.863, 0.425 | -Y / +Z | 0.023 |
| 16 | pinky_02_l | pinky_01_l | 0.557, 1.020, 0.262 | 0.129, -0.904, 0.409 | -Y / +Z | 0.017 |
| 17 | pinky_03_l | pinky_02_l | 0.559, 1.004, 0.269 | 0.113, -0.920, 0.376 | -Y / +Z |  |
| 18 | ring_01_l | hand_l | 0.549, 1.051, 0.273 | 0.297, -0.812, 0.502 | -Y / +Z | 0.033 |
| 19 | ring_02_l | ring_01_l | 0.558, 1.024, 0.290 | 0.184, -0.817, 0.547 | -Y / +Z | 0.027 |
| 20 | ring_03_l | ring_02_l | 0.563, 1.002, 0.304 | 0.093, -0.887, 0.453 | -Y / +Z |  |
| 21 | thumb_01_l | hand_l | 0.494, 1.106, 0.255 | -0.682, -0.262, 0.682 | +Z / -X | 0.034 |
| 22 | thumb_02_l | thumb_01_l | 0.471, 1.097, 0.278 | -0.350, -0.333, 0.875 | +Z / -X | 0.040 |
| 23 | thumb_03_l | thumb_02_l | 0.457, 1.084, 0.313 | -0.185, -0.610, 0.770 | +Z / -Y |  |
| 24 | lowerarm_twist_01_l | lowerarm_l | 0.427, 1.175, 0.113 | 0.506, -0.482, 0.715 | +Z / +X |  |
| 25 | clavicle_r | spine_03 | -0.023, 1.458, 0.028 | -0.985, -0.165, -0.051 | -X | 0.171 |
| 26 | upperarm_r | clavicle_r | -0.192, 1.430, 0.019 | -0.661, -0.751, 0.005 | -Y / -X | 0.257 |
| 27 | lowerarm_r | upperarm_r | -0.361, 1.237, 0.021 | -0.506, -0.482, 0.715 | +Z / -X | 0.259 |
| 28 | hand_r | lowerarm_r | -0.492, 1.112, 0.206 | -0.340, -0.445, 0.829 | +Z / -Y | 0.112 |
| 29 | index_01_r | hand_r | -0.522, 1.073, 0.311 | -0.136, -0.575, 0.807 | +Z / -Y | 0.028 |
| 30 | index_02_r | index_01_r | -0.526, 1.056, 0.334 | 0.026, -0.678, 0.735 | +Z / -Y | 0.026 |
| 31 | index_03_r | index_02_r | -0.525, 1.039, 0.353 | 0.130, -0.720, 0.681 | -Y / +Z |  |
| 32 | middle_01_r | hand_r | -0.541, 1.060, 0.292 | -0.209, -0.749, 0.629 | -Y / +Z | 0.037 |
| 33 | middle_02_r | middle_01_r | -0.548, 1.032, 0.316 | -0.088, -0.759, 0.645 | -Y / +Z | 0.030 |
| 34 | middle_03_r | middle_02_r | -0.551, 1.009, 0.335 | -0.001, -0.811, 0.585 | -Y / +Z |  |
| 35 | pinky_01_r | hand_r | -0.550, 1.040, 0.252 | -0.273, -0.863, 0.425 | -Y / +Z | 0.023 |
| 36 | pinky_02_r | pinky_01_r | -0.557, 1.020, 0.262 | -0.129, -0.904, 0.409 | -Y / +Z | 0.017 |
| 37 | pinky_03_r | pinky_02_r | -0.559, 1.004, 0.269 | -0.113, -0.920, 0.376 | -Y / +Z |  |
| 38 | ring_01_r | hand_r | -0.549, 1.051, 0.273 | -0.297, -0.812, 0.502 | -Y / +Z | 0.033 |
| 39 | ring_02_r | ring_01_r | -0.558, 1.024, 0.290 | -0.184, -0.817, 0.547 | -Y / +Z | 0.027 |
| 40 | ring_03_r | ring_02_r | -0.563, 1.002, 0.304 | -0.093, -0.887, 0.453 | -Y / +Z |  |
| 41 | thumb_01_r | hand_r | -0.494, 1.106, 0.255 | 0.682, -0.262, 0.682 | +Z / +X | 0.034 |
| 42 | thumb_02_r | thumb_01_r | -0.471, 1.097, 0.278 | 0.350, -0.333, 0.875 | +Z / +X | 0.040 |
| 43 | thumb_03_r | thumb_02_r | -0.457, 1.084, 0.313 | 0.185, -0.610, 0.770 | +Z / -Y |  |
| 44 | lowerarm_twist_01_r | lowerarm_r | -0.427, 1.175, 0.113 | -0.506, -0.482, 0.715 | +Z / -X |  |
| 45 | neck_01 | spine_03 | 0.000, 1.534, 0.014 | 0.000, 0.953, 0.304 | +Y | 0.100 |
| 46 | head | neck_01 | 0.000, 1.629, 0.044 | 0.000, 1.000, 0.004 | +Y |  |
| 47 | thigh_l | pelvis | 0.111, 0.960, -0.003 | 0.093, -0.993, 0.077 | -Y | 0.437 |
| 48 | calf_l | thigh_l | 0.152, 0.526, 0.030 | 0.095, -0.995, -0.037 | -Y | 0.444 |
| 49 | foot_l | calf_l | 0.194, 0.084, 0.014 | 0.019, -0.443, 0.896 | +Z / -Y | 0.145 |
| 50 | ball_l | foot_l | 0.197, 0.020, 0.144 | -0.057, 0.077, 0.995 | +Z |  |
| 51 | thigh_r | pelvis | -0.111, 0.960, -0.003 | -0.093, -0.993, 0.077 | -Y | 0.437 |
| 52 | calf_r | thigh_r | -0.152, 0.526, 0.030 | -0.095, -0.995, -0.037 | -Y | 0.444 |
| 53 | foot_r | calf_r | -0.194, 0.084, 0.014 | -0.019, -0.443, 0.896 | +Z / -Y | 0.145 |
| 54 | ball_r | foot_r | -0.197, 0.020, 0.144 | 0.057, 0.077, 0.995 | +Z |  |

The # column is the joint index used by `JOINTS_0` and the order of `skeleton.bones` in three.

## Sword attachment

The hand bone local frame that the preview renders use for a one-handed sword. Parent the sword to `hand_r` (or `hand_l`):

| | `hand_r` local | `hand_l` local |
|---|---|---|
| Cross-guard centre | (0.0150, 0.0976, 0.0338) | (-0.0150, 0.0976, 0.0338) |
| Grip centre (9.5 cm below the guard) | (-0.0618, 0.0882, -0.0214) | (0.0618, 0.0882, -0.0214) |
| Blade direction | (0.8080, 0.0984, 0.5809) | (-0.8080, 0.0984, 0.5809) |
| Cutting edge direction | (-0.0495, 0.9938, -0.0994) | (0.0495, 0.9938, -0.0994) |
| Quaternion (x, y, z, w) for a sword modelled with blade +Y, edge +Z | (0.3217, 0.6680, 0.5893, -0.3209) | (-0.3217, 0.6680, 0.5893, 0.3209) |

For a sword whose origin is at the cross-guard, with the blade along +Y and the edge along +Z:

```js
sword.position.set(0.0150, 0.0976, 0.0338);
sword.quaternion.set(0.3217, 0.6680, 0.5893, -0.3209);
soldier.getObjectByName('hand_r').add(sword);
```

The fingers are open in the rest pose. Finger poses in the clips come from the source animation (sampled at each clip's midpoint):

- `sword_ready`, `sword_swing`: right hand closed around the grip, left hand open.
- `idle`, `walk`, `jog`, `sprint`: both hands in a loose fist, the same finger pose as the sword hand.
- `hit_chest`, `hit_head`: both hands half closed.

Expect to fine-tune the offset by a centimetre or so for your sword's grip thickness.

## Animation clips

Eight clips are baked into `soldier.glb`, retargeted from the Quaternius Universal Animation Library (CC0, see LICENSES.md).

| Clip | Length | Loops | Source clip | Notes |
|---|---|---|---|---|
| `idle` | 2.500 s | yes | `Idle_Loop` | Breathing, weight shift |
| `walk` | 1.333 s | yes | `Walk_Loop` | Natural ground speed 1.04 m/s |
| `jog` | 0.933 s | yes | `Jog_Fwd_Loop` | Natural ground speed 5.7 m/s, which is a fast run rather than a jog |
| `sprint` | 0.667 s | yes | `Sprint_Loop` | Natural ground speed 8.8 m/s. Extra, not requested |
| `sword_ready` | 1.667 s | yes | `Sword_Idle` | One-handed sword in the right hand, deep crouched stance |
| `sword_swing` | 1.533 s | no | `Sword_Attack` | Diagonal cut with a lunge; starts and ends in the `sword_ready` pose |
| `hit_chest` | 0.333 s | no | `Hit_Chest` | Short flinch from a blow to the chest |
| `hit_head` | 0.433 s | no | `Hit_Head` | Short flinch from a blow to the head |

Contact sheets rendered from the shipped file: `preview/anim_<clip>.png`.

Facts about the clip data:

- Keys are at 60 Hz with linear interpolation.
- Clips are in place. `Root` never moves; move the character in code. The natural ground speeds above come from the source root motion scaled to this skeleton's legs; set `action.timeScale = speed / naturalSpeed` to keep the feet from sliding.
- Only rotations are animated, plus the translation of `pelvis`. Each clip still carries a constant two-key position and scale track for every bone (165 tracks per clip). Dropping them is safe and saves mixer work:

  ```js
  clip.tracks = clip.tracks.filter(t => t.name.endsWith('.quaternion') || t.name === 'pelvis.position');
  ```

- Feet were re-solved with two-bone IK after retargeting and clamped to the ground. Sampled at 240 Hz through three's `AnimationMixer`, the lowest boot-sole vertex is within 0.2 mm of the ground in every clip except `sprint` (dips 7 mm for a few milliseconds) and `sword_swing` (3.5 mm).
- `idle`, `jog` and `sprint` have a first-to-last pose gap of at most 5 mm; `walk`, `sword_ready` and `sword_swing` close exactly.
- three computes a skinned mesh's culling bounds from the rest pose. `sword_swing` lunges about a metre, so set `frustumCulled = false` on the meshes or recompute the bounds if the character pops out at screen edges.

Known limits of the clips:

- The free tier of the source library has one sword attack, so there is one swing, not two or three.
- `sword_swing` has snappy, game-style timing: the cut itself takes about 0.2 s and the right foot steps 0.55 m in under 0.1 s. This is in the source animation. Lower `timeScale` for a heavier feel.
- `sword_ready` is a low action-game crouch, not a historical guard.
- There is no cloth simulation. The gambeson skirt is skinned to the thighs and stretches in long strides and in the lunge.

## Known limits of the model

- The face is the weakest part: plausible at 2 m and beyond and mostly covered by the coif and helmet, but mannequin-like in close-up (`preview/head.png`).
- Hand skin colour comes from a low-resolution region of the source skin texture. Knuckle and crease detail is in the normal map, and the hands look slightly soft at 30 cm.
- Cloth texel density is 1.3 to 1.8 px/mm on the gambeson and 0.74 px/mm on the hose, so the chest is slightly blurry when the first-person camera looks straight down.
- Folds and quilting are baked into the normal and colour maps; there is no fold geometry. Quilting lines wobble a little at the lower back below the belt.
- Boots and eyes use mirrored UVs. The pouch is a plain shape.
- The two-handed grip in `preview/hands_grip_*.png` is a scripted pose, not a clip. Thumbs are a little stiff and fingertips do not wrap the hilt exactly.

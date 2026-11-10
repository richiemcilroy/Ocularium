// Curated list of CC0 photoscanned assets from Poly Haven (https://polyhaven.com).
// `res` is the source resolution fetched; textures are transcoded to KTX2 by build-assets.mjs.

export const RAW_DIR = process.env.OCULARIUM_RAW || '/Volumes/CapGPUIBuild/ocularium-work/raw';

/** Tiling surface materials: id -> { res, maps } */
export const textures = {
  // ground
  cobblestone_floor_08: { res: '2k', disp: true },
  mossy_cobblestone: { res: '2k', disp: true },
  brown_mud_leaves_01: { res: '2k', disp: true },
  brown_mud_02: { res: '2k', disp: true },
  muddy_tracks: { res: '2k', disp: true },
  dirt_floor: { res: '2k' },
  forrest_ground_01: { res: '2k', disp: true },
  // masonry
  castle_wall_slates: { res: '2k', disp: true },
  medieval_blocks_03: { res: '2k', disp: true },
  medieval_blocks_05: { res: '2k', disp: true },
  medieval_wall_02: { res: '2k', disp: true },
  plastered_stone_wall: { res: '2k', disp: true },
  slate_floor_02: { res: '2k', disp: true },
  // timber frame, plaster, planks
  beam_wall_01: { res: '2k' },
  white_plaster_rough_01: { res: '2k' },
  worn_plaster_wall: { res: '2k' },
  medieval_wood: { res: '2k' },
  weathered_planks: { res: '2k' },
  raw_plank_wall: { res: '2k' },
  dark_planks: { res: '2k' },
  wooden_rough_planks: { res: '2k' },
  // roofs
  thatch_roof_angled: { res: '2k', disp: true },
  roof_slates_02: { res: '2k' },
  // metal, cloth, leather
  rusty_metal_02: { res: '2k' },
  metal_plate: { res: '1k' },
  rough_linen: { res: '1k' },
  brown_leather: { res: '1k' },
};

/** glTF models: id -> { res } */
export const models = {
  modular_fort_01: { res: '2k' },
  large_castle_door: { res: '2k' },
  large_iron_gate: { res: '2k' },
  // weapons
  antique_estoc: { res: '2k' },
  kite_shield: { res: '2k' },
  ornate_medieval_mace: { res: '2k' },
  ornate_war_hammer: { res: '2k' },
  ornate_medieval_dagger: { res: '2k' },
  wooden_axe_02: { res: '1k' },
  hatchet: { res: '1k' },
  // props
  wooden_barrels_01: { res: '1k' },
  wine_barrel_01: { res: '1k' },
  wooden_crate_02: { res: '1k' },
  wooden_bucket_01: { res: '1k' },
  wooden_bucket_02: { res: '1k' },
  treasure_chest: { res: '1k' },
  stone_fire_pit: { res: '1k' },
  wooden_lantern_01: { res: '1k' },
  WoodenTable_03: { res: '1k' },
  wooden_stool_01: { res: '1k' },
  wooden_stool_02: { res: '1k' },
  wooden_bowl_01: { res: '1k' },
  brass_goblets: { res: '1k' },
  wooden_candlestick: { res: '1k' },
  jug_01: { res: '1k' },
  wicker_basket_01: { res: '1k' },
  wooden_ladder: { res: '1k' },
  spinning_wheel_01: { res: '1k' },
  // nature
  boulder_01: { res: '1k' },
  rock_moss_set_01: { res: '1k' },
  tree_stump_01: { res: '1k' },
  dead_tree_trunk: { res: '1k' },
  dry_branches_medium_01: { res: '1k' },
  fern_02: { res: '1k' },
  nettle_plant: { res: '1k' },
  weed_plant_02: { res: '1k' },
  shrub_01: { res: '1k' },
};

/** HDR skies: id -> { res } */
export const hdris = {
  overcast_soil_puresky: { res: '2k' },
};

// The wiki's built-in groups, sub-groups and page templates.
//
// Every page has the same basic parts: name, picture, overview, its group and sub-group
// (its category), versionAdded, related pages and notes. The sub-group picks the template,
// and the template lists the extra fields shown in the page's info box (saved in page.fields).
//
// Changes made in the app (part 2b step 3) are saved in the "groups" and "templates"
// collections and override these defaults by id.

const f = (key, label) => ({ key, label });

export const TEMPLATES = {
  mob: { name: 'Mob', fields: [
    f('health', 'Health'), f('attackDamage', 'Attack damage'), f('behavior', 'Behavior'),
    f('spawnBiomes', 'Spawn biomes'), f('drops', 'Drops'), f('breedingFood', 'Breeding or taming food')] },
  item: { name: 'Item', fields: [
    f('stackSize', 'Stack size'), f('obtainedFrom', 'Obtained from'), f('craftingRecipe', 'Crafting recipe'),
    f('usedToCraft', 'Used to craft'), f('craftedAt', 'Crafted at'), f('behavior', 'Behavior')] },
  food: { name: 'Food', fields: [
    f('hungerRestored', 'Hunger restored'), f('saturation', 'Saturation'),
    f('effectsWhenEaten', 'Effects when eaten'), f('obtainedFrom', 'Obtained from')] },
  tool: { name: 'Tool', fields: [
    f('toolType', 'Tool type'), f('miningTier', 'Mining tier'), f('durability', 'Durability'),
    f('attackDamage', 'Attack damage'), f('miningSpeed', 'Mining speed'), f('repairMaterial', 'Repair material')] },
  weapon: { name: 'Weapon', fields: [
    f('attackDamage', 'Attack damage'), f('attackSpeed', 'Attack speed'), f('durability', 'Durability'),
    f('specialAbility', 'Special ability'), f('repairMaterial', 'Repair material')] },
  armor: { name: 'Armor', fields: [
    f('armorSlot', 'Armor slot'), f('armorPoints', 'Armor points'), f('durability', 'Durability'),
    f('setBonus', 'Set bonus'), f('repairMaterial', 'Repair material')] },
  utility: { name: 'Utility & equipment', fields: [
    f('durability', 'Durability'), f('uses', 'Uses'), f('function', 'Function'),
    f('howToUse', 'How to use'), f('cooldown', 'Cooldown'), f('repairMaterial', 'Repair material')] },
  potion: { name: 'Potion', fields: [
    f('effects', 'Effects'), f('duration', 'Duration'), f('brewedFrom', 'Brewed from'),
    f('upgrades', 'Upgrades'), f('splashAndLingering', 'Splash & lingering'), f('color', 'Color')] },
  block: { name: 'Block', fields: [
    f('requiredTool', 'Required tool'), f('lightLevel', 'Light level emitted'), f('drops', 'Drops'),
    f('obtainedFrom', 'Obtained from'), f('craftingRecipe', 'Crafting recipe'), f('usedToCraft', 'Used to craft'),
    f('craftedAt', 'Crafted at'), f('behavior', 'Behavior')] },
  structure: { name: 'Structure', fields: [
    f('location', 'Location'), f('frequency', 'Frequency'), f('loot', 'Loot'), f('mobsPresent', 'Mobs present')] },
  biome: { name: 'Biome', fields: [
    f('temperature', 'Temperature'), f('commonMobs', 'Common mobs'), f('commonBlocks', 'Common blocks'),
    f('structures', 'Structures'), f('weather', 'Weather')] },
  tree: { name: 'Tree', fields: [
    f('growsIn', 'Grows in'), f('sapling', 'Sapling'), f('howItGrows', 'How it grows'),
    f('woodSet', 'Wood set'), f('fruitAndDrops', 'Fruit & drops'), f('sizes', 'Sizes & variants')] },
  dimension: { name: 'Dimension', fields: [
    f('dayLength', 'Day length'), f('hostileSpawns', 'Hostile spawns'), f('sky', 'Sky'), f('portal', 'Portal')] },
  effect: { name: 'Status effect', fields: [
    f('duration', 'Duration'), f('levels', 'Levels'), f('source', 'Source'),
    f('beneficialOrHarmful', 'Beneficial or harmful')] },
  enchantment: { name: 'Enchantment', fields: [
    f('maxLevel', 'Max level'), f('appliesTo', 'Applies to'), f('incompatibleWith', 'Incompatible with'),
    f('obtainedVia', 'Obtained via')] },
};

const s = (id, name, template, icon) => ({ id, name, template, icon });

// icon: a pixel icon from config/icons.js
export const GROUPS = [
  { id: 'mobs', name: 'Mobs', icon: 'mob', subgroups: [
    s('passive', 'Passive', 'mob', 'passive'), s('neutral', 'Neutral', 'mob', 'neutral'),
    s('hostile', 'Hostile', 'mob', 'hostile'), s('boss', 'Boss', 'mob', 'boss')] },
  { id: 'items', name: 'Items', icon: 'item', subgroups: [
    s('tools', 'Tools', 'tool', 'pickaxe'), s('weapons', 'Weapons', 'weapon', 'item'), s('armor', 'Armor', 'armor', 'armor'),
    s('utility', 'Utility & Equipment', 'utility', 'compass'), s('food', 'Food & Ingredients', 'food', 'food'),
    s('potions', 'Potions', 'potion', 'effect'), s('misc', 'Materials & Misc', 'item', 'gem')] },
  { id: 'blocks', name: 'Blocks', icon: 'block', subgroups: [
    s('natural', 'Natural', 'block', 'grass'), s('building', 'Building', 'block', 'bricks'),
    s('plants', 'Plants & Crops', 'block', 'sapling'), s('functional', 'Functional', 'block', 'gear'),
    s('decorative', 'Decorative', 'block', 'decor')] },
  { id: 'world', name: 'World', icon: 'globe', subgroups: [
    s('biomes', 'Biomes', 'biome', 'landscape'), s('trees', 'Trees', 'tree', 'tree'),
    s('structures', 'Structures', 'structure', 'house'), s('dimensions', 'Dimensions', 'dimension', 'portal')] },
  { id: 'effects', name: 'Effects & Enchantments', icon: 'effect', subgroups: [
    s('status-effects', 'Status effects', 'effect', 'sparkle'), s('enchantments', 'Enchantments', 'enchantment', 'wand')] },
];

/** Page statuses besides the normal "in the mod". */
export const STATUSES = {
  planned: 'Planned',
};

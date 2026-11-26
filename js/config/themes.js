// Color themes. To add one, copy a line and change the id, name and three colors.
// A theme counts as dark or light from its background color. Text, borders and muted
// colors are worked out from these three automatically.

export const THEMES = [
  // Dark
  { id: 'midnight-navy', name: 'Midnight Navy', bg: '#0B1A2E', panel: '#13263F', accent: '#2BB3C0' },
  { id: 'forest-dark',   name: 'Forest Dark',   bg: '#0F1F17', panel: '#1A3327', accent: '#4CAF7A' },
  { id: 'deep-teal',     name: 'Deep Teal',     bg: '#0A1C1E', panel: '#132C2F', accent: '#3FBFB0' },
  { id: 'slate-dark',    name: 'Slate Dark',    bg: '#11151C', panel: '#1B2230', accent: '#7C9CFF' },
  { id: 'rose-night',    name: 'Rose Night',    bg: '#1C1118', panel: '#2B1A26', accent: '#FF7AB8' },
  { id: 'amethyst',      name: 'Amethyst',      bg: '#15111F', panel: '#221B31', accent: '#B48CFF' },
  { id: 'ember',         name: 'Ember',         bg: '#1A120D', panel: '#2A1D15', accent: '#F0904A' },
  { id: 'crimson',       name: 'Crimson',       bg: '#1A0D0F', panel: '#2B161A', accent: '#F0645C' },
  { id: 'deepslate',     name: 'Deepslate',     bg: '#141518', panel: '#212328', accent: '#D4B66A' },
  { id: 'moss',          name: 'Moss',          bg: '#11170F', panel: '#1D2619', accent: '#A6C85C' },
  // Light
  { id: 'light',         name: 'Seafoam',       bg: '#F4F7F6', panel: '#FFFFFF', accent: '#1F7A8C' },
  { id: 'blossom',       name: 'Blossom',       bg: '#FBF0F5', panel: '#FFFFFF', accent: '#B83A78' },
  { id: 'sand',          name: 'Sand',          bg: '#F6F1E6', panel: '#FFFDF8', accent: '#9A5A22' },
  { id: 'mint',          name: 'Mint',          bg: '#EEF6F1', panel: '#FFFFFF', accent: '#237447' },
  { id: 'sky',           name: 'Sky',           bg: '#EDF3FB', panel: '#FFFFFF', accent: '#2A64C4' },
  { id: 'lavender',      name: 'Lavender',      bg: '#F3F0FA', panel: '#FFFFFF', accent: '#6A45C2' },
  { id: 'paper',         name: 'Paper',         bg: '#F2F2EF', panel: '#FFFFFF', accent: '#3D4A5C' },
  { id: 'peach',         name: 'Peach',         bg: '#FCF2EC', panel: '#FFFFFF', accent: '#B4502B' },
  { id: 'sage',          name: 'Sage',          bg: '#EFF3EA', panel: '#FBFCF8', accent: '#55733A' },
  { id: 'cherry',        name: 'Cherry',        bg: '#FBF0F0', panel: '#FFFFFF', accent: '#B0303A' },
];

export const DEFAULT_THEME = 'midnight-navy';
export const DEFAULT_LIGHT_THEME = 'light';

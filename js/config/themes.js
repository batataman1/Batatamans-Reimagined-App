// Color themes. To add one, copy a line and change the id, name and three colors.
// Text, borders and muted colors are worked out from these automatically.

export const THEMES = [
  { id: 'midnight-navy', name: 'Midnight Navy', bg: '#0B1A2E', panel: '#13263F', accent: '#2BB3C0' },
  { id: 'forest-dark',   name: 'Forest Dark',   bg: '#0F1F17', panel: '#1A3327', accent: '#4CAF7A' },
  { id: 'deep-teal',     name: 'Deep Teal',     bg: '#0A1C1E', panel: '#132C2F', accent: '#3FBFB0' },
  { id: 'slate-dark',    name: 'Slate Dark',    bg: '#11151C', panel: '#1B2230', accent: '#7C9CFF' },
  { id: 'light',         name: 'Light',         bg: '#F4F7F6', panel: '#FFFFFF', accent: '#1F7A8C' },
];

export const DEFAULT_THEME = 'midnight-navy';
export const DEFAULT_LIGHT_THEME = 'light';

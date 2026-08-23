/**
 * Semantic design tokens synced from the sibling web artifact.
 * Vibe: editorial field notebook for live pool data—confident, information-dense, tactile.
 */

const colors = {
  light: {
    text: '#0B0B0B',
    tint: '#0B0B0B',

    background: '#FAF9F7', // paper
    foreground: '#0B0B0B', // ink

    card: '#FFFFFF', // surface
    cardForeground: '#0B0B0B',

    primary: '#0B0B0B', // ink
    primaryForeground: '#FAF9F7', // paper

    secondary: '#E6E3DD', // line
    secondaryForeground: '#0B0B0B',

    muted: '#F2F0EC', // subtle
    mutedForeground: '#8A867E', // muted

    accent: '#F2F0EC',
    accentForeground: '#0B0B0B',

    destructive: '#B93A2B', // down
    destructiveForeground: '#FFFFFF',

    success: '#127A3B', // up

    border: '#E6E3DD', // line
    input: '#E6E3DD',

    gold: '#ffb700',
    afc: '#B93A2B',
    nfc: '#0075F5',
    warning: '#d97706',
  },

  dark: {
    text: '#FAF9F7',
    tint: '#FAF9F7',

    background: '#0B0B0B',
    foreground: '#FAF9F7',

    card: '#1A1917',
    cardForeground: '#FAF9F7',

    primary: '#FAF9F7',
    primaryForeground: '#0B0B0B',

    secondary: '#333333',
    secondaryForeground: '#FAF9F7',

    muted: '#2A2928',
    mutedForeground: '#8A867E',

    accent: '#2A2928',
    accentForeground: '#FAF9F7',

    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    success: '#22c55e',

    border: '#333333',
    input: '#333333',

    gold: '#ffb700',
    afc: '#ef3b60',
    nfc: '#3390ff',
    warning: '#f59e0b',
  },

  radius: 0,
};

export default colors;

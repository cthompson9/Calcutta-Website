/**
 * Semantic design tokens synced from the sibling web artifact
 * (artifacts/nfl-auction/src/index.css). Sharp corners (radius 0),
 * monochrome base with gold / AFC red / NFC blue accents.
 */

const colors = {
  light: {
    // Legacy aliases
    text: '#171717',
    tint: '#171717',

    background: '#ffffff',
    foreground: '#171717',

    card: '#ffffff',
    cardForeground: '#171717',

    primary: '#171717',
    primaryForeground: '#fafafa',

    secondary: '#f5f5f5',
    secondaryForeground: '#171717',

    muted: '#f5f5f5',
    mutedForeground: '#737373',

    accent: '#f5f5f5',
    accentForeground: '#171717',

    destructive: '#ef4444',
    destructiveForeground: '#ffffff',

    border: '#e0e0e0',
    input: '#e0e0e0',

    // Brand extras (from web tokens)
    gold: '#ffb700',
    afc: '#dc143f',
    nfc: '#0075f5',
    success: '#16a34a',
    warning: '#d97706',
  },

  dark: {
    text: '#fafafa',
    tint: '#fafafa',

    background: '#0a0a0a',
    foreground: '#fafafa',

    card: '#0f0f0f',
    cardForeground: '#fafafa',

    primary: '#fafafa',
    primaryForeground: '#171717',

    secondary: '#262626',
    secondaryForeground: '#fafafa',

    muted: '#262626',
    mutedForeground: '#a3a3a3',

    accent: '#262626',
    accentForeground: '#fafafa',

    destructive: '#b91c1c',
    destructiveForeground: '#fafafa',

    border: '#333333',
    input: '#333333',

    gold: '#ffb700',
    afc: '#ef3b60',
    nfc: '#3390ff',
    success: '#22c55e',
    warning: '#f59e0b',
  },

  // Synced from web --radius: 0 (sharp, editorial look)
  radius: 0,
};

export default colors;

/** User's explicit theme preference stored in localStorage */
export type ThemePreference = 'light' | 'dark' | 'system'

/** The actual applied theme after resolving 'system' to a concrete value */
export type ResolvedTheme = 'light' | 'dark'

/** Value shape exposed by ThemeContext */
export interface ThemeContextValue {
  /** Current user preference (what is stored) */
  preference: ThemePreference
  /** Current applied theme (after system resolution) */
  resolved: ResolvedTheme
  /** Change the user's theme preference */
  setPreference: (pref: ThemePreference) => void
}

// Retry on each app initialization if storage access is temporarily blocked.
export function clearRetiredSpeechKeys(): void {
  for (const key of ['hhc-speech-key-azure', 'hhc-speech-key-gcp']) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* Storage may be unavailable. */
    }
  }
}

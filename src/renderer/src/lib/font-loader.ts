const languageFonts = new Map<string, Promise<void>>()

export function loadLanguageFont(language: string): Promise<void> {
  const normalizedLanguage = language === 'zh-CN' ? 'zh-CN' : language === 'zh-TW' ? 'zh-TW' : 'en'
  const existing = languageFonts.get(normalizedLanguage)
  if (existing) return existing

  const loading = (
    normalizedLanguage === 'zh-CN'
      ? import('@fontsource-variable/noto-sans-sc/index.css')
      : normalizedLanguage === 'zh-TW'
        ? import('@fontsource-variable/noto-sans-tc/index.css')
        : Promise.resolve()
  )
    .then(() => undefined)
    .catch((error) => {
      languageFonts.delete(normalizedLanguage)
      console.error(`Failed to load font for ${normalizedLanguage}:`, error)
    })
  languageFonts.set(normalizedLanguage, loading)
  return loading
}

export async function loadPresentationFont(family: string): Promise<void> {
  if (family === 'Noto Sans TC Variable') await loadLanguageFont('zh-TW')
  if (family === 'Noto Sans SC Variable') await loadLanguageFont('zh-CN')
  await document.fonts?.load(`16px ${JSON.stringify(family)}`)
}

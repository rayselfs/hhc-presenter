import { lazy, Suspense, useEffect, useState } from 'react'
import { Button } from '@heroui/react/button'
const ChineseSpeechPilot = lazy(() =>
  import('./ChineseSpeechPilot').then((module) => ({ default: module.ChineseSpeechPilot }))
)
import LocalSpeechCard from './LocalSpeechCard'

export default function SpeechRecognitionCard(): React.JSX.Element {
  const [available, setAvailable] = useState(false)
  const [pilot, setPilot] = useState(true)
  useEffect(() => {
    let live = true
    void window.api?.speech
      ?.chineseAvailable?.()
      .then((value) => {
        if (live) setAvailable(value)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  if (!available) return <LocalSpeechCard />
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Button variant="ghost" size="sm" onPress={() => setPilot(!pilot)}>
        {pilot ? '切回語音功能' : '開啟中文本機實測'}
      </Button>
      <div className="min-h-0 flex-1">
        {pilot ? (
          <Suspense fallback={null}>
            <ChineseSpeechPilot />
          </Suspense>
        ) : (
          <LocalSpeechCard />
        )}
      </div>
    </div>
  )
}

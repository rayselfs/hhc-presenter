import LyricsOutput from '@renderer/components/Common/LyricsOutput'
import { useCameraLyricsStore } from '@renderer/stores/camera-lyrics'
function onOverflow(overflow: boolean): void {
  const state = useCameraLyricsStore.getState()
  if (overflow && state.error !== 'overflow') useCameraLyricsStore.setState({ error: 'overflow' })
  if (!overflow && state.error === 'overflow') useCameraLyricsStore.setState({ error: null })
}
export default function LyricsPreview(): React.JSX.Element {
  const state = useCameraLyricsStore()
  return (
    <LyricsOutput
      output={{
        lines: state.lines,
        style: state.style,
        visible: state.visible,
        expiresAt: state.manual ? Number.MAX_SAFE_INTEGER : state.acceptedAt + 1000
      }}
      onOverflow={onOverflow}
    />
  )
}

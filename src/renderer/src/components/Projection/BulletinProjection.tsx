import type { BulletinProjectionView } from '@shared/bulletin-projection'
import BulletinPageView from '@renderer/components/Control/Bulletin/BulletinPageView'

export default function BulletinProjection({
  view
}: {
  view: BulletinProjectionView
}): React.JSX.Element {
  return (
    <main className="flex h-screen w-screen flex-col bg-[#fffdf7] text-[#25231e]">
      <div className="min-h-0 flex-1">
        <BulletinPageView
          page={view.page}
          fontScale={view.fontScale}
          highlights={view.highlights}
          position={view.position}
        />
      </div>
      <footer className="flex justify-between px-[7%] pb-2 text-sm">
        <span>{view.page.label}</span>
        <span>{view.traceCode}</span>
      </footer>
    </main>
  )
}

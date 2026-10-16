import { Outlet } from 'react-router-dom'
import { PresentationSessionRegistryProvider } from '@renderer/contexts/PresentationSessionRegistryContext'
import { PresentationCloseDecisionProvider } from '@renderer/contexts/PresentationCloseDecisionContext'
import PresentationElectronCloseBridge from '@renderer/contexts/PresentationElectronCloseBridge'
import PresentationCloseDecisionDialog from './Header/PresentationCloseDecisionDialog'

export default function ControlAppShell(): React.JSX.Element {
  return (
    <PresentationSessionRegistryProvider>
      <PresentationCloseDecisionProvider>
        <Outlet />
        <PresentationCloseDecisionDialog />
        <PresentationElectronCloseBridge />
      </PresentationCloseDecisionProvider>
    </PresentationSessionRegistryProvider>
  )
}

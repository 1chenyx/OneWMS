import { ConnectPage } from './pages/ConnectPage.js';
import { ModePage } from './pages/ModePage.js';
import { Shell } from './pages/Shell.js';
import type { ScanBroadcastPlugin } from './scan/broadcast.js';
import { ScanProvider } from './scan/ScanProvider.js';
import { useFieldSession } from './session.js';

export default function App({ broadcastPlugin }: { broadcastPlugin?: ScanBroadcastPlugin }) {
  const session = useFieldSession();
  return (
    <div className="field-app">
      <div className="field-frame">
        {session.phase !== 'booting' && session.phase !== 'connect' && !session.online ? (
          <p className="field-banner">未连接</p>
        ) : null}
        {session.phase === 'booting' ? (
          <main className="field-main">
            <h1 className="field-title">正在连接</h1>
          </main>
        ) : null}
        {session.phase === 'connect' ? <ConnectPage /> : null}
        {session.phase === 'mode' ? <ModePage /> : null}
        {session.phase === 'app' ? (
          <ScanProvider plugin={broadcastPlugin}>
            <Shell />
          </ScanProvider>
        ) : null}
      </div>
    </div>
  );
}

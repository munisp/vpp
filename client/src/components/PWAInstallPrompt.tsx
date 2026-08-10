import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePWA } from "@/hooks/usePWA";
import { Download, RefreshCw, WifiOff, X } from "lucide-react";
import { useEffect, useState } from "react";

export function PWAInstallPrompt() {
  const { canInstall, promptInstall, needRefresh, offlineReady, updateApp, closePrompt, isOffline } = usePWA();
  const [showInstall, setShowInstall] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Show install prompt after 30 seconds if user hasn't dismissed it
    const timer = setTimeout(() => {
      if (canInstall && !dismissed) {
        setShowInstall(true);
      }
    }, 30000);

    return () => clearTimeout(timer);
  }, [canInstall, dismissed]);

  const handleInstall = async () => {
    const installed = await promptInstall();
    if (installed) {
      setShowInstall(false);
    }
  };

  const handleDismiss = () => {
    setShowInstall(false);
    setDismissed(true);
    // Remember dismissal for 7 days
    localStorage.setItem('pwa-install-dismissed', Date.now().toString());
  };

  const handleUpdate = () => {
    updateApp();
    closePrompt();
  };

  // Check if user dismissed install prompt recently
  useEffect(() => {
    const dismissedTime = localStorage.getItem('pwa-install-dismissed');
    if (dismissedTime) {
      const daysSinceDismissed = (Date.now() - parseInt(dismissedTime)) / (1000 * 60 * 60 * 24);
      if (daysSinceDismissed < 7) {
        setDismissed(true);
      } else {
        localStorage.removeItem('pwa-install-dismissed');
      }
    }
  }, []);

  return (
    <>
      {/* Offline indicator */}
      {isOffline && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-yellow-500 text-white px-4 py-2 text-center text-sm font-medium">
          <div className="flex items-center justify-center gap-2">
            <WifiOff className="h-4 w-4" />
            <span>You're offline. Some features may be limited.</span>
          </div>
        </div>
      )}

      {/* Update available prompt */}
      {(needRefresh || offlineReady) && (
        <Card className="fixed bottom-4 right-4 z-50 p-4 shadow-lg max-w-sm">
          <div className="flex items-start gap-3">
            <RefreshCw className="h-5 w-5 text-primary mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-sm mb-1">
                {offlineReady ? 'App ready to work offline' : 'New version available'}
              </h3>
              <p className="text-sm text-muted-foreground mb-3">
                {offlineReady
                  ? 'The app is now ready to work offline.'
                  : 'A new version of the app is available. Update now for the latest features.'}
              </p>
              <div className="flex gap-2">
                {needRefresh && (
                  <Button size="sm" onClick={handleUpdate}>
                    Update Now
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={closePrompt}>
                  {needRefresh ? 'Later' : 'OK'}
                </Button>
              </div>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={closePrompt}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      )}

      {/* Install prompt */}
      {canInstall && showInstall && !dismissed && (
        <Card className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 z-50 p-4 shadow-lg max-w-sm">
          <div className="flex items-start gap-3">
            <Download className="h-5 w-5 text-primary mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-sm mb-1">Install VPP Platform</h3>
              <p className="text-sm text-muted-foreground mb-3">
                Install our app for quick access, offline support, and a native app experience.
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleInstall}>
                  Install App
                </Button>
                <Button size="sm" variant="outline" onClick={handleDismiss}>
                  Not Now
                </Button>
              </div>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={handleDismiss}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

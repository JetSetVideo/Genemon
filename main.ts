// Genemon entry point: boots the App and exposes the QA / AI-session surface.
import { App } from "./src/ui/app.ts";

function boot(): void {
  try {
    const app = new App();
    (globalThis as unknown as { __GENEMON__: unknown }).__GENEMON__ = {
      app,
      ledger: app.ledger,
      snapshot: () => app.snapshot(),
      go: (s: string) => app.go(s),
      battle: (o: Parameters<App["startBattle"]>[0]) => app.startBattle(o),
    };
  } catch (e) {
    console.error(e);
    const p = document.getElementById("panel");
    if (p) p.textContent = `Genemon failed to start: ${(e as Error).message}. WebGL is required.`;
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

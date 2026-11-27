import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VoiceCloneLibrary } from "@/ui/animas/VoiceCloneLibrary";
import { RuntimeOwnerProvider } from "@/app/runtime/RuntimeOwnerContext";
import { observations } from "./boundaries";
import "@/index.css";

// Real form, dialog, effects and mutation lifecycle; this fixture never reaches a backend.
const client = new QueryClient();
const root = createRoot(document.getElementById("root")!);
Object.assign(window, {
  voiceCloneFixture: {
    observations,
    pendingMutations: () => client.isMutating(),
    unmount: () => root.unmount(),
  },
});
root.render(
  <QueryClientProvider client={client}>
    <RuntimeOwnerProvider ownerId="voice-clone-fixture">
      <VoiceCloneLibrary
        disabled={false}
        onBusyChange={(busy) => observations.busy.push(busy)}
      />
    </RuntimeOwnerProvider>
  </QueryClientProvider>,
);

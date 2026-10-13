import {
  Outlet,
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { useRuntimeAdmission } from "@/app/runtime/RuntimeAdmissionProvider";
import { CompanionSafetyProvider } from "@/ui/safety/CompanionSafetyProvider";
import { AvatarOnlySafetyOverlay } from "@/ui/safety/CompanionSafetySlot";

import { useRememberLastActiveAnima } from "@/hooks/useRememberLastActiveAnima";
import { AnimaRouteProviders } from "@/ui/app/AnimaRouteProviders";
import { ChatInterface } from "@/ui/main/chat/ChatInterface";
import { MainShell } from "@/ui/main/MainShell";

export const Route = createFileRoute("/_app/$animaId")({
  component: AnimaRuntimeLayout,
});

function AnimaRuntimeLayout() {
  const { animaId } = Route.useParams();
  const { admission } = useRuntimeAdmission();
  const confirmed =
    admission.status === "ready" && !admission.onboardingRequired;
  useRememberLastActiveAnima(confirmed ? animaId : null);
  const params = useParams({ strict: false });
  const chatId = typeof params?.chatId === "string" ? params.chatId : null;
  const navigate = useNavigate();
  const replaceChatRoute = useCallback(
    (nextChatId: string) =>
      navigate({
        to: "/$animaId/c/$chatId",
        params: { animaId, chatId: nextChatId },
        replace: true,
      }),
    [navigate, animaId],
  );
  const openDraftChatRoute = useCallback(
    () =>
      navigate({
        to: "/$animaId",
        params: { animaId },
      }),
    [navigate, animaId],
  );
  const openMemoryEntry = useCallback(
    (entryId: string) =>
      navigate({
        to: "/memories",
        search: { tab: "memory", mode: "manual", entryId },
      }),
    [navigate],
  );

  return (
    <AnimaRouteProviders>
      <CompanionSafetyProvider key={animaId}>
        <MainShell
          avatarOnlyOverlay={<AvatarOnlySafetyOverlay />}
          // Delay chat's voice, Quick Chat and native shortcut handlers while
          // the heavier avatar/content preparation runs behind the age dialog.
          chatPanel={({ canvasMode }) =>
            confirmed ? (
              <ChatInterface
                key={animaId}
                layout={canvasMode === "chat" ? "chat-only" : "scene-overlay"}
                animaId={animaId}
                chatId={chatId}
                openDraftChatRoute={openDraftChatRoute}
                replaceChatRoute={replaceChatRoute}
                openMemoryEntry={openMemoryEntry}
              />
            ) : (
              <></>
            )
          }
        >
          <Outlet />
        </MainShell>
      </CompanionSafetyProvider>
    </AnimaRouteProviders>
  );
}

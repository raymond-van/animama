"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";

import {
  applyDesktopPipVisualState,
  captureDesktopPipVisualState,
  isDesktopPipVisualState,
  type DesktopPipVisualState,
} from "@/lib/desktop-pip/visual-state";
import { useRuntimePlatform } from "@/platform/RuntimePlatformProvider";
import {
  isProviderTimingOnlyChange,
  useAvatarLipSyncBridgeStore,
} from "@/stores/avatar-lipsync-bridge-store";
import { useAvatarRuntimeStore } from "@/stores/avatar-runtime-store";
import { useSceneVFXStore } from "@/stores/scene-vfx-store";
import type { SceneCameraSettings } from "@/ui/main/canvas/sceneCameraPresets";
import type { AvatarTransform } from "@/ui/main/canvas/transform-state";

type UseDesktopPipRuntimeProducerOptions = {
  avatarTransform: AvatarTransform;
  backgroundMode: DesktopPipBackgroundMode;
  enabled: boolean;
  sceneCameraSettings: SceneCameraSettings;
};

type UseDesktopPipRuntimeConsumerResult = {
  backgroundMode: DesktopPipBackgroundMode;
  isHovered: boolean;
  sizeScale: number;
  visualState: DesktopPipVisualState | null;
};

const SNAPSHOT_THROTTLE_MS = 60;
const DEFAULT_PIP_SIZE_SCALE = 0.5;

function createRuntimeMessage(args: {
  payload: DesktopPipVisualState | { kind: "ready" };
  animaId: string;
  sequence: number;
  type: DesktopPipRuntimeMessage["type"];
}): DesktopPipRuntimeMessage {
  return {
    type: args.type,
    sequence: args.sequence,
    sentAtMs: performance.now(),
    animaId: args.animaId,
    payload: args.payload,
  };
}

export function useDesktopPipRuntimeProducer({
  avatarTransform,
  backgroundMode,
  enabled,
  sceneCameraSettings,
}: UseDesktopPipRuntimeProducerOptions): void {
  const platform = useRuntimePlatform();
  const params = useParams({ strict: false });
  const animaId = typeof params?.animaId === "string" ? params.animaId : null;
  const pipBridge =
    platform.kind === "desktop" && platform.capabilities.nativePiP
      ? (platform.desktopBridge.pip ?? null)
      : null;
  const isPipWindow =
    platform.kind === "desktop" && platform.desktopBridge.windowRole === "pip";
  const sequenceRef = useRef(0);
  const latestVisualInputsRef = useRef({
    avatarTransform,
    backgroundMode,
    sceneCameraSettings,
  });
  const snapshotTimerRef = useRef<number | null>(null);

  useEffect(() => {
    latestVisualInputsRef.current = {
      avatarTransform,
      backgroundMode,
      sceneCameraSettings,
    };
  }, [avatarTransform, backgroundMode, sceneCameraSettings]);

  const publishSnapshot = useCallback(
    (messageType: DesktopPipRuntimeMessage["type"] = "snapshot") => {
      if (!enabled || !pipBridge || !animaId || isPipWindow) return;
      sequenceRef.current += 1;
      const payload = captureDesktopPipVisualState(
        latestVisualInputsRef.current,
      );
      void pipBridge
        .publishRuntimeMessage(
          createRuntimeMessage({
            payload,
            animaId,
            sequence: sequenceRef.current,
            type: messageType,
          }),
        )
        .catch(() => {});
    },
    [enabled, isPipWindow, animaId, pipBridge],
  );

  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimerRef.current !== null) return;
    snapshotTimerRef.current = window.setTimeout(() => {
      snapshotTimerRef.current = null;
      publishSnapshot("incremental");
    }, SNAPSHOT_THROTTLE_MS);
  }, [publishSnapshot]);

  useEffect(() => {
    if (!enabled || !pipBridge || !animaId || isPipWindow) return;

    const unsubscribe = pipBridge.onRuntimeMessage((message) => {
      if (message.animaId !== animaId || message.type !== "ready") {
        return;
      }
      publishSnapshot("snapshot");
    });

    void pipBridge
      .getState()
      .then((state) => {
        if (state.isOpen && state.animaId === animaId) {
          publishSnapshot("snapshot");
        }
      })
      .catch(() => {});

    return () => {
      unsubscribe();
    };
  }, [enabled, isPipWindow, animaId, pipBridge, publishSnapshot]);

  useEffect(() => {
    if (!enabled || !pipBridge || !animaId || isPipWindow) return;
    scheduleSnapshot();
  }, [
    avatarTransform,
    backgroundMode,
    enabled,
    isPipWindow,
    animaId,
    pipBridge,
    sceneCameraSettings,
    scheduleSnapshot,
  ]);

  useEffect(() => {
    if (!enabled || !pipBridge || !animaId || isPipWindow) return;

    const unsubscribeAvatarRuntime = useAvatarRuntimeStore.subscribe(() => {
      scheduleSnapshot();
    });
    const unsubscribeLipSync = useAvatarLipSyncBridgeStore.subscribe(
      (state, previous) => {
        // The PiP window does not mirror provider timing, which updates with
        // every realtime audio frame.
        if (isProviderTimingOnlyChange(state, previous)) return;
        scheduleSnapshot();
      },
    );
    const unsubscribeSceneVfx = useSceneVFXStore.subscribe(() => {
      scheduleSnapshot();
    });

    return () => {
      unsubscribeAvatarRuntime();
      unsubscribeLipSync();
      unsubscribeSceneVfx();
      if (snapshotTimerRef.current !== null) {
        window.clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
    };
  }, [enabled, isPipWindow, animaId, pipBridge, scheduleSnapshot]);
}

export function useDesktopPipRuntimeConsumer(): UseDesktopPipRuntimeConsumerResult {
  const platform = useRuntimePlatform();
  const params = useParams({ strict: false });
  const animaId = typeof params?.animaId === "string" ? params.animaId : null;
  const pipBridge =
    platform.kind === "desktop" && platform.capabilities.nativePiP
      ? (platform.desktopBridge.pip ?? null)
      : null;
  const sequenceRef = useRef(0);
  const [visualState, setVisualState] = useState<DesktopPipVisualState | null>(
    null,
  );
  const [backgroundMode, setBackgroundMode] =
    useState<DesktopPipBackgroundMode>("transparent");
  const [isHovered, setIsHovered] = useState(false);
  const [sizeScale, setSizeScale] = useState(DEFAULT_PIP_SIZE_SCALE);

  useEffect(() => {
    if (!pipBridge || !animaId) return;

    const unsubscribeRuntime = pipBridge.onRuntimeMessage((message) => {
      if (
        message.animaId !== animaId ||
        (message.type !== "snapshot" && message.type !== "incremental") ||
        !isDesktopPipVisualState(message.payload)
      ) {
        return;
      }
      if (message.sequence < sequenceRef.current) {
        return;
      }
      sequenceRef.current = message.sequence;
      applyDesktopPipVisualState(message.payload);
      setVisualState(message.payload);
      setBackgroundMode(message.payload.backgroundMode);
    });
    const unsubscribeState = pipBridge.onStateChange((state) => {
      if (state.animaId === animaId) {
        setBackgroundMode(state.backgroundMode);
        setIsHovered(state.isHovered);
        setSizeScale(state.sizeScale);
        return;
      }
      setIsHovered(false);
    });

    void pipBridge
      .publishRuntimeMessage(
        createRuntimeMessage({
          payload: { kind: "ready" },
          animaId,
          sequence: 0,
          type: "ready",
        }),
      )
      .catch(() => {});
    void pipBridge
      .getState()
      .then((state) => {
        if (state.animaId === animaId) {
          setBackgroundMode(state.backgroundMode);
          setIsHovered(state.isHovered);
          setSizeScale(state.sizeScale);
        }
      })
      .catch(() => {});

    return () => {
      unsubscribeRuntime();
      unsubscribeState();
    };
  }, [animaId, pipBridge]);

  return { backgroundMode, isHovered, sizeScale, visualState };
}

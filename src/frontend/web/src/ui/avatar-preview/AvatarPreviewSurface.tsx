"use client";

import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import { PerspectiveCamera } from "three";

import { useElementSize } from "@/hooks/useElementSize";
import type { Avatar } from "@/lib/avatar";
import {
  acquireContentPreviewResource,
  logContentPreviewLifecycle,
  type ContentPreviewRendererOwner,
} from "@/lib/content-preview/lifecycle";
import { sceneVFXActiveByKind } from "@/lib/scene-vfx/runtime-state";
import type { SceneVFXRuntimeEntry } from "@/lib/scene-vfx/types";
import { cn } from "@/lib/utils";
import { CONTINUOUS_CANVAS_RESIZE } from "@/ui/main/canvas/canvasResizeOptions";
import { CanvasViewportProvider } from "@/ui/main/canvas/CanvasViewportContext";
import { SceneRuntimeProvider } from "@/ui/main/canvas/SceneRuntimeContext";
import {
  buildCreatorCameraPreset,
  DEFAULT_SCENE_LIGHTS,
  sceneVector3ToArray,
  type CreatorCameraPreset,
  type SceneCameraSettings,
} from "@/ui/main/canvas/sceneCameraPresets";
import {
  SceneVFXOverlayLayers,
  SceneVFXUnderlayLayers,
} from "@/ui/main/scene-vfx/SceneVFXLayers";
import { AvatarShaderRendering } from "@/lib/avatar/toon-shader/AvatarShaderRendering";

export type AvatarPreviewCameraProfile = CreatorCameraPreset | "custom";

export type AvatarPreviewSurfaceProps = {
  active?: boolean;
  activeAvatar?: Avatar | null;
  cameraProfile?: AvatarPreviewCameraProfile;
  cameraSettings?: SceneCameraSettings;
  canvasTestId?: string;
  children: ReactNode;
  className?: string;
  enablePan?: boolean;
  enableRotate?: boolean;
  enableZoom?: boolean;
  enableDamping?: boolean;
  frameloop?: "always" | "demand";
  lifecycleOwner: ContentPreviewRendererOwner;
  maxDistance?: number;
  minDistance?: number;
  onCameraChanged?: (changed: boolean) => void;
  resetCameraRequest?: number;
  sceneVFX?: SceneVFXRuntimeEntry | null;
  sceneBackgroundScope?: "canvas" | "viewport";
  showDefaultLights?: boolean;
  showSceneVFX?: boolean;
  overlay?: ReactNode;
  underlay?: ReactNode;
};

function resolveCameraSettings({
  activeAvatar,
  cameraProfile,
  cameraSettings,
}: Pick<
  AvatarPreviewSurfaceProps,
  "activeAvatar" | "cameraProfile" | "cameraSettings"
>): SceneCameraSettings {
  if (cameraProfile === "custom" && cameraSettings) return cameraSettings;
  return buildCreatorCameraPreset(
    cameraProfile === "custom" || !cameraProfile ? "full-body" : cameraProfile,
    { avatar: activeAvatar },
  ).settings;
}

/**
 * Shared interactive WebGL shell for typed content previews and authoring.
 * Product routes provide their own R3F actor while this component owns the
 * camera, lighting, VFX layers, viewport contexts, and disposal telemetry.
 */
export function AvatarPreviewSurface({
  active = true,
  activeAvatar = null,
  cameraProfile = "full-body",
  cameraSettings,
  canvasTestId = "avatar-preview-canvas",
  children,
  className,
  enablePan = false,
  enableRotate = true,
  enableZoom = true,
  enableDamping = true,
  frameloop,
  lifecycleOwner,
  maxDistance = 6,
  minDistance = 0.75,
  onCameraChanged,
  resetCameraRequest = 0,
  sceneVFX = null,
  sceneBackgroundScope = "canvas",
  showDefaultLights = true,
  showSceneVFX = true,
  overlay,
  underlay,
}: AvatarPreviewSurfaceProps) {
  const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
  const hostSize = useElementSize(hostElement);
  const camera = useMemo(
    () =>
      resolveCameraSettings({ activeAvatar, cameraProfile, cameraSettings }),
    [activeAvatar, cameraProfile, cameraSettings],
  );
  const viewport = useMemo(() => {
    const hasSize = hostSize.width > 0 && hostSize.height > 0;
    return {
      width: hostSize.width,
      height: hostSize.height,
      aspectRatio: hasSize ? hostSize.width / hostSize.height : 16 / 9,
      hasSize,
    };
  }, [hostSize.height, hostSize.width]);
  const sceneRuntime = useMemo(
    () => ({ avatar: activeAvatar }),
    [activeAvatar],
  );
  const activeByKind = useMemo(
    () => sceneVFXActiveByKind(sceneVFX),
    [sceneVFX],
  );

  return (
    <CanvasViewportProvider value={viewport}>
      <SceneRuntimeProvider value={sceneRuntime}>
        <div
          ref={setHostElement}
          className={cn("relative size-full overflow-hidden", className)}
        >
          {underlay}
          {showSceneVFX ? (
            <SceneVFXUnderlayLayers
              activeByKind={activeByKind}
              backgroundScope={sceneBackgroundScope}
            />
          ) : null}
          <Canvas
            data-testid={canvasTestId}
            className="relative z-10 size-full"
            dpr={[1, 2]}
            frameloop={frameloop ?? (active ? "always" : "demand")}
            camera={{
              position: sceneVector3ToArray(camera.position),
              fov: camera.fov,
            }}
            gl={{ antialias: true, alpha: true }}
            resize={CONTINUOUS_CANVAS_RESIZE}
            onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
          >
            <AvatarPreviewLifecycleMarker owner={lifecycleOwner} />
            <AvatarShaderRendering />
            <AvatarPreviewCameraController
              settings={camera}
              resetRequest={resetCameraRequest}
              enablePan={enablePan}
              enableRotate={enableRotate}
              enableZoom={enableZoom}
              enableDamping={enableDamping}
              minDistance={minDistance}
              maxDistance={maxDistance}
              onChanged={onCameraChanged}
            />
            {showDefaultLights ? (
              <>
                <ambientLight
                  intensity={DEFAULT_SCENE_LIGHTS.ambientIntensity}
                />
                {DEFAULT_SCENE_LIGHTS.directional.map((light, index) => (
                  <directionalLight
                    key={index}
                    position={light.position}
                    intensity={light.intensity}
                  />
                ))}
              </>
            ) : null}
            {children}
          </Canvas>
          {showSceneVFX ? (
            <SceneVFXOverlayLayers
              activeByKind={activeByKind}
              className="z-20"
            />
          ) : null}
          {overlay}
        </div>
      </SceneRuntimeProvider>
    </CanvasViewportProvider>
  );
}

function AvatarPreviewCameraController({
  settings,
  resetRequest,
  enablePan,
  enableRotate,
  enableZoom,
  enableDamping,
  minDistance,
  maxDistance,
  onChanged,
}: {
  settings: SceneCameraSettings;
  resetRequest: number;
  enablePan: boolean;
  enableRotate: boolean;
  enableZoom: boolean;
  enableDamping: boolean;
  minDistance: number;
  maxDistance: number;
  onChanged?: (changed: boolean) => void;
}) {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera, invalidate } = useThree();
  const reset = useCallback(() => {
    camera.position.set(...sceneVector3ToArray(settings.position));
    if (camera instanceof PerspectiveCamera) {
      camera.fov = settings.fov;
      camera.updateProjectionMatrix();
    }
    controlsRef.current?.target.set(
      ...sceneVector3ToArray(settings.orbitTarget),
    );
    controlsRef.current?.update();
    onChanged?.(false);
    invalidate();
  }, [camera, invalidate, onChanged, settings]);

  useEffect(() => reset(), [reset, resetRequest]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enablePan={enablePan}
      enableRotate={enableRotate}
      enableZoom={enableZoom}
      enableDamping={enableDamping}
      dampingFactor={0.08}
      minDistance={minDistance}
      maxDistance={maxDistance}
      target={sceneVector3ToArray(settings.orbitTarget)}
      onChange={() => {
        const controls = controlsRef.current;
        if (!controls) return;
        const changed =
          camera.position.distanceTo(settings.position) > 0.001 ||
          controls.target.distanceTo(settings.orbitTarget) > 0.001;
        onChanged?.(changed);
      }}
    />
  );
}

function AvatarPreviewLifecycleMarker({
  owner,
}: {
  owner: ContentPreviewRendererOwner;
}) {
  const { gl } = useThree();
  useEffect(() => {
    logContentPreviewLifecycle("session_create", owner);
    const release = acquireContentPreviewResource(owner, "canvas");
    const reportLoss = () => logContentPreviewLifecycle("webgl_loss", owner);
    gl.domElement.addEventListener("webglcontextlost", reportLoss);
    return () => {
      gl.domElement.removeEventListener("webglcontextlost", reportLoss);
      release();
      logContentPreviewLifecycle("final_disposal", owner, {
        reason: "unmount",
      });
    };
  }, [gl, owner]);
  return null;
}

export { resolveCameraSettings as resolveAvatarPreviewCameraSettings };

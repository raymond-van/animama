"use client";

import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  PerspectiveCamera as DreiPerspectiveCamera,
} from "@react-three/drei";
import { AvatarTransformControls as TransformControls } from "@/ui/avatar-preview/AvatarTransformControls";
import {
  Suspense,
  type ComponentRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Group,
  MOUSE,
  PerspectiveCamera as ThreePerspectiveCamera,
} from "three";

import { getAvatarBackgroundOption } from "@/lib/avatar/backgroundOptions";
import { AvatarShaderRendering } from "@/lib/avatar/toon-shader/AvatarShaderRendering";
import type { CursorLookAtInputProvider } from "@/lib/avatar";
import { resolveAvatarBackgroundCrop } from "@/lib/avatar/backgroundCrop";
import { AvatarCanvasActor } from "./AvatarCanvasActor";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { useOptionalMountedAnimaRuntimeContent } from "@/ui/app/AnimaRouteProviders";
import { AvatarBackgroundMedia } from "@/ui/main/canvas/AvatarBackgroundMedia";
import { useCanvasViewport } from "@/ui/main/canvas/CanvasViewportContext";
import { useSettings } from "@/ui/settings/SettingsProvider";
import { SceneVFXUnderlayHost } from "@/ui/main/scene-vfx/SceneVFXUnderlayHost";
import { StageBackgroundLayer } from "@/ui/main/canvas/StageBackgroundLayer";
import type { Avatar } from "@/lib/avatar";
import { CONTINUOUS_CANVAS_RESIZE } from "@/ui/main/canvas/canvasResizeOptions";
import {
  DEFAULT_SCENE_LIGHTS,
  sceneVector3ToArray,
  type SceneCameraSettings,
} from "./sceneCameraPresets";
import {
  applyAvatarTransformToObject,
  areAvatarTransformsEqual,
  avatarTransformFromObject,
  type AvatarTransform,
  type TransformMode,
} from "./transform-state";

type SceneProps = {
  avatarActor?: ReactNode;
  avatarTransform: AvatarTransform;
  allowBackgroundLayers?: boolean;
  backgroundMediaEnabled?: boolean;
  clipVfxEnabled?: boolean;
  cursorLookAtInputProvider?: CursorLookAtInputProvider | null;
  orbitDomElement?: HTMLElement | null;
  orbitInteractionEnabled?: boolean;
  orbitModifierActive?: boolean;
  onAvatarInstanceChange?: (avatar: Avatar | null) => void;
  onAvatarTransformChange?: (transform: AvatarTransform) => void;
  playRuntimeVfxSounds?: boolean;
  sceneEffectsEnabled?: boolean;
  sceneCameraSettings: SceneCameraSettings;
  transparentBackground?: boolean;
  transformDomElement?: HTMLElement | null;
  transformMode?: TransformMode | null;
};

type OrbitControlsRef = ComponentRef<typeof OrbitControls>;
type PerspectiveCameraRef = ThreePerspectiveCamera;

function SceneCameraController({
  cameraRef,
  orbitControlsRef,
  settings,
}: {
  cameraRef: RefObject<PerspectiveCameraRef | null>;
  orbitControlsRef: RefObject<OrbitControlsRef | null>;
  settings: SceneCameraSettings;
}) {
  useLayoutEffect(() => {
    const camera = cameraRef.current;
    if (!(camera instanceof ThreePerspectiveCamera)) return;

    camera.position.x = settings.position.x;
    camera.position.y = settings.position.y;
    camera.position.z = settings.position.z;
  }, [
    cameraRef,
    settings.position.x,
    settings.position.y,
    settings.position.z,
  ]);

  useLayoutEffect(() => {
    const camera = cameraRef.current;
    if (!(camera instanceof ThreePerspectiveCamera)) return;

    if (camera.fov !== settings.fov) {
      camera.fov = settings.fov;
      camera.updateProjectionMatrix();
    }
  }, [cameraRef, settings.fov]);

  useLayoutEffect(() => {
    const controls = orbitControlsRef.current;
    if (!controls) return;

    controls.target.x = settings.orbitTarget.x;
    controls.target.y = settings.orbitTarget.y;
    controls.target.z = settings.orbitTarget.z;
    controls.update();
  }, [
    orbitControlsRef,
    settings.orbitTarget.x,
    settings.orbitTarget.y,
    settings.orbitTarget.z,
  ]);

  return null;
}

export default function Scene({
  allowBackgroundLayers = true,
  avatarActor,
  avatarTransform,
  backgroundMediaEnabled = true,
  clipVfxEnabled = true,
  cursorLookAtInputProvider = null,
  orbitDomElement = null,
  orbitInteractionEnabled = false,
  orbitModifierActive = false,
  onAvatarInstanceChange,
  onAvatarTransformChange,
  playRuntimeVfxSounds = true,
  sceneEffectsEnabled = true,
  sceneCameraSettings,
  transparentBackground = false,
  transformDomElement = null,
  transformMode = null,
}: SceneProps) {
  const [avatarRoot, setAvatarRoot] = useState<Group | null>(null);
  const [dpr, setDpr] = useState(1);
  const cameraRef = useRef<PerspectiveCameraRef | null>(null);
  const orbitControlsRef = useRef<OrbitControlsRef | null>(null);
  const logger = useMemo(() => createLogger("Scene"), []);
  const canvasViewport = useCanvasViewport();
  const { animaPreferences, animaSettings } = useSettings();
  // Authoring surfaces reuse Scene outside an Anima route and intentionally
  // have no mounted runtime catalog.
  const mountedRuntimeContent = useOptionalMountedAnimaRuntimeContent();
  const runtimeBackgroundEntry =
    mountedRuntimeContent?.data?.background_image ?? null;
  const backgroundOption = backgroundMediaEnabled
    ? mountedRuntimeContent
      ? null
      : getAvatarBackgroundOption(animaSettings?.background)
    : null;
  const backgroundCrop = backgroundOption
    ? resolveAvatarBackgroundCrop(backgroundOption, animaPreferences)
    : null;
  const mouseButtons = useMemo(
    () =>
      orbitModifierActive
        ? {
            LEFT: MOUSE.PAN,
            MIDDLE: MOUSE.DOLLY,
            RIGHT: MOUSE.PAN,
          }
        : {
            LEFT: MOUSE.ROTATE,
            MIDDLE: MOUSE.DOLLY,
            RIGHT: MOUSE.PAN,
          },
    [orbitModifierActive],
  );

  const handleAvatarRootRef = useCallback((node: Group | null) => {
    setAvatarRoot(node);
  }, []);

  useLayoutEffect(() => {
    if (!avatarRoot) return;
    applyAvatarTransformToObject(avatarRoot, avatarTransform);
  }, [avatarRoot, avatarTransform]);

  const handleTransformObjectChange = useCallback(() => {
    if (!avatarRoot || !onAvatarTransformChange) return;

    const nextTransform = avatarTransformFromObject(avatarRoot);
    if (areAvatarTransformsEqual(nextTransform, avatarTransform)) return;
    onAvatarTransformChange(nextTransform);
  }, [avatarRoot, avatarTransform, onAvatarTransformChange]);

  useEffect(() => {
    const targetDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (targetDpr <= 1) return;

    const win = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (win.requestIdleCallback) {
      const handle = win.requestIdleCallback(() => {
        setDpr(targetDpr);
      });
      return () => win.cancelIdleCallback?.(handle);
    }

    const timeout = window.setTimeout(() => {
      setDpr(targetDpr);
    }, 800);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    logger.info("Lifecycle", "Mounted");
    return () => {
      logger.info("Lifecycle", "Unmounted");
    };
  }, [logger]);

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden",
        !transparentBackground && "bg-background",
        orbitInteractionEnabled && "cursor-grab",
      )}
    >
      {!transparentBackground &&
      backgroundMediaEnabled &&
      mountedRuntimeContent ? (
        <StageBackgroundLayer
          variant="chat"
          boundImage={runtimeBackgroundEntry}
        />
      ) : !transparentBackground &&
        backgroundOption &&
        canvasViewport.hasSize ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <AvatarBackgroundMedia
            option={backgroundOption}
            crop={backgroundCrop}
            frameWidth={canvasViewport.width}
            frameHeight={canvasViewport.height}
          />
        </div>
      ) : null}
      {sceneEffectsEnabled ? (
        <SceneVFXUnderlayHost allowBackgroundLayers={allowBackgroundLayers} />
      ) : null}
      <Canvas
        className="relative z-10 h-full w-full"
        dpr={dpr}
        gl={{ antialias: true, alpha: true }}
        resize={CONTINUOUS_CANVAS_RESIZE}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
      >
        <DreiPerspectiveCamera
          ref={cameraRef}
          makeDefault
          position={sceneVector3ToArray(sceneCameraSettings.position)}
          fov={sceneCameraSettings.fov}
        />
        <SceneCameraController
          cameraRef={cameraRef}
          orbitControlsRef={orbitControlsRef}
          settings={sceneCameraSettings}
        />
        <AvatarShaderRendering />
        <ambientLight intensity={DEFAULT_SCENE_LIGHTS.ambientIntensity} />
        {DEFAULT_SCENE_LIGHTS.directional.map((light, index) => (
          <directionalLight
            key={index}
            position={light.position}
            intensity={light.intensity}
          />
        ))}
        {/* {isDev ? <axesHelper args={[5]} /> : null}
        {isDev ? (
          <Grid
            position={[0, -0.01, 0]}
            args={[10.5, 10.5]}
            cellSize={0.5}
            cellThickness={0.5}
            cellColor="#6f6f6f"
            sectionSize={3}
            sectionThickness={1}
            sectionColor="#9d4b4b"
            fadeDistance={30}
            fadeStrength={1}
            followCamera={false}
            infiniteGrid
          />
        ) : null} */}
        <group ref={handleAvatarRootRef}>
          <Suspense fallback={null}>
            {avatarActor === undefined ? (
              <AvatarCanvasActor
                clipVfxEnabled={clipVfxEnabled}
                cursorLookAtInputProvider={cursorLookAtInputProvider}
                onAvatarInstanceChange={onAvatarInstanceChange}
                playRuntimeVfxSounds={playRuntimeVfxSounds}
              />
            ) : (
              avatarActor
            )}
          </Suspense>
        </group>
        {transformMode && avatarRoot ? (
          <TransformControls
            domElement={transformDomElement ?? undefined}
            enabled
            mode={transformMode}
            object={avatarRoot}
            onObjectChange={handleTransformObjectChange}
            showX
            showY
            showZ
            size={0.85}
            space={transformMode === "translate" ? "world" : "local"}
          />
        ) : null}
        <OrbitControls
          ref={orbitControlsRef}
          makeDefault
          domElement={orbitDomElement ?? undefined}
          enabled
          enablePan={orbitInteractionEnabled && !orbitModifierActive}
          enableRotate={orbitInteractionEnabled}
          enableZoom={orbitInteractionEnabled}
          mouseButtons={mouseButtons}
          target={sceneVector3ToArray(sceneCameraSettings.orbitTarget)}
          enableDamping
          dampingFactor={0.08}
          minDistance={0.1}
          maxDistance={15}
          // onChange={invalidate}
        />
        {/* {isDev ? <Stats /> : null} */}
      </Canvas>
    </div>
  );
}

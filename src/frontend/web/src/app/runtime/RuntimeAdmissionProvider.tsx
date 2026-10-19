import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { AccountAffordances } from "./composition";
import { RuntimeController } from "./runtime-controller";

const RuntimeAdmissionContext = createContext<RuntimeController | null>(null);

export function RuntimeAdmissionProvider({
  controller,
  children,
}: {
  controller: RuntimeController;
  children: ReactNode;
}) {
  useEffect(() => {
    void controller.refresh();
    const unsubscribe = controller.composition.subscribe?.((invalidate) => {
      void controller.refresh(false, invalidate);
    });
    return () => {
      unsubscribe?.();
      controller.dispose();
    };
  }, [controller]);
  return (
    <RuntimeAdmissionContext.Provider value={controller}>
      {children}
    </RuntimeAdmissionContext.Provider>
  );
}

export function useRuntimeAdmission() {
  const controller = useContext(RuntimeAdmissionContext);
  if (!controller)
    throw new Error("Application admission requires RuntimeAdmissionProvider");
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return { ...snapshot, controller, composition: controller.composition };
}

/** Optional shell affordances may also render in isolated component previews. */
export function useOptionalRuntimeController() {
  return useContext(RuntimeAdmissionContext);
}

const withoutController = () => () => {};

/** Account controls that follow admission; isolated previews have none. */
export function useOptionalAccountAffordances(): AccountAffordances | null {
  const controller = useContext(RuntimeAdmissionContext);
  const snapshot = () => controller?.getSnapshot() ?? null;
  return (
    useSyncExternalStore(
      controller?.subscribe ?? withoutController,
      snapshot,
      snapshot,
    )?.account ?? null
  );
}

/** Nullable saved choice from hosted authority, even while settings cache is stale. */
export function useOptionalLocaleInput() {
  const controller = useContext(RuntimeAdmissionContext);
  const snapshot = () => controller?.getSnapshot() ?? null;
  return (
    useSyncExternalStore(
      controller?.subscribe ?? withoutController,
      snapshot,
      snapshot,
    )?.locale ?? null
  );
}

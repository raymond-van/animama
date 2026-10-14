import { Tabs, TabsList, TabsTrigger } from "@/ui/components/tabs";

/**
 * A creator's view: Simple shows the effect and its broad controls, Advanced
 * the full panels. It is page state: every open starts in Simple, and it is
 * neither undoable nor saved.
 */
export type CreatorMode = "simple" | "advanced";

const CREATOR_MODES: ReadonlyArray<readonly [CreatorMode, string]> = [
  ["simple", "Simple"],
  ["advanced", "Advanced"],
];

/**
 * The Simple | Advanced switch for `CreatorToolbar`'s `modeControl` slot. The
 * page passes each mode's panels to `CreatorWorkspaceShell`, so its narrow
 * panel tabs follow the mode.
 */
export function CreatorModeSwitch({
  value,
  onValueChange,
}: {
  value: CreatorMode;
  onValueChange: (mode: CreatorMode) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(mode) => onValueChange(mode as CreatorMode)}
    >
      <TabsList
        aria-label="Creator mode"
        className="border-border/70 h-11 rounded-xl border shadow-sm lg:h-12"
      >
        {CREATOR_MODES.map(([mode, label]) => (
          <TabsTrigger
            key={mode}
            value={mode}
            className="h-full rounded-lg px-2 text-xs 2xl:px-3 2xl:text-sm"
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

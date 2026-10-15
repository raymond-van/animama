"use client";

import {
  AVATAR_SHADER_IDS,
  AVATAR_SHADER_LABELS,
  useAvatarShaderStore,
} from "@/lib/avatar/toon-shader/avatarShader";
import { Button } from "@/ui/components/button";

/** Switches the experimental Avatar toon shader; each switch reloads the Avatar. */
export function AvatarShaderDebugSection() {
  const shader = useAvatarShaderStore((state) => state.shader);
  const setShader = useAvatarShaderStore((state) => state.setShader);

  return (
    <div className="space-y-1.5">
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label="Avatar shader"
      >
        {AVATAR_SHADER_IDS.map((id) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={id === shader ? "secondary" : "ghost"}
            aria-pressed={id === shader}
            onClick={() => setShader(id)}
            className="text-2xs h-7 px-2"
          >
            {AVATAR_SHADER_LABELS[id]}
          </Button>
        ))}
      </div>
      <div className="text-muted-foreground text-2xs">
        Reloads the Avatar. Tuned colours come from VRoid material names, so
        other models may look off. lilToon uses only the first directional
        light, and VRM material-colour expressions do not apply to it.
      </div>
    </div>
  );
}

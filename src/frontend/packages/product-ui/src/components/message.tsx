// Adapted from ElevenLabs UI and Vercel AI Elements (MIT AND Apache-2.0): apps/www/registry/elevenlabs-ui/ui/message.tsx; modified for Animama.
// See licenses/third-party/adapted-code.md.
import {
  useState,
  type ComponentProps,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "../lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

export type MessageLayout = "scene-overlay" | "chat-only";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant";
  messageLayout?: MessageLayout;
  overlayInset?: number;
};

export const Message = ({
  children,
  className,
  from,
  messageLayout = "scene-overlay",
  style,
  overlayInset = 0,
  ...props
}: MessageProps) => {
  const isUserMessage = from === "user";
  const desktopOverlayInset =
    messageLayout === "scene-overlay" ? overlayInset : 0;
  const insetStyle: CSSProperties = isUserMessage
    ? { paddingRight: desktopOverlayInset }
    : { paddingLeft: desktopOverlayInset };

  return (
    <div
      className={cn(
        "group flex w-full items-end justify-end gap-2 py-4",
        from === "user"
          ? "is-user"
          : "is-assistant flex-row-reverse justify-end",
        className,
      )}
      style={{ ...insetStyle, ...style }}
      {...props}
    >
      {children}
    </div>
  );
};

const messageContentShellVariants = cva(
  "is-user:dark relative isolate flex flex-col gap-2 overflow-hidden rounded-xl text-base",
  {
    variants: {
      variant: {
        contained: "max-w-[30%] px-4 py-3",
        flat: [
          "group-[.is-user]:max-w-[30%] lg:group-[.is-user]:max-w-[30%]",
          "group-[.is-user]:px-4 group-[.is-user]:py-3",
        ],
      },
    },
    defaultVariants: {
      variant: "contained",
    },
  },
);

const messageContentBackgroundVariants = cva(
  "pointer-events-none absolute inset-0 rounded-[inherit]",
  {
    variants: {
      variant: {
        // The bubble surface (theme.css) drawn with the role's tint, as
        // frosted glass or as a solid fill.
        contained: [
          "animama-glass-bubble",
          "group-[.is-user]:[--bubble-tint:var(--bubble-user)] group-[.is-user]:[--bubble-glass:var(--bubble-user-glass)]",
          "group-[.is-assistant]:[--bubble-tint:var(--bubble-anima)] group-[.is-assistant]:[--bubble-glass:var(--bubble-anima-glass)]",
        ],
        flat: [
          "group-[.is-user]:bg-secondary/90 lg:group-[.is-user]:bg-secondary",
          "group-[.is-assistant]:bg-transparent",
        ],
      },
    },
    defaultVariants: {
      variant: "contained",
    },
  },
);

const messageContentForegroundVariants = cva("relative z-10", {
  variants: {
    variant: {
      // Text matches whichever brand fill the bubble uses in each variant.
      contained: [
        "group-[.is-user]:text-primary-foreground",
        "group-[.is-assistant]:text-secondary-foreground",
      ],
      flat: [
        "group-[.is-user]:text-secondary-foreground",
        "group-[.is-assistant]:text-foreground",
      ],
    },
  },
  defaultVariants: {
    variant: "contained",
  },
});

export type MessageContentProps = HTMLMotionProps<"div"> &
  VariantProps<typeof messageContentShellVariants> & {
    /** Read once at mount; give the bubble a new key to replay the entrance. */
    animateOnEnter?: boolean;
    from?: "user" | "assistant";
    messageLayout?: MessageLayout;
  };

export const MessageContent = ({
  animateOnEnter = false,
  children,
  className,
  from = "assistant",
  messageLayout = "scene-overlay",
  style,
  variant,
  ...props
}: MessageContentProps) => {
  // Keep the entrance the bubble mounted with. A finished turn replaces the
  // streamed bubble with its saved message under the same key; dropping the
  // targets then would freeze an entrance that a hidden window, which runs no
  // animation frames, never started.
  const [entering] = useState(animateOnEnter);
  const isUserMessage = from === "user";
  const transformOrigin = isUserMessage ? "100% 100%" : "0% 100%";
  const chatOnlyClassName =
    messageLayout === "chat-only"
      ? isUserMessage
        ? "max-w-[min(72%,36rem)]"
        : "max-w-full"
      : null;

  return (
    <motion.div
      className={cn(
        messageContentShellVariants({ variant }),
        chatOnlyClassName,
        className,
      )}
      style={style}
      {...props}
    >
      <motion.div
        aria-hidden="true"
        initial={entering ? { opacity: 0.72, scaleX: 0, scaleY: 0 } : false}
        animate={entering ? { opacity: 1, scaleX: 1, scaleY: 1 } : undefined}
        transition={
          entering ? { duration: 0.42, ease: [0.16, 1, 0.3, 1] } : undefined
        }
        className={cn(messageContentBackgroundVariants({ variant }))}
        style={{ transformOrigin }}
      />
      <motion.div
        initial={entering ? { opacity: 0, y: 6 } : false}
        animate={entering ? { opacity: 1, y: 0 } : undefined}
        transition={
          entering
            ? { duration: 0.22, ease: "easeOut", delay: 0.08 }
            : undefined
        }
        className={cn(messageContentForegroundVariants({ variant }))}
      >
        {children}
      </motion.div>
    </motion.div>
  );
};

export type MessageAvatarProps = ComponentProps<typeof Avatar> & {
  src: string;
  name?: string;
};

export const MessageAvatar = ({
  src,
  name,
  className,
  ...props
}: MessageAvatarProps) => (
  <Avatar className={cn("ring-border size-8 ring-1", className)} {...props}>
    <AvatarImage alt="" className="mt-0 mb-0" src={src} />
    <AvatarFallback>{name?.slice(0, 2) || "ME"}</AvatarFallback>
  </Avatar>
);

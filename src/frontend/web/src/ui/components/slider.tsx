"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
    /** Accessible labels and value text belong on the focusable thumb. */
    thumbProps?: Pick<React.AriaAttributes, "aria-label" | "aria-valuetext">;
  }
>(({ className, thumbProps, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    data-slot="slider"
    className={cn(
      "relative flex w-full touch-none items-center select-none",
      className,
    )}
    {...props}
  >
    <SliderPrimitive.Track
      data-slot="slider-track"
      className="bg-muted relative h-2 w-full grow overflow-hidden rounded-full"
    >
      <SliderPrimitive.Range
        data-slot="slider-range"
        className="bg-primary absolute h-full"
      />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      {...thumbProps}
      data-slot="slider-thumb"
      className="border-primary/50 bg-background focus-visible:ring-ring block h-4 w-4 rounded-full border shadow transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
    />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };

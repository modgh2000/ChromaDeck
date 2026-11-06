"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { cn } from "cn"
import { CheckIcon } from "lucide-react"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border border-border-hover bg-transparent text-primary-foreground data-checked:bg-primary data-checked:border-primary data-indeterminate:bg-primary data-indeterminate:border-primary transition-[background-color,border-color] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      {...props}
    />
  )
}

function CheckboxIndicator({ className, ...props }: CheckboxPrimitive.Indicator.Props) {
  return (
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      className={cn("flex size-4 items-center justify-center", className)}
      {...props}
    >
      <CheckIcon className="size-3.5 text-primary-foreground" />
    </CheckboxPrimitive.Indicator>
  )
}

export { Checkbox, CheckboxIndicator }

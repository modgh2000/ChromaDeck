import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const cardVariants = cva(
  "relative flex flex-col justify-between p-6 transition-all",
  {
    variants: {
      variant: {
        default:
          "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-card border border-border bg-surface py-(--card-spacing) text-sm text-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img]:p-0 data-[size=sm]:[--card-spacing:--spacing(3)]",
        interactive:
          "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-card border border-border bg-surface py-(--card-spacing) text-sm text-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img]:p-0 data-[size=sm]:[--card-spacing:--spacing(3)] hover:border-border-hover hover:bg-surface-hover cursor-pointer",
        active:
          "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-[8px] border border-border-hover bg-surface py-(--card-spacing) text-sm text-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img]:p-0 data-[size=sm]:[--card-spacing:--spacing(3)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Card({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ variant }), className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-card px-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-[8px] border-t bg-transparent p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}

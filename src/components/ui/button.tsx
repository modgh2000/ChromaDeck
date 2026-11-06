import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[8px] border bg-clip-padding font-display text-sm transition focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground focus-visible:border-primary",
        outline:
          "border-border bg-transparent text-foreground hover:border-border-hover aria-expanded:bg-surface-hover",
        secondary:
          "border-border bg-surface-hover text-foreground hover:bg-border-hover aria-expanded:bg-border-hover",
        ghost:
          "border-transparent bg-transparent text-foreground aria-expanded:bg-surface-hover",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground focus-visible:border-destructive",
        link: "border-transparent text-foreground underline underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 gap-3 px-6",
        xs: "h-6 gap-1 px-3 text-xs",
        sm: "h-8 gap-1.5 px-4 text-xs",
        lg: "h-12 gap-3 px-8 text-sm",
        icon: "size-11",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  children,
  trailingIcon,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { trailingIcon?: React.ReactNode }) {
  const filled = variant === "default" || variant === "destructive"
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(
        buttonVariants({ variant, size, className }),
        trailingIcon && "pl-6 pr-1.5",
      )}
      {...props}
    >
      <span
        className="btn-content inline-flex items-center gap-[inherit] relative z-10 transition-[scale] duration-[var(--motion-fast)] ease-[var(--ease-standard)] group-hover/button:scale-[1.04]"
      >
        {children}
      </span>
      {trailingIcon && (
        <span
          data-trailing-icon
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-[translate]",
            filled ? "bg-primary-foreground/10" : "bg-surface-hover",
          )}
        >
          {trailingIcon}
        </span>
      )}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }

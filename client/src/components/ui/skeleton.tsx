import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// This & That: line sizes added once here, so callers don't size skeletons.
const skeletonVariants = cva("animate-pulse rounded-md bg-accent", {
  variants: {
    size: {
      none: "",
      line: "h-4 w-full",
      "line-short": "h-4 w-1/2",
    },
  },
  defaultVariants: { size: "none" },
})

function Skeleton({ className, size, ...props }: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(skeletonVariants({ size }), className)}
      {...props}
    />
  )
}

export { Skeleton }

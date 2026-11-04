
import * as React from "react";
import { cn } from "../lib/utils";
import { AlertCircle, CheckCircle, Info, X, AlertTriangle } from "lucide-react";

const alertVariants = {
  variant: {
    default: "bg-[var(--surface)] text-[var(--text)] [&>svg]:text-[var(--muted)]",
    destructive:
      "border-[var(--error)] text-[var(--error)] [&>svg]:text-[var(--error)]",
    success:
      "border-[color-mix(in_srgb,var(--ok)_50%,transparent)] text-[var(--ok)] [&>svg]:text-[var(--ok)]",
    warning:
      "border-[color-mix(in_srgb,var(--warn)_50%,transparent)] text-[var(--warn)] [&>svg]:text-[var(--warn)]",
    /* An informational alert has no colour of its own. The vendored version used
       the old blue, and the design system bans blue outright. */
    info:
      "border-[var(--border-strong)] text-[var(--text)] [&>svg]:text-[var(--muted)]",
  },
  size: {
    default: "p-4",
    sm: "p-3 text-sm",
    lg: "p-6 text-base"
  }
};

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The style variant of the alert */
  variant?: keyof typeof alertVariants.variant;
  /** The size of the alert */
  size?: keyof typeof alertVariants.size;
  /** Whether the alert should be dismissible */
  dismissible?: boolean;
  /** Callback fired when dismissing the alert */
  onDismiss?: () => void;
  /** Whether to display an icon */
  withIcon?: boolean;
  /** Custom icon to display */
  icon?: React.ReactNode;
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ 
    className, 
    variant = "default", 
    size = "default", 
    dismissible = false,
    onDismiss,
    withIcon = false,
    icon,
    children,
    ...props 
  }, ref) => {
    // Icon mapping based on variant
    const variantIcons = {
      default: <Info className="h-4 w-4" />,
      destructive: <AlertCircle className="h-4 w-4" />,
      success: <CheckCircle className="h-4 w-4" />,
      warning: <AlertTriangle className="h-4 w-4" />,
      info: <Info className="h-4 w-4" />
    };

    const handleDismiss = () => {
      if (onDismiss) {
        onDismiss();
      }
    };

    return (
      <div
        ref={ref}
        role="alert"
        className={cn(
          "relative w-full rounded-lg border",
          withIcon && "[&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
          withIcon && "[&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px]",
          alertVariants.variant[variant],
          alertVariants.size[size],
          className
        )}
        {...props}
      >
        {withIcon && (icon || variantIcons[variant])}
        {children}
        {dismissible && (
          <button
            className="absolute top-4 right-4 rounded-full p-1
            text-[var(--muted)]
            transition-colors hover:text-[var(--text)]
            focus:outline-none focus:ring-2 focus:ring-ring
            focus:ring-offset-2"
            onClick={handleDismiss}
            aria-label="Dismiss alert"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }
);
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement> & {
    /** Size of the title */
    size?: "sm" | "default" | "lg";
  }
>(({ className, size = "default", ...props }, ref) => {
  const sizeClasses = {
    sm: "text-sm",
    default: "text-base",
    lg: "text-lg"
  };

  return (
    <h5
      ref={ref}
      className={cn("mb-1 font-medium leading-none tracking-tight", sizeClasses[size], className)}
      {...props}
    />
  );
});
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement> & {
    /** Text color intensity */
    intensity?: "muted" | "default";
  }
>(({ className, intensity = "default", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "text-sm [&_p]:leading-relaxed", 
      intensity === "muted" ? "text-muted-foreground" : "",
      className
    )}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };

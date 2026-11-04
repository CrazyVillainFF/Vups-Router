
import * as React from "react";
import { cn } from "../lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Current progress value */
  value?: number;
  /** Maximum progress value */
  max?: number;
  /** Optional class name for the indicator element */
  indicatorClassName?: string;
  /** Whether to show indeterminate loading animation */
  indeterminate?: boolean;
  /** Color variant for the progress bar */
  color?: "default" | "primary" | "secondary" | "success" | "warning" | "danger";
  /** Size variant of the progress bar */
  size?: "sm" | "md" | "lg";
  /** Whether to show the progress value as text */
  showValue?: boolean;
  /** Animation speed for the progress transitions */
  animationSpeed?: "slow" | "normal" | "fast";
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ 
    className, 
    value = 0, 
    max = 100, 
    indicatorClassName,
    indeterminate = false,
    color = "default",
    size = "md",
    showValue = false,
    animationSpeed = "normal",
    ...props 
  }, ref) => {
    const percentage = value ? (value / max) * 100 : 0;
    const [prevPercentage, setPrevPercentage] = React.useState(percentage);
    const [isAnimating, setIsAnimating] = React.useState(false);
    
    React.useEffect(() => {
      // Only animate when the value actually changes
      if (percentage !== prevPercentage) {
        setIsAnimating(true);
        setPrevPercentage(percentage);
        
        // Reset the animation state after the transition is complete
        const timeout = setTimeout(() => {
          setIsAnimating(false);
        }, 1000); // This should match the CSS transition duration
        
        return () => clearTimeout(timeout);
      }
    }, [percentage, prevPercentage]);
    
    // Color variants
    const colorVariants = {
      default: "bg-primary",
      primary: "bg-primary",
      secondary: "bg-secondary",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-destructive"
    };
    
    // Size variants
    const sizeVariants = {
      sm: "h-2",
      md: "h-4",
      lg: "h-6"
    };
    
    // Animation speed variants in milliseconds
    const animationSpeedMs = {
      slow: 1000,
      normal: 700,
      fast: 300
    };
    
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuetext={indeterminate ? undefined : `${Math.round(percentage)}%`}
        className={cn(
          "relative w-full overflow-hidden rounded-full bg-secondary text-foreground",
          "transition-colors", // Smooth colors/shadows transition for theme toggle
          sizeVariants[size],
          className
        )}
        {...props}
      >
        <div
          className={cn(
            "h-full w-full flex-1",
            colorVariants[color],
            indeterminate ? "animate-progress-indeterminate origin-left" : "",
            indicatorClassName
          )}
          style={{
            ...(indeterminate ? {} : { transform: `translateX(-${100 - percentage}%)` }),
            transition: indeterminate
              ? "background-color 200ms, border-color 200ms, box-shadow 200ms"
              : isAnimating
              ? `transform ${animationSpeedMs[animationSpeed]}ms cubic-bezier(0.4, 0, 0.2, 1), background-color 200ms, border-color 200ms, box-shadow 200ms`
              : "background-color 200ms, border-color 200ms, box-shadow 200ms"
          }}
        />
        {showValue && (
          <div className={cn(
            "absolute inset-0 flex items-center justify-center text-xs font-semibold",
            isAnimating ? "transition-opacity duration-300" : ""
          )}>
            {Math.round(percentage)}%
          </div>
        )}
      </div>
    );
  }
);
Progress.displayName = "Progress";

export { Progress };

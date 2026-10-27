import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Shared class merger required by the vendored Lightswind UI components.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

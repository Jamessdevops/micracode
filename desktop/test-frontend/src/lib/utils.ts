import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui convention: class-name merger that respects Tailwind specificity. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

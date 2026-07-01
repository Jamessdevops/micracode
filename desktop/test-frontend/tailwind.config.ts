import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Colors are backed by CSS variables defined in `globals.css`, which flip
 * automatically under `prefers-color-scheme: dark` — so `darkMode: "media"`
 * and the token utilities (`bg-sidebar`, `text-ink-soft`, …) adapt without any
 * `dark:` variants sprinkled through the markup.
 */
const config: Config = {
  darkMode: "media",
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--bg)",
        surface: "var(--surface)",
        sidebar: {
          DEFAULT: "var(--sidebar)",
          hover: "var(--sidebar-hover)",
          active: "var(--sidebar-active)",
        },
        line: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        ink: {
          DEFAULT: "var(--text)",
          soft: "var(--text-soft)",
          faint: "var(--text-faint)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          on: "var(--on-accent)",
        },
        bubble: "var(--user-bubble)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        soft: "var(--shadow)",
      },
      keyframes: {
        blink: {
          "0%,80%,100%": { opacity: "0.25" },
          "40%": { opacity: "1" },
        },
      },
      animation: {
        blink: "blink 1.2s infinite both",
      },
    },
  },
  plugins: [animate],
};

export default config;

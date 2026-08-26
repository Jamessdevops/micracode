"""Minimal Next.js (App Router) tree so WebContainer preview can run before generation.

The scaffold ships with Tailwind, CSS-variable design tokens, Inter via
``next/font/google``, ``lucide-react`` icons, ``framer-motion``, and a
``cn()`` helper so the codegen model can produce visually polished sites
from the very first turn.
"""

from __future__ import annotations

# Paths are relative to the project root (same layout as storage docstring).
NEXT_STARTER_FILES: dict[str, str] = {
    "package.json": """\
{
  "name": "app",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev --hostname 0.0.0.0"
  },
  "dependencies": {
    "@babel/runtime": "7.25.6",
    "clsx": "2.1.1",
    "framer-motion": "11.11.17",
    "lucide-react": "0.453.0",
    "next": "14.2.18",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "tailwind-merge": "2.5.4"
  },
  "devDependencies": {
    "@types/node": "20.14.10",
    "@types/react": "18.3.3",
    "@types/react-dom": "18.3.0",
    "autoprefixer": "10.4.20",
    "postcss": "8.4.47",
    "tailwindcss": "3.4.14",
    "typescript": "5.5.4"
  }
}
""",
    "tsconfig.json": """\
{
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"]
    },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
""",
    "next-env.d.ts": """\
/// <reference types="next" />
/// <reference types="next/image-types/global" />
""",
    "next.config.mjs": """\
/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "placehold.co" },
    ],
  },
};
export default nextConfig;
""",
    "babel.config.js": """\
const path = require("path");

/**
 * Dev-only: stamp each host (lowercase) JSX element with its source location as
 * `data-mc-loc="relative/path.tsx:line:col"`. The preview click-to-select bridge
 * reads this to map a clicked DOM node back to the file that renders it.
 *
 * Presence of this Babel config makes Next use Babel instead of SWC — that's why
 * the template avoids `next/font` (which requires SWC). In production builds
 * NODE_ENV is "production", so the plugin is dropped and no attribute is emitted.
 */
function jsxSourceLoc({ types: t }) {
  return {
    visitor: {
      JSXOpeningElement(nodePath, state) {
        const name = nodePath.node.name;
        // Host elements only (div, h1, button…): components would receive it as
        // an unknown prop, and the clicked DOM node is always a host element.
        if (name.type !== "JSXIdentifier" || !/^[a-z]/.test(name.name)) return;
        const loc = nodePath.node.loc;
        if (!loc) return;
        if (nodePath.node.attributes.some(
          (a) => a.type === "JSXAttribute" && a.name.name === "data-mc-loc",
        )) return;
        const rel = path.relative(process.cwd(), state.file.opts.filename || "");
        nodePath.node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-mc-loc"),
            t.stringLiteral(`${rel}:${loc.start.line}:${loc.start.column}`),
          ),
        );
      },
    },
  };
}

module.exports = {
  presets: ["next/babel"],
  plugins: process.env.NODE_ENV === "development" ? [jsxSourceLoc] : [],
};
""",
    "postcss.config.mjs": """\
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
""",
    "tailwind.config.ts": """\
import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx,mdx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
""",
    "app/globals.css": """\
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --font-sans: "Inter", system-ui, -apple-system, sans-serif;
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 3.9%;
    --primary: 240 5.9% 10%;
    --primary-foreground: 0 0% 98%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 72.2% 50.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 240 5.9% 10%;
    --radius: 0.75rem;
  }

  .dark {
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;
    --card: 240 10% 3.9%;
    --card-foreground: 0 0% 98%;
    --popover: 240 10% 3.9%;
    --popover-foreground: 0 0% 98%;
    --primary: 0 0% 98%;
    --primary-foreground: 240 5.9% 10%;
    --secondary: 240 3.7% 15.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 240 3.7% 15.9%;
    --muted-foreground: 240 5% 64.9%;
    --accent: 240 3.7% 15.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 3.7% 15.9%;
    --input: 240 3.7% 15.9%;
    --ring: 240 4.9% 83.9%;
  }
}

@layer base {
  * {
    @apply border-border;
  }

  body {
    @apply bg-background text-foreground antialiased;
    font-feature-settings:
      "rlig" 1,
      "calt" 1;
  }
}
""",
    "lib/utils.ts": """\
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
""",
    "app/layout.tsx": """\
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Your app",
  description: "Built with Micracode.",
};

// Inter via a plain stylesheet link rather than `next/font` so the project can
// use a Babel config (which disables SWC, and `next/font` requires SWC) — Babel
// is what stamps source locations onto the DOM for click-to-select. See
// babel.config.js. `--font-sans` is defined in globals.css.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
""",
    "app/page.tsx": """\
export default function Page() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-gradient-to-b from-background to-muted">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-[28rem] bg-gradient-to-b from-primary/10 to-transparent blur-3xl"
      />
      <section className="relative mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-24 text-center">
        <span className="mb-6 inline-flex items-center rounded-full border border-border bg-background/60 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
          Micracode
        </span>
        <h1 className="text-5xl font-semibold tracking-tight md:text-6xl">
          Your app starts here
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
          Describe what you want to build in chat. Your preview updates here as it takes shape.
        </p>
      </section>
    </main>
  );
}
""",
}

import { expect, test } from "bun:test";

import { resolveSource } from "./resolveSource";

// Trimmed from a real generated app (~/opener-apps/create-a-modern-landing-page).
const PAGE = `export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-r flex flex-col items-center">
      <h1 className="text-3xl font-bold tracking-tight">ModernLanding</h1>
      <button className="mt-10 bg-white text-indigo-600 font-semibold py-3 px-6 rounded-lg">
        Get Started
      </button>
      <div className="card p-8">
        <h3 className="text-2xl font-bold mb-4">Modern Design</h3>
      </div>
      <div className="card p-8">
        <h3 className="text-2xl font-bold mb-4">Fully Responsive</h3>
      </div>
    </main>
  );
}
`;
const files = [{ path: "app/page.tsx", content: PAGE }];

test("exact class string pins the element's line", () => {
  const loc = resolveSource(
    { tag: "button", classes: ["mt-10", "bg-white", "text-indigo-600", "font-semibold", "py-3", "px-6", "rounded-lg"], text: "Get Started" },
    files,
  );
  expect(loc?.path).toBe("app/page.tsx");
  expect(loc?.line).toBe(5); // the <button ...> line
});

test("column points at the opening '<', not the className value", () => {
  const loc = resolveSource(
    { tag: "h1", classes: ["text-3xl", "font-bold", "tracking-tight"], text: "ModernLanding" },
    files,
  );
  expect(loc?.line).toBe(4);
  expect(PAGE.split("\n")[loc!.line - 1]!.slice(loc!.column, loc!.column + 3)).toBe("<h1");
});

test("repeated class string is disambiguated by nearby text", () => {
  const loc = resolveSource(
    { tag: "h3", classes: ["text-2xl", "font-bold", "mb-4"], text: "Fully Responsive" },
    files,
  );
  expect(loc?.line).toBe(12); // the second card's <h3>, not the first (line 9)
});

test("no class match falls back to unique visible text", () => {
  const loc = resolveSource({ tag: "h1", classes: [], text: "ModernLanding" }, files);
  expect(loc?.line).toBe(4);
});

test("nothing matches -> undefined (caller keeps text-only prompt)", () => {
  const loc = resolveSource({ tag: "span", classes: ["nope-xyz"], text: "absent" }, files);
  expect(loc).toBeUndefined();
});

test("ignores non-JSX files", () => {
  const loc = resolveSource(
    { tag: "h1", classes: ["text-3xl", "font-bold", "tracking-tight"], text: "ModernLanding" },
    [{ path: "readme.md", content: PAGE }],
  );
  expect(loc).toBeUndefined();
});

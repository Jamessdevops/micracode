import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Micracode",
  description: "Chat client for the Micracode Rust backend.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}

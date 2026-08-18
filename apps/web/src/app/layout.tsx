import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";
import { ReactGrab } from "./react-grab";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Micracode",
  description:
    "Open-source AI-powered web app builder with in-browser Node.js preview.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark h-full ${spaceGrotesk.variable}`}>
      <body className="h-full bg-[#0e0e11] font-sans text-white antialiased">
        <ReactGrab />
        {children}
      </body>
    </html>
  );
}

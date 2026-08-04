import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "Decision Room — Structured disagreement, clearer decisions",
    description:
      "Convene an independent council of AI specialists and turn competing perspectives into a clear, conditional recommendation.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Decision Room",
      description: "Make the call. See the disagreement.",
      type: "website",
      url: origin,
      images: [{ url: new URL("/og.png", origin), width: 1200, height: 630, alt: "Decision Room multi-agent council" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Decision Room",
      description: "Make the call. See the disagreement.",
      images: [new URL("/og.png", origin)],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DocBot Lab — Your document assistant",
  description: "Create a private document assistant with NVIDIA, Supabase and Telegram. One link for the whole class.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

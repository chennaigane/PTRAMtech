import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PTRAAM Enterprises | Field Operations",
  description: "Branch attendance, GPS journeys and travel reimbursements for PTRAAM Enterprises.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/ptraam-logo.png",
    shortcut: "/ptraam-logo.png",
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

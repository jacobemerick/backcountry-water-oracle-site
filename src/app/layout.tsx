import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DESCRIPTION =
  "Will that seep be running? We correlate a backcountry water source's " +
  "historical field reports against nearly two decades of daily precipitation " +
  "for its exact coordinates, and give you a read on whether it's likely to " +
  "have water.";

export const metadata: Metadata = {
  metadataBase: new URL("https://backcountrywateroracle.com"),
  title: {
    default: "Backcountry Water Oracle",
    template: "%s · Backcountry Water Oracle",
  },
  description: DESCRIPTION,
  openGraph: {
    title: "Backcountry Water Oracle",
    description: DESCRIPTION,
    url: "/",
    siteName: "Backcountry Water Oracle",
    type: "website",
  },
  twitter: { card: "summary", title: "Backcountry Water Oracle", description: DESCRIPTION },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

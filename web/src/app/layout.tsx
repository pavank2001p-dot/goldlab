import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import Toaster from "@/components/Toaster";
import Tour from "@/components/Tour";
import AlertWatcher from "@/components/practice/AlertWatcher";
import { UserProvider } from "@/lib/useUser";
import { THEME_SCRIPT } from "@/lib/themeScript";
import { SITE_URL } from "@/lib/site";
import PageView from "@/components/PageView";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Trading Lab: charts, backtests and paper trading",
  description: "Chart, backtest and practise trading gold, commodities, forex, indices, stocks and crypto, with news insights matched to your risk appetite.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0e12" },
    { media: "(prefers-color-scheme: light)", color: "#f5f3ee" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable} data-theme="dark" data-accent="gold" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-screen flex-col antialiased">
        <UserProvider>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
          <Toaster />
          <Tour />
          <AlertWatcher />
          <PageView />
        </UserProvider>
      </body>
    </html>
  );
}

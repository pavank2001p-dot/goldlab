import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { UserProvider } from "@/lib/useUser";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "GoldLab: gold (XAU/USD) analysis and backtesting",
  description: "Chart, backtest and understand gold trading, with news insights matched to your risk appetite.",
};

export const viewport: Viewport = { themeColor: "#0b0e12" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="flex min-h-screen flex-col antialiased">
        <UserProvider>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </UserProvider>
      </body>
    </html>
  );
}

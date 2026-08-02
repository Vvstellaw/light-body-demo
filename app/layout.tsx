import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "轻体记 · 看见身体真实的变化",
  description: "记录体重、体脂与体型照片，获得专属 AI 健身计划。",
  icons: {
    icon: "/assets/app-icon.svg",
    shortcut: "/assets/app-icon.svg",
    apple: "/assets/app-icon-180.png",
  },
  openGraph: {
    title: "轻体记 · 看见身体真实的变化",
    description: "记录体重、体脂与体型照片，获得专属 AI 健身计划。",
    images: [{ url: "/og.png", width: 1731, height: 909 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "轻体记 · 看见身体真实的变化",
    description: "每天一分钟，看见身体真实的变化。",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f8f6f3",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

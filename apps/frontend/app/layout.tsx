import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "./lib/auth";
import { ThemeProvider } from "./lib/theme";
import AppShell from "./components/AppShell";

export const metadata: Metadata = {
  title: "Cliquey — Multi-Channel Marketing Platform",
  description: "Send email, SMS, and voice campaigns to your contacts at scale. Built on AWS.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

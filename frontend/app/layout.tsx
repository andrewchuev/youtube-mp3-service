import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YouTube to MP3",
  description: "Convert authorized YouTube videos to MP3 files.",
};

const themeScript = `
(() => {
  try {
    const storageKey = "youtube-mp3.theme";
    const storedTheme = window.localStorage.getItem(storageKey);
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    const theme =
      storedTheme === "light" || storedTheme === "dark"
        ? storedTheme
        : (systemPrefersDark ? "dark" : "light");

    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  } catch (_) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
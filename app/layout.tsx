import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "./components/nav";

export const metadata: Metadata = {
  title: "LLM Observability & Eval Dashboard",
  description: "Self-hosted GenAI trace ingest, evals, drift, and alerts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}

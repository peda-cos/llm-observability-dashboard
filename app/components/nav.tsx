"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Overview" },
  { href: "/traces", label: "Traces" },
  { href: "/evals", label: "Evals" },
  { href: "/drift", label: "Drift" },
  { href: "/alerts", label: "Alerts" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">◎</span>
        <span>
          LLM Observability
          <small>GenAI semconv · evals · drift</small>
        </span>
      </div>
      <nav className="nav" aria-label="Primary">
        {links.map((link) => {
          const active =
            link.href === "/" ? pathname === "/" : pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link key={link.href} href={link.href} className={active ? "active" : undefined}>
              {link.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

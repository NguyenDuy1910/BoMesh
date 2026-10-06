import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/cn";

export interface Crumb {
  label: string;
  /** Omit for the current page. */
  href?: string;
}

export interface PageHeaderProps {
  title: string;
  /** One line saying what this page is for. */
  sub?: React.ReactNode;
  /** Where this page sits; the last crumb is usually the current page. */
  crumbs?: readonly Crumb[];
  /** Beside the title: a status badge, a Preview tag, a count. */
  titleExtra?: React.ReactNode;
  /** Exactly one primary action; the rest secondary or in a menu. */
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, sub, crumbs, titleExtra, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-5 flex flex-col items-start gap-4 min-[861px]:flex-row min-[861px]:justify-between", className)}>
      <div className="min-w-0 flex-1">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-2">
            <ol className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--text-tertiary)]">
              {crumbs.map((crumb, index) => (
                <li className="inline-flex items-center gap-1.5" key={`${crumb.label}-${index}`}>
                  {index > 0 && <ChevronRight aria-hidden="true" size={13} />}
                  {crumb.href ? (
                    <Link
                      className="rounded-[var(--radius-xs)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                      href={crumb.href}
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={index === crumbs.length - 1 ? "page" : undefined}>{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="min-w-0 text-balance text-[length:var(--text-size-title)] font-semibold leading-tight tracking-[-0.015em] text-[var(--text-primary)]">
            {title}
          </h1>
          {titleExtra}
        </div>
        {sub && (
          <p className="mt-1 max-w-[640px] text-[length:var(--text-size-body)] text-[var(--text-secondary)]">{sub}</p>
        )}
      </div>
      {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
    </header>
  );
}

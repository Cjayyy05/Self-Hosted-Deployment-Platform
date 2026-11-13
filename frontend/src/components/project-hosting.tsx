import type { HostingStatus, Project } from "@/lib/api";

const statuses: Record<HostingStatus, { label: string; style: string }> = {
  DISABLED: { label: "Hosting disabled", style: "border-slate-200 bg-slate-100 text-slate-700" },
  AVAILABLE: { label: "Available", style: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  DEPLOYING: { label: "Deploying", style: "border-blue-200 bg-blue-50 text-blue-700" },
  UNAVAILABLE: { label: "Unavailable", style: "border-slate-200 bg-slate-100 text-slate-700" },
  RECOVERING: { label: "Recovering or requires attention", style: "border-amber-200 bg-amber-50 text-amber-800" },
};

export function ProjectHosting({
  project,
  isChangingRoute = false,
}: {
  project: Pick<Project, "hostingStatus" | "localApplicationUrl">;
  isChangingRoute?: boolean;
}) {
  const { localApplicationUrl } = project;
  const status = isChangingRoute && project.hostingStatus === "AVAILABLE"
    ? "RECOVERING"
    : project.hostingStatus;
  const { label, style } = statuses[status];

  return (
    <div className="space-y-2" aria-label="Application hosting">
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}>
          {label}
        </span>
        {localApplicationUrl !== null ? (
          <span className="text-xs font-medium text-slate-600">Local only · HTTP</span>
        ) : null}
      </div>
      {localApplicationUrl !== null ? (
        <p className="break-all font-mono text-xs text-slate-700">{localApplicationUrl}</p>
      ) : null}
      {status === "AVAILABLE" && localApplicationUrl !== null ? (
        <a className="button-secondary" href={localApplicationUrl} rel="noreferrer" target="_blank">
          Open Application
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}

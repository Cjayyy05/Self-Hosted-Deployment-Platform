"use client";

import { useEffect, useState } from "react";

import type { HostingStatus, Project } from "@/lib/api";

const statuses: Record<HostingStatus, { label: string; style: string }> = {
  DISABLED: { label: "Hosting disabled", style: "border-slate-200 bg-slate-100 text-slate-700" },
  AVAILABLE: { label: "Available", style: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  VERIFYING_HTTPS: { label: "Public HTTPS unverified", style: "border-amber-200 bg-amber-50 text-amber-800" },
  DEPLOYING: { label: "Deploying", style: "border-blue-200 bg-blue-50 text-blue-700" },
  UNAVAILABLE: { label: "Unavailable", style: "border-slate-200 bg-slate-100 text-slate-700" },
  RECOVERING: { label: "Recovering or requires attention", style: "border-amber-200 bg-amber-50 text-amber-800" },
};

function usePublicAvailability(url: string | undefined, path: string | undefined) {
  const probe = url && path ? url + path : undefined;
  const [verified, setVerified] = useState<{ probe: string; signal: AbortSignal }>();

  useEffect(() => {
    if (!probe) return;
    const controller = new AbortController();
    let refresh: ReturnType<typeof setTimeout>;
    let expiry: ReturnType<typeof setTimeout>;
    async function verify() {
      if (!probe) return;
      const timeout = AbortSignal.timeout(3000);
      try {
        const response = await fetch(probe, {
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.any([controller.signal, timeout]),
        });
        if (controller.signal.aborted) return;
        clearTimeout(expiry);
        setVerified(response.status === 204 ? { probe, signal: controller.signal } : undefined);
        expiry = setTimeout(() => setVerified(undefined), 7000);
      } catch {
        if (!controller.signal.aborted) setVerified(undefined);
      } finally {
        if (!controller.signal.aborted) refresh = setTimeout(verify, 5000);
      }
    }
    void verify();
    return () => {
      controller.abort();
      clearTimeout(refresh);
      clearTimeout(expiry);
    };
  }, [probe]);

  return verified !== undefined && verified.probe === probe && !verified.signal.aborted;
}

export function ProjectHosting({
  project,
  isChangingRoute = false,
}: {
  project: Pick<Project, "hostingStatus" | "localApplicationUrl" | "publicApplicationUrl" | "publicProbePath">;
  isChangingRoute?: boolean;
}) {
  const { localApplicationUrl, publicApplicationUrl, publicProbePath, hostingStatus } = project;
  const applicationUrl = publicApplicationUrl ?? localApplicationUrl;
  const requiresPublicProbe = publicApplicationUrl !== undefined &&
    (hostingStatus === "VERIFYING_HTTPS" || hostingStatus === "AVAILABLE");
  const available = usePublicAvailability(publicApplicationUrl, requiresPublicProbe && !isChangingRoute ? publicProbePath : undefined);
  const routeStatus = requiresPublicProbe
    ? (available ? "AVAILABLE" : "VERIFYING_HTTPS")
    : hostingStatus;
  const status = isChangingRoute && routeStatus === "AVAILABLE" ? "RECOVERING" : routeStatus;
  const { label, style } = statuses[status];

  return (
    <div className="space-y-2" aria-label="Application hosting">
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}>
          {label}
        </span>
        {applicationUrl !== null ? (
          <span className="text-xs font-medium text-slate-600">{publicApplicationUrl ? "Public · HTTPS" : "Local only · HTTP"}</span>
        ) : null}
      </div>
      {applicationUrl !== null ? (
        <p className="break-all font-mono text-xs text-slate-700">{applicationUrl}</p>
      ) : null}
      {status === "AVAILABLE" && applicationUrl !== null ? (
        <a className="button-secondary" href={applicationUrl} rel="noreferrer" target="_blank">
          Open Application
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </div>
  );
}

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

export const APPROVAL_LABELS: Record<NonNullable<Project["approvalStatus"]>, string> = {
  UNAPPROVED: "Approval required",
  APPROVED: "Approved",
  WITHDRAWAL_PENDING: "Withdrawal pending",
  REVOKED: "Hosting revoked",
  UNKNOWN: "Approval unverified",
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
  project: Project;
  isChangingRoute?: boolean;
}) {
  const { localApplicationUrl, publicApplicationUrl, publicProbePath, hostingStatus, approvalStatus, certificateStatus } = project;
  const isPublic = project.publicHostingEnabled === true;
  const isApproved = approvalStatus === "APPROVED";
  const applicationUrl = isPublic ? (isApproved ? publicApplicationUrl ?? null : null) : localApplicationUrl;
  const routeCanBeVerified = isPublic && isApproved && !isChangingRoute &&
    certificateStatus === "READY" && hostingStatus === "AVAILABLE";
  const available = usePublicAvailability(
    publicApplicationUrl,
    routeCanBeVerified ? publicProbePath : undefined,
  );
  const [copyResult, setCopyResult] = useState<{ url: string; message: string }>();
  const status = isChangingRoute ? "RECOVERING"
    : isPublic && !isApproved ? "UNAVAILABLE"
      : isPublic && hostingStatus === "AVAILABLE" && !available ? "VERIFYING_HTTPS"
        : hostingStatus;
  const { label, style } = statuses[status];

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyResult({ url, message: "Public URL copied." });
    } catch {
      setCopyResult({ url, message: "Clipboard unavailable. Select and copy the URL shown above." });
    }
  }

  return (
    <div className="min-w-0 space-y-2" aria-label="Application hosting">
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}>
          {isChangingRoute ? "Updating hosting" : label}
        </span>
        {applicationUrl !== null ? (
          <span className="text-xs font-medium text-slate-600">{isPublic ? "Public · HTTPS" : "Local only · HTTP"}</span>
        ) : null}
      </div>
      {isPublic && (
        <dl className="space-y-1.5 text-sm text-slate-700">
          <div><dt className="inline font-medium">Approval</dt>{" · "}<dd className="inline">{APPROVAL_LABELS[approvalStatus ?? "UNKNOWN"]}</dd></div>
          <div><dt className="inline font-medium">Public hostname</dt>{" · "}<dd className="inline break-all font-mono text-xs">{project.publicHostname ?? "—"}</dd></div>
          <div><dt className="inline font-medium">Certificate</dt>{" · "}<dd className="inline">{!isChangingRoute && isApproved && certificateStatus === "READY" ? "Ready" : "Unverified"}</dd></div>
        </dl>
      )}
      {project.hostingError && (
        <p className="text-sm text-red-700">{project.hostingError.message}</p>
      )}
      {applicationUrl !== null ? (
        <p className="break-all font-mono text-xs text-slate-700">{applicationUrl}</p>
      ) : null}
      {status === "AVAILABLE" && applicationUrl !== null ? (
        <div className="flex flex-wrap gap-2">
          <a className="button-secondary" href={applicationUrl} rel="noreferrer" target="_blank">
            {isPublic ? "Open website" : "Open Application"}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          {isPublic && (
            <button className="button-secondary" onClick={() => void copyUrl(applicationUrl)} type="button">
              Copy public URL
            </button>
          )}
        </div>
      ) : null}
      {status === "AVAILABLE" && copyResult?.url === applicationUrl && (
        <p className="text-xs text-slate-600" role="status">{copyResult.message}</p>
      )}
    </div>
  );
}

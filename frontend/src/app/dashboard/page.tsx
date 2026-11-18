"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CreateProjectForm } from "@/components/create-project-form";
import { ProjectCard } from "@/components/project-card";
import { ProjectListSkeleton } from "@/components/project-list-skeleton";
import { useAuth } from "@/context/auth-context";
import { ApiError, PROJECT_REFRESH_INTERVAL_MS, projectApi, type Project } from "@/lib/api";

export default function DashboardPage() {
  const { logout, token, user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const requestId = useRef(0);

  const loadProjects = useCallback(
    async (signal?: AbortSignal, showLoading = true) => {
      if (token === null) return;

      const id = ++requestId.current;
      if (showLoading) setIsLoading(true);

      try {
        const projectList = await projectApi.list(token, signal);
        if (signal?.aborted || id !== requestId.current) return;
        setProjects(projectList);
        setError(null);
      } catch (requestError: unknown) {
        if (signal?.aborted || id !== requestId.current) return;

        if (requestError instanceof ApiError && requestError.status === 401) {
          logout();
          return;
        }

        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to load your projects.",
        );
      } finally {
        if (!signal?.aborted && id === requestId.current) setIsLoading(false);
      }
    },
    [logout, token],
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const refresh = async (initial = false) => {
      if (controller.signal.aborted) return;
      if (initial || !document.hidden) await loadProjects(controller.signal, initial);
      if (!controller.signal.aborted) {
        timer = window.setTimeout(() => void refresh(), PROJECT_REFRESH_INTERVAL_MS);
      }
    };
    queueMicrotask(() => void refresh(true));
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadProjects]);

  const handleProjectCreated = async () => {
    await loadProjects();
    setIsCreateOpen(false);
  };

  return (
    <div className="flex-1 bg-slate-50 px-6 py-10 lg:px-8 lg:py-12">
      <div className="mx-auto w-full max-w-7xl">
        <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
          <div>
            <p className="text-sm font-semibold text-blue-700">Project workspace</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Your projects
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Welcome back, {user?.email}. Review hosting and deployment status for each project.
            </p>
          </div>
          <button
            className="button-primary shrink-0"
            onClick={() => setIsCreateOpen((current) => !current)}
            type="button"
          >
            <span aria-hidden="true">+</span>
            {isCreateOpen ? "Close form" : "Create Project"}
          </button>
        </div>

        <div className="mt-9">
          {isCreateOpen && token !== null ? (
            <CreateProjectForm
              onCancel={() => setIsCreateOpen(false)}
              onCreated={handleProjectCreated}
              token={token}
            />
          ) : null}

          {isLoading ? <ProjectListSkeleton /> : null}

          {!isLoading && error !== null ? (
            <div className="rounded-2xl border border-red-200 bg-white px-6 py-10 text-center shadow-sm">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-red-50 text-lg font-semibold text-red-700">
                !
              </div>
              <h2 className="mt-4 text-lg font-semibold text-slate-950">
                Projects could not be loaded
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
                {error}
              </p>
              <button
                className="button-secondary mt-6"
                onClick={() => void loadProjects()}
                type="button"
              >
                Try again
              </button>
            </div>
          ) : null}

          {!isLoading && error === null && projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
              <div className="mx-auto grid h-12 w-12 grid-cols-2 gap-1.5 rounded-xl bg-slate-950 p-2.5">
                <span className="rounded-sm bg-blue-500" />
                <span className="rounded-sm bg-white" />
                <span className="rounded-sm bg-white/70" />
                <span className="rounded-sm bg-blue-300" />
              </div>
              <h2 className="mt-5 text-xl font-semibold tracking-tight text-slate-950">
                Create your first project
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
                Connect a trusted public GitHub repository and record the container
                settings DeployFlow will use.
              </p>
              <button
                className="button-primary mt-6"
                onClick={() => setIsCreateOpen(true)}
                type="button"
              >
                <span aria-hidden="true">+</span>
                Create Project
              </button>
            </div>
          ) : null}

          {!isLoading && error === null && projects.length > 0 ? (
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

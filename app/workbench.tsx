"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Job } from "@/core/jobs";
import type { ModuleManifest, OptionSchema } from "@/core/types";
import { OptionField, defaultValues } from "./option-field";

const CATEGORY_LABEL: Record<string, string> = {
  image: "Gorsel",
  video: "Video",
  audio: "Ses",
  document: "Dokuman",
  utility: "Arac",
};

const ENGINE_LABEL: Record<string, string> = {
  inproc: "Yerlesik",
  binary: "Harici program",
  docker: "Docker",
};

/** Critically damped: reaches the target and settles, never overshoots. */
const SETTLE = { type: "spring", bounce: 0, duration: 0.38 } as const;

export default function Workbench({ modules }: { modules: ModuleManifest[] }) {
  const [activeId, setActiveId] = useState(modules[0]?.id ?? "");
  const active = modules.find((m) => m.id === activeId);
  const reduced = useReducedMotion();

  const grouped = useMemo(() => {
    const map = new Map<string, ModuleManifest[]>();
    for (const m of modules) {
      const list = map.get(m.category) ?? [];
      list.push(m);
      map.set(m.category, list);
    }
    return [...map.entries()];
  }, [modules]);

  if (modules.length === 0) {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <p className="max-w-sm text-center type-body text-label-2">
          Hic modul yok. <code className="text-label">modules/</code> altina bir klasor
          ekleyip <code className="text-label">pnpm gen</code> calistir.
        </p>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen grid-cols-[264px_1fr]">
      {/* Structural material: heavier than the controls it contains. */}
      <aside className="material-sidebar sticky top-0 h-screen overflow-y-auto border-r border-separator px-3 py-6">
        <div className="mb-7 px-3">
          <h1 className="type-title text-label">Converter Hub</h1>
          <p className="mt-0.5 type-caption text-label-3">Yerel &middot; sinirsiz</p>
        </div>

        <nav className="space-y-6">
          {grouped.map(([category, items]) => (
            <div key={category}>
              <h2 className="mb-1.5 px-3 type-section text-label-3">
                {CATEGORY_LABEL[category] ?? category}
              </h2>
              <ul>
                {items.map((m) => {
                  const selected = m.id === activeId;
                  return (
                    <li key={m.id} className="relative">
                      {selected && (
                        <motion.span
                          aria-hidden
                          layoutId="nav-selection"
                          transition={reduced ? { duration: 0 } : SETTLE}
                          className="absolute inset-0 rounded-lg bg-white/[0.08]"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => setActiveId(m.id)}
                        aria-current={selected ? "page" : undefined}
                        className={`press-sm relative flex w-full items-center gap-2.5 rounded-lg px-3 py-[7px] text-left ${
                          selected ? "text-label" : "text-label-2 hover:text-label"
                        }`}
                      >
                        <span aria-hidden className="text-[15px] leading-none">
                          {m.icon}
                        </span>
                        <span className="flex-1 truncate type-body">{m.name}</span>
                        {!m.health.ok && (
                          <span
                            title={m.health.reason}
                            aria-label="Kullanilamiyor"
                            className="size-1.5 shrink-0 rounded-full bg-caution"
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <main className="min-w-0">
        <AnimatePresence mode="wait" initial={false}>
          {active && <ModulePanel key={active.id} module={active} />}
        </AnimatePresence>
      </main>
    </div>
  );
}

function ModulePanel({ module: mod }: { module: ModuleManifest }) {
  const reduced = useReducedMotion();
  const [values, setValues] = useState(() => defaultValues(mod.options));
  const [files, setFiles] = useState<File[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const busy = job?.status === "queued" || job?.status === "running";

  // The stream must be torn down when the panel unmounts, or switching modules
  // mid-run leaks an open connection per switch.
  useEffect(() => () => esRef.current?.close(), []);

  const [primary, advanced] = useMemo(() => {
    const p: OptionSchema[] = [];
    const a: OptionSchema[] = [];
    for (const o of mod.options) (o.advanced ? a : p).push(o);
    return [p, a];
  }, [mod.options]);

  const setValue = useCallback((key: string, value: string | number | boolean) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const addFiles = useCallback(
    (incoming: FileList | null) => {
      if (!incoming) return;
      const list = [...incoming];
      setFiles((prev) => (mod.accepts?.multiple ? [...prev, ...list] : list.slice(0, 1)));
    },
    [mod.accepts?.multiple]
  );

  async function start() {
    setError(null);
    esRef.current?.close();

    const form = new FormData();
    form.set("moduleId", mod.id);
    form.set("options", JSON.stringify(values));
    for (const f of files) form.append("files", f);

    let created: Job;
    try {
      const res = await fetch("/api/jobs", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Is baslatilamadi.");
      created = data.job;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    setJob(created);

    const es = new EventSource(`/api/jobs/${created.id}/events`);
    esRef.current = es;
    es.onmessage = (event) => {
      const next = JSON.parse(event.data) as Job;
      setJob(next);
      if (next.status !== "queued" && next.status !== "running") es.close();
    };
    es.onerror = () => es.close();
  }

  async function cancel() {
    if (!job) return;
    await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
  }

  const needsFiles = mod.inputMode === "files";
  const canRun = !busy && (!needsFiles || files.length > 0) && mod.health.ok;

  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
      transition={reduced ? { duration: 0.15 } : SETTLE}
    >
      {/* Floating chrome: content passes beneath it rather than being cut off. */}
      <header className="material-bar sticky top-0 z-10 border-b border-separator px-10 py-5">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <span aria-hidden className="text-xl leading-none">
            {mod.icon}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="type-title text-label">{mod.name}</h2>
            <p className="mt-0.5 truncate type-caption text-label-2">{mod.description}</p>
          </div>
          <span className="shrink-0 rounded-full border border-separator px-2.5 py-1 type-caption text-label-3">
            {ENGINE_LABEL[mod.engine] ?? mod.engine}
          </span>
        </div>
      </header>
      <div aria-hidden className="scroll-edge sticky top-[85px] z-10 -mt-px h-5" />

      <div className="mx-auto max-w-3xl space-y-7 px-10 pt-2 pb-24">
        {!mod.health.ok && (
          <Notice tone="caution" title="Bu modul su an calistirilamaz">
            {mod.health.reason ?? "Sebep bilinmiyor."}
          </Notice>
        )}

        {needsFiles && (
          <section>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInput.current?.click()}
              className={`press-sm cursor-pointer rounded-2xl border border-dashed px-6 py-11 text-center
                          transition-colors duration-150 ${
                            dragging
                              ? "border-accent bg-accent/8"
                              : "border-white/14 bg-white/[0.02] hover:border-white/28 hover:bg-white/[0.04]"
                          }`}
            >
              <p className="type-body text-label">
                {mod.accepts?.multiple ? "Dosyalari surukle" : "Dosyayi surukle"} veya tikla
              </p>
              {mod.accepts?.ext.length ? (
                <p className="mt-1 type-caption text-label-3">
                  {mod.accepts.ext.join("  ·  ")}
                </p>
              ) : null}
            </div>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple={mod.accepts?.multiple}
              accept={mod.accepts?.ext.map((e) => `.${e}`).join(",")}
              onChange={(e) => addFiles(e.target.files)}
            />

            <AnimatePresence initial={false}>
              {files.length > 0 && (
                <motion.div
                  initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={reduced ? { duration: 0.15 } : SETTLE}
                  className="overflow-hidden"
                >
                  <div className="flex items-start gap-3 pt-3">
                    <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                      {files.slice(0, 8).map((f, i) => (
                        <li
                          key={`${f.name}-${i}`}
                          title={f.name}
                          className="max-w-44 truncate rounded-md bg-white/[0.06] px-2 py-1 type-caption text-label-2"
                        >
                          {f.name}
                        </li>
                      ))}
                      {files.length > 8 && (
                        <li className="rounded-md px-2 py-1 type-caption text-label-3">
                          +<span className="tnum">{files.length - 8}</span> daha
                        </li>
                      )}
                    </ul>
                    <button
                      type="button"
                      onClick={() => setFiles([])}
                      className="press-sm shrink-0 rounded-md px-2 py-1 type-caption text-label-3 hover:text-label"
                    >
                      Temizle
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        )}

        {primary.length > 0 && (
          <section className="grid gap-5 sm:grid-cols-2">
            {primary.map((o) => (
              <div
                key={o.key}
                className={o.type === "text" && o.multiline ? "sm:col-span-2" : ""}
              >
                <OptionField schema={o} values={values} onChange={setValue} />
              </div>
            ))}
          </section>
        )}

        {advanced.length > 0 && (
          <section>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="press-sm flex items-center gap-1.5 rounded-md py-1 type-body text-label-2 hover:text-label"
            >
              <svg
                aria-hidden
                viewBox="0 0 12 12"
                className="size-3 transition-transform duration-200"
                style={{
                  transitionTimingFunction: "var(--ease-settle)",
                  transform: showAdvanced ? "rotate(90deg)" : "none",
                }}
              >
                <path
                  d="M4.5 3 7.5 6 4.5 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Gelismis ayarlar
            </button>

            <AnimatePresence initial={false}>
              {showAdvanced && (
                <motion.div
                  initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={reduced ? { duration: 0.15 } : SETTLE}
                  className="overflow-hidden"
                >
                  <div className="grid gap-5 pt-4 sm:grid-cols-2">
                    {advanced.map((o) => (
                      <div
                        key={o.key}
                        className={o.type === "text" && o.multiline ? "sm:col-span-2" : ""}
                      >
                        <OptionField schema={o} values={values} onChange={setValue} />
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        )}

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={start}
            disabled={!canRun}
            className="press rounded-xl bg-accent px-5 py-2.5 type-body font-medium text-white
                       hover:bg-accent-hi disabled:pointer-events-none disabled:opacity-35"
          >
            {busy ? "Calisiyor" : "Calistir"}
          </button>
          {busy && (
            <button
              type="button"
              onClick={cancel}
              className="press material-control rounded-xl px-4 py-2.5 type-body text-label-2 hover:text-label"
            >
              Iptal
            </button>
          )}
        </div>

        {error && (
          <Notice tone="critical" title="Baslatilamadi">
            {error}
          </Notice>
        )}

        <AnimatePresence initial={false}>{job && <JobView job={job} />}</AnimatePresence>
      </div>
    </motion.div>
  );
}

/* --------------------------------------------------------------------- job */

function JobView({ job }: { job: Job }) {
  const reduced = useReducedMotion();
  const done = job.status === "done";
  const failed = job.status === "error";

  return (
    <motion.section
      // Materialise: the surface arrives as a real object rather than a plain fade.
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.99 }}
      transition={reduced ? { duration: 0.15 } : SETTLE}
      className={`space-y-5 rounded-2xl border bg-white/[0.025] p-5 ${
        failed
          ? "border-critical/40"
          : done
            ? "border-positive/35"
            : "border-separator"
      }`}
    >
      <div>
        <div className="mb-2.5 flex items-baseline justify-between gap-4">
          <span
            className={`min-w-0 truncate type-body ${failed ? "text-critical" : "text-label"}`}
          >
            {job.error ?? job.message}
          </span>
          <span className="tnum shrink-0 type-caption text-label-3">{job.progress}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-white/8">
          <div
            className={`h-full rounded-full ${failed ? "bg-critical" : done ? "bg-positive" : "bg-accent"}`}
            style={{
              width: `${job.progress}%`,
              transition: "width 320ms var(--ease-settle), background-color 200ms linear",
            }}
          />
        </div>
      </div>

      {job.outputs.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-4">
            <h3 className="type-body font-medium text-label">
              <span className="tnum">{job.outputs.length}</span> cikti
            </h3>
            {job.outputs.length > 1 && (
              <a
                href={`/api/jobs/${job.id}/zip`}
                className="press-sm material-control rounded-lg px-3 py-1.5 type-caption text-label
                           hover:bg-white/[0.09]"
              >
                Hepsini ZIP indir
              </a>
            )}
          </div>

          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {job.outputs.map((o, i) => (
              <motion.li
                key={o.href}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={
                  reduced
                    ? { duration: 0.15 }
                    : { ...SETTLE, delay: Math.min(i * 0.028, 0.34) }
                }
              >
                <a
                  href={`/api/files/${o.href}?download`}
                  download={o.name}
                  title={`${o.name} indir`}
                  className="press-sm block overflow-hidden rounded-xl border border-white/10
                             bg-sunken transition-colors duration-150 hover:border-white/22"
                >
                  {isPreviewable(o.name) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/files/${o.href}`}
                      alt=""
                      loading="lazy"
                      className="aspect-square w-full object-contain"
                    />
                  ) : (
                    <div className="grid aspect-square place-items-center text-2xl opacity-50">
                      📄
                    </div>
                  )}
                  <div className="border-t border-white/8 px-2.5 py-2">
                    <p className="truncate type-caption text-label" title={o.name}>
                      {o.name}
                    </p>
                    <p className="tnum type-caption text-label-3">{formatBytes(o.size)}</p>
                  </div>
                </a>
              </motion.li>
            ))}
          </ul>
        </>
      )}

      {job.log.length > 0 && (
        <details className="group">
          <summary className="press-sm inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 type-caption text-label-3 hover:text-label-2">
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className="size-3 transition-transform duration-200 group-open:rotate-90"
              style={{ transitionTimingFunction: "var(--ease-settle)" }}
            >
              <path
                d="M4.5 3 7.5 6 4.5 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Kayit &middot; <span className="tnum">{job.log.length}</span> satir
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-sunken p-3 font-mono text-[11px] leading-relaxed text-label-2">
            {job.log.join("\n")}
          </pre>
        </details>
      )}
    </motion.section>
  );
}

/* ------------------------------------------------------------------ notice */

function Notice({
  tone,
  title,
  children,
}: {
  tone: "caution" | "critical";
  title: string;
  children: React.ReactNode;
}) {
  const styles =
    tone === "caution"
      ? "border-caution/35 bg-caution/8 text-caution"
      : "border-critical/35 bg-critical/8 text-critical";

  return (
    <div className={`rounded-xl border px-4 py-3 ${styles}`}>
      <p className="type-body font-medium">{title}</p>
      <p className="mt-0.5 type-caption opacity-85">{children}</p>
    </div>
  );
}

function isPreviewable(name: string): boolean {
  return /\.(png|jpe?g|webp|avif|gif|svg)$/i.test(name);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The module contract.
 *
 * Everything the UI needs to render a converter — its inputs, its option form,
 * its health state — is declared here. Adding a converter means adding one
 * folder under modules/ that default-exports a ConverterModule. No other file
 * in the project needs to change.
 */

export type Category = "image" | "video" | "audio" | "document" | "utility";

/** Where a module gets its work from. */
export type InputMode =
  /** User uploads one or more files. */
  | "files"
  /** No file input; everything comes from options (e.g. QR generation). */
  | "none";

/** How a module does its work — surfaced in the UI so heavy modules are obvious. */
export type Engine =
  /** Pure Node, in-process. No external dependency. */
  | "inproc"
  /** Shells out to a local executable (ffmpeg, tesseract...). */
  | "binary"
  /** Talks HTTP to a Docker sidecar (rembg, docling...). */
  | "docker";

/* ------------------------------------------------------------------ options */

interface OptionBase {
  key: string;
  label: string;
  help?: string;
  /** Only show this option when another option has one of these values. */
  showWhen?: { key: string; equals: (string | number | boolean)[] };
  /**
   * Tuck this option behind a disclosure. The common path stays visible; the
   * knobs most runs never touch sit one level deeper.
   */
  advanced?: boolean;
}

export type OptionSchema =
  | (OptionBase & {
      type: "select";
      default: string;
      choices: { value: string; label: string }[];
    })
  | (OptionBase & {
      type: "number";
      default: number;
      min?: number;
      max?: number;
      step?: number;
    })
  | (OptionBase & { type: "boolean"; default: boolean })
  | (OptionBase & { type: "text"; default: string; placeholder?: string; multiline?: boolean });

export type OptionValues = Record<string, string | number | boolean>;

/* -------------------------------------------------------------------- files */

export interface InputFile {
  /** Absolute path on disk inside the job's input directory. */
  path: string;
  /** Original filename as uploaded. */
  name: string;
  /** Lowercase extension without the dot. */
  ext: string;
  size: number;
}

export interface OutputFile {
  /** Absolute path on disk inside the job's output directory. */
  path: string;
  name: string;
}

/* ------------------------------------------------------------------ running */

export interface RunContext {
  inputs: InputFile[];
  /** Absolute path of the directory to write results into. Already created. */
  outDir: string;
  options: OptionValues;
  /** Report progress. `pct` is 0-100. */
  onProgress: (pct: number, message?: string) => void;
  /** Append a line to the job log, shown in the UI. */
  log: (message: string) => void;
  /** Aborted when the user cancels the job. Long tasks should honour it. */
  signal: AbortSignal;
}

export interface RunResult {
  outputs: OutputFile[];
  /** One-line human summary, e.g. "20 dosya donusturuldu (4.2 MB -> 1.1 MB)". */
  summary?: string;
}

export interface HealthStatus {
  ok: boolean;
  /** Why it is not usable, shown to the user so they know what to install. */
  reason?: string;
}

/* ------------------------------------------------------------------- module */

export interface ConverterModule {
  /** Stable, URL-safe. Must match the folder name under modules/. */
  id: string;
  name: string;
  description: string;
  category: Category;
  engine: Engine;
  /** Single emoji shown in the UI card. */
  icon: string;

  inputMode: InputMode;
  accepts?: {
    /** Lowercase extensions without the dot. Empty means "any file". */
    ext: string[];
    multiple: boolean;
  };

  options: OptionSchema[];

  /**
   * Whether the module can run right now. Used to grey out modules whose
   * dependency (a binary, a container) is missing, with an actionable reason.
   * Modules that cannot fail to be available may omit this.
   */
  health?: () => Promise<HealthStatus>;

  run: (ctx: RunContext) => Promise<RunResult>;
}

/** Helper that gives inference and a compile-time check at the definition site. */
export function defineModule(m: ConverterModule): ConverterModule {
  return m;
}

/** The shape the UI receives — everything except the non-serialisable functions. */
export type ModuleManifest = Omit<ConverterModule, "run" | "health"> & {
  health: HealthStatus;
};

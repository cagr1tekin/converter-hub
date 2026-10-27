import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray lockfile in the home directory makes Next guess the wrong workspace
  // root and trace the whole user folder. Pin it to this project.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),

  // Keep these out of the bundler and let Node resolve them from node_modules:
  // sharp is a native module, and pdfjs-dist loads its worker by file path at
  // runtime — a path that does not survive being bundled.
  serverExternalPackages: ["sharp", "pdfjs-dist"],
  experimental: {
    serverActions: { bodySizeLimit: "2gb" },
  },
};

export default nextConfig;

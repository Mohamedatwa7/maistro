// Copy the legacy single-file app into public/legacy so Next.js can serve it
// at `/` via the rewrite in next.config.ts. Runs as `prebuild`; the copy is
// generated output and git-ignored. index.html stays where it is (the tests,
// the smoke script and the preview tooling read it there) until it retires.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "legacy");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "index.html"), join(out, "index.html"));
const assets = join(root, "assets");
if (existsSync(assets)) cpSync(assets, join(root, "public", "assets"), { recursive: true });
console.log("[sync-legacy] copied index.html and assets/ into public/");

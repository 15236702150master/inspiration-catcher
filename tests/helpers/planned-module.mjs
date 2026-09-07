import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = resolve(import.meta.dirname, "../..");

export async function importPlanned(relativePath, requiredExports = []) {
  const absolutePath = resolve(projectRoot, relativePath);
  try {
    await access(absolutePath);
  } catch {
    throw new Error(
      `Planned module is missing: ${relativePath}. ` +
      "Implement the approved transcript workspace plan before marking this suite green."
    );
  }

  const module = await import(`${pathToFileURL(absolutePath).href}?test=${Date.now()}`);
  const missing = requiredExports.filter((name) => typeof module[name] !== "function");
  if (missing.length) {
    throw new Error(`${relativePath} is missing required exports: ${missing.join(", ")}`);
  }
  return module;
}

export function unwrapDatabase(value) {
  return value?.db || value?.database || value;
}


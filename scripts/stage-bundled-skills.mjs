import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.join(os.homedir(), ".codexh", "skills");
const outputRoot = path.resolve("build", "seed-skills");
const scopes = ["system", "imported", "installed"];

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputRoot, { recursive: true });

for (const scope of scopes) {
  const source = path.join(sourceRoot, scope);
  const destination = path.join(outputRoot, scope);
  try {
    await fs.access(source);
    await fs.cp(source, destination, { recursive: true, force: true, preserveTimestamps: true });
  } catch {
    await fs.mkdir(destination, { recursive: true });
  }
}

console.log(`Bundled skills staged from ${sourceRoot}`);

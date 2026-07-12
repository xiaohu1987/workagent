import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const toolDir = path.resolve("build", "tools");
const output = path.join(toolDir, "rcedit-x64.exe");
const archive = path.join(toolDir, "winCodeSign.7z");
const mirror = process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? "https://npmmirror.com/mirrors/electron-builder-binaries/";
const archiveUrl = `${mirror.replace(/\/?$/, "/")}winCodeSign-2.6.0/winCodeSign-2.6.0.7z`;

await fs.mkdir(toolDir, { recursive: true });
try {
  await fs.access(output);
  console.log(`Windows icon tool ready: ${output}`);
  process.exit(0);
} catch {}

const cachedTool = await findCachedRcedit(path.join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache", "winCodeSign"));
if (cachedTool) {
  await fs.copyFile(cachedTool, output);
  console.log(`Windows icon tool copied from cache: ${output}`);
  process.exit(0);
}

const response = await fetch(archiveUrl);
if (!response.ok) throw new Error(`Unable to download rcedit: HTTP ${response.status}`);
await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
const sevenZip = path.resolve("node_modules", ".pnpm", "7zip-bin@5.2.0", "node_modules", "7zip-bin", "win", "x64", "7za.exe");
execFileSync(sevenZip, ["e", "-y", archive, "rcedit-x64.exe", `-o${toolDir}`], { stdio: "inherit" });
await fs.access(output);
console.log(`Windows icon tool downloaded: ${output}`);

async function findCachedRcedit(root) {
  try {
    const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    const entry = entries.find((item) => item.isFile() && item.name === "rcedit-x64.exe");
    return entry ? path.join(entry.parentPath, entry.name) : null;
  } catch {
    return null;
  }
}

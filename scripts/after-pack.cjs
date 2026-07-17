const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function wait(milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    // rcedit can race with Defender scanning the freshly copied Electron binary.
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const root = process.cwd();
  const tool = path.join(root, "build", "tools", "rcedit-x64.exe");
  const icon = path.join(root, "assets", "icon.ico");
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  if (!fs.existsSync(tool)) throw new Error("rcedit-x64.exe is missing. Run prepare:windows-icon before packaging.");
  if (!fs.existsSync(icon)) throw new Error("assets/icon.ico is missing.");
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      execFileSync(tool, [executable, "--set-icon", icon], { stdio: "inherit" });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) wait(attempt * 500);
    }
  }
  throw new Error(`Unable to set the Windows executable icon after 5 attempts: ${lastError?.message ?? "unknown rcedit error"}`);
};

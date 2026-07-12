const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const root = process.cwd();
  const tool = path.join(root, "build", "tools", "rcedit-x64.exe");
  const icon = path.join(root, "assets", "icon.ico");
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  if (!fs.existsSync(tool)) throw new Error("rcedit-x64.exe is missing. Run prepare:windows-icon before packaging.");
  if (!fs.existsSync(icon)) throw new Error("assets/icon.ico is missing.");
  execFileSync(tool, [executable, "--set-icon", icon], { stdio: "inherit" });
};

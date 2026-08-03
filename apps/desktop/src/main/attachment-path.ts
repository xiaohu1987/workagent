import path from "node:path";

/** Returns whether a picked file belongs to the current project. */
export function isProjectAttachmentPath(projectRoot: string | null | undefined, filePath: string | undefined): filePath is string {
  if (!projectRoot || !filePath || !path.isAbsolute(filePath)) return false;

  const relative = path.relative(path.resolve(projectRoot), path.resolve(filePath));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

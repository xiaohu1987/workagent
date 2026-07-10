import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import type { SkillMetadata, SkillScope } from "@shared-types";

const SKILL_FILE = "SKILL.md";
const METADATA_FILE = path.join("agents", "openai.yaml");
const MAX_SCAN_DEPTH = 6;

export interface SkillRootDefinition {
  path: string;
  scope: SkillScope;
  pluginId?: string;
}

interface OpenAiMetadataFile {
  interface?: {
    display_name?: string;
    short_description?: string;
    default_prompt?: string;
    brand_color?: string;
  };
  dependencies?: {
    tools?: Array<{
      type?: string;
      value?: string;
      description?: string;
      transport?: string;
      command?: string;
      url?: string;
    }>;
  };
  policy?: {
    allow_implicit_invocation?: boolean;
    products?: string[];
  };
}

export function discoverSkillRoots(appHome: string, cwd?: string | null): SkillRootDefinition[] {
  const roots: SkillRootDefinition[] = [
    { path: path.join(appHome, "skills", "system"), scope: "system" },
    { path: path.join(appHome, "skills", "imported"), scope: "user" },
    { path: path.join(appHome, "skills", "installed"), scope: "user" },
    { path: path.join(appHome, "skills", "drafts"), scope: "user" }
  ];

  if (cwd) {
    roots.unshift(
      { path: path.join(cwd, ".codexh", "skills"), scope: "repo" },
      { path: path.join(cwd, ".agents", "skills"), scope: "repo" },
      { path: path.join(cwd, ".codex", "skills"), scope: "repo" }
    );
  }

  return roots;
}

export async function loadSkillsFromRoots(
  roots: SkillRootDefinition[]
): Promise<SkillMetadata[]> {
  const discovered = new Map<string, SkillMetadata>();

  for (const root of roots) {
    const skills = await scanSkillRoot(root);
    for (const skill of skills) {
      if (!discovered.has(skill.skillPath)) {
        discovered.set(skill.skillPath, skill);
      }
    }
  }

  return [...discovered.values()].sort((left, right) => {
    const scopeRank = (scope: SkillScope): number => {
      switch (scope) {
        case "repo":
          return 0;
        case "user":
          return 1;
        case "system":
          return 2;
        case "admin":
          return 3;
      }
    };

    return (
      scopeRank(left.scope) - scopeRank(right.scope) ||
      left.qualifiedName.localeCompare(right.qualifiedName)
    );
  });
}

async function scanSkillRoot(root: SkillRootDefinition): Promise<SkillMetadata[]> {
  try {
    await fs.access(root.path);
  } catch {
    return [];
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root.path, depth: 0 }];
  const skills: SkillMetadata[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = await fs.readdir(current.dir, { withFileTypes: true });
    const hasSkillFile = entries.some((entry) => entry.isFile() && entry.name === SKILL_FILE);

    if (hasSkillFile) {
      const skill = await readSkillDirectory(current.dir, root);
      if (skill) {
        skills.push(skill);
      }
      continue;
    }

    if (current.depth >= MAX_SCAN_DEPTH) {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
  }

  return skills;
}

async function readSkillDirectory(
  skillDir: string,
  root: SkillRootDefinition
): Promise<SkillMetadata | null> {
  const skillPath = path.join(skillDir, SKILL_FILE);
  const content = await fs.readFile(skillPath, "utf8");
  const parsed = matter(content);
  const metadata = await readOptionalMetadataFile(skillDir);
  const name = typeof parsed.data.name === "string" && parsed.data.name.trim().length > 0
    ? parsed.data.name.trim()
    : path.basename(skillDir);
  const description = typeof parsed.data.description === "string"
    ? parsed.data.description.trim()
    : "";

  if (!description) {
    return null;
  }

  const hash = createHash("sha256").update(content).digest("hex");
  const namespace = root.pluginId ? `${root.pluginId}:${name}` : name;

  return {
    id: hash,
    name,
    qualifiedName: namespace,
    description,
    shortDescription:
      typeof parsed.data.metadata?.["short-description"] === "string"
        ? parsed.data.metadata["short-description"]
        : metadata?.interface?.short_description,
    scope: root.scope,
    rootPath: root.path,
    skillPath,
    metadataPath: metadata ? path.join(skillDir, METADATA_FILE) : null,
    pluginId: root.pluginId,
    defaultPrompt: metadata?.interface?.default_prompt,
    displayName: metadata?.interface?.display_name,
    brandColor: metadata?.interface?.brand_color,
    dependencies: metadata?.dependencies?.tools ?? [],
    allowImplicitInvocation: metadata?.policy?.allow_implicit_invocation ?? true,
    products: metadata?.policy?.products ?? [],
    contentHash: hash
  };
}

async function readOptionalMetadataFile(
  skillDir: string
): Promise<OpenAiMetadataFile | null> {
  const metadataPath = path.join(skillDir, METADATA_FILE);

  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return YAML.parse(raw) as OpenAiMetadataFile;
  } catch {
    return null;
  }
}

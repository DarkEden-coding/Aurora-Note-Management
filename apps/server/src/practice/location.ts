// Where practice notes live: lists the library's project/folder paths for Claude and resolves a chosen path, creating what is missing.
import { createFolder, listFolders } from "../library/folders.js";
import { createProject, listProjects } from "../library/projects.js";
import { invalid } from "../errors.js";

export type PracticeLocation = { project: string; folder?: string | undefined };

type FolderNode = { id: string; parentId: string | null; name: string };

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Splits "Calculus / Derivatives" into ["Calculus", "Derivatives"]. */
export function folderSegments(path: string | undefined): string[] {
  return (path ?? "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Every folder as a "/"-joined path from its project root, sorted. */
export function folderPaths(folders: FolderNode[]): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const pathOf = (folder: FolderNode): string => {
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    return parent ? `${pathOf(parent)}/${folder.name}` : folder.name;
  };
  return folders.map(pathOf).sort((a, b) => a.localeCompare(b));
}

export async function listLocations(
  ownerId: string,
): Promise<{ project: string; folders: string[] }[]> {
  const projects = await listProjects(ownerId, false);
  return Promise.all(
    projects.map(async (project) => ({
      project: project.name,
      folders: folderPaths(await listFolders(ownerId, project.id)),
    })),
  );
}

/** Finds the project and folder path by name (case-insensitive), creating any missing part. */
export async function resolveLocation(
  ownerId: string,
  location: PracticeLocation,
): Promise<{ projectId: string; folderId: string | null }> {
  const projectName = location.project.trim();
  if (!projectName) throw invalid("Project name is required");
  const projects = await listProjects(ownerId, false);
  const projectId =
    projects.find((project) => sameName(project.name, projectName))?.id ??
    (await createProject(ownerId, { name: projectName })).id;

  const folders = await listFolders(ownerId, projectId);
  let parentId: string | null = null;
  for (const name of folderSegments(location.folder)) {
    const existing = folders.find(
      (folder) => folder.parentId === parentId && sameName(folder.name, name),
    );
    parentId =
      existing?.id ??
      (
        await createFolder(ownerId, projectId, {
          name,
          parentId: parentId ?? undefined,
        })
      ).id;
  }
  return { projectId, folderId: parentId };
}

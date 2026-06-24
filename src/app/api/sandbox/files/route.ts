import { NextResponse } from 'next/server';
import { auth0 } from '../../../../lib/auth0';
import { getProject, getProjectFiles } from '../../../../lib/db/projects';
import { getProjectSandbox } from '../../../../lib/daytona';
import { normalizeDirectoryPath } from '../../../../lib/project-paths';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await auth0.getSession();
  if (!session?.user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId');

  if (!projectId) {
    return new NextResponse('Missing projectId', { status: 400 });
  }

  try {
    const pathParam = normalizeDirectoryPath(searchParams.get('path') || '.');
    const project = await getProject(projectId, session.user.sub);
    if (!project) {
      return new NextResponse('Project not found', { status: 404 });
    }

    const allFiles = await getProjectFiles(projectId, session.user.sub);

    // Build a virtual directory tree based on the paths
    const filesInDir = new Map<string, { name: string, isDir: boolean, size: number }>();
    
    // Normalize path to not have trailing slash unless it's '.'
    const normalizedPath = pathParam === '.' ? '' : (pathParam.endsWith('/') ? pathParam.slice(0, -1) : pathParam);
    const prefix = normalizedPath ? `${normalizedPath}/` : '';

    for (const file of allFiles) {
      if (file.path === 'preview.html') continue;
      if (prefix && !file.path.startsWith(prefix)) continue;
      
      const relativePath = prefix ? file.path.slice(prefix.length) : file.path;
      if (!relativePath) continue;

      const parts = relativePath.split('/');
      const isDir = parts.length > 1;
      const name = parts[0];

      if (!filesInDir.has(name)) {
        filesInDir.set(name, {
          name,
          isDir,
          size: file.content?.length || 0
        });
      } else if (isDir) {
        // If it was added as a file (shouldn't happen) but we now see it's a dir, mark it as dir
        const existing = filesInDir.get(name)!;
        existing.isDir = true;
      }
    }

    try {
      const sandbox = await getProjectSandbox(projectId);
      const rawFiles = await sandbox.fs.listFiles(pathParam);
      // Filter out system files so they don't clutter the UI
      const ignored = ['.daytona', '.bashrc', '.profile', '.bash_logout', 'node_modules', '.next', '.git', '.turbo', '.vercel', 'dist', 'build', 'coverage'];

      for (const file of rawFiles) {
        if (!file.name || ignored.includes(file.name)) continue;
        const existing = filesInDir.get(file.name);

        if (!existing) {
          filesInDir.set(file.name, {
            name: file.name,
            isDir: Boolean(file.isDir),
            size: file.size || 0,
          });
          continue;
        }

        if (file.isDir) {
          existing.isDir = true;
        }

        existing.size = Math.max(existing.size, file.size || 0);
      }
    } catch {
      // Daytona may be unavailable or unauthorized; DB files remain usable.
    }

    return NextResponse.json({ files: Array.from(filesInDir.values()) });
  } catch (error: any) {
    console.error('Error fetching sandbox files:', error);
    return new NextResponse(error.message || 'Internal Server Error', { status: 500 });
  }
}

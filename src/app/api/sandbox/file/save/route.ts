import { NextResponse } from 'next/server';
import { auth0 } from '../../../../../lib/auth0';
import { getProjectSandbox } from '../../../../../lib/daytona';
import { getProject, saveProjectFile } from '../../../../../lib/db/projects';
import { normalizeProjectPath } from '../../../../../lib/project-paths';

export async function POST(req: Request) {
  const session = await auth0.getSession();
  if (!session?.user) return new NextResponse('Unauthorized', { status: 401 });

  try {
    const { projectId, path, content } = await req.json();

    if (!projectId || !path || content === undefined) {
      return new NextResponse('Missing parameters', { status: 400 });
    }

    const project = await getProject(projectId, session.user.sub);
    if (!project) {
      return new NextResponse('Project not found', { status: 404 });
    }

    const cleanPath = normalizeProjectPath(path);

    // 1. Save to Database
    await saveProjectFile(projectId, session.user.sub, cleanPath, content);

    // 2. Save to Daytona Sandbox (sync)
    try {
      const sandbox = await getProjectSandbox(projectId);
      const buf = Buffer.from(content, 'utf8');
      await sandbox.fs.uploadFile(buf, cleanPath);
    } catch (daytonaErr) {
      console.warn('Failed to sync to Daytona, but saved to DB:', daytonaErr);
      // We don't fail the request if Daytona is offline or sleeping,
      // because DB is now the source of truth!
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error saving file:', error);
    return new NextResponse(error.message || 'Internal Server Error', { status: 500 });
  }
}

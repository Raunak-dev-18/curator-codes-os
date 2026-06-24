import { NextResponse } from 'next/server';
import { auth0 } from '../../../../../lib/auth0';
import { getProjectSandbox } from '../../../../../lib/daytona';
import { deleteProjectFile, getProject, renameProjectFile } from '../../../../../lib/db/projects';
import { normalizeProjectPath } from '../../../../../lib/project-paths';

export async function DELETE(req: Request) {
  const session = await auth0.getSession();
  if (!session?.user) return new NextResponse('Unauthorized', { status: 401 });

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId');
  const path = searchParams.get('path');

  if (!projectId || !path) {
    return new NextResponse('Missing projectId or path', { status: 400 });
  }

  try {
    const project = await getProject(projectId, session.user.sub);
    if (!project) {
      return new NextResponse('Project not found', { status: 404 });
    }

    const cleanPath = normalizeProjectPath(path);
    try {
      const sandbox = await getProjectSandbox(projectId);
      await sandbox.fs.deleteFile(cleanPath, true);
    } catch (daytonaErr) {
      console.warn('Daytona delete failed (maybe file only exists in DB or sandbox is down):', daytonaErr);
    }
    
    await deleteProjectFile(projectId, session.user.sub, cleanPath);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting file:', error);
    return new NextResponse(error.message || 'Internal Server Error', { status: 500 });
  }
}

export async function PUT(req: Request) {
  const session = await auth0.getSession();
  if (!session?.user) return new NextResponse('Unauthorized', { status: 401 });

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId');
  const path = searchParams.get('path');
  const newPath = searchParams.get('newPath');

  if (!projectId || !path || !newPath) {
    return new NextResponse('Missing parameters', { status: 400 });
  }

  try {
    const project = await getProject(projectId, session.user.sub);
    if (!project) {
      return new NextResponse('Project not found', { status: 404 });
    }

    const cleanPath = normalizeProjectPath(path);
    const cleanNewPath = normalizeProjectPath(newPath);
    try {
      const sandbox = await getProjectSandbox(projectId);
      await sandbox.fs.moveFiles(cleanPath, cleanNewPath);
    } catch (daytonaErr) {
      console.warn('Daytona rename failed (maybe file only exists in DB or sandbox is down):', daytonaErr);
    }

    await renameProjectFile(projectId, session.user.sub, cleanPath, cleanNewPath);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error renaming file:', error);
    return new NextResponse(error.message || 'Internal Server Error', { status: 500 });
  }
}

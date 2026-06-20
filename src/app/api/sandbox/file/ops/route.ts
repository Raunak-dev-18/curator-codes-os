import { NextResponse } from 'next/server';
import { auth0 } from '../../../../../lib/auth0';
import { getProjectSandbox } from '../../../../../lib/daytona';
import { deleteProjectFile, renameProjectFile } from '../../../../../lib/db/projects';

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
    const sandbox = await getProjectSandbox(projectId);
    const result = await sandbox.process.exec(`rm -rf "${path}"`);
    if (result.exitCode !== 0) {
      console.warn('Daytona delete failed (maybe file only exists in DB):', result.stderr);
    }
    
    await deleteProjectFile(projectId, path);
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
    const sandbox = await getProjectSandbox(projectId);
    const result = await sandbox.process.exec(`mv "${path}" "${newPath}"`);
    if (result.exitCode !== 0) {
      console.warn('Daytona rename failed (maybe file only exists in DB):', result.stderr);
    }

    await renameProjectFile(projectId, path, newPath);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error renaming file:', error);
    return new NextResponse(error.message || 'Internal Server Error', { status: 500 });
  }
}

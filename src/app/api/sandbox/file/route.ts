import { NextResponse } from 'next/server';
import { auth0 } from '../../../../lib/auth0';
import { getProjectFiles } from '../../../../lib/db/projects';
import { getProjectSandbox } from '../../../../lib/daytona';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await auth0.getSession();
  if (!session?.user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId');
  const path = searchParams.get('path');

  if (!projectId || !path) {
    return new NextResponse('Missing projectId or path', { status: 400 });
  }

  try {
    const allFiles = await getProjectFiles(projectId);
    const cleanPath = path.startsWith('./') ? path.slice(2) : path;
    const file = allFiles.find(f => f.path === cleanPath);

    if (!file) {
      // Fallback to Daytona for backward compatibility with older projects
      try {
        const sandbox = await getProjectSandbox(projectId);
        const fileBuffer = await sandbox.fs.downloadFile(path);
        return new NextResponse(fileBuffer.toString('utf8'), {
          headers: { 'Content-Type': 'text/plain' }
        });
      } catch (fallbackErr) {
        return new NextResponse('File not found in database or Daytona', { status: 404 });
      }
    }

    return new NextResponse(file.content, {
      headers: { 'Content-Type': 'text/plain' }
    });
  } catch (error: any) {
    console.error('Error fetching sandbox file:', error);
    return new NextResponse(error.message || 'Internal Server Error', { status: 500 });
  }
}

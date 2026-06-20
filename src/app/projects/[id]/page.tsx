import { auth0 } from '../../../lib/auth0';
import { redirect } from 'next/navigation';
import { getProject, createProject } from '../../../lib/db/projects';
import { Workspace } from '../../../components/project/Workspace';

export default async function ProjectPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ prompt?: string }>;
}) {
  const session = await auth0.getSession();
  if (!session?.user) {
    redirect('/auth/login');
  }

  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;

  const userId = session.user.sub;
  const projectId = resolvedParams.id;
  
  let project = await getProject(projectId, userId);

  // If the project doesn't exist, create it
  if (!project) {
    if (resolvedSearchParams.prompt) {
      const title = resolvedSearchParams.prompt.slice(0, 30) + (resolvedSearchParams.prompt.length > 30 ? '...' : '');
      project = await createProject(userId, projectId, title);
    } else {
      redirect('/dashboard');
    }
  }

  // Serialize the MongoDB document before passing to Client Component
  const serializedProject = {
    id: project._id.toString(),
    name: project.name,
    messages: project.messages || []
  };

  return <Workspace project={serializedProject} initialPrompt={resolvedSearchParams.prompt} />;
}

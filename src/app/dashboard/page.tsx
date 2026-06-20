import { auth0 } from '../../lib/auth0';
import { redirect } from 'next/navigation';
import { Sidebar } from '../../components/ui/sidebar';
import { PromptForm } from '../../components/ui/prompt-form';
import { getUserProjects } from '../../lib/db/projects';

export default async function Dashboard() {
  const session = await auth0.getSession();
  
  if (!session?.user) {
    redirect('/auth/login');
  }

  const { user } = session;
  
  // Fetch user's projects to populate the sidebar with error handling
  let projects: any[] = [];
  try {
    const rawProjects = await getUserProjects(user.sub);
    projects = rawProjects.map(p => ({ id: p._id.toString(), name: p.name }));
  } catch (error) {
    console.error("Failed to fetch projects from MongoDB:", error);
  }

  return (
    <div className="dashboard-layout">
      <Sidebar user={user} projects={projects} />

      {/* Main Content Area */}
      <main className="prompt-center-container">
        <PromptForm />
      </main>
    </div>
  );
}

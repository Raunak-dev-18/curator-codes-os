import { auth0 } from '../../lib/auth0';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function Dashboard() {
  const session = await auth0.getSession();
  
  if (!session?.user) {
    redirect('/auth/login');
  }

  const { user } = session;

  return (
    <div className="dashboard-layout">
      {/* Minimal Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          <span>AI Builder</span>
        </div>
        
        <nav className="sidebar-nav">
          <Link href="/dashboard" className="sidebar-link active">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg> 
            <span>New Project</span>
          </Link>
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile">
            <div className="profile-avatar">
              <img src={user.picture || ''} alt={user.name || 'User Avatar'} />
            </div>
            <div className="user-info">
              <span className="user-name">{user.name}</span>
              <a href="/auth/logout" className="logout-link">Sign Out</a>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        <div className="prompt-container">
          <h1 className="prompt-title">What would you like to build?</h1>
          <p className="prompt-subtitle">
            Describe your application, and our AI will generate the initial structure for you.
          </p>

          <form className="prompt-card">
            <textarea 
              placeholder="e.g., Build a customer support chatbot that answers questions based on my company's knowledge base..."
              className="prompt-textarea"
              rows={1}
            />
            <div className="prompt-footer">
              <div className="prompt-tools">
                <button type="button" className="icon-btn" title="Attach file">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                </button>
              </div>
              <button type="submit" className="btn btn-primary" style={{ padding: '0.4rem 1.2rem', fontSize: '0.875rem' }}>
                Generate
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

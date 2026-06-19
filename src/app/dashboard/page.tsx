import { getSession } from '@auth0/nextjs-auth0';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function Dashboard() {
  const session = await getSession();
  
  if (!session?.user) {
    redirect('/api/auth/login');
  }

  const { user } = session;

  return (
    <div className="dashboard-layout">
      {/* Minimal Glass Sidebar */}
      <aside className="sidebar glass-card" style={{ borderRadius: 0, borderTop: 'none', borderBottom: 'none', borderLeft: 'none' }}>
        <h2 className="gradient-text" style={{ marginBottom: '2rem', fontSize: '1.25rem' }}>AI Builder</h2>
        
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '1rem', flex: 1 }}>
          <Link href="/dashboard" style={{ color: 'var(--accent-primary)', textDecoration: 'none', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.2rem' }}>✨</span> New Project
          </Link>
          <Link href="/dashboard/history" style={{ color: 'var(--text-secondary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.2rem' }}>📚</span> History
          </Link>
          <Link href="/dashboard/settings" style={{ color: 'var(--text-secondary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.2rem' }}>⚙️</span> Settings
          </Link>
        </nav>

        <div style={{ marginTop: 'auto', paddingTop: '2rem', borderTop: '1px solid var(--card-border)', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div className="profile-avatar" style={{ width: '40px', height: '40px' }}>
            <img src={user.picture || ''} alt={user.name || 'User Avatar'} />
          </div>
          <div style={{ overflow: 'hidden' }}>
            <p style={{ fontSize: '0.875rem', fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{user.name}</p>
            <Link href="/api/auth/logout" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textDecoration: 'none' }}>Sign Out</Link>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        <div className="blob blob-1" style={{ opacity: 0.5, top: '20%', left: '30%' }}></div>
        <div className="blob blob-2" style={{ opacity: 0.5, bottom: '20%', right: '30%' }}></div>

        <div style={{ maxWidth: '800px', width: '100%', zIndex: 10, textAlign: 'center' }}>
          <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', fontWeight: 600 }}>What would you like to build?</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '3rem' }}>
            Describe your application, and our AI will generate the initial structure for you.
          </p>

          <form className="glass-card prompt-form" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', borderRadius: '16px' }}>
            <textarea 
              placeholder="e.g., Build a customer support chatbot that answers questions based on my company's knowledge base..."
              className="prompt-input"
              rows={4}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                fontSize: '1rem',
                resize: 'none',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--card-border)', paddingTop: '1rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="icon-btn" title="Attach file">📎</button>
                <button type="button" className="icon-btn" title="Settings">⚙️</button>
              </div>
              <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 1.5rem' }}>
                Generate App
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}

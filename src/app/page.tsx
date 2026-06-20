import { auth0 } from '../lib/auth0';
import { redirect } from 'next/navigation';
import { PromptForm } from '../components/ui/prompt-form';

export default async function Home() {
  const session = await auth0.getSession();
  
  if (session?.user) {
    redirect('/dashboard');
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: '#000000', color: '#ffffff' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: '1.5rem 2rem', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, fontSize: '1.1rem' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          AI Builder
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <a href="/auth/login" style={{ color: '#888', textDecoration: 'none', fontSize: '0.9rem', fontWeight: 500, transition: 'color 0.2s' }}>Sign In</a>
          <a href="/auth/login" style={{ background: '#ffffff', color: '#000000', padding: '0.4rem 1rem', borderRadius: '6px', fontSize: '0.9rem', fontWeight: 500, textDecoration: 'none' }}>Sign Up</a>
        </div>
      </header>
      
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', paddingBottom: '10vh' }}>
        <div className="prompt-container" style={{ width: '100%', maxWidth: '760px', textAlign: 'center' }}>
          <h1 className="prompt-title">What would you like to build?</h1>
          <p className="prompt-subtitle">
            Describe your application, and our AI will generate the initial structure for you.
          </p>
          <div style={{ textAlign: 'left' }}>
            <PromptForm />
          </div>
        </div>
      </main>
    </div>
  );
}

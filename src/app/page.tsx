export default function Home() {
  return (
    <main className="hero-section">
      <div className="container">
        <div className="hero-content">
          <div className="glass-card" style={{ animation: 'float 6s ease-in-out infinite', background: '#0a0a0a', border: '1px solid var(--card-border)', boxShadow: 'none' }}>
            <h1 className="hero-title">
              Build the Future with <br />
              <span>AI App Builder</span>
            </h1>
            <p className="hero-subtitle">
              Design, prototype, and deploy intelligent applications in minutes. 
              Powered by advanced models, secured by Auth0, and built for speed.
            </p>
            <div className="hero-buttons">
              <a href="/auth/login" className="btn btn-primary">
                Get Started Free
              </a>
              <a href="/auth/login" className="btn btn-secondary">
                Sign In
              </a>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

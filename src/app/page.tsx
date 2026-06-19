import Link from 'next/link';

export default function Home() {
  return (
    <main className="hero-section">
      <div className="blob blob-1"></div>
      <div className="blob blob-2"></div>
      
      <div className="container">
        <div className="hero-content">
          <div className="glass-card" style={{ animation: 'float 6s ease-in-out infinite' }}>
            <h1 className="hero-title">
              Build the Future with <br />
              <span className="gradient-text">AI App Builder</span>
            </h1>
            <p className="hero-subtitle">
              Design, prototype, and deploy intelligent applications in minutes. 
              Powered by advanced models, secured by Auth0, and built for speed.
            </p>
            <div className="hero-buttons">
              <Link href="/api/auth/login" className="btn btn-primary">
                Get Started Free
              </Link>
              <Link href="/api/auth/login" className="btn btn-secondary">
                Sign In
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface SidebarProps {
  user: {
    name?: string | null;
    picture?: string | null;
    email?: string | null;
  };
  projects?: { id: string, name: string }[];
}

export function Sidebar({ user, projects = [] }: SidebarProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(true);
  const router = useRouter();

  return (
    <aside className="sidebar-static">
      <div className="sidebar-header-dropdown">
        <span>Account Name</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      
      <div className="sidebar-section-title">
        Curator
      </div>

      <nav className="sidebar-nav-new">
        <button className="btn-green" onClick={() => router.push('/dashboard')}>
          <span>New App</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <path d="M12 8v8M8 12h8" />
          </svg>
        </button>
        
        <button 
          className="btn-green" 
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
        >
          <span>My Apps</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: isDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
            <circle cx="12" cy="12" r="10" />
            <path d="M8 10l4 4 4-4" />
          </svg>
        </button>

        {isDropdownOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.2rem' }}>
            {projects.length > 0 ? (
              projects.map(project => (
                <Link key={project.id} href={`/projects/${project.id}`} className="btn-green nested">
                  {project.name || 'Untitled App'}
                </Link>
              ))
            ) : (
              <span className="btn-green nested" style={{ opacity: 0.6, cursor: 'default' }}>
                No apps yet
              </span>
            )}
          </div>
        )}
      </nav>

      <div className="sidebar-footer-new">
        <Link href="/auth/logout" style={{ textDecoration: 'none' }}>
          <div className="btn-green" style={{ justifyContent: 'flex-start', gap: '0.5rem' }}>
            <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: '#ccc', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {user.picture ? (
                <img src={user.picture} alt="User" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
              )}
            </div>
            <span>{user.email || user.name || 'Sign Out'}</span>
          </div>
        </Link>
      </div>
    </aside>
  );
}

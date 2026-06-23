"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

export function PromptForm() {
  const [prompt, setPrompt] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSelectedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() && selectedFiles.length === 0) return;

    // Generate a unique project ID
    const projectId = crypto.randomUUID();
    
    if (selectedFiles.length > 0) {
      const attachments = await Promise.all(selectedFiles.map(async (file) => {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve({
            type: 'file',
            url: ev.target?.result,
            mediaType: file.type,
            contentType: file.type,
            name: file.name,
            filename: file.name
          });
          reader.readAsDataURL(file);
        });
      }));
      sessionStorage.setItem(`initial_files_${projectId}`, JSON.stringify(attachments));
    }
    
    let queryStr = `prompt=${encodeURIComponent(prompt)}`;
    if (selectedFiles.length > 0) {
      queryStr += `&hasFiles=true`;
    }
    // Redirect to the new project workspace with the initial prompt
    router.push(`/projects/${projectId}?${queryStr}`);
  };

  return (
    <div style={{ width: '100%', maxWidth: '600px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <form className="prompt-box-aesthetic" onSubmit={handleSubmit}>
        <div className="prompt-box-main">
          <input 
            type="file" 
            multiple 
            ref={fileInputRef} 
            style={{ display: 'none' }} 
            onChange={handleFileChange}
            accept="image/*,.pdf,.doc,.docx,.txt"
          />
          {selectedFiles.length > 0 && (
            <div className="selected-files" style={{ padding: '0 0 1rem 0' }}>
              {selectedFiles.map((f, idx) => (
                <div key={idx} className="file-chip">
                  {f.type.startsWith('image/') && (
                    <img 
                      src={URL.createObjectURL(f)} 
                      alt={f.name} 
                      className="file-chip-thumb" 
                    />
                  )}
                  <span className="file-name" title={f.name}>{f.name}</span>
                  <button type="button" className="remove-file-btn" onClick={() => removeFile(idx)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea 
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Build me a blog page."
            className="prompt-box-textarea"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (prompt.trim() || selectedFiles.length > 0) handleSubmit(e as any);
              }
            }}
          />
          <div className="prompt-box-footer">
            <button type="button" className="btn-icon-plus" title="Add File" onClick={() => fileInputRef.current?.click()}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
            </button>
            <button type="submit" className="btn-submit-aesthetic" title="Send" disabled={!prompt.trim() && selectedFiles.length === 0}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
            </button>
          </div>
        </div>

        <div className="connectors-row">
          <span className="connectors-label">Connector</span>
          {/* GitHub Icon */}
          <div className="connector-icon" style={{ background: '#00B8D9', color: 'white', border: '1px solid #1c1c1c' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12"/></svg>
          </div>
          {/* Atlassian Icon (Triangle approximation) */}
          <div className="connector-icon" style={{ background: '#0052CC', color: 'white' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 20h20L12 2z"/></svg>
          </div>
          {/* N Icon */}
          <div className="connector-icon" style={{ background: '#00C781', color: 'black' }}>
            <span style={{ fontWeight: 800, fontSize: '0.9rem' }}>N</span>
          </div>
          {/* Notion Icon approximation */}
          <div className="connector-icon" style={{ background: 'white', color: 'black', borderRadius: '4px' }}>
            <span style={{ fontWeight: 800, fontSize: '0.9rem' }}>N</span>
          </div>
        </div>
      </form>
    </div>
  );
}

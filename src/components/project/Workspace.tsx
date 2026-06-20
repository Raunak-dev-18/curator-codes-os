"use client";

import { useChat } from '@ai-sdk/react';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';

interface Project {
  id: string;
  name: string;
  messages: any[];
}

interface WorkspaceProps {
  project: Project;
  initialPrompt?: string;
}

export function Workspace({ project, initialPrompt }: WorkspaceProps) {
  const [canvasCode, setCanvasCode] = useState<string>('');
  const [input, setInput] = useState<string>('');
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const initialTriggered = useRef(false);
  
  const { messages, sendMessage, status } = useChat({
    api: '/api/chat',
    body: { projectId: project.id },
    initialMessages: project.messages,
  });

  const isLoading = status === 'submitted' || status === 'streaming';

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input }, { body: { projectId: project.id } });
    setInput('');
  };

  // Extract the latest canvas code from tool invocations
  useEffect(() => {
    const latestMessage = messages[messages.length - 1];
    if (latestMessage?.toolInvocations) {
      for (const invocation of latestMessage.toolInvocations) {
        if (invocation.toolName === 'updateCanvas' && 'args' in invocation) {
          setCanvasCode(invocation.args.code);
        }
      }
    }
  }, [messages]);

  // Trigger initial prompt
  useEffect(() => {
    if (initialPrompt && project.messages.length === 0 && !initialTriggered.current) {
      initialTriggered.current = true;
      sendMessage({ text: initialPrompt }, { body: { projectId: project.id } });
      window.history.replaceState({}, '', `/projects/${project.id}`);
    }
  }, [initialPrompt, project.messages.length, project.id, sendMessage]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const defaultCanvas = `
    <html>
      <body style="background: #107c41; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: system-ui, sans-serif;">
        <h2 style="opacity: 0.5;">Preview Canvas</h2>
      </body>
    </html>
  `;

  return (
    <div className="workspace-layout">
      {/* Top Navigation Bar */}
      <header className="workspace-header">
        <div className="header-left">
          <Link href="/dashboard" className="back-link">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          </Link>
          <div className="project-dropdown">
            <span className="project-name">{project.name}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
          </div>
        </div>

        <div className="header-center">
          <div className="view-toggles">
            <button className="view-btn active">
              <span>Preview</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
            </button>
            <button className="view-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>
            </button>
            <button className="view-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            </button>
            <button className="view-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
            </button>
          </div>
        </div>

        <div className="header-right">
          <button className="btn-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/></svg>
          </button>
          <button className="btn-publish">
            <span>Publish</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
          </button>
        </div>
      </header>

      <div className="workspace-main">
        {/* Left Chat Pane */}
        <div className="workspace-sidebar">
          <div className="chat-messages" ref={chatContainerRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">
                What would you like to add or change?
              </div>
            ) : (
              messages.map(m => {
                // @ts-ignore
                let textContent = m.content || m.text || (m.parts ? m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('') : '') || '';
                
                // Clean up any weird role prefixes that some compatible models accidentally generate
                if (m.role === 'assistant') {
                  textContent = textContent.replace(/^(assistant:\s*)+/gi, '').trim();
                }

                return (
                  <div key={m.id} className={`chat-message ${m.role}`}>
                    {m.role === 'user' ? (
                      <div className="message-bubble user">{textContent}</div>
                    ) : (
                      <div className="message-content ai">
                        {textContent}
                        {m.toolInvocations && m.toolInvocations.map((tool, idx) => (
                          <div key={idx} className="tool-call-badge">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                            <span>Updating Canvas...</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {isLoading && (
              <div className="chat-message ai">
                <div className="typing-indicator">
                  <span></span><span></span><span></span>
                </div>
              </div>
            )}
          </div>

          <div className="chat-input-container">
            <form onSubmit={handleSubmit} className="prompt-card small">
              <textarea 
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Message AI Builder..."
                className="prompt-textarea"
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim()) handleSubmit(e);
                  }
                }}
              />
              <div className="prompt-footer">
                <div className="prompt-tools">
                  <button type="button" className="icon-btn" title="Attach file">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                  </button>
                </div>
                <button type="submit" className="btn-submit" title="Send" disabled={!input.trim() || isLoading}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Right Canvas Area */}
        <div className="workspace-canvas">
          <div className="canvas-wrapper">
            <iframe 
              srcDoc={canvasCode || defaultCanvas}
              sandbox="allow-scripts allow-same-origin allow-forms"
              className="canvas-frame"
              title="Preview Canvas"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

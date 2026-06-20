"use client";

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  const isDragging = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(33.33);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: { projectId: project.id },
    }),
    messages: project.messages,
  });

  const isLoading = status === 'submitted' || status === 'streaming';

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!input.trim() && selectedFiles.length === 0) || isLoading) return;

    let finalInput = input;
    const imageFiles: File[] = [];

    for (const file of selectedFiles) {
      if (file.type.startsWith('image/')) {
        imageFiles.push(file);
      } else {
        try {
          const text = await file.text();
          finalInput += `\n\n[File Content: ${file.name}]\n\`\`\`\n${text}\n\`\`\``;
        } catch (err) {
          console.error("Failed to read file", file.name);
        }
      }
    }

    const payload: any = { text: finalInput };
    
    if (imageFiles.length > 0) {
      const attachments = await Promise.all(imageFiles.map(async (file) => {
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve({
            type: 'file',
            url: e.target?.result,
            mediaType: file.type,
            contentType: file.type,
            name: file.name,
            filename: file.name
          });
          reader.readAsDataURL(file);
        });
      }));
      payload.files = attachments;
    }

    sendMessage(payload, { body: { projectId: project.id } });
    setInput('');
    setSelectedFiles([]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSelectedFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // Extract the latest canvas code from tool invocations
  useEffect(() => {
    const latestMessage = messages[messages.length - 1];
    if (latestMessage?.parts) {
      for (const part of latestMessage.parts) {
        if (part.type === 'tool-updateCanvas' || (part.type === 'dynamic-tool' && (part as any).toolName === 'updateCanvas')) {
          const args = (part as any).input || (part as any).args;
          if (args && args.code) {
            setCanvasCode(args.code);
            return;
          }
        }
      }
    }
  }, [messages]);

  // Sidebar resizer logic
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      
      const newWidthPercent = (e.clientX / window.innerWidth) * 100;
      
      // Clamp between 33.33% (1/3) and 50% (1.5/3)
      if (newWidthPercent >= 33.33 && newWidthPercent <= 50) {
        setSidebarWidth(newWidthPercent);
      } else if (newWidthPercent < 33.33) {
        setSidebarWidth(33.33);
      } else if (newWidthPercent > 50) {
        setSidebarWidth(50);
      }
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto'; // Re-enable text selection
        
        // Re-enable iframe pointer events
        const iframe = document.querySelector('.canvas-frame') as HTMLIFrameElement;
        if (iframe) iframe.style.pointerEvents = 'auto';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none'; // Prevent text selection while dragging
    
    // Disable iframe pointer events to prevent it from stealing mouse movements during drag
    const iframe = document.querySelector('.canvas-frame') as HTMLIFrameElement;
    if (iframe) iframe.style.pointerEvents = 'none';
  };

  // Trigger initial prompt
  useEffect(() => {
    if ((initialPrompt || typeof window !== 'undefined' && sessionStorage.getItem(`initial_files_${project.id}`)) && project.messages.length === 0 && !initialTriggered.current) {
      initialTriggered.current = true;
      
      const payload: any = { text: initialPrompt || '' };
      
      try {
        const storedFiles = sessionStorage.getItem(`initial_files_${project.id}`);
        if (storedFiles) {
          payload.files = JSON.parse(storedFiles);
          sessionStorage.removeItem(`initial_files_${project.id}`);
        }
      } catch (e) {
        console.error("Failed to parse initial files", e);
      }
      
      sendMessage(payload, { body: { projectId: project.id } });
      window.history.replaceState({}, '', `/projects/${project.id}`);
    }
  }, [initialPrompt, project.messages.length, project.id, sendMessage]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  const handleScroll = () => {
    if (!chatContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    // Show button if we are more than 100px from the bottom
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    setShowScrollButton(!isAtBottom);
  };

  const scrollToBottom = () => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  };

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
        <div className="workspace-sidebar" style={{ width: `${sidebarWidth}%` }}>
          <div className="chat-messages" ref={chatContainerRef} onScroll={handleScroll}>
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
                  textContent = textContent.replace(/^(assistant:?\s*)+/gi, '').trim();
                }

                // @ts-ignore
                const attachments = m.files?.length ? m.files : (m.experimental_attachments?.length ? m.experimental_attachments : (m.parts?.filter((p: any) => p.type === 'file' || p.type === 'image' || p.type === 'image-url') || []));

                return (
                  <div key={m.id} className={`chat-message ${m.role}`}>
                    {m.role === 'user' ? (
                      <div className="message-bubble user">
                        {attachments.length > 0 && (
                          <div className="message-attachments">
                            {attachments.map((att: any, idx: number) => {
                              const url = att.url || att.image || att.data;
                              const isImage = att.contentType?.startsWith('image/') || att.mimeType?.startsWith('image/') || att.type === 'image' || att.type === 'image-url';
                              return (isImage && url) ? (
                                <img 
                                  key={idx} 
                                  src={url} 
                                  alt={att.name || att.filename || 'Attachment'} 
                                  className="message-thumbnail" 
                                  onClick={() => setPreviewImage(url)}
                                  style={{ cursor: 'pointer' }}
                                />
                              ) : null;
                            })}
                          </div>
                        )}
                        {textContent}
                      </div>
                    ) : (
                      <div className="message-content ai markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {textContent}
                        </ReactMarkdown>
                        {m.parts?.filter(p => p.type.startsWith('tool-') || p.type === 'dynamic-tool').map((tool, idx) => (
                          <div key={idx} className="tool-call-badge">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
                            <span>Updating Canvas...</span>
                          </div>
                        ))}
                        <div className="message-actions">
                          <button 
                            className="copy-btn" 
                            onClick={() => handleCopy(textContent, m.id)}
                            title="Copy response"
                          >
                            {copiedId === m.id ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                            )}
                          </button>
                        </div>
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

          <div className="chat-input-wrapper">
            {showScrollButton && (
              <button 
                className="scroll-to-bottom-btn" 
                onClick={scrollToBottom}
                title="Scroll to bottom"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>
              </button>
            )}
            <div className="chat-input-container">
              <form onSubmit={handleSubmit} className="prompt-card small">
                {selectedFiles.length > 0 && (
                  <div className="selected-files">
                    {selectedFiles.map((f, idx) => (
                      <div key={idx} className="file-chip">
                        {f.type.startsWith('image/') && (
                          <img 
                            src={URL.createObjectURL(f)} 
                            alt={f.name} 
                            className="file-chip-thumb" 
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => setPreviewImage((e.target as HTMLImageElement).src)}
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
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Build me a blog page."
                className="prompt-textarea"
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (input.trim() || selectedFiles.length > 0) handleSubmit(e);
                  }
                }}
              />
              <div className="prompt-footer">
                <div className="prompt-tools">
                  <input 
                    type="file" 
                    multiple 
                    ref={fileInputRef} 
                    style={{ display: 'none' }} 
                    onChange={handleFileChange} 
                  />
                  <button type="button" className="icon-btn" title="Attach file" onClick={() => fileInputRef.current?.click()}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                  </button>
                </div>
                <button type="submit" className="btn-submit" title="Send" disabled={(!input.trim() && selectedFiles.length === 0) || isLoading}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
                </button>
              </div>
            </form>
            </div>
          </div>
        </div>

        {/* Resizer Handle */}
        <div 
          className="workspace-resizer" 
          onMouseDown={handleMouseDown} 
          title="Drag to resize"
        />

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

      {/* Image Preview Modal */}
      {previewImage && (
        <div className="image-preview-modal" onClick={() => setPreviewImage(null)}>
          <button className="image-preview-close" onClick={() => setPreviewImage(null)}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
          <img src={previewImage} alt="Preview" className="image-preview-content" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

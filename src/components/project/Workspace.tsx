"use client";

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Editor from '@monaco-editor/react';
import { FileExplorer } from './FileExplorer';
import { ContextMenu } from './ContextMenu';
import { Search, X, Settings } from 'lucide-react';

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

  // Code Mode States
  const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [openedFiles, setOpenedFiles] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState<string>('');
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [showMinimap, setShowMinimap] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [editorContextMenu, setEditorContextMenu] = useState<{ x: number, y: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleFileSelect = (path: string) => {
    if (!openedFiles.includes(path)) {
      setOpenedFiles(prev => [...prev, path]);
    }
    setActiveFile(path);
  };

  const handleCloseFile = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    const newFiles = openedFiles.filter(f => f !== path);
    setOpenedFiles(newFiles);
    if (activeFile === path) {
      setActiveFile(newFiles.length > 0 ? newFiles[newFiles.length - 1] : null);
    }
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value === undefined) return;
    setFileContent(value);
    
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    
    if (activeFile) {
      setIsSaving(true);
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await fetch('/api/sandbox/file/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: project.id, path: activeFile, content: value })
          });
        } catch (err) {
          console.error("Auto-save failed", err);
        } finally {
          setIsSaving(false);
        }
      }, 1000); // 1s debounce
    }
  };
  
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

  // Fetch file content when activeFile changes
  useEffect(() => {
    if (!activeFile) return;
    
    const fetchFileContent = async () => {
      setIsFileLoading(true);
      try {
        const res = await fetch(`/api/sandbox/file?projectId=${project.id}&path=${encodeURIComponent(activeFile)}`);
        if (!res.ok) throw new Error('Failed to fetch file');
        const text = await res.text();
        setFileContent(text);
      } catch (err) {
        console.error(err);
        setFileContent('Error loading file content.');
      } finally {
        setIsFileLoading(false);
      }
    };
    
    fetchFileContent();
  }, [activeFile, project.id]);

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
            <button 
              className={`view-btn ${viewMode === 'preview' ? 'active' : ''}`}
              onClick={() => setViewMode('preview')}
            >
              <span>Preview</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
            </button>
            <button 
              className={`view-btn ${viewMode === 'code' ? 'active' : ''}`}
              onClick={() => setViewMode('code')}
            >
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
                        {(m.toolInvocations || m.parts?.filter(p => p.type.startsWith('tool-') || p.type === 'dynamic-tool'))?.map((tool: any, idx: number) => {
                          const toolName = tool.toolName || (tool.type?.startsWith('tool-') ? tool.type.split('tool-')[1] : 'Unknown');
                          const isResult = tool.state === 'result' || tool.result !== undefined;
                          
                          let label = 'Working...';
                          let icon = isResult ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2">
                              <path d="M20 6L9 17l-5-5"/>
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
                               <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                            </svg>
                          );

                          // Parse args to show specific info
                          let args = {} as any;
                          try {
                            if (tool.args && typeof tool.args === 'object') args = tool.args;
                            else if (typeof tool.args === 'string') args = JSON.parse(tool.args);
                            else if (typeof tool.argsText === 'string') args = JSON.parse(tool.argsText);
                          } catch (e) {}

                          const commandStr = args.command ? (args.command.length > 30 ? args.command.substring(0, 30) + '...' : args.command) : 'command';

                          if (toolName === 'updateCanvas') {
                            label = 'Updating Preview Canvas...';
                          } else if (toolName === 'execute_command') {
                            label = `Running: ${commandStr}`;
                          } else if (toolName === 'write_file') {
                            label = `Writing file: ${args.path || 'file'}...`;
                            if (!isResult) {
                              icon = (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-pulse">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                </svg>
                              );
                            }
                          } else if (toolName === 'read_file') {
                            label = `Reading: ${args.path || 'file'}...`;
                          } else if (toolName === 'get_preview_url') {
                            label = 'Fetching Preview URL...';
                          } else if (toolName === 'list_files') {
                            label = 'Listing Sandbox Files...';
                          } else if (toolName === 'create_sandbox') {
                            label = 'Initializing Sandbox...';
                          }

                          return (
                            <div key={idx} className={`tool-call-badge flex items-center gap-2 px-3 py-2 rounded-md border text-xs w-fit mt-2 shadow-sm ${isResult ? 'bg-[#1e1e1e] border-[#333] text-neutral-400' : 'bg-[#1a2e1e] border-[#2e5e3e] text-[#4ade80]'}`} title={toolName}>
                              {icon}
                              <span className="font-mono">{label}</span>
                            </div>
                          );
                        })}
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

        {/* Right Canvas / Code Area */}
        <div className="workspace-canvas" style={{ alignItems: 'stretch' }}>
          {viewMode === 'preview' ? (
            <div className="canvas-wrapper" style={{ flex: 1, width: '100%', height: '100%' }}>
              <iframe 
                srcDoc={canvasCode || defaultCanvas}
                sandbox="allow-scripts allow-same-origin allow-forms"
                className="canvas-frame"
                title="Preview Canvas"
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
            </div>
          ) : (
            <div className="code-mode-container">
              <div className="file-explorer-panel">
                <div className="explorer-title flex items-center justify-between" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Explorer</span>
                </div>
                <div style={{ padding: '0 1rem 0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', background: '#000', borderRadius: '4px', border: '1px solid #333', padding: '2px 6px' }}>
                    <Search width="12" height="12" color="#737373" />
                    <input 
                      placeholder="Search files..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ background: 'transparent', border: 'none', color: '#ccc', fontSize: '11px', width: '100%', outline: 'none', padding: '4px' }}
                    />
                  </div>
                </div>
                <FileExplorer 
                  projectId={project.id} 
                  onFileSelect={handleFileSelect} 
                  searchQuery={searchQuery}
                />
              </div>
              <div className="editor-panel">
                {openedFiles.length > 0 ? (
                  <>
                    <div 
                      className="editor-tabs-container" 
                      style={{ display: 'flex', overflowX: 'auto', background: '#181818', borderBottom: '1px solid #333' }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setEditorContextMenu({ x: e.clientX, y: e.clientY });
                      }}
                    >
                      {openedFiles.map(file => (
                        <div 
                          key={file}
                          className={`editor-tab ${activeFile === file ? 'active' : ''}`}
                          onClick={() => setActiveFile(file)}
                          style={{ 
                            display: 'flex', alignItems: 'center', gap: '8px', padding: '0.5rem 1rem', fontSize: '13px', 
                            cursor: 'pointer', borderRight: '1px solid #333',
                            background: activeFile === file ? '#1e1e1e' : '#181818',
                            color: activeFile === file ? '#ffffff' : '#8a8a8a',
                            borderTop: activeFile === file ? '1px solid #007acc' : '1px solid transparent'
                          }}
                        >
                          {file.split('/').pop()}
                          <div 
                            className="tab-close" 
                            onClick={(e) => handleCloseFile(e, file)}
                            style={{ opacity: activeFile === file ? 1 : 0.5, cursor: 'pointer', padding: '2px', borderRadius: '4px' }}
                          >
                            <X width="14" height="14" />
                          </div>
                        </div>
                      ))}
                    </div>
                    {isFileLoading && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#1e1e1e]/80">
                        <div className="text-neutral-400 animate-pulse">Loading...</div>
                      </div>
                    )}
                    <Editor
                      height="100%"
                      defaultLanguage="typescript"
                      language={activeFile?.endsWith('.ts') || activeFile?.endsWith('.tsx') ? 'typescript' : 
                               activeFile?.endsWith('.js') || activeFile?.endsWith('.jsx') ? 'javascript' :
                               activeFile?.endsWith('.css') ? 'css' :
                               activeFile?.endsWith('.json') ? 'json' :
                               activeFile?.endsWith('.html') ? 'html' : 'plaintext'}
                      theme="vs-dark"
                      value={fileContent}
                      onChange={handleEditorChange}
                      options={{
                        readOnly: false,
                        minimap: { enabled: showMinimap },
                        fontSize: 14,
                        wordWrap: 'on',
                        padding: { top: 16 }
                      }}
                    />
                    {isSaving && (
                      <div style={{ position: 'absolute', bottom: '8px', right: '16px', fontSize: '11px', color: '#8a8a8a' }}>
                        Saving...
                      </div>
                    )}
                    {editorContextMenu && (
                      <ContextMenu
                        x={editorContextMenu.x}
                        y={editorContextMenu.y}
                        onClose={() => setEditorContextMenu(null)}
                        items={[
                          {
                            label: showMinimap ? 'Hide Minimap' : 'Show Minimap',
                            icon: <Settings width="14" height="14" />,
                            onClick: () => setShowMinimap(!showMinimap)
                          }
                        ]}
                      />
                    )}
                  </>
                ) : (
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#737373' }}>
                    <div style={{ textAlign: 'center' }}>
                      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ margin: '0 auto 1rem', opacity: 0.5 }}><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                      <p>Select a file to view code</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
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

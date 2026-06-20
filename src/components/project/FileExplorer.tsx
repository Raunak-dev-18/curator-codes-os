"use client";

import { useState, useEffect } from 'react';
import { FileIcon, Folder, FolderOpen, ChevronRight, ChevronDown, Trash2, Edit2, FileText, Code, Image as ImageIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { ContextMenu } from './ContextMenu';

interface FileInfo {
  name: string;
  isDir: boolean;
  size: number;
}

interface FileExplorerProps {
  projectId: string;
  onFileSelect: (path: string) => void;
  currentPath?: string;
  basePath?: string;
  searchQuery?: string;
  onRefresh?: () => void;
}

export function FileExplorer({ projectId, onFileSelect, currentPath = '.', basePath = '', searchQuery = '', onRefresh }: FileExplorerProps) {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, file: FileInfo, fullPath: string } | null>(null);
  const [renamingFile, setRenamingFile] = useState<{ name: string, fullPath: string } | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    fetchFiles();
  }, [projectId, currentPath, onRefresh]);

  const fetchFiles = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sandbox/files?projectId=${projectId}&path=${currentPath}`);
      if (!res.ok) throw new Error('Failed to fetch files');
      const data = await res.json();
      
      const sortedFiles = data.files.sort((a: FileInfo, b: FileInfo) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
      setFiles(sortedFiles);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleFolder = (folderName: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderName)) next.delete(folderName);
      else next.add(folderName);
      return next;
    });
  };

  const handleContextMenu = (e: React.MouseEvent, file: FileInfo, fullPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, file, fullPath });
  };

  const handleDelete = async (fullPath: string) => {
    if (!confirm(`Are you sure you want to delete ${fullPath}?`)) return;
    try {
      const res = await fetch(`/api/sandbox/file/ops?projectId=${projectId}&path=${encodeURIComponent(fullPath)}`, {
        method: 'DELETE'
      });
      if (res.ok) fetchFiles();
    } catch (err) {
      console.error("Failed to delete", err);
    }
  };

  const handleRenameSubmit = async (e: React.KeyboardEvent | React.FocusEvent, oldPath: string, isDir: boolean) => {
    if ('key' in e && e.key !== 'Enter' && e.key !== 'Escape') return;
    
    if ('key' in e && e.key === 'Escape') {
      setRenamingFile(null);
      return;
    }

    if (!newName.trim() || newName === renamingFile?.name) {
      setRenamingFile(null);
      return;
    }

    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '.';
    const newPath = parentPath === '.' ? newName : `${parentPath}/${newName}`;

    try {
      const res = await fetch(`/api/sandbox/file/ops?projectId=${projectId}&path=${encodeURIComponent(oldPath)}&newPath=${encodeURIComponent(newPath)}`, {
        method: 'PUT'
      });
      if (res.ok) {
        fetchFiles();
      }
    } catch (err) {
      console.error("Failed to rename", err);
    } finally {
      setRenamingFile(null);
    }
  };

  const filteredFiles = files.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()) || f.isDir);

  if (loading && files.length === 0) {
    return <div style={{ padding: '1rem', fontSize: '0.75rem', color: '#737373' }}>Loading...</div>;
  }

  const getFileIcon = (name: string) => {
    if (name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.js') || name.endsWith('.jsx')) return <Code width="16" height="16" color="#f1e05a" />;
    if (name.endsWith('.css')) return <Code width="16" height="16" color="#563d7c" />;
    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.svg')) return <ImageIcon width="16" height="16" color="#a074c4" />;
    return <FileText width="16" height="16" opacity="0.7" />;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', fontSize: '0.875rem', fontFamily: 'monospace', userSelect: 'none' }}>
      {filteredFiles.map(file => {
        const fullPath = basePath ? `${basePath}/${file.name}` : file.name;
        const isExpanded = expandedFolders.has(file.name);
        const isRenaming = renamingFile?.fullPath === fullPath;

        // If searching, auto-expand folders if they contain matching children (simplified: just keep them visible)
        if (searchQuery && file.isDir && !isExpanded) {
           // Basic optimization: if filtering, we don't automatically deeply search unexpanded folders here to save API calls, 
           // but we keep the folder visible.
        }

        if (file.isDir) {
          return (
            <div key={fullPath} style={{ display: 'flex', flexDirection: 'column' }}>
              <div 
                className="folder-item"
                onClick={() => toggleFolder(file.name)}
                onContextMenu={(e) => handleContextMenu(e, file, fullPath)}
              >
                {isExpanded ? <ChevronDown width="14" height="14" opacity="0.5" /> : <ChevronRight width="14" height="14" opacity="0.5" />}
                {isExpanded ? <FolderOpen width="16" height="16" color="#60a5fa" /> : <Folder width="16" height="16" color="#60a5fa" />}
                
                {isRenaming ? (
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => handleRenameSubmit(e, fullPath, true)}
                    onBlur={(e) => handleRenameSubmit(e, fullPath, true)}
                    style={{ background: '#000', color: '#fff', border: '1px solid #007acc', outline: 'none', padding: '0 4px', width: '100%' }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                )}
              </div>
              <AnimatePresence>
                {isExpanded && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    style={{ overflow: 'hidden' }}
                  >
                    <div style={{ paddingLeft: '1rem', borderLeft: '1px solid rgba(255,255,255,0.1)', marginLeft: '0.625rem' }}>
                      <FileExplorer 
                        projectId={projectId} 
                        onFileSelect={onFileSelect} 
                        currentPath={currentPath === '.' ? file.name : `${currentPath}/${file.name}`}
                        basePath={fullPath}
                        searchQuery={searchQuery}
                        onRefresh={fetchFiles}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        }

        if (searchQuery && !file.name.toLowerCase().includes(searchQuery.toLowerCase())) {
          return null;
        }

        return (
          <div 
            key={fullPath}
            className="file-item"
            style={{ marginLeft: '1.25rem' }}
            onClick={() => onFileSelect(currentPath === '.' ? file.name : `${currentPath}/${file.name}`)}
            onContextMenu={(e) => handleContextMenu(e, file, fullPath)}
          >
            {getFileIcon(file.name)}
            {isRenaming ? (
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => handleRenameSubmit(e, fullPath, false)}
                onBlur={(e) => handleRenameSubmit(e, fullPath, false)}
                style={{ background: '#000', color: '#fff', border: '1px solid #007acc', outline: 'none', padding: '0 4px', width: '100%' }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
            )}
          </div>
        );
      })}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: 'Open',
              onClick: () => !contextMenu.file.isDir && onFileSelect(contextMenu.fullPath)
            },
            {
              label: 'Rename',
              icon: <Edit2 width="14" height="14" />,
              onClick: () => {
                setRenamingFile({ name: contextMenu.file.name, fullPath: contextMenu.fullPath });
                setNewName(contextMenu.file.name);
              }
            },
            {
              label: 'Delete',
              icon: <Trash2 width="14" height="14" />,
              danger: true,
              onClick: () => handleDelete(contextMenu.fullPath)
            }
          ]}
        />
      )}
    </div>
  );
}

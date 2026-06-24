import { streamText, tool, convertToModelMessages, stepCountIs } from 'ai';
import { getModel } from '../../../lib/ai';
import { auth0 } from '../../../lib/auth0';
import { saveMessages, deleteProjectFile, getProject, getProjectFiles, renameProjectFile, saveProjectFile } from '../../../lib/db/projects';
import { z } from 'zod';
import crypto from 'crypto';
import { revalidatePath } from 'next/cache';
import { getProjectSandbox } from '../../../lib/daytona';
import { normalizeDirectoryPath, normalizeProjectPath } from '../../../lib/project-paths';
import { syncSandboxFilesToProject } from '../../../lib/sandbox-sync';
import { isRenderableCanvasCode } from '../../../lib/canvas-preview';

// Allow long-running operations
export const maxDuration = 60;

const COMMAND_TIMEOUT_MS = 45_000;
const COMMAND_OUTPUT_LIMIT = 12_000;
const LEGACY_PREVIEW_FILE = 'preview.html';
const PROJECT_ROOT = '.';

function getRequiredRootNextCommand() {
  return 'npx -y create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --yes --force';
}

function getCreateNextAppTarget(command: string) {
  const match = command.match(/\bcreate-next-app(?:@[^\s]+)?\s+([^\s]+)/);
  return match?.[1];
}

function validateSandboxCommand(command: string) {
  const trimmed = command.trim();
  if (/^(pwd|ls|ls\s+-la|ls\s+-al|dir)$/i.test(trimmed)) {
    return 'Refused low-value diagnostic command. Use get_project_state or list_files instead of looping on pwd/ls.';
  }

  if (/[;&]{2}|\|\||;/.test(command)) {
    return 'Refused chained shell command. Run one focused command per tool call so progress and failures are visible.';
  }

  if (/\brm\s+-[^\n]*[rf]/.test(command)) {
    return 'Refused destructive cleanup command. Use delete_file for intentional file removal.';
  }

  if (/\bnpm\s+run\s+dev\b/.test(command) && !/^nohup\s+npm\s+run\s+dev\s+--\s+--hostname\s+0\.0\.0\.0\s*>\s*dev\.log\s+2>&1\s*&\s*$/.test(command)) {
    return "Refused foreground dev server command. Use start_preview instead, or run exactly: nohup npm run dev -- --hostname 0.0.0.0 > dev.log 2>&1 &";
  }

  const createNextTarget = getCreateNextAppTarget(command);
  if (!createNextTarget) return null;

  if (createNextTarget !== '.') {
    return `Refused to run create-next-app in nested folder "${createNextTarget}". Build in the existing project sandbox root using: ${getRequiredRootNextCommand()}`;
  }

  if (!/\s--yes(?:\s|$)/.test(command) || !/\s--force(?:\s|$)/.test(command)) {
    return `Refused interactive or unsafe create-next-app command. Use: ${getRequiredRootNextCommand()}`;
  }

  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(label)), timeoutMs);
    }),
  ]);
}

function truncateOutput(output: unknown) {
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  if (text.length <= COMMAND_OUTPUT_LIMIT) return text;
  return `${text.slice(0, COMMAND_OUTPUT_LIMIT)}\n\n[output truncated after ${COMMAND_OUTPUT_LIMIT} characters]`;
}

function getParentDirs(path: string) {
  const parts = normalizeProjectPath(path).split('/');
  parts.pop();

  const dirs: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    dirs.push(parts.slice(0, index).join('/'));
  }

  return dirs;
}

async function createParentFolders(sandbox: any, path: string) {
  for (const dir of getParentDirs(path)) {
    try {
      await sandbox.fs.createFolder(dir, '755');
    } catch {
      // Existing directories and SDK-specific duplicate errors are safe to ignore.
    }
  }
}

async function uploadFileToSandbox(sandbox: any, path: string, content: string) {
  const cleanPath = normalizeProjectPath(path);
  await createParentFolders(sandbox, cleanPath);
  await sandbox.fs.uploadFile(Buffer.from(content, 'utf8'), cleanPath);
}

async function syncDbFilesToSandbox(projectId: string, userId: string, sandbox: any) {
  const files = await getProjectFiles(projectId, userId);
  let uploaded = 0;
  const errors: string[] = [];

  for (const file of files) {
    if (file.path === LEGACY_PREVIEW_FILE) continue;

    try {
      await uploadFileToSandbox(sandbox, file.path, file.content);
      uploaded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown upload error';
      errors.push(`${file.path}: ${message}`);
    }
  }

  return { uploaded, errors };
}

async function getEmbeddablePreviewUrl(sandbox: any, port: number) {
  if (typeof sandbox.getSignedPreviewUrl === 'function') {
    const signed = await sandbox.getSignedPreviewUrl(port, 3600);
    return { url: signed.url, token: signed.token, signed: true };
  }

  const preview = await sandbox.getPreviewLink(port);
  return { url: preview.url, token: preview.token, signed: false };
}

const APP_BUILDER_SYSTEM_PROMPT = `You are an autonomous, highly capable AI software agent and app builder.
Your objective is to build premium, production-ready, full-stack web applications for users using Next.js App Router and Tailwind CSS, executing directly inside the remote Daytona sandbox environment.

### 🛠️ YOUR TOOLBOX & INSTRUMENTS

1. **State & File Explorer Control**:
   - \`get_project_state\`: Use first to inspect the workspace structure and file presence. Do not loop on raw commands (like 'ls' or 'pwd').
   - \`list_files\`: Find files under specific directories.
   - \`read_file\`: View contents of any project file.
   - \`write_file\` / \`write_files\`: Create/overwrite files. The DB-backed file explorer is user-visible, so authored code MUST be written with these.
   - \`delete_file\` / \`move_file\`: Delete or rename/move files/folders.

2. **Code Execution & PTY (Pseudo-Terminal)**:
   - \`execute_command\`: Run non-interactive commands (e.g., \`npm run build\`).
   - \`execute_pty_command\`: Run commands requiring a real terminal session (TTY), interactive user input prompts, or real-time outputs (e.g., CLI prompts, database migration setup, interactive configurations).
   - \`start_preview\`: Automatically sync database files to Daytona, spin up the background Next dev server, and retrieve a secure signed preview URL.
   - \`get_preview_url\`: Get a preview URL on a specific port.
   - \`get_entrypoint_logs\`: Retrieve container boot logs (\`stdout\` and \`stderr\`) to debug server startup issues or failures.

3. **Git Control**:
   - \`git_clone\`: Clone external repositories, boilerplate repos, or libraries.
   - \`git_status\`: Check workspace state and modifications.
   - \`git_commit\`: Create standard Git commits representing implementation steps.
   - \`git_push\` / \`git_pull\`: Sync with remote Git hosts.

---

### 🚀 AGENTIC WORKFLOW PROTOCOL

1. **Phase 1: Explore and Setup**
   - Execute \`get_project_state\` immediately to understand the project structure.
   - If \`package.json\` is missing, scaffold Next.js by executing exactly: \`${getRequiredRootNextCommand()}\` using \`execute_command\`.
   - Never build nested directories. Scaffolding must happen in the root folder \`.\`.
   - After running commands that create files, call \`sync_project_files\` with path \`.\` to update the user's files database.

2. **Phase 2: System Integration & Execution**
   - Use Git tools (\`git_clone\`, \`git_status\`, etc.) to pull templates or keep version control accurate.
   - If a command fails or a server won't start, call \`get_entrypoint_logs\` to inspect output streams and self-repair errors.
   - Use \`execute_pty_command\` if setup steps require pseudo-terminals or shell interactions.

3. **Phase 3: Code Writing**
   - Write fully functioning, clean Next.js App Router code using \`write_files\`.
   - Create Route Handlers under \`src/app/api/**/route.ts\` to make features dynamic.
   - Do not emit stub code, placeholders, or partial patches in your comments. Implement the actual feature logic completely.

4. **Phase 4: Verification & Preview**
   - Run \`npm run build\` using \`execute_command\` to verify zero compilation or TypeScript errors.
   - Once build succeeds, call \`start_preview\` on port 3000 to launch the application.

---

### 🎨 PREMIUM DESIGN STANDARD
- Use curated, high-end color systems (dark modes, glassmorphism, smooth gradients) to build premium UI.
- Use Lucide Icons (\`lucide-react\`) for visual indicators.
- Build complete functional paths (e.g. settings page, dashboard, interactive features) instead of generic static landing pages.

---

### 💬 CHAT DESIGN PRINCIPLE
- Keep text short and focused on operations.
- Avoid printing source code blocks in chat. All file modifications must happen silently using file tools.
- Never use \`updateCanvas\` for coding; preview must always run through the Next.js dev server.`;

export async function POST(req: Request) {
  const session = await auth0.getSession();
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userId = session.user.sub;
  const payload = await req.json();
  const { messages, projectId } = payload;

  if (!projectId) {
    console.error("Missing Project ID");
    return new Response('Project ID is required', { status: 400 });
  }

  if (!(await getProject(projectId, userId))) {
    return new Response('Project not found', { status: 404 });
  }

  // Save the incoming user message to the DB (don't fail the request if it fails)
  try {
    await saveMessages(projectId, userId, messages);
    revalidatePath(`/projects/${projectId}`);
  } catch (err) {
    console.error("Failed to save incoming messages to DB", err);
  }

  // Patch missing mimeType and type for image parts to prevent AI SDK crash
  for (const msg of messages) {
    // Map files or experimental_attachments to parts if missing
    if (!msg.parts && (msg.files || (msg as any).experimental_attachments)) {
      msg.parts = msg.files || (msg as any).experimental_attachments;
    }

    if (msg.parts) {
      for (const part of msg.parts) {
        if (!part.type && part.url) {
          part.type = 'file';
        }
        // The AI SDK's convertToModelMessages function SILENTLY drops parts with type: 'image'.
        // UI parts must strictly be type: 'file' with a corresponding mediaType.
        if (part.type === 'image') {
          part.type = 'file';
        }
        if (!part.mediaType) {
          part.mediaType = part.contentType || part.mimeType || 'image/jpeg';
        }
      }
    }
  }

  const model = getModel();
  const rawModelMessages = await convertToModelMessages(messages);
  
  // Fix for proxy bugs (e.g. Gemini via OpenAI compat) that stringify text part arrays
  const modelMessages = rawModelMessages.map(m => {
    if (Array.isArray(m.content) && m.content.every((p: any) => p.type === 'text')) {
      return { ...m, content: m.content.map((p: any) => p.text).join('\n') };
    }
    return m;
  }) as any;

  const result = streamText({
    model,
    stopWhen: stepCountIs(14),
    timeout: {
      totalMs: 55_000,
      stepMs: 45_000,
    },
    system: APP_BUILDER_SYSTEM_PROMPT,
    messages: modelMessages,
    tools: {
      get_project_state: tool({
        description: 'Inspect the database-backed file tree and sandbox root before deciding what to build. Use this instead of pwd/ls diagnostics.',
        inputSchema: z.object({}),
        execute: async () => {
          const dbFiles = (await getProjectFiles(projectId, userId))
            .filter((file) => file.path !== LEGACY_PREVIEW_FILE)
            .map((file) => ({ path: file.path, size: file.content.length }));

          const filePaths = new Set(dbFiles.map((file) => file.path));
          const requiredFiles = ['package.json', 'src/app/page.tsx', 'src/app/layout.tsx', 'src/app/globals.css'];
          const requiredState = Object.fromEntries(requiredFiles.map((path) => [path, filePaths.has(path)]));

          let sandboxRoot: string[] = [];
          let sandboxAvailable = false;
          let sandboxError: string | undefined;

          try {
            const sandbox = await getProjectSandbox(projectId);
            const rootFiles = await sandbox.fs.listFiles(PROJECT_ROOT);
            sandboxRoot = rootFiles
              .filter((file: any) => file.name && !['.daytona', '.git', '.next', 'node_modules'].includes(file.name))
              .map((file: any) => `${file.isDir ? '[DIR]' : '[FILE]'} ${file.name}`);
            sandboxAvailable = true;
          } catch (error) {
            sandboxError = error instanceof Error ? error.message : 'Unknown sandbox error';
          }

          return JSON.stringify({
            requiredState,
            dbFileCount: dbFiles.length,
            dbFiles: dbFiles.slice(0, 80),
            sandboxAvailable,
            sandboxRoot,
            sandboxError,
            scaffoldCommand: getRequiredRootNextCommand(),
          }, null, 2);
        }
      }),
      start_preview: tool({
        description: 'Sync DB files into Daytona, start the Next.js dev server in the background, and return an iframe-safe signed preview URL.',
        inputSchema: z.object({
          port: z.number().default(3000).describe('The web server port. Use 3000 for Next.js dev server.'),
        }),
        execute: async ({ port }) => {
          try {
            const sandbox = await getProjectSandbox(projectId);
            const uploadResult = await syncDbFilesToSandbox(projectId, userId, sandbox);
            const command = 'nohup npm run dev -- --hostname 0.0.0.0 > dev.log 2>&1 &';
            let commandSummary = 'Started Next.js dev server.';

            try {
              const response = await sandbox.process.executeCommand(command, PROJECT_ROOT, undefined, 10);
              commandSummary = `Dev server command exit ${response.exitCode}: ${truncateOutput(response.result)}`;
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown start error';
              commandSummary = `Dev server start command returned an error: ${message}`;
            }

            const preview = await getEmbeddablePreviewUrl(sandbox, port);
            return `Preview URL: ${preview.url}\nSigned URL: ${preview.signed}\nToken: ${preview.token || ''}\nSynced DB files to Daytona: ${uploadResult.uploaded}${uploadResult.errors.length ? `\nUpload errors: ${uploadResult.errors.slice(0, 5).join('; ')}` : ''}\n${commandSummary}`;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown preview error';
            return `Failed to start preview: ${message}`;
          }
        }
      }),
      updateCanvas: tool({
        description: 'Legacy preview-status tool. Only use this for a preview URL iframe after get_preview_url. Do not use it to build apps or send HTML/source code.',
        inputSchema: z.object({
          code: z.string().describe('A preview URL iframe only. Do not pass complete HTML, React, JavaScript bundles, or source code.'),
          explanation: z.string().describe('A brief explanation of what was built or changed.')
        }),
        execute: async ({ code, explanation }) => {
          if (isRenderableCanvasCode(code)) {
            return `Rejected static HTML preview. Build a full Next.js app by writing src/app/page.tsx, src/app/layout.tsx, src/app/globals.css, and any supporting components with write_file, then run npm run dev and get_preview_url.`;
          }

          return `Preview updated: ${explanation}`;
        }
      }),
      execute_command: tool({
        description: 'Run a shell command in the remote sandbox (e.g. npm run dev, npx create-next-app, npm install).',
        inputSchema: z.object({
          command: z.string().describe('The bash command to execute.')
        }),
        execute: async ({ command }) => {
          const commandError = validateSandboxCommand(command);
          if (commandError) return commandError;

          try {
            const sandbox = await getProjectSandbox(projectId);
            const uploadResult = await syncDbFilesToSandbox(projectId, userId, sandbox);
            const response = await withTimeout(
              sandbox.process.executeCommand(command, PROJECT_ROOT, undefined, Math.ceil(COMMAND_TIMEOUT_MS / 1000)),
              COMMAND_TIMEOUT_MS,
              `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s. Stop retrying this command; write files directly or run a smaller verification command.`
            );
            let syncSummary = '';

            try {
              const syncResult = await syncSandboxFilesToProject({ sandbox, projectId, userId });
              syncSummary = `\n\nSynced project files: ${syncResult.synced} saved, ${syncResult.skipped} skipped${
                syncResult.errors.length ? `, ${syncResult.errors.length} errors` : ''
              }.`;
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown sync error';
              syncSummary = `\n\nProject file sync failed: ${message}`;
            }

            return `Exit Code: ${response.exitCode}\nOutput:\n${truncateOutput(response.result)}\nSynced DB files to Daytona before command: ${uploadResult.uploaded}${uploadResult.errors.length ? `, upload errors: ${uploadResult.errors.length}` : ''}${syncSummary}`;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown command error';
            return `Failed to run command: ${message}`;
          }
        }
      }),
      read_file: tool({
        description: 'Read the contents of a file from the sandbox filesystem.',
        inputSchema: z.object({
          path: z.string().describe('Absolute or relative path to the file.')
        }),
        execute: async ({ path }) => {
          try {
            const cleanPath = normalizeProjectPath(path);
            const dbFile = (await getProjectFiles(projectId, userId)).find((file) => file.path === cleanPath);
            if (dbFile) return dbFile.content;

            const sandbox = await getProjectSandbox(projectId);
            const buf = await sandbox.fs.downloadFile(cleanPath);
            return buf.toString('utf8');
          } catch (err: any) {
            return `Failed to read file: ${err.message}`;
          }
        }
      }),
      write_file: tool({
        description: 'Write content to a file in the sandbox filesystem. Will overwrite if it exists.',
        inputSchema: z.object({
          path: z.string().describe('Absolute or relative path to the file.'),
          content: z.string().describe('The file contents to write.')
        }),
        execute: async ({ path, content }) => {
          try {
            const cleanPath = normalizeProjectPath(path);

            // Database is the source of truth for the UI; save here first even if Daytona is unavailable.
            await saveProjectFile(projectId, userId, cleanPath, content);
            if (cleanPath !== LEGACY_PREVIEW_FILE) await deleteProjectFile(projectId, userId, LEGACY_PREVIEW_FILE);

            try {
              const sandbox = await getProjectSandbox(projectId);
              await uploadFileToSandbox(sandbox, cleanPath, content);
              return `Successfully wrote ${cleanPath} to DB and Daytona`;
            } catch (sandboxErr) {
              const message = sandboxErr instanceof Error ? sandboxErr.message : 'Unknown Daytona sync error';
              return `Successfully wrote ${cleanPath} to DB. Daytona sync failed: ${message}`;
            }
          } catch (err: any) {
            return `Failed to write file: ${err.message}`;
          }
        }
      }),
      write_files: tool({
        description: 'Write multiple source files. This saves every file to the database first so the UI file explorer updates immediately, then attempts Daytona sync.',
        inputSchema: z.object({
          files: z.array(z.object({
            path: z.string().describe('Relative project path, for example src/app/page.tsx.'),
            content: z.string().describe('Complete file contents.'),
          })).min(1).max(30),
        }),
        execute: async ({ files }) => {
          const savedPaths: string[] = [];
          const failedPaths: string[] = [];

          for (const file of files) {
            try {
              const cleanPath = normalizeProjectPath(file.path);
              await saveProjectFile(projectId, userId, cleanPath, file.content);
              savedPaths.push(cleanPath);
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown DB save error';
              failedPaths.push(`${file.path}: ${message}`);
            }
          }

          let daytonaSummary = 'Daytona sync skipped because no files were saved.';
          if (savedPaths.some((path) => path !== LEGACY_PREVIEW_FILE)) {
            await deleteProjectFile(projectId, userId, LEGACY_PREVIEW_FILE);
          }

          if (savedPaths.length > 0) {
            try {
              const sandbox = await getProjectSandbox(projectId);
              for (const file of files) {
                const cleanPath = normalizeProjectPath(file.path);
                if (!savedPaths.includes(cleanPath)) continue;
                await uploadFileToSandbox(sandbox, cleanPath, file.content);
              }
              daytonaSummary = `Synced ${savedPaths.length} files to Daytona.`;
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown Daytona sync error';
              daytonaSummary = `Daytona sync failed: ${message}`;
            }
          }

          return `Saved ${savedPaths.length} files to DB: ${savedPaths.join(', ')}.${failedPaths.length ? ` Failed: ${failedPaths.join('; ')}.` : ''} ${daytonaSummary}`;
        }
      }),
      list_files: tool({
        description: 'List the files and directories in a given path in the sandbox.',
        inputSchema: z.object({
          path: z.string().describe('Path to the directory to list.')
        }),
        execute: async ({ path }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            const cleanPath = normalizeDirectoryPath(path);
            const files = await sandbox.fs.listFiles(cleanPath);
            return files.map(f => `${f.isDir ? '[DIR]' : '[FILE]'} ${f.name} - ${f.size} bytes`).join('\n');
          } catch (err: any) {
            return `Failed to list files: ${err.message}`;
          }
        }
      }),
      sync_project_files: tool({
        description: 'Sync text source files from the Daytona sandbox into the database-backed file explorer.',
        inputSchema: z.object({
          path: z.string().default('.').describe('Directory to sync from. Use "." for the project root.'),
        }),
        execute: async ({ path }) => {
          try {
            const sandbox = await getProjectSandbox(projectId);
            const cleanPath = normalizeDirectoryPath(path);
            const syncResult = await syncSandboxFilesToProject({
              sandbox,
              projectId,
              userId,
              rootPath: cleanPath,
            });

            return `Synced ${syncResult.synced} files from ${cleanPath}. Skipped ${syncResult.skipped} generated or binary files.${
              syncResult.errors.length ? ` Errors: ${syncResult.errors.slice(0, 5).join('; ')}` : ''
            }`;
          } catch (err: any) {
            return `Failed to sync project files: ${err.message}`;
          }
        }
      }),
      delete_file: tool({
        description: 'Delete a file or directory in the sandbox.',
        inputSchema: z.object({
          path: z.string().describe('Path to the file or directory to delete.')
        }),
        execute: async ({ path }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            const cleanPath = normalizeProjectPath(path);
            await sandbox.fs.deleteFile(cleanPath, true);
            await deleteProjectFile(projectId, userId, cleanPath);
            return `Successfully deleted ${cleanPath}`;
          } catch (err: any) {
            return `Failed to delete file: ${err.message}`;
          }
        }
      }),
      move_file: tool({
        description: 'Move or rename a file in the sandbox.',
        inputSchema: z.object({
          source: z.string().describe('Source path of the file.'),
          destination: z.string().describe('Destination path for the file.')
        }),
        execute: async ({ source, destination }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            const cleanSource = normalizeProjectPath(source);
            const cleanDestination = normalizeProjectPath(destination);
            await sandbox.fs.moveFiles(cleanSource, cleanDestination);
            await renameProjectFile(projectId, userId, cleanSource, cleanDestination);
            return `Successfully moved ${cleanSource} to ${cleanDestination}`;
          } catch (err: any) {
            return `Failed to move file: ${err.message}`;
          }
        }
      }),
      git_clone: tool({
        description: 'Clone a git repository into the sandbox.',
        inputSchema: z.object({
          url: z.string().describe('The URL of the git repository.'),
          path: z.string().describe('The path to clone the repository into.')
        }),
        execute: async ({ url, path }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            await sandbox.git.clone(url, path);
            return `Successfully cloned ${url} into ${path}`;
          } catch (err: any) {
            return `Failed to clone repository: ${err.message}`;
          }
        }
      }),
      git_commit: tool({
        description: 'Commit changes to the git repository.',
        inputSchema: z.object({
          path: z.string().describe('The path of the git repository.'),
          message: z.string().describe('The commit message.'),
          author: z.string().describe('The name of the author.'),
          email: z.string().describe('The email of the author.')
        }),
        execute: async ({ path, message, author, email }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            const resp = await sandbox.git.commit(path, message, author, email);
            return `Successfully committed changes. Hash: ${resp.sha}`;
          } catch (err: any) {
            return `Failed to commit changes: ${err.message}`;
          }
        }
      }),
      git_status: tool({
        description: 'Get the status of the git repository.',
        inputSchema: z.object({
          path: z.string().describe('The path of the git repository.')
        }),
        execute: async ({ path }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            const status = await sandbox.git.status(path);
            return JSON.stringify(status, null, 2);
          } catch (err: any) {
            return `Failed to get git status: ${err.message}`;
          }
        }
      }),
      git_push: tool({
        description: 'Push changes to the remote git repository.',
        inputSchema: z.object({
          path: z.string().describe('The path of the git repository.')
        }),
        execute: async ({ path }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            await sandbox.git.push(path);
            return `Successfully pushed changes for ${path}`;
          } catch (err: any) {
            return `Failed to push changes: ${err.message}`;
          }
        }
      }),
      git_pull: tool({
        description: 'Pull changes from the remote git repository.',
        inputSchema: z.object({
          path: z.string().describe('The path of the git repository.')
        }),
        execute: async ({ path }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            await sandbox.git.pull(path);
            return `Successfully pulled changes for ${path}`;
          } catch (err: any) {
            return `Failed to pull changes: ${err.message}`;
          }
        }
      }),
      get_entrypoint_logs: tool({
        description: 'Get the entrypoint logs (stdout and stderr) of the sandbox container.',
        inputSchema: z.object({}),
        execute: async () => {
          const sandbox = await getProjectSandbox(projectId);
          try {
            const logs = await sandbox.process.getEntrypointLogs();
            return `STDOUT:\n${logs.stdout}\n\nSTDERR:\n${logs.stderr}`;
          } catch (err: any) {
            return `Failed to get entrypoint logs: ${err.message}`;
          }
        }
      }),
      execute_pty_command: tool({
        description: 'Run a bash command inside a Pseudo Terminal (PTY) session, capturing all terminal stdout and waiting for completion. Highly recommended for commands that require a TTY or interactive setup.',
        inputSchema: z.object({
          command: z.string().describe('The bash command to run.'),
          cols: z.number().optional().describe('Width of the terminal in columns (default 120).'),
          rows: z.number().optional().describe('Height of the terminal in rows (default 30).'),
        }),
        execute: async ({ command, cols = 120, rows = 30 }) => {
          const commandError = validateSandboxCommand(command);
          if (commandError) return commandError;

          try {
            const sandbox = await getProjectSandbox(projectId);
            const uploadResult = await syncDbFilesToSandbox(projectId, userId, sandbox);
            
            let outputBuffer = '';
            const ptyId = crypto.randomUUID();
            const ptyHandle = await sandbox.process.createPty({
              id: ptyId,
              cols,
              rows,
              onData: (data) => {
                const text = new TextDecoder().decode(data);
                outputBuffer += text;
              }
            });

            await ptyHandle.waitForConnection();
            
            // Send command and exit shell
            await ptyHandle.sendInput(`${command}\nexit\n`);
            
            // Wait for completion (with timeout)
            const result = await withTimeout(
              ptyHandle.wait(),
              COMMAND_TIMEOUT_MS,
              'PTY command execution timed out.'
            );
            
            await ptyHandle.disconnect();

            let syncSummary = '';
            try {
              const syncResult = await syncSandboxFilesToProject({ sandbox, projectId, userId });
              syncSummary = `\n\nSynced project files: ${syncResult.synced} saved, ${syncResult.skipped} skipped.`;
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown sync error';
              syncSummary = `\n\nProject file sync failed: ${message}`;
            }

            return `Exit Code: ${result.exitCode ?? 0}\nOutput:\n${truncateOutput(outputBuffer)}\nSynced DB files to Daytona before command: ${uploadResult.uploaded}${uploadResult.errors.length ? `, upload errors: ${uploadResult.errors.length}` : ''}${syncSummary}`;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown PTY error';
            return `Failed to run command in PTY: ${message}`;
          }
        }
      }),
      get_preview_url: tool({
        description: 'Get a public URL to preview the running web application on a specific port (e.g. 3000 for Next.js). The UI renders this URL automatically.',
        inputSchema: z.object({
          port: z.number().describe('The port the web server is running on (usually 3000).')
        }),
        execute: async ({ port }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
             const preview = await getEmbeddablePreviewUrl(sandbox, port);
             return `Preview URL: ${preview.url}\nSigned URL: ${preview.signed}\nToken: ${preview.token || ''}`;
          } catch (err: any) {
             return `Failed to get preview URL: ${err.message}`;
          }
        }
      }),
    },
    async onFinish(event: any) {
      try {
        // Construct the assistant's response to save to MongoDB
        const assistantMessage: any = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: event.text || '',
          parts: event.text ? [{ type: 'text', text: event.text }] : [],
        };
        
        let allToolCalls = event.toolCalls || [];
        let allToolResults = event.toolResults || [];
        
        // If multi-step is used, accumulate from steps
        if (event.steps && event.steps.length > 0) {
            allToolCalls = [];
            allToolResults = [];
            event.steps.forEach((step: any) => {
                if (step.toolCalls) allToolCalls.push(...step.toolCalls);
                if (step.toolResults) allToolResults.push(...step.toolResults);
            });
        }
        
        if (allToolCalls && allToolCalls.length > 0) {
          const toolResultsById = new Map<string, any>(
            allToolResults
              .filter((result: any) => result?.toolCallId)
              .map((result: any) => [result.toolCallId, result])
          );

          assistantMessage.toolInvocations = allToolCalls.map((tc: any) => {
            const tr = toolResultsById.get(tc.toolCallId);
            return {
              state: 'result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args || tc.input || {},
              result: tr ? (tr.result ?? tr.output) : undefined
            };
          });
        }
        
        // Save the updated history including the AI's response
        await saveMessages(projectId, userId, [...messages, assistantMessage]);
        revalidatePath(`/projects/${projectId}`);
      } catch (err) {
        console.error("Failed to save final messages to DB", err);
      }
    },
  });

  return result.toUIMessageStreamResponse();
}

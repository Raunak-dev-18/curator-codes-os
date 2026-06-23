import { streamText, tool, convertToModelMessages, stepCountIs } from 'ai';
import { getModel } from '../../../lib/ai';
import { auth0 } from '../../../lib/auth0';
import { saveMessages, deleteProjectFile, getProject, getProjectFiles, renameProjectFile, saveProjectFile } from '../../../lib/db/projects';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getProjectSandbox } from '../../../lib/daytona';
import { normalizeDirectoryPath, normalizeProjectPath } from '../../../lib/project-paths';
import { syncSandboxFilesToProject } from '../../../lib/sandbox-sync';
import { isRenderableCanvasCode } from '../../../lib/canvas-preview';

// Allow long-running operations
export const maxDuration = 60;

const COMMAND_TIMEOUT_MS = 45_000;
const COMMAND_OUTPUT_LIMIT = 12_000;

function getRequiredRootNextCommand() {
  return 'npx -y create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --yes --force';
}

function getCreateNextAppTarget(command: string) {
  const match = command.match(/\bcreate-next-app(?:@[^\s]+)?\s+([^\s]+)/);
  return match?.[1];
}

function validateSandboxCommand(command: string) {
  if (/[;&]{2}|\|\||;/.test(command)) {
    return 'Refused chained shell command. Run one focused command per tool call so progress and failures are visible.';
  }

  if (/\brm\s+-[^\n]*[rf]/.test(command)) {
    return 'Refused destructive cleanup command. Use delete_file for intentional file removal.';
  }

  if (/\bnpm\s+run\s+dev\b/.test(command) && !/^nohup\s+npm\s+run\s+dev\s+--\s+--hostname\s+0\.0\.0\.0\s*>\s*dev\.log\s+2>&1\s*&\s*$/.test(command)) {
    return "Refused foreground dev server command. Start preview with: nohup npm run dev -- --hostname 0.0.0.0 > dev.log 2>&1 &";
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

const APP_BUILDER_SYSTEM_PROMPT = `You are an autonomous AI app builder for a v0/Lovable/Replit-style product.
Your job is to turn the user's prompt into a real full-stack Next.js App Router project inside the existing Daytona sandbox and keep the database-backed file explorer accurate.

Operating principles:
- Work autonomously. Do not ask permission for ordinary build steps.
- The app must be a real Next.js project, not a static HTML page, CDN demo, iframe dump, or updateCanvas prototype.
- The database-backed file explorer is the user-visible source of truth. Every authored source file must be created with write_file or write_files.
- Never create nested apps like blog-app. Build in the sandbox root ".".
- Prefer write_files for authored code. Use shell commands only for scaffolding, dependency install, build checks, and starting the preview server.
- Never run chained shell commands, destructive cleanup commands, or foreground dev servers.
- If a command fails or times out, do not loop on commands. Continue by writing the needed source files directly, then run one bounded verification command.

Required workflow for a fresh app:
1. Inspect or scaffold:
   - If package.json is missing, run exactly: ${getRequiredRootNextCommand()}
   - If package.json exists, do not re-run create-next-app.
   - After command-generated files, call sync_project_files with path ".".
2. Author the app:
   - Use write_files to create or overwrite at least src/app/page.tsx, src/app/layout.tsx, src/app/globals.css, and supporting files under src/components or src/lib as needed.
   - For full-stack requirements, add Route Handlers under src/app/api/**/route.ts and shared server modules under src/lib/**.
   - Use complete file contents. Do not emit partial patches or code blocks in chat.
3. Verify:
   - Run one focused check such as npm run build.
   - If it fails, read the relevant file or error, fix with write_file/write_files, then run one more focused check.
4. Preview:
   - Start the server only with: nohup npm run dev -- --hostname 0.0.0.0 > dev.log 2>&1 &
   - Then call get_preview_url for port 3000.

Design expectations:
- Build polished, responsive, production-quality interfaces.
- Use App Router patterns, React components, route handlers, server/client boundaries, and Tailwind CSS.
- Use lucide-react icons when icons are useful.
- Avoid one-off landing-page filler when the user asked for an app; build the actual usable product surface.

Chat behavior:
- Keep chat text short and operational.
- Do not paste raw source code, minified bundles, HTML documents, or iframes into chat.
- Do not use updateCanvas to build or preview apps. The preview must come from get_preview_url.
- Finish by briefly stating what was built and that the preview is ready or what exact blocker remains.`;

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
            const response = await withTimeout(
              sandbox.process.executeCommand(command),
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

            return `Exit Code: ${response.exitCode}\nOutput:\n${truncateOutput(response.result)}${syncSummary}`;
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

            try {
              const sandbox = await getProjectSandbox(projectId);
              const buf = Buffer.from(content, 'utf8');
              await sandbox.fs.uploadFile(buf, cleanPath);
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
          if (savedPaths.length > 0) {
            try {
              const sandbox = await getProjectSandbox(projectId);
              for (const file of files) {
                const cleanPath = normalizeProjectPath(file.path);
                if (!savedPaths.includes(cleanPath)) continue;
                await sandbox.fs.uploadFile(Buffer.from(file.content, 'utf8'), cleanPath);
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
      get_preview_url: tool({
        description: 'Get a public URL to preview the running web application on a specific port (e.g. 3000 for Next.js). The UI renders this URL automatically.',
        inputSchema: z.object({
          port: z.number().describe('The port the web server is running on (usually 3000).')
        }),
        execute: async ({ port }) => {
          const sandbox = await getProjectSandbox(projectId);
          try {
             const preview = await sandbox.getPreviewLink(port);
             return `Preview URL: ${preview.url}\n(Token if private: ${preview.token})`;
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

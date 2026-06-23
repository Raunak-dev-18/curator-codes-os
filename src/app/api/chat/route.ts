import { streamText, tool, convertToModelMessages, stepCountIs } from 'ai';
import { getModel } from '../../../lib/ai';
import { auth0 } from '../../../lib/auth0';
import { saveMessages, deleteProjectFile, getProject, getProjectFiles, renameProjectFile, saveProjectFile } from '../../../lib/db/projects';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getProjectSandbox } from '../../../lib/daytona';
import { normalizeDirectoryPath, normalizeProjectPath } from '../../../lib/project-paths';
import { syncSandboxFilesToProject } from '../../../lib/sandbox-sync';
import { CANVAS_FALLBACK_FILE, isRenderableCanvasCode } from '../../../lib/canvas-preview';

// Allow long-running operations
export const maxDuration = 60;

function getRequiredRootNextCommand() {
  return 'npx -y create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --yes --force';
}

function getCreateNextAppTarget(command: string) {
  const match = command.match(/\bcreate-next-app(?:@[^\s]+)?\s+([^\s]+)/);
  return match?.[1];
}

function validateSandboxCommand(command: string) {
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
    stopWhen: stepCountIs(10),
    system: `You are an elite, autonomous AI App Builder (like Lovable.dev or Replit Agent).
Your singular job is to build fully-functional, beautiful, and production-ready Next.js web applications directly from user prompts.
You have access to a secure, remote Daytona Node.js sandbox.

## 🎯 Core Directives
1. **Act Autonomously**: Do not ask for permission. When a user gives a prompt, use your tools to build it end-to-end.
2. **Write Actual Code**: Do NOT just run 'create-next-app' and stop. You MUST write the actual application logic, components, and pages using the 'write_file' tool. A generated boilerplate is not an app.
3. **Premium Aesthetics**: Your UI/UX must be breathtaking. Use Tailwind CSS, glassmorphism, subtle gradients, rich shadows, and framer-motion micro-animations.
4. **Use the existing sandbox**: Never create nested apps such as "blog-app" inside the sandbox. Work in "." unless the user explicitly asks for a subfolder.

## 🚀 The Multi-Step Agentic Workflow
You MUST follow this exact loop for every project:

**Step 1: Code Acquisition & Scaffolding**
- If working with an existing repo, use 'git_clone' to clone it.
- If starting fresh, use 'execute_command': 'npx -y create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --yes --force'
- Wait for it to finish, then 'execute_command': 'npm install framer-motion lucide-react clsx tailwind-merge'
- After any scaffolding, install, or generated-file command, call 'sync_project_files' so the user's file explorer updates.

**Step 2: Architecture & Coding (CRITICAL STEP)**
- You must physically write the code for the user's request. 
- Use 'write_file' to create or overwrite 'src/app/page.tsx', 'src/app/globals.css', and any necessary UI components.
- You can use 'delete_file' or 'move_file' to manage the file system.
- **IMPORTANT**: The user's IDE reads synced project files. Use 'write_file' for authored files and 'sync_project_files' after command-generated files. Do not skip this step.

**Step 3: Version Control (Optional)**
- If the user asks you to save or commit work, use 'git_commit' and 'git_push'.

**Step 4: Start Server & Get URL**
- Use 'execute_command' to start the Next.js dev server: 'nohup npm run dev -- --hostname 0.0.0.0 > dev.log 2>&1 &'
- If you encounter issues, you can check 'get_entrypoint_logs' or read 'dev.log'.
- Use 'get_preview_url' with port '3000' to fetch the live URL.

**Step 5: Render to User**
- The UI automatically renders URLs returned by 'get_preview_url'. Do not pass compiled JavaScript bundles or raw app code to 'updateCanvas'.

## 🚫 Strict Rules
1. **NO RAW CODE IN CHAT**: NEVER output raw markdown code blocks (e.g. tsx code blocks) in your chat messages. Only use 'write_file'.
2. **CONCISE CHAT**: Keep chat text to one short sentence while building. The UI shows thinking, commands, file edits, and preview progress.
3. **NO IFRAME IN CHAT**: Never output HTML iframes in the chat text.
4. **NO BUNDLES AS PREVIEW**: Never send minified/bundled JavaScript to 'updateCanvas'. Use 'get_preview_url' for live preview.

Remember: Scaffolding is just step 1. You haven't built the app until you've written the custom React components via 'write_file'! Make the user say "WOW".`,
    messages: modelMessages,
    tools: {
      updateCanvas: tool({
        description: 'Update the preview canvas only with a preview URL iframe or a complete HTML document. Do not pass bundled JavaScript or raw source code.',
        inputSchema: z.object({
          code: z.string().describe('A preview URL iframe or complete HTML document. Prefer get_preview_url for running apps.'),
          explanation: z.string().describe('A brief explanation of what was built or changed.')
        }),
        execute: async ({ code, explanation }) => {
          if (isRenderableCanvasCode(code)) {
            try {
              const { saveProjectFile } = await import('../../../lib/db/projects');
              await saveProjectFile(projectId, userId, CANVAS_FALLBACK_FILE, code);
              return `Preview updated: ${explanation}\nSaved fallback file: ${CANVAS_FALLBACK_FILE}`;
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown save error';
              return `Preview updated: ${explanation}\nFailed to save fallback file: ${message}`;
            }
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
          try {
            const sandbox = await getProjectSandbox(projectId);
            const response = await sandbox.process.executeCommand(command);
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

            return `Exit Code: ${response.exitCode}\nOutput:\n${response.result}${syncSummary}`;
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
          const sandbox = await getProjectSandbox(projectId);
          try {
            const cleanPath = normalizeProjectPath(path);
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
          const sandbox = await getProjectSandbox(projectId);
          try {
            const cleanPath = normalizeProjectPath(path);
            const buf = Buffer.from(content, 'utf8');
            await sandbox.fs.uploadFile(buf, cleanPath);
            
            // Sync to Database
            const { saveProjectFile } = await import('../../../lib/db/projects');
            await saveProjectFile(projectId, userId, cleanPath, content);

            return `Successfully wrote to ${cleanPath} and synced to DB`;
          } catch (err: any) {
            return `Failed to write file: ${err.message}`;
          }
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
        description: 'Get a public URL to preview the running web application on a specific port (e.g. 3000 for Next.js). Call this once the app is running and tell the user the URL to visit or open it in an iframe using updateCanvas.',
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

import { streamText, tool, convertToModelMessages, stepCountIs } from 'ai';
import { getModel } from '../../../lib/ai';
import { auth0 } from '../../../lib/auth0';
import { saveMessages, deleteProjectFile, renameProjectFile } from '../../../lib/db/projects';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getDaytonaClient, getProjectSandbox } from '../../../lib/daytona';

// Allow long-running operations
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await auth0.getSession();
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userId = session.user.sub;
  const payload = await req.json();
  const { messages, projectId } = payload;
  
  const fs = require('fs');
  fs.writeFileSync('last_payload.json', JSON.stringify({
     lastMessage: messages[messages.length - 1],
     projectId
  }, null, 2));

  if (!projectId) {
    console.error("Missing Project ID");
    return new Response('Project ID is required', { status: 400 });
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

## 🚀 The Multi-Step Agentic Workflow
You MUST follow this exact loop for every project:

**Step 1: Code Acquisition & Scaffolding**
- If working with an existing repo, use 'git_clone' to clone it.
- If starting fresh, use 'execute_command': 'npx -y create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*"'
- Wait for it to finish, then 'execute_command': 'npm install framer-motion lucide-react clsx tailwind-merge'

**Step 2: Architecture & Coding (CRITICAL STEP)**
- You must physically write the code for the user's request. 
- Use 'write_file' to create or overwrite 'src/app/page.tsx', 'src/app/globals.css', and any necessary UI components.
- You can use 'delete_file' or 'move_file' to manage the file system.
- **IMPORTANT**: The user's IDE reads from a database. ONLY files you explicitly write using the 'write_file' tool will show up in their File Explorer. Do not skip this step!

**Step 3: Version Control (Optional)**
- If the user asks you to save or commit work, use 'git_commit' and 'git_push'.

**Step 4: Start Server & Get URL**
- Use 'execute_command' to start the Next.js dev server: 'nohup npm run dev > dev.log 2>&1 &'
- If you encounter issues, you can check 'get_entrypoint_logs' or read 'dev.log'.
- Use 'get_preview_url' with port '3000' to fetch the live URL.

**Step 5: Render to User**
- Use 'updateCanvas' passing an iframe with the preview URL: '<iframe src="PREVIEW_URL" style="width: 100%; height: 100vh; border: none;"></iframe>'

## 🚫 Strict Rules
1. **NO RAW CODE IN CHAT**: NEVER output raw markdown code blocks (e.g. tsx code blocks) in your chat messages. Only use 'write_file'.
2. **CONCISE CHAT**: Say "Building your application..." and let your tool calls do the talking.
3. **NO IFRAME IN CHAT**: Never output HTML iframes in the chat text. Only use 'updateCanvas'.

Remember: Scaffolding is just step 1. You haven't built the app until you've written the custom React components via 'write_file'! Make the user say "WOW".`,
    messages: modelMessages,
    tools: {
      updateCanvas: tool({
        description: 'Update the preview canvas with HTML/CSS/JS code to render the requested app or component.',
        inputSchema: z.object({
          code: z.string().describe('The complete HTML document or React code to render. You can use standard HTML/CSS or external CDNs.'),
          explanation: z.string().describe('A brief explanation of what was built or changed.')
        })
      }),
      execute_command: tool({
        description: 'Run a shell command in the remote sandbox (e.g. npm run dev, npx create-next-app, npm install).',
        inputSchema: z.object({
          command: z.string().describe('The bash command to execute.')
        }),
        execute: async ({ command }) => {
          const sandbox = await getProjectSandbox(projectId);
          const response = await sandbox.process.executeCommand(command);
          return `Exit Code: ${response.exitCode}\nOutput:\n${response.result}`;
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
            const buf = await sandbox.fs.downloadFile(path);
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
            const buf = Buffer.from(content, 'utf8');
            await sandbox.fs.uploadFile(buf, path);
            
            // Sync to Database
            const { saveProjectFile } = await import('../../../lib/db/projects');
            await saveProjectFile(projectId, path, content);

            return `Successfully wrote to ${path} and synced to DB`;
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
            const files = await sandbox.fs.listFiles(path);
            return files.map(f => `${f.isDir ? '[DIR]' : '[FILE]'} ${f.name} - ${f.size} bytes`).join('\n');
          } catch (err: any) {
            return `Failed to list files: ${err.message}`;
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
            await sandbox.fs.deleteFile(path);
            await deleteProjectFile(projectId, path);
            return `Successfully deleted ${path}`;
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
            await sandbox.fs.moveFiles(source, destination);
            await renameProjectFile(projectId, source, destination);
            return `Successfully moved ${source} to ${destination}`;
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
            return `Successfully committed changes. Hash: ${resp.hash}`;
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
          assistantMessage.toolInvocations = allToolCalls.map((tc: any, index: number) => {
            const tr = allToolResults.find((r: any) => r.toolCallId === tc.toolCallId) || allToolResults[index];
            return {
              state: 'result',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args || tc.input || {},
              result: tr ? tr.result : undefined
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

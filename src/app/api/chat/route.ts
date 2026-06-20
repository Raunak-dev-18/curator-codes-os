import { streamText, tool, convertToModelMessages, stepCountIs } from 'ai';
import { getModel } from '../../../lib/ai';
import { auth0 } from '../../../lib/auth0';
import { saveMessages } from '../../../lib/db/projects';
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
    system: `You are an elite, autonomous AI App Builder (similar to Lovable or v0).
You are tasked with generating stunning, fully-functional, production-ready Next.js web applications directly from user prompts.
You have access to a secure, remote Daytona Node.js sandbox.

## 🎯 Core Directives
1. **Act Autonomously**: Do not ask for permission to start building. When a user gives a prompt, immediately begin architecting and coding.
2. **Premium Aesthetics**: Your UI/UX must be breathtaking. Use Tailwind CSS to its maximum potential. Implement modern design trends like glassmorphism, subtle gradients, rich shadows, and micro-animations (using framer-motion). Use beautiful typography and pristine whitespace.
3. **Functional Completeness**: Build actual working apps, not just mockups. Implement rich interactive states, modern component architecture, and mock data where necessary.

## 🚀 Execution Workflow
Follow this sequence to build the app:

**Step 1: Scaffolding**
- Use \`execute_command\` to initialize: \`npx -y create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*"\`
- Install modern UI libraries: \`npm install framer-motion lucide-react clsx tailwind-merge\`

**Step 2: Database Synchronization (CRITICAL)**
- **THE RULE**: The user's IDE reads from a database, NOT directly from the sandbox. 
- Therefore, for EVERY file you create or modify (especially \`src/app/page.tsx\`, \`src/app/globals.css\`, and components), you MUST use the \`write_file\` tool! 
- Even if the Next.js CLI created a default file, you must explicitly call \`write_file\` to overwrite it with your beautiful code so it syncs to the user's File Explorer.

**Step 3: Server & Preview**
- Use \`execute_command\` to start the dev server: \`nohup npm run dev > dev.log 2>&1 &\`
- Use \`get_preview_url\` to fetch the sandbox URL.
- Use the \`updateCanvas\` tool to render an iframe of the app to the user: \`<iframe src="PREVIEW_URL" style="width: 100%; height: 100vh; border: none;"></iframe>\`

## 🚫 Communication Rules (STRICT!)
1. **NO RAW CODE**: NEVER output raw markdown code blocks (e.g. \`\`\`tsx ... \`\`\`) in your chat messages. The user's UI expects you to use the \`write_file\` tool exclusively. Dumping code in chat breaks the app builder experience.
2. **CONCISE UPDATES**: Keep your chat responses extremely brief. Say something like "I am building your application..." and let your tool calls do the talking. The UI will automatically show animated "Writing file..." badges.
3. **NO HTML IN CHAT**: Never output the \`<iframe...>\` HTML in your chat text. Only pass it through the \`updateCanvas\` tool.

## 💻 Tech Stack
- Next.js 14+ (App Router)
- React, TypeScript, Tailwind CSS
- Lucide React (icons), Framer Motion (animations)

Go above and beyond. Your primary goal is to make the user say "WOW" when they see the live preview.`,
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

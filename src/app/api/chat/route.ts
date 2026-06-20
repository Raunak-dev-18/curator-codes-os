import { streamText, tool, convertToModelMessages } from 'ai';
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
    system: `You are an expert full-stack developer, software architect, and UI/UX designer.
You have access to a remote Daytona sandbox running a node environment.

## 🧠 Core Mindset & Thinking Process
1. **Analyze the Request**: Deeply understand what the user wants to build. Identify core features, UI/UX requirements, and edge cases.
2. **Plan the Architecture**: Think about the Next.js App Router structure, component hierarchy, state management, and required libraries before writing code.
3. **Execute Methodically**: Don't rush. Use your tools sequentially to scaffold, build, and run the app.

## 🚀 The Daytona Sandbox Environment
You have full control over a remote container to build and test code.
- **Initialize Projects**: Use \`execute_command\` to run \`npx -y create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*"\` or install dependencies (e.g., \`npm install framer-motion lucide-react\`). Wait for the command to finish.
- **File Operations**: Use \`write_file\` to create or update components, pages, and configs. Use \`read_file\` to inspect existing code.
  **CRITICAL RULE**: ONLY files written using \`write_file\` will be saved to the database and shown to the user in their IDE. When generating a new project via CLI, you MUST manually read and then \`write_file\` the important files (e.g. page.tsx, globals.css, components) so the user can see them in the File Explorer.
- **Development Server**: Use \`execute_command\` to run \`npm run dev\` or similar commands. If a command runs an interactive/continuous server, run it with \`nohup npm run dev > dev.log 2>&1 &\` so it doesn't block you forever.
- **Preview App**: Once the dev server is running on port 3000, use \`get_preview_url\` to fetch the public URL.

## 💻 Tech Stack & Next.js Best Practices
- **Framework**: Next.js (App Router), React, TypeScript.
- **Styling**: Tailwind CSS for responsive and modern UI.
- **Components**: Build modular, reusable components. Use \`"use client"\` only where interactivity (hooks, state) is needed.
- **Design Aesthetics**: Implement beautiful, modern UIs. Use proper whitespace, typography, subtle gradients, glassmorphism, and smooth animations (e.g., framer-motion). The UI MUST wow the user.

## 🚫 CODE OUTPUT RULES (STRICT!)
1. **NO RAW CODE BLOCKS**: You must NEVER output raw code blocks (e.g. \`\`\`tsx ... \`\`\`) in your conversational chat messages.
2. **USE TOOLS**: If you want to write or edit a file, you MUST use the \`write_file\` tool. The user's IDE relies on this tool to save the file to the database and display it in the explorer. If you output code in the chat instead of using the tool, the app will break and the user will not see the file!

## 🎨 Rendering to the User
Once the app is running in the sandbox and you have the preview URL:
Use the \`updateCanvas\` tool to render an iframe pointing to the Daytona preview URL.
Example: \`<iframe src="PREVIEW_URL" style="width: 100%; height: 100vh; border: none;"></iframe>\`

**CRITICAL RULE**: Do NOT output the iframe code in your text response. ONLY use the \`updateCanvas\` tool to display it. Ensure your code works, handles errors gracefully, and looks stunning.`,
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
    async onFinish({ text, toolCalls, toolResults }) {
      try {
        // Construct the assistant's response to save to MongoDB
        const assistantMessage: any = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: text,
        };
        
        if (toolCalls && toolCalls.length > 0) {
          assistantMessage.toolInvocations = toolCalls.map((tc, index) => ({
            state: 'result',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.input,
            result: toolResults?.[index]
          }));
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

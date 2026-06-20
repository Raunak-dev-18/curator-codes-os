import { streamText, tool, convertToModelMessages } from 'ai';
import { getModel } from '../../../lib/ai';
import { auth0 } from '../../../lib/auth0';
import { saveMessages } from '../../../lib/db/projects';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';

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
    system: "You are an expert web developer and UI designer. You can update the user's preview canvas using the updateCanvas tool. Always use the tool to render UI when asked to build or change something. Ensure the code works and looks great.",
    messages: modelMessages,
    tools: {
      updateCanvas: tool({
        description: 'Update the preview canvas with HTML/CSS/JS code to render the requested app or component.',
        inputSchema: z.object({
          code: z.string().describe('The complete HTML document or React code to render. You can use standard HTML/CSS or external CDNs.'),
          explanation: z.string().describe('A brief explanation of what was built or changed.')
        })
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

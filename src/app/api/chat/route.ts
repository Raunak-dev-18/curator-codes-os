import { streamText, tool } from 'ai';
import { getModel } from '../../../lib/ai';
import { auth0 } from '../../../lib/auth0';
import { saveMessages } from '../../../lib/db/projects';
import { z } from 'zod';

// Allow long-running operations
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await auth0.getSession();
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userId = session.user.sub;
  const payload = await req.json();
  console.log("Chat API Payload:", payload);
  const { messages, projectId } = payload;

  if (!projectId) {
    console.error("Missing Project ID");
    return new Response('Project ID is required', { status: 400 });
  }

  // Save the incoming user message to the DB (don't fail the request if it fails)
  try {
    await saveMessages(projectId, userId, messages);
  } catch (err) {
    console.error("Failed to save incoming messages to DB", err);
  }

  const model = getModel();

  const result = streamText({
    model,
    system: "You are an expert web developer and UI designer. You can update the user's preview canvas using the updateCanvas tool. Always use the tool to render UI when asked to build or change something. Ensure the code works and looks great.",
    messages,
    tools: {
      updateCanvas: tool({
        description: 'Update the preview canvas with HTML/CSS/JS code to render the requested app or component.',
        parameters: z.object({
          code: z.string().describe('The complete HTML document or React code to render. You can use standard HTML/CSS or external CDNs.'),
          explanation: z.string().describe('A brief explanation of what was built or changed.')
        }),
        execute: async ({ code, explanation }) => {
          // This executes on the server. We acknowledge the execution so the UI knows it finished.
          return { success: true, message: 'Canvas successfully updated.' };
        },
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
            args: tc.args,
            result: toolResults?.[index]
          }));
        }
        
        // Save the updated history including the AI's response
        await saveMessages(projectId, userId, [...messages, assistantMessage]);
      } catch (err) {
        console.error("Failed to save final messages to DB", err);
      }
    },
  });

  return result.toUIMessageStreamResponse();
}

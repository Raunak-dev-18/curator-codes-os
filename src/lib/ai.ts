import { createOpenAI } from '@ai-sdk/openai';

let customProvider: ReturnType<typeof createOpenAI> | null = null;

export const getModel = () => {
  const modelId = process.env.LLM_ID;
  if (!modelId) {
    throw new Error('LLM_ID environment variable is not defined');
  }

  return getProvider().chat(modelId);
};

function getProvider() {
  if (!customProvider) {
    const apiKey = process.env.LLM_API_KEY;
    const baseURL = process.env.LLM_BASE_URL;

    if (!apiKey) {
      throw new Error('LLM_API_KEY environment variable is not defined');
    }

    if (!baseURL) {
      throw new Error('LLM_BASE_URL environment variable is not defined');
    }

    customProvider = createOpenAI({
      apiKey,
      baseURL,
    });
  }

  return customProvider;
}

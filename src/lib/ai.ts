import { createOpenAI } from '@ai-sdk/openai';

// Create a custom OpenAI instance pointing to the specified base URL and using the specified API key
export const customProvider = createOpenAI({
  apiKey: process.env.LLM_API_KEY || '',
  baseURL: process.env.LLM_BASE_URL || '',
  compatibility: 'compatible',
});

// Helper function to get the specific model based on the ID in the environment
export const getModel = () => {
  const modelId = process.env.LLM_ID;
  if (!modelId) {
    throw new Error("LLM_ID environment variable is not defined");
  }
  return customProvider(modelId);
};

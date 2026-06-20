import { Daytona } from '@daytona/sdk';

let daytonaClient: Daytona | null = null;

export const getDaytonaClient = (): Daytona => {
  if (!daytonaClient) {
    const apiKey = process.env.DAYTONA_API_KEY;
    const apiUrl = process.env.DAYTONA_API_URL;
    const target = process.env.DAYTONA_REGION;

    if (!apiKey) {
      throw new Error('DAYTONA_API_KEY environment variable is missing.');
    }

    daytonaClient = new Daytona({
      apiKey,
      apiUrl,
      target,
    });
  }

  return daytonaClient;
};

export async function getProjectSandbox(projectId: string) {
  const daytona = getDaytonaClient();
  const safeId = projectId.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
  const sandboxName = `curator-${safeId}`.slice(0, 32);

  try {
    const iter = daytona.list({ name: sandboxName });
    for await (const sb of iter) {
       if (sb.name === sandboxName) return sb;
    }
  } catch (err) {
    console.error("Error listing sandboxes:", err);
  }

  console.log(`Creating new sandbox: ${sandboxName}`);
  return await daytona.create({
    name: sandboxName,
    image: 'node:20-bookworm',
    language: 'typescript',
    autoStopInterval: 15
  });
}

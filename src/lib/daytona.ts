import { Daytona } from '@daytona/sdk';

let daytonaClient: Daytona | null = null;
let daytonaClientConfigKey: string | null = null;

const DAYTONA_SANDBOX_PREFIX = 'curator';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown Daytona error';
}

function getErrorDetails(error: unknown) {
  if (!error || typeof error !== 'object') {
    return { message: getErrorMessage(error) };
  }

  const maybeError = error as {
    message?: unknown;
    statusCode?: unknown;
    errorCode?: unknown;
  };

  return {
    message: typeof maybeError.message === 'string' ? maybeError.message : getErrorMessage(error),
    statusCode: typeof maybeError.statusCode === 'number' ? maybeError.statusCode : undefined,
    errorCode: typeof maybeError.errorCode === 'string' ? maybeError.errorCode : undefined,
  };
}

function isAuthenticationError(error: unknown): boolean {
  const details = getErrorDetails(error);
  return (
    details.statusCode === 401 ||
    details.errorCode === 'Unauthorized' ||
    /invalid credentials|unauthorized/i.test(details.message)
  );
}

export function getProjectSandboxName(projectId: string): string {
  const safeId = projectId
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
  const sandboxName = `${DAYTONA_SANDBOX_PREFIX}-${safeId}`.slice(0, 32).replace(/-+$/g, '');

  if (sandboxName.length <= DAYTONA_SANDBOX_PREFIX.length + 1) {
    throw new Error('Project ID cannot be converted to a valid Daytona sandbox name.');
  }

  return sandboxName;
}

function getLegacyProjectSandboxName(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
  return `${DAYTONA_SANDBOX_PREFIX}-${safeId}`.slice(0, 32);
}

export const getDaytonaClient = (): Daytona => {
  const apiKey = process.env.DAYTONA_API_KEY;
  const apiUrl = process.env.DAYTONA_API_URL;
  const target = process.env.DAYTONA_TARGET ?? process.env.DAYTONA_REGION;

  if (!apiKey) {
    throw new Error('DAYTONA_API_KEY environment variable is missing.');
  }

  const configKey = JSON.stringify({ apiKey, apiUrl, target });
  if (!daytonaClient || daytonaClientConfigKey !== configKey) {
    daytonaClient = new Daytona({
      apiKey,
      apiUrl,
      target,
    });
    daytonaClientConfigKey = configKey;
  }

  return daytonaClient;
};

export async function getProjectSandbox(projectId: string) {
  const daytona = getDaytonaClient();
  const sandboxName = getProjectSandboxName(projectId);
  const legacySandboxName = getLegacyProjectSandboxName(projectId);

  try {
    const iter = daytona.list({ name: sandboxName });

    for await (const sb of iter) {
      if (sb.name === sandboxName || sb.name === legacySandboxName) return sb;
    }
  } catch (err) {
    const details = getErrorDetails(err);

    if (isAuthenticationError(err)) {
      throw new Error(
        'Daytona authentication failed while looking up the existing sandbox. Check DAYTONA_API_KEY, DAYTONA_API_URL, and DAYTONA_TARGET/DAYTONA_REGION. Refusing to create a new sandbox until listing succeeds.'
      );
    }

    throw new Error(
      `Failed to list Daytona sandboxes before reuse/create (${details.statusCode ?? 'no status'}${
        details.errorCode ? ` ${details.errorCode}` : ''
      }): ${details.message}`
    );
  }

  console.log(`Creating new sandbox: ${sandboxName}`);
  return await daytona.create({
    name: sandboxName,
    image: 'node:20-bookworm',
    language: 'typescript',
    autoStopInterval: 15,
    labels: {
      app: 'opensource-curator',
      projectId,
    },
  });
}

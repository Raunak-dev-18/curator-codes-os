export const CANVAS_FALLBACK_FILE = 'preview.html';

export function isRenderableCanvasCode(code: string) {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^<(?:!doctype|html|head|body|main|div|section)\b/i.test(trimmed)) return true;

  return (
    /<(?:html|body|main|div|section)\b/i.test(trimmed) &&
    /<\/(?:html|body|main|div|section)>/i.test(trimmed)
  );
}

export function extractIframePreviewUrl(code: string) {
  const trimmed = code.trim();
  const iframeMatch = trimmed.match(/^<iframe[^>]+src=["']([^"']+)["']/i);
  return iframeMatch?.[1] || '';
}

function getToolName(tool: any) {
  if (tool?.toolName) return tool.toolName;
  if (typeof tool?.type === 'string' && tool.type.startsWith('tool-')) {
    return tool.type.slice('tool-'.length);
  }
  return '';
}

function getToolInput(tool: any) {
  const rawInput = tool?.input ?? tool?.args ?? tool?.inputText ?? tool?.argsText ?? {};

  if (typeof rawInput === 'string') {
    try {
      return JSON.parse(rawInput);
    } catch {
      return { value: rawInput };
    }
  }

  return rawInput && typeof rawInput === 'object' ? rawInput : {};
}

export function extractLatestCanvasHtml(messages: any[]) {
  let html = '';

  for (const message of messages || []) {
    const parts = message.parts?.filter((part: any) => typeof part?.type === 'string' && part.type.startsWith('tool-')) || [];
    const legacyTools = message.toolInvocations || [];

    for (const tool of [...parts, ...legacyTools]) {
      if (getToolName(tool) !== 'updateCanvas') continue;

      const input = getToolInput(tool);
      if (typeof input.code === 'string' && isRenderableCanvasCode(input.code)) {
        html = input.code;
      }
    }
  }

  return html;
}

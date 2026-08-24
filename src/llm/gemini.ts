/**
 * Minimal Gemini REST client for agentic loops.
 *
 * Nuances handled here (learned the hard way — see knowledge/research):
 *  - Gemini 3.x REQUIRES echoing `thoughtSignature` parts back or the API
 *    returns 400; we preserve model turns byte-for-byte.
 *  - Screenshots ride inlineData parts; old images are pruned from history to
 *    stay under request-size/token limits while keeping full textual state.
 *  - functionResponse.response must be an OBJECT, never a string.
 */
import type { Observation } from '../core/actions.js';

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GenerateResult {
  parts: GeminiPart[];
  usage?: { promptTokens?: number; totalTokens?: number };
}

export class GeminiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async generate(
    contents: GeminiContent[],
    opts: {
      system?: string;
      temperature?: number;
      /** OpenAPI-subset function declarations (Gemini function calling). */
      tools?: Array<Record<string, unknown>>;
    } = {}
  ): Promise<GenerateResult> {
    // Free-tier RPM limits make 429s routine for agentic loops; backoff is
    // part of the client contract, not the caller's problem.
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.generateOnce(contents, opts);
      } catch (err) {
        const e = err as Error;
        lastError = e;
        const status = e.message.match(/gemini (\d+)/)?.[1];
        if (status !== '429' && status !== '500' && status !== '503') throw e;
        const retryDelay = Number(e.message.match(/"retryDelay": "(\d+)s"/)?.[1] ?? 0);
        const waitMs = Math.min(Math.max(retryDelay * 1000, 15000), 70000);
        if (attempt < 4) await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastError ?? new Error('gemini generate failed');
  }

  private async generateOnce(
    contents: GeminiContent[],
    opts: {
      system?: string;
      temperature?: number;
      tools?: Array<Record<string, unknown>>;
    } = {}
  ): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: 2048,
      },
    };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;

    const res = await this.fetchFn(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`gemini ${res.status}: ${detail.slice(0, 400)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
      usageMetadata?: { promptTokenCount?: number; totalTokenCount?: number };
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    return {
      parts,
      usage: {
        promptTokens: data.usageMetadata?.promptTokenCount,
        totalTokens: data.usageMetadata?.totalTokenCount,
      },
    };
  }
}

/** Build the user turn that shows the model the current screen state. */
export function observationParts(
  goal: string,
  obs: Observation,
  extraGuidance?: string
): GeminiPart[] {
  return [
    {
      text: [
        `GOAL: ${goal}`,
        ``,
        `CURRENT SCREEN (viewport ${obs.viewport.width}x${obs.viewport.height}):`,
        `URL: ${obs.url}`,
        `TITLE: ${obs.title}`,
        ``,
        `ACCESSIBILITY OUTLINE (interactive elements carry [eN] refs you can target instead of pixels):`,
        obs.a11yAnnotatedYaml,
        ``,
        extraGuidance ?? '',
        `Decide the SINGLE next best action and call the matching function.`,
      ]
        .join('\n')
        .slice(0, 24000),
    },
    { inlineData: { mimeType: 'image/png', data: obs.screenshotBase64 } },
  ];
}

/**
 * History pruning: keep the last K observations' images; older image parts are
 * dropped (text outline remains) so long runs don't blow request limits.
 */
export function pruneHistory(history: GeminiContent[], keepImages = 3): GeminiContent[] {
  let imageBudget = keepImages;
  const out: GeminiContent[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i]!;
    const parts: GeminiPart[] = [];
    for (const p of [...c.parts].reverse()) {
      if (p.inlineData) {
        if (imageBudget <= 0) continue;
        imageBudget -= 1;
      }
      parts.unshift(p);
    }
    out.unshift({ ...c, parts });
  }
  return out;
}

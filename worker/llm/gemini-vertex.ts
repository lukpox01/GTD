import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { parseClassification, vertexResponseSchema } from "./schema";
import { ClassificationError, type ClassifyInput, type ClassifyResult, type LlmProvider } from "./types";
import { bytesToBase64, getAccessToken, type ServiceAccount } from "./vertex-auth";

/** Inline request data is capped at ~20 MB by Vertex; base64 adds a third. */
const MAX_AUDIO_BYTES = 14 * 1024 * 1024;

export interface GeminiVertexConfig {
  serviceAccount: ServiceAccount;
  projectId: string;
  location: string;
  model: string;
  /** Sent as thinkingConfig.thinkingLevel when set; empty leaves the model default. */
  thinkingLevel?: string;
  timezone: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

export class GeminiVertexProvider implements LlmProvider {
  readonly name = "gemini-vertex";
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly config: GeminiVertexConfig) {
    this.fetchFn = config.fetch ?? fetch.bind(globalThis);
    this.now = config.now ?? (() => new Date());
  }

  endpoint(): string {
    const { location, projectId, model } = this.config;
    const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
  }

  buildRequest(input: ClassifyInput): unknown {
    const parts: unknown[] = [
      { text: buildUserPrompt({ now: this.now(), timezone: this.config.timezone, text: input.text, hasAudio: !!input.audio }) },
    ];
    if (input.audio) {
      parts.push({ inlineData: { mimeType: input.audio.mimeType, data: bytesToBase64(input.audio.bytes) } });
    }
    return {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: vertexResponseSchema,
        maxOutputTokens: 8192,
        ...(this.config.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.config.thinkingLevel } } : {}),
      },
    };
  }

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const model = this.config.model;
    if (!input.text && !input.audio) throw new ClassificationError("empty input", { model });
    if (input.audio && input.audio.bytes.length > MAX_AUDIO_BYTES) {
      throw new ClassificationError(`audio too large (${input.audio.bytes.length} bytes)`, { model });
    }

    const token = await getAccessToken(this.config.serviceAccount, { fetch: this.fetchFn });
    const res = await this.fetchFn(this.endpoint(), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(this.buildRequest(input)),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new ClassificationError(`Vertex AI HTTP ${res.status}: ${body.slice(0, 500)}`, { model });
    }

    let data: GenerateContentResponse;
    try {
      data = JSON.parse(body) as GenerateContentResponse;
    } catch {
      throw new ClassificationError("Vertex AI returned non-JSON envelope", { model, rawOutput: body.slice(0, 2000) });
    }
    const usedModel = data.modelVersion ?? model;

    if (data.promptFeedback?.blockReason) {
      throw new ClassificationError(`prompt blocked: ${data.promptFeedback.blockReason}`, { model: usedModel });
    }
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (!text) {
      throw new ClassificationError(`empty response (finishReason: ${candidate?.finishReason ?? "none"})`, {
        model: usedModel,
      });
    }

    const parsed = parseClassification(text);
    if (!parsed.ok) {
      throw new ClassificationError(parsed.error, {
        model: usedModel,
        rawOutput: text,
        partialTranscript: parsed.partialTranscript,
      });
    }
    const u = data.usageMetadata;
    const usage = u
      ? { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thoughts: u.thoughtsTokenCount ?? 0 }
      : undefined;
    return { item: parsed.item, model: usedModel, ...(usage ? { usage } : {}) };
  }
}

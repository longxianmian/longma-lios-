// P0 LLM Placeholder — OpenAI-compatible chat completions format.
// Does NOT make real HTTP calls; generates deterministic mock output.
// Plugin output is ALWAYS routed to Candidate or Evidence channels — never directly to Decision.

export interface OpenAIChatMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIChatResponse {
  id:      string;
  object:  'chat.completion';
  model:   string;
  choices: Array<{
    index:         number;
    message:       OpenAIChatMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens:     number;
    completion_tokens: number;
    total_tokens:      number;
  };
}

export interface PlaceholderInput {
  prompt:        string;
  context?:      Record<string, unknown>;
  system_prompt?: string;
}

export interface PlaceholderCandidateOutput {
  name:        string;
  description: string;
  score:       number;
}

export interface PlaceholderEvidenceOutput {
  type:        string;
  content:     string;
  trust_level: 'L1' | 'L2' | 'L3' | 'L4';
  weight:      number;
}

export interface PlaceholderResult {
  text:       string;
  model:      string;
  raw:        OpenAIChatResponse;
  candidate?: PlaceholderCandidateOutput;
  evidence?:  PlaceholderEvidenceOutput;
}

function deterministicScore(prompt: string, floor: number, ceil: number): number {
  const hash = prompt.split('').reduce((h, c) => ((h * 31) ^ c.charCodeAt(0)) >>> 0, 5381);
  const range = ceil - floor;
  return parseFloat((floor + (hash % 1000) / 1000 * range).toFixed(4));
}

export function invokeLlmPlaceholder(
  input:      PlaceholderInput,
  config:     Record<string, unknown>,
  outputRole: 'candidate' | 'evidence'
): PlaceholderResult {
  const model   = (config.model as string) ?? 'gpt-4o-placeholder';
  const prompt  = input.prompt;
  const score   = deterministicScore(prompt, 0.60, 0.92);
  const summary = prompt.slice(0, 80);

  const responseText = outputRole === 'candidate'
    ? `[LLM-PLACEHOLDER] 候选方案分析：针对「${summary}」推荐执行路径，综合评分 ${score.toFixed(2)}`
    : `[LLM-PLACEHOLDER] 证据信号：「${summary}」模型置信度 ${score.toFixed(2)}，来源 ${model}`;

  const raw: OpenAIChatResponse = {
    id:     `chatcmpl-ph-${deterministicScore(prompt, 0, 1e9).toString(16)}`,
    object: 'chat.completion',
    model,
    choices: [{
      index:         0,
      message:       { role: 'assistant', content: responseText },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens:     Math.ceil(prompt.length / 4),
      completion_tokens: 48,
      total_tokens:      Math.ceil(prompt.length / 4) + 48,
    },
  };

  if (outputRole === 'candidate') {
    return {
      text: responseText, model, raw,
      candidate: {
        name:        `llm-${model.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30)}-pack`,
        description: responseText,
        score,
      },
    };
  }

  return {
    text: responseText, model, raw,
    // LLM output is L3 by default: heuristic/model output, not authoritative
    evidence: {
      type:        'signal',
      content:     responseText,
      trust_level: 'L3',
      weight:      score,
    },
  };
}

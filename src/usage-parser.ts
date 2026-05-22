import { readFile } from "node:fs/promises";

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * cacheRead / (input + cacheCreation + cacheRead).
   * Fraction of input-side tokens that were served from cache.
   * 0 when there is no input traffic at all.
   */
  cacheHitRatio: number;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AssistantLine {
  type?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    usage?: RawUsage;
  };
}

/**
 * Parses a Claude Code session transcript JSONL and aggregates main-agent
 * token usage. Parallel tool calls within one turn share `message.id` and are
 * deduplicated. Returns undefined if no usable usage entries are found.
 */
export async function parseTranscriptUsage(
  transcriptPath: string
): Promise<UsageStats | undefined> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return undefined;
  }

  return aggregateUsage(raw);
}

export function aggregateUsage(jsonl: string): UsageStats | undefined {
  const seenIds = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let counted = 0;

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const entry = parseLine(line);
    if (!isMainAssistantEntry(entry)) {
      continue;
    }
    const msgId = entry.message?.id;
    const usage = entry.message?.usage;
    if (!usage) {
      continue;
    }
    if (msgId !== undefined) {
      if (seenIds.has(msgId)) {
        continue;
      }
      seenIds.add(msgId);
    }
    inputTokens += usage.input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
    cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    counted += 1;
  }

  if (counted === 0) {
    return undefined;
  }

  const totalInputSide = inputTokens + cacheCreationTokens + cacheReadTokens;
  const cacheHitRatio = totalInputSide > 0 ? cacheReadTokens / totalInputSide : 0;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRatio,
  };
}

function parseLine(line: string): AssistantLine | undefined {
  try {
    return JSON.parse(line) as AssistantLine;
  } catch {
    return undefined;
  }
}

function isMainAssistantEntry(entry: AssistantLine | undefined): entry is AssistantLine {
  if (!entry) {
    return false;
  }
  if (entry.type !== "assistant") {
    return false;
  }
  if (entry.isSidechain === true) {
    return false;
  }

  return true;
}

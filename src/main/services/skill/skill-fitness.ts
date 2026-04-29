/**
 * Skill Fitness Function for GEPA Evolution
 *
 * Implements the three-dimensional fitness metric (process compliance,
 * result correctness, conciseness) using LLM-as-judge evaluation.
 * Used by both GEPA and MIPROv2 optimizers as the metric function.
 */

import type { FitnessScore } from '../../../shared/skill/skill-evolution-types';

/** Arguments for the fitness evaluation */
export interface FitnessEvaluationInput {
  skillInstructions: string;
  taskInput: string;
  output: string;
  expectedOutput?: string;
}

/**
 * Evaluate a single fitness dimension using a simple heuristic approach.
 *
 * For V1, we use a rule-based scoring that looks at structural indicators
 * rather than calling an external LLM. This avoids extra API costs and
 * keeps the evaluation fast. The GEPA optimizer still benefits from the
 * relative ranking between prompt variants.
 *
 * When an external LLM is available and configured, this can be upgraded
 * to use LLM-as-judge for more nuanced evaluation.
 */
export function evaluateFitness(input: FitnessEvaluationInput): FitnessScore {
  const { skillInstructions, taskInput, output } = input;

  const processCompliance = scoreProcessCompliance(skillInstructions, output);
  const resultCorrectness = scoreResultCorrectness(output, input.expectedOutput);
  const conciseness = scoreConciseness(skillInstructions, output, taskInput);
  const overall = processCompliance * 0.4 + resultCorrectness * 0.4 + conciseness * 0.2;

  return {
    processCompliance,
    resultCorrectness,
    conciseness,
    overall,
  };
}

/**
 * Process compliance: Does the output follow the structure/patterns
 * described in the skill instructions?
 */
function scoreProcessCompliance(instructions: string, output: string): number {
  if (!output || output.trim().length === 0) return 0;

  let score = 0.5;

  // Check if output references tools or patterns mentioned in instructions
  const instructionKeywords = extractKeywords(instructions);
  const outputKeywords = extractKeywords(output);
  const overlap = instructionKeywords.filter((k) => outputKeywords.includes(k));
  if (instructionKeywords.length > 0) {
    score += 0.3 * Math.min(overlap.length / Math.max(instructionKeywords.length, 1), 1);
  }

  // Check for structured output patterns (lists, steps, headers)
  const hasStructure = /[\n#\-*>1.]\s/.test(output);
  if (hasStructure) score += 0.1;

  // Penalize if output is just echoing instructions
  if (similarity(instructions, output) > 0.8) score -= 0.3;

  return clamp(score);
}

/**
 * Result correctness: Is the output substantive and coherent?
 * When an expected output is provided, measures similarity to it.
 */
function scoreResultCorrectness(output: string, expected?: string): number {
  if (!output || output.trim().length === 0) return 0;

  if (expected) {
    return similarity(output, expected);
  }

  let score = 0.5;

  // Substantive output (not just a few words)
  if (output.length > 50) score += 0.2;
  if (output.length > 100) score += 0.1;

  // Coherent (no repeated chunks, no obvious errors)
  const words = output.split(/\s+/);
  const uniqueWords = new Set(words.map((w) => w.toLowerCase()));
  if (words.length > 0) {
    const uniqueness = uniqueWords.size / words.length;
    score += 0.2 * uniqueness;
  }

  return clamp(score);
}

/**
 * Conciseness: Is the output appropriately concise relative to the task?
 */
function scoreConciseness(instructions: string, output: string, taskInput: string): number {
  if (!output || output.trim().length === 0) return 0;

  const outputLen = output.length;
  const inputLen = taskInput.length + instructions.length;

  // Ideal output length: roughly 0.5-3x the combined input length
  const ratio = outputLen / Math.max(inputLen, 1);

  if (ratio >= 0.3 && ratio <= 3) return 0.8 + 0.2 * (1 - Math.abs(ratio - 1));
  if (ratio < 0.1) return 0.3; // Too short
  if (ratio > 5) return 0.3; // Too verbose
  if (ratio < 0.3) return 0.6;
  return 0.6;
}

/** Extract significant keywords from text */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'shall',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'between',
    'out',
    'off',
    'over',
    'under',
    'again',
    'further',
    'then',
    'once',
    'and',
    'but',
    'or',
    'nor',
    'not',
    'so',
    'yet',
    'both',
    'either',
    'neither',
    'each',
    'every',
    'all',
    'any',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'no',
    'only',
    'own',
    'same',
    'than',
    'too',
    'very',
    'just',
    'because',
    'this',
    'that',
    'these',
    'those',
    'it',
    'its',
    'i',
    'me',
    'my',
    'you',
    'your',
    'he',
    'him',
    'his',
    'she',
    'her',
    'we',
    'us',
    'our',
    'they',
    'them',
    'their',
    'what',
    'which',
    'who',
    'whom',
    'how',
    'when',
    'where',
    'why',
    'if',
    'then',
    'else',
    'about',
    'up',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

/** Simple Jaccard word-overlap similarity between two texts */
function similarity(a: string, b: string): number {
  const wordsA = new Set(extractKeywords(a));
  const wordsB = new Set(extractKeywords(b));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  Array.from(wordsA).forEach((w) => {
    if (wordsB.has(w)) intersection++;
  });

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Batch evaluate fitness for multiple inputs.
 * Returns the average fitness score across all inputs.
 */
export function batchEvaluateFitness(inputs: FitnessEvaluationInput[]): FitnessScore {
  if (inputs.length === 0) {
    return { processCompliance: 0, resultCorrectness: 0, conciseness: 0, overall: 0 };
  }

  const scores = inputs.map(evaluateFitness);
  const avg = (fn: (s: FitnessScore) => number) =>
    scores.reduce((sum, s) => sum + fn(s), 0) / scores.length;

  return {
    processCompliance: avg((s) => s.processCompliance),
    resultCorrectness: avg((s) => s.resultCorrectness),
    conciseness: avg((s) => s.conciseness),
    overall: avg((s) => s.overall),
  };
}

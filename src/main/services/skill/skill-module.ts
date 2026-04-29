/**
 * DSPy Skill Module for GEPA/MIPROv2 Optimization
 *
 * Wraps a skill's system_prompt as a DSPy-compatible module that can be
 * optimized by GEPA or MIPROv2. The skill_instructions field is the
 * trainable parameter — GEPA evolves this text through multi-round
 * Pareto-optimal selection.
 *
 * Uses @jaex/dstsx (DSPy TypeScript port) for all DSPy primitives.
 */

import {
  Predict,
  ChainOfThought,
  Example,
  type Module,
  type Metric,
  type Prediction,
} from '@jaex/dstsx';
import type { FitnessScore } from '../../../shared/skill/skill-evolution-types';
import { evaluateFitness, type FitnessEvaluationInput } from './skill-fitness';

/** Signature for skill execution: given instructions and task, produce output */
const SKILL_SIGNATURE = 'skill_instructions, task_input -> output';

/**
 * Create a DSPy-compatible skill module with the given instructions.
 *
 * The module uses ChainOfThought for better reasoning before output.
 * The `skill_instructions` field is what GEPA optimizes.
 */
export function createSkillModule(skillInstructions: string, useChainOfThought = true): Module {
  const ModuleClass = useChainOfThought ? ChainOfThought : Predict;
  const module = new ModuleClass(SKILL_SIGNATURE);

  // Set the instructions as the system prompt
  if (module instanceof Predict) {
    module.instructions = skillInstructions;
  }

  return module;
}

/**
 * Build an Example dataset from usage records for GEPA training.
 *
 * Each usage record becomes an Example with:
 * - task_input: the user context from the session
 * - output: the agent's response summary
 * - skill_instructions: current skill prompt
 */
export function buildExamplesFromUsage(
  usageRecords: Array<{
    userContext: string;
    agentResponseSummary: string;
    processCompliance: number | null;
    resultCorrectness: number | null;
  }>,
  currentInstructions: string,
): Example[] {
  return usageRecords
    .filter((r) => r.userContext && r.agentResponseSummary)
    .map(
      (r) =>
        new Example({
          skill_instructions: currentInstructions,
          task_input: r.userContext,
          output: r.agentResponseSummary,
        }),
    );
}

/**
 * Split examples into train/val/holdout sets (70/15/15).
 */
export function splitExamples(examples: Example[]): {
  train: Example[];
  val: Example[];
  holdout: Example[];
} {
  const shuffled = [...examples].sort(() => Math.random() - 0.5);
  const n = shuffled.length;
  const trainEnd = Math.floor(n * 0.7);
  const valEnd = Math.floor(n * 0.85);

  return {
    train: shuffled.slice(0, trainEnd),
    val: shuffled.slice(trainEnd, valEnd),
    holdout: shuffled.slice(valEnd),
  };
}

/**
 * The metric function used by GEPA/MIPROv2.
 *
 * Evaluates how well a skill's output matches expectations using the
 * three-dimensional fitness scoring (process compliance, result correctness,
 * conciseness).
 */
export function createSkillFitnessMetric(examples: Example[]): Metric {
  // Build a lookup of expected outputs from the training examples
  const expectedOutputs = new Map<string, string>();
  for (const ex of examples) {
    const taskInput = String(ex.get('task_input') || '');
    const output = String(ex.get('output') || '');
    if (taskInput) {
      expectedOutputs.set(taskInput, output);
    }
  }

  const metric: Metric = (example: Example, prediction: Prediction): number => {
    const taskInput = String(example.get('task_input') || '');
    const output = String(prediction.get('output') || '');
    const skillInstructions = String(prediction.get('skill_instructions') || '');

    const evalInput: FitnessEvaluationInput = {
      skillInstructions,
      taskInput,
      output,
      expectedOutput: expectedOutputs.get(taskInput),
    };

    const score = evaluateFitness(evalInput);
    return score.overall;
  };

  return metric;
}

/**
 * Evaluate a skill module on a dataset and return fitness scores.
 */
export async function evaluateSkillModule(
  module: Module,
  examples: Example[],
): Promise<FitnessScore> {
  if (examples.length === 0) {
    return { processCompliance: 0, resultCorrectness: 0, conciseness: 0, overall: 0 };
  }

  const evalInputs: FitnessEvaluationInput[] = [];

  for (const ex of examples) {
    try {
      const result = await module.forward({
        task_input: ex.get('task_input'),
        skill_instructions: ex.get('skill_instructions'),
      });

      const prediction = result instanceof Array ? result[0] : result;
      const output = String(prediction?.get?.('output') || '');

      evalInputs.push({
        skillInstructions: String(ex.get('skill_instructions') || ''),
        taskInput: String(ex.get('task_input') || ''),
        output,
        expectedOutput: String(ex.get('output') || ''),
      });
    } catch {
      evalInputs.push({
        skillInstructions: String(ex.get('skill_instructions') || ''),
        taskInput: String(ex.get('task_input') || ''),
        output: '',
        expectedOutput: String(ex.get('output') || ''),
      });
    }
  }

  const { batchEvaluateFitness } = await import('./skill-fitness');
  return batchEvaluateFitness(evalInputs);
}

/**
 * Extract the optimized instructions from a GEPA-compiled module.
 *
 * After GEPA.compile(), the module's `instructions` field contains the
 * evolved prompt text.
 */
export function extractOptimizedInstructions(module: Module): string {
  if (module instanceof Predict && module.instructions) {
    return module.instructions;
  }
  // Walk sub-predictors
  const predictors = module.namedPredictors();
  for (const [, pred] of predictors) {
    if (pred instanceof Predict && pred.instructions) {
      return pred.instructions;
    }
  }
  return '';
}

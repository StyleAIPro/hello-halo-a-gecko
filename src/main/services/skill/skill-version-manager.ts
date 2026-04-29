/**
 * Skill Version Manager
 *
 * Manages skill version snapshots for rollback and history tracking.
 * Each time a skill is auto-evolved or manually confirmed, a snapshot
 * is saved with the full system_prompt and fitness scores.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { v4 as uuid } from 'uuid';
import type {
  SkillVersionSnapshot,
  FitnessScore,
} from '../../../shared/skill/skill-evolution-types';
import type { EvolutionStore } from './evolution-store';
import { SkillManager } from './skill-manager';

export class SkillVersionManager {
  private static instance: SkillVersionManager;
  private store: EvolutionStore;

  private constructor(store: EvolutionStore) {
    this.store = store;
  }

  static getInstance(): SkillVersionManager | undefined {
    return SkillVersionManager.instance;
  }

  static initialize(store: EvolutionStore): SkillVersionManager {
    if (!SkillVersionManager.instance) {
      SkillVersionManager.instance = new SkillVersionManager(store);
    }
    return SkillVersionManager.instance;
  }

  /**
   * Create an initial version snapshot for a skill (if none exists).
   */
  async createInitialSnapshot(skillId: string): Promise<SkillVersionSnapshot | null> {
    const existing = this.store.getVersionHistory(skillId, 1);
    if (existing.length > 0) return null;

    const skill = SkillManager.getInstance()?.getSkill(skillId);
    if (!skill) return null;

    return this.createSnapshot({
      skillId,
      systemPrompt: skill.spec.system_prompt || '',
      fitnessScore: null,
      reason: 'initial',
    });
  }

  /**
   * Create a version snapshot before applying a change.
   */
  async createSnapshot(params: {
    skillId: string;
    systemPrompt: string;
    fitnessScore: FitnessScore | null;
    reason: SkillVersionSnapshot['reason'];
    relatedSuggestionId?: string;
  }): Promise<SkillVersionSnapshot> {
    const history = this.store.getVersionHistory(params.skillId);
    const versionNum = history.length + 1;

    const snapshot: SkillVersionSnapshot = {
      id: uuid(),
      skillId: params.skillId,
      version: `v${versionNum}`,
      systemPrompt: params.systemPrompt,
      fitnessScore: params.fitnessScore,
      createdAt: new Date().toISOString(),
      reason: params.reason,
      relatedSuggestionId: params.relatedSuggestionId,
    };

    this.store.saveVersionSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Apply a new system_prompt to a skill, creating a snapshot first.
   */
  async applyVersion(
    skillId: string,
    newPrompt: string,
    reason: SkillVersionSnapshot['reason'],
    fitnessScore: FitnessScore | null,
    relatedSuggestionId?: string,
  ): Promise<SkillVersionSnapshot> {
    const skillManager = SkillManager.getInstance();
    const skill = skillManager?.getSkill(skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);

    // Snapshot current version before change
    const snapshot = await this.createSnapshot({
      skillId,
      systemPrompt: newPrompt,
      fitnessScore,
      reason,
      relatedSuggestionId,
    });

    // Apply the new prompt
    const baseDir = skillManager!.getSkillBaseDir(skillId);
    const skillDir = path.join(baseDir, skillId);

    // Update SKILL.md or SKILL.yaml
    const mdFile = path.join(skillDir, 'SKILL.md');
    const yamlFile = path.join(skillDir, 'SKILL.yaml');

    try {
      await fs.access(mdFile);
      await this.updateSkillMd(mdFile, skillId, newPrompt);
    } catch {
      try {
        await fs.access(yamlFile);
        await this.updateSkillYaml(yamlFile, newPrompt);
      } catch {
        throw new Error(`No SKILL.md or SKILL.yaml found for ${skillId}`);
      }
    }

    // Refresh skill manager cache
    await skillManager!.refresh();

    return snapshot;
  }

  /**
   * Rollback a skill to a specific version snapshot.
   */
  async rollback(skillId: string, versionId: string): Promise<SkillVersionSnapshot> {
    const history = this.store.getVersionHistory(skillId);
    const target = history.find((h) => h.id === versionId);
    if (!target) throw new Error(`Version not found: ${versionId}`);

    const snapshot = await this.applyVersion(
      skillId,
      target.systemPrompt,
      'rollback',
      target.fitnessScore,
    );

    return snapshot;
  }

  /**
   * Get version history for a skill.
   */
  getVersionHistory(skillId: string, limit?: number): SkillVersionSnapshot[] {
    return this.store.getVersionHistory(skillId, limit);
  }

  /**
   * Get the latest version for a skill.
   */
  getLatestVersion(skillId: string): SkillVersionSnapshot | null {
    return this.store.getLatestVersion(skillId);
  }

  /**
   * Update SKILL.md with new system_prompt body (preserving frontmatter).
   */
  private async updateSkillMd(filePath: string, skillId: string, newPrompt: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

    if (frontmatterMatch) {
      const body = newPrompt;
      const updated = `${frontmatterMatch[0]}\n${body}`;
      await fs.writeFile(filePath, updated, 'utf-8');
    } else {
      await fs.writeFile(filePath, newPrompt, 'utf-8');
    }
  }

  /**
   * Update SKILL.yaml with new system_prompt.
   */
  private async updateSkillYaml(filePath: string, newPrompt: string): Promise<void> {
    const { parse: parseYaml, stringify: stringifyYaml } = await import('yaml');
    const content = await fs.readFile(filePath, 'utf-8');
    const spec = parseYaml(content) as Record<string, unknown>;
    spec.system_prompt = newPrompt;
    await fs.writeFile(filePath, stringifyYaml(spec), 'utf-8');
  }
}

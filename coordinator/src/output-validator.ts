import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logEvent } from './queue';
import { tasksDir } from './paths';

const TASKS_DIR = tasksDir();

const VALID_EFFORT_SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const VALID_MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6'];
// Mirrors Claude Code's --effort flag values. 'low' is unused in our codebase
// (PM/UX/QA defaults are medium+), but accepting it keeps validation consistent
// with the CLI surface. 'xhigh' is no longer accepted — PM should emit max for
// XL/L+ instead. session-manager normalizes any legacy xhigh to max at call time.
const VALID_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function readJSON(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Validate PM agent output after research phase.
 */
export function validatePmOutput(taskId: string): ValidationResult {
  const errors: string[] = [];
  const ctxPath = join(TASKS_DIR, taskId, 'context.json');
  const ctx = readJSON(ctxPath);

  if (!ctx) {
    errors.push('context.json is missing or not valid JSON');
    return { valid: false, errors };
  }

  // Check research
  if (!ctx.research || !ctx.research.summary) {
    errors.push('Missing research.summary in context.json');
  }
  if (!ctx.research?.title || ctx.research.title.length === 0) {
    errors.push('Missing research.title in context.json — provide a concise task title (max 60 chars)');
  } else if (ctx.research.title.length > 80) {
    errors.push(`research.title is too long (${ctx.research.title.length} chars) — must be max 60 chars`);
  }

  // Check effort
  if (!ctx.effort) {
    errors.push('Missing effort object in context.json');
  } else {
    if (!VALID_EFFORT_SIZES.includes(ctx.effort.size)) {
      errors.push(`Invalid effort.size "${ctx.effort.size}" — must be one of: ${VALID_EFFORT_SIZES.join(', ')}`);
    }
    if (!VALID_MODELS.includes(ctx.effort.dev_model)) {
      errors.push(`Invalid effort.dev_model "${ctx.effort.dev_model}" — must be one of: ${VALID_MODELS.join(', ')}`);
    }
    if (!VALID_MODELS.includes(ctx.effort.reviewer_model)) {
      errors.push(`Invalid effort.reviewer_model "${ctx.effort.reviewer_model}" — must be one of: ${VALID_MODELS.join(', ')}`);
    }
    if (!VALID_EFFORT_LEVELS.includes(ctx.effort.dev_effort)) {
      errors.push(`Invalid effort.dev_effort "${ctx.effort.dev_effort}" — must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
    }
    if (!VALID_EFFORT_LEVELS.includes(ctx.effort.reviewer_effort)) {
      errors.push(`Invalid effort.reviewer_effort "${ctx.effort.reviewer_effort}" — must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
    }
    if (typeof ctx.effort.estimated_turns !== 'number' || ctx.effort.estimated_turns < 1) {
      errors.push('effort.estimated_turns must be a positive number');
    }
  }

  // Check design brief
  if (!ctx.effort?.skip_design && !ctx.design_brief) {
    errors.push('Missing design_brief in context.json (set effort.skip_design: true to skip)');
  }

  // Check context-pack.md — the digest dev/UX read instead of raw skills files.
  // Required for ALL tasks (UI or not) so dev has a focused per-task brief.
  const contextPackPath = join(TASKS_DIR, taskId, 'context-pack.md');
  if (!existsSync(contextPackPath)) {
    errors.push('Missing tasks/{TASK_ID}/context-pack.md — write per-task digest before handoff (see pm-agent.md step 3)');
  } else {
    const pack = readFileSync(contextPackPath, 'utf-8');
    const requiredHeadings = ['## What', '## Why', '## Affected Scope', '## Research Summary', '## Relevant Guides', '## Implementation Notes'];
    for (const h of requiredHeadings) {
      if (!pack.includes(h)) {
        errors.push(`context-pack.md missing required heading: ${h}`);
      }
    }
    if (pack.trim().length < 200) {
      errors.push('context-pack.md is too short (< 200 chars) — it needs to be a complete per-task brief');
    }
  }

  if (errors.length > 0) {
    logEvent(taskId, 'validator', 'pm_invalid', errors.join('; '));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate UX agent output after design phase.
 *
 * The designer's output is now high-fidelity HTML wireframes plus an
 * `index.json` that lists them. We require the index to exist, parse, and
 * point at ≥1 HTML file that's actually on disk.
 */
export function validateUxOutput(taskId: string): ValidationResult {
  const errors: string[] = [];
  const wireframesDir = join(TASKS_DIR, taskId, 'wireframes');
  const indexPath = join(wireframesDir, 'index.json');

  if (!existsSync(indexPath)) {
    errors.push('wireframes/index.json not created');
    return { valid: false, errors };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
  } catch (err: any) {
    errors.push(`wireframes/index.json failed to parse: ${err.message}`);
    return { valid: false, errors };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.screens)) {
    errors.push('wireframes/index.json missing required "screens" array');
    return { valid: false, errors };
  }

  if (parsed.screens.length === 0) {
    errors.push('wireframes/index.json has empty screens list');
  }

  for (const screen of parsed.screens) {
    if (!screen?.id || !screen?.file) {
      errors.push(`screen entry missing id/file: ${JSON.stringify(screen)}`);
      continue;
    }
    const htmlPath = join(wireframesDir, screen.file);
    if (!existsSync(htmlPath)) {
      errors.push(`screen "${screen.id}" references missing file: ${screen.file}`);
    }
  }

  if (errors.length > 0) {
    logEvent(taskId, 'validator', 'ux_invalid', errors.join('; '));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate Dev agent output after development phase.
 */
export function validateDevOutput(taskId: string): ValidationResult {
  const errors: string[] = [];
  const ctxPath = join(TASKS_DIR, taskId, 'context.json');
  const summaryPath = join(TASKS_DIR, taskId, 'implementation-summary.md');

  const ctx = readJSON(ctxPath);
  if (!ctx) {
    errors.push('context.json is missing or not valid JSON');
  } else if (!ctx.DEV_COMPLETE) {
    errors.push('DEV_COMPLETE not set to true in context.json');
  }

  if (!existsSync(summaryPath)) {
    errors.push('implementation-summary.md not created');
  }

  if (errors.length > 0) {
    logEvent(taskId, 'validator', 'dev_invalid', errors.join('; '));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate Reviewer agent output after review phase.
 */
export function validateReviewerOutput(taskId: string): ValidationResult {
  const errors: string[] = [];
  const reviewPath = join(TASKS_DIR, taskId, 'review.md');

  if (!existsSync(reviewPath)) {
    errors.push('review.md not created');
    return { valid: false, errors };
  }

  const content = readFileSync(reviewPath, 'utf-8');
  if (!content.includes('APPROVE') && !content.includes('REQUEST_CHANGES')) {
    errors.push('review.md must contain either "APPROVE" or "REQUEST_CHANGES"');
  }

  if (errors.length > 0) {
    logEvent(taskId, 'validator', 'reviewer_invalid', errors.join('; '));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate QA agent output. qa-report.md must exist with a clear PASS or FAIL
 * header. On FAIL, qa-failure.json is required with at minimum a failing_step
 * and expected/actual fields so downstream fix tasks have structured context.
 */
export function validateQAOutput(taskId: string): ValidationResult {
  const errors: string[] = [];
  const reportPath = join(TASKS_DIR, taskId, 'qa-report.md');
  const failurePath = join(TASKS_DIR, taskId, 'qa-failure.json');

  if (!existsSync(reportPath)) {
    errors.push('qa-report.md not created');
    return { valid: false, errors };
  }

  const report = readFileSync(reportPath, 'utf-8');
  const passed = /QA Report\s*[—-]\s*PASS/i.test(report);
  const failed = /QA Report\s*[—-]\s*FAIL/i.test(report);

  if (!passed && !failed) {
    errors.push('qa-report.md must start with either "# QA Report — PASS" or "# QA Report — FAIL"');
  }

  if (failed) {
    if (!existsSync(failurePath)) {
      errors.push('qa-report.md declares FAIL but qa-failure.json is missing');
    } else {
      const fail = readJSON(failurePath);
      if (!fail) {
        errors.push('qa-failure.json is not valid JSON');
      } else {
        const required = ['category', 'failing_step', 'expected', 'actual'];
        for (const field of required) {
          if (!fail[field] || typeof fail[field] !== 'string') {
            errors.push(`qa-failure.json missing required string field: ${field}`);
          }
        }
        const validCategories = ['assertion_failed', 'login_failed', 'staging_error', 'visual_regression', 'unknown'];
        if (fail.category && !validCategories.includes(fail.category)) {
          errors.push(`qa-failure.json has invalid category "${fail.category}" — must be one of: ${validCategories.join(', ')}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    logEvent(taskId, 'validator', 'qa_invalid', errors.join('; '));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Build a retry prompt that tells the agent what was wrong with its output.
 */
export function buildValidationRetryPrompt(errors: string[]): string {
  return `YOUR PREVIOUS OUTPUT FAILED VALIDATION. Fix the following issues:\n\n${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nRe-read the task context and produce corrected output.`;
}

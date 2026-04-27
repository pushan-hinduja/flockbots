import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { LinearClient } from '@linear/sdk';
import { listInstanceSlugs, instancesDir } from '../paths';
import { help } from './brand';
import type { WizardConfig } from './wizard';

type ClackModule = typeof import('@clack/prompts');

interface LinearDefaults {
  apiKey?: string;
  teamId?: string;
  projectId?: string;
}

/**
 * Linear setup step — API key, team, and project. Multi-instance: each
 * instance gets its own project so issues created here don't collide with
 * a sibling instance's queue. Block (team_id, project_id) duplicates.
 *
 * Different teams across instances are allowed (intentional — sometimes a
 * separate Linear team makes sense for unrelated repos).
 *
 * defaults pre-populates prompts when reconfiguring or pre-filling from a
 * sibling instance's existing values.
 */
export async function askLinear(
  p: ClackModule,
  defaults: LinearDefaults = {},
  currentSlug?: string,
): Promise<Partial<WizardConfig> | null> {
  const enable = await p.confirm({
    message: 'Sync tasks from Linear? (optional — CLI + chat always work)',
    initialValue: !!defaults.apiKey,
  });
  if (p.isCancel(enable)) return null;
  if (!enable) return {};

  p.note(
    help([
      '1. In Linear: Settings → API → Personal API keys',
      '2. Create a key named "FlockBots"',
      '3. Copy the key (starts with lin_api_)',
    ].join('\n')),
    'Linear API key'
  );
  const apiKey = await p.password({
    message: 'Linear API key:',
    validate: (v) => (v.startsWith('lin_api_') ? undefined : 'Expected lin_api_... prefix'),
  });
  if (p.isCancel(apiKey)) return null;

  const teamId = await p.text({
    message: 'Linear team ID (Settings → Teams → General → copy ID):',
    initialValue: defaults.teamId,
    validate: (v) => (v && v.length > 5 ? undefined : 'Required'),
  });
  if (p.isCancel(teamId)) return null;

  // Connect to Linear and list this team's existing projects.
  const client = new LinearClient({ apiKey: apiKey as string });
  let projectsList: { id: string; name: string }[] = [];
  const spin = p.spinner();
  spin.start('Loading Linear projects');
  try {
    const team = await client.team(teamId as string);
    const projects = await team.projects();
    projectsList = projects.nodes.map((proj) => ({ id: proj.id, name: proj.name }));
    spin.stop(`Found ${projectsList.length} project${projectsList.length === 1 ? '' : 's'} in this team`);
  } catch (err: any) {
    spin.stop(`Failed to load projects: ${err.message}`);
    return null;
  }

  const claimedFor = (projectId: string) =>
    findInstanceUsingLinearProject(projectId, teamId as string, currentSlug);

  const projectChoice = await p.select({
    message: 'Which Linear project should this instance write to?',
    options: [
      ...projectsList.map((proj) => {
        const claimed = claimedFor(proj.id);
        return {
          value: proj.id,
          label: proj.name,
          hint: claimed ? `in use by '${claimed}'` : undefined,
        };
      }),
      { value: '__create__', label: '+ Create a new project on this team' },
    ],
    initialValue: defaults.projectId && projectsList.some((p) => p.id === defaults.projectId)
      ? defaults.projectId
      : '__create__',
  });
  if (p.isCancel(projectChoice)) return null;

  let projectId: string;
  let projectName: string;

  if (projectChoice === '__create__') {
    const name = await p.text({
      message: 'Name for the new Linear project:',
      placeholder: currentSlug || 'flockbots-acme-app',
      validate: (v) => (v && v.trim().length >= 2 ? undefined : 'Required (≥2 chars)'),
    });
    if (p.isCancel(name)) return null;

    const createSpin = p.spinner();
    createSpin.start(`Creating project "${name}"`);
    try {
      const result = await client.createProject({
        teamIds: [teamId as string],
        name: (name as string).trim(),
      });
      const created = await result.project;
      if (!created) throw new Error('No project returned by Linear');
      projectId = created.id;
      projectName = created.name;
      createSpin.stop(`Created → ${projectName}`);
    } catch (err: any) {
      createSpin.stop(`Failed to create project: ${err.message}`);
      return null;
    }
  } else {
    projectId = projectChoice as string;
    projectName = projectsList.find((p) => p.id === projectId)?.name || '';
    const claimed = claimedFor(projectId);
    if (claimed) {
      const ok = await p.confirm({
        message: `Instance '${claimed}' already uses this project. Issues will collide. Continue anyway?`,
        initialValue: false,
      });
      if (p.isCancel(ok) || !ok) return null;
    }
  }

  return {
    linearApiKey: apiKey as string,
    linearTeamId: teamId as string,
    linearProjectId: projectId,
    linearProjectName: projectName,
  };
}

/**
 * Returns the slug of an existing instance that already claims (team_id,
 * project_id), or null if none. Skips currentSlug — the instance being
 * reconfigured doesn't conflict with itself.
 */
function findInstanceUsingLinearProject(
  projectId: string,
  teamId: string,
  currentSlug?: string,
): string | null {
  for (const slug of listInstanceSlugs()) {
    if (slug === currentSlug) continue;
    const envPath = join(instancesDir(), slug, '.env');
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      let team = '';
      let proj = '';
      for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/\r$/, '').trim();
        const m = line.match(/^(LINEAR_TEAM_ID|LINEAR_PROJECT_ID)\s*=\s*(.*)$/);
        if (!m) continue;
        let val = m[2].trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (m[1] === 'LINEAR_TEAM_ID') team = val;
        else proj = val;
      }
      if (team === teamId && proj === projectId && proj) return slug;
    } catch {
      // Skip unreadable .env
    }
  }
  return null;
}

/**
 * GitHub Search - Result Formatters
 *
 * Format GitHub API results for display in the AI agent.
 */

export function formatRepoResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No repositories found matching your query.';
  }

  const lines = data.map((repo, i) => {
    const parts = [
      `[${i + 1}] ${repo.fullName || repo.full_name}`,
      `    ${repo.description || 'No description'}`,
      `    ⭐ ${repo.stars || repo.stargazers_count || 0} | 🍴 ${repo.forks || repo.forks_count || 0} | ${repo.language || 'Unknown'}`,
      `    ${repo.url || repo.html_url}`,
    ];
    return parts.join('\n');
  });

  return `Found ${data.length} repositories:\n\n${lines.join('\n\n')}`;
}

export function formatIssueResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No issues found matching your query.';
  }

  const lines = data.map((issue, i) => {
    const labels = issue.labels?.map((l: any) => l.name || l).join(', ') || '';
    const parts = [
      `[${i + 1}] #${issue.number} ${issue.title}`,
      `    State: ${issue.state} | Author: ${issue.author?.login || issue.user?.login || 'Unknown'}`,
      labels ? `    Labels: ${labels}` : null,
      `    ${issue.url || issue.html_url}`,
    ].filter(Boolean);
    return parts.join('\n');
  });

  return `Found ${data.length} issues:\n\n${lines.join('\n\n')}`;
}

export function formatPrResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No pull requests found matching your query.';
  }

  const lines = data.map((pr, i) => {
    const draft = pr.isDraft || pr.draft ? ' [DRAFT]' : '';
    const merged = pr.isMerged || pr.merged ? ' [MERGED]' : '';
    const parts = [
      `[${i + 1}] #${pr.number} ${pr.title}${draft}${merged}`,
      `    State: ${pr.state} | Author: ${pr.author?.login || pr.user?.login || 'Unknown'}`,
      `    ${pr.head?.label || pr.headRefName} → ${pr.base?.label || pr.baseRefName}`,
      `    ${pr.url || pr.html_url}`,
    ];
    return parts.join('\n');
  });

  return `Found ${data.length} pull requests:\n\n${lines.join('\n\n')}`;
}

export function formatCodeResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No code results found matching your query.';
  }

  const lines = data.map((code, i) => {
    const parts = [
      `[${i + 1}] ${code.repository?.full_name || code.repository}: ${code.path}`,
      `    ${code.url || code.html_url}`,
    ];
    if (code.snippet) {
      parts.push(`    \`\`\`\n    ${code.snippet.split('\n').join('\n    ')}\n    \`\`\``);
    }
    return parts.join('\n');
  });

  return `Found ${data.length} code results:\n\n${lines.join('\n\n')}`;
}

export function formatCommitResults(data: any[]): string {
  if (!data || data.length === 0) {
    return 'No commits found matching your query.';
  }

  const lines = data.map((commit, i) => {
    const parts = [
      `[${i + 1}] ${commit.shortSha || commit.sha?.substring(0, 7)}`,
      `    ${commit.message?.split('\n')[0]}`,
      `    Author: ${commit.author?.login || commit.author_name || 'Unknown'}`,
      `    ${commit.url || commit.html_url}`,
    ];
    return parts.join('\n');
  });

  return `Found ${data.length} commits:\n\n${lines.join('\n\n')}`;
}

export function formatIssueView(data: any): string {
  const labels = data.labels?.map((l: any) => l.name || l).join(', ') || '';
  const assignees = data.assignees?.map((a: any) => a.login || a).join(', ') || '';

  const lines = [
    `## Issue #${data.number}: ${data.title}`,
    '',
    `**State:** ${data.state}`,
    `**Author:** ${data.author?.login || 'Unknown'}`,
    `**Created:** ${data.createdAt || data.created_at}`,
    labels ? `**Labels:** ${labels}` : null,
    assignees ? `**Assignees:** ${assignees}` : null,
    data.milestone?.title ? `**Milestone:** ${data.milestone.title}` : null,
    '',
    `**URL:** ${data.url || data.html_url}`,
    '',
    '---',
    '',
    data.body || '*No description provided*',
  ].filter(Boolean);

  return lines.join('\n');
}

export function formatPrView(data: any): string {
  const draft = data.isDraft || data.draft ? ' [DRAFT]' : '';
  const merged = data.merged ? ' [MERGED]' : '';
  const reviewers =
    data.reviewRequests?.nodes?.map((r: any) => r.requestedReviewer?.login || r.name).join(', ') ||
    data.reviewDecision ||
    '';

  const lines = [
    `## PR #${data.number}: ${data.title}${draft}${merged}`,
    '',
    `**State:** ${data.state}`,
    `**Author:** ${data.author?.login || 'Unknown'}`,
    `**Branch:** ${data.headRefName || data.head?.ref} → ${data.baseRefName || data.base?.ref}`,
    `**Created:** ${data.createdAt || data.created_at}`,
    reviewers ? `**Reviewers:** ${reviewers}` : null,
    data.mergeable !== undefined ? `**Mergeable:** ${data.mergeable}` : null,
    '',
    `**URL:** ${data.url || data.html_url}`,
    '',
    '---',
    '',
    data.body || '*No description provided*',
  ].filter(Boolean);

  return lines.join('\n');
}

export function formatRepoView(data: any): string {
  const topics =
    data.repositoryTopics?.nodes?.map((t: any) => t.topic?.name || t).join(', ') ||
    data.topics?.join(', ') ||
    '';

  const lines = [
    `## ${data.nameWithOwner || data.full_name}`,
    '',
    data.description || '*No description*',
    '',
    `**Stars:** ${data.stargazerCount || data.stargazers_count || 0}`,
    `**Forks:** ${data.forkCount || data.forks_count || 0}`,
    `**Watchers:** ${data.watchers?.totalCount || data.watchers_count || 0}`,
    `**Open Issues:** ${data.issues?.totalCount || data.open_issues_count || 0}`,
    `**Language:** ${data.primaryLanguage?.name || data.language || 'Unknown'}`,
    `**License:** ${data.licenseInfo?.name || data.license?.spdx_id || 'None'}`,
    data.isPrivate !== undefined ? `**Private:** ${data.isPrivate ? 'Yes' : 'No'}` : null,
    topics ? `**Topics:** ${topics}` : null,
    '',
    `**Created:** ${data.createdAt || data.created_at}`,
    `**Last Updated:** ${data.updatedAt || data.updated_at}`,
    '',
    `**URL:** ${data.url || data.html_url}`,
    '',
    '---',
    '',
    data.readme ? `### README\n\n${data.readme}` : '*No README available*',
  ].filter(Boolean);

  return lines.join('\n');
}

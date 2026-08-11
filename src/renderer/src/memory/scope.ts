import type { Memory } from '@shared/api'

export interface ScopeInfo {
  key: string
  label: string
  title: string
  rank: number
  className: string
  description: string
}

const cleanScope = (scope: string): string => scope.trim().toLowerCase().replace(/[\s_-]+/g, '-')

const titleCase = (scope: string): string =>
  scope
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')

export function scopeInfo(scope: string): ScopeInfo {
  const normalized = cleanScope(scope)
  switch (normalized) {
    case 'session':
      return {
        key: 'session',
        label: 'Session',
        title: 'Session Memories',
        rank: 0,
        className: 'scope-session',
        description: 'Specific to the current session'
      }
    case 'branch':
      return {
        key: 'branch',
        label: 'Branch',
        title: 'Branch Memories',
        rank: 5,
        className: 'scope-branch',
        description: 'Specific to this branch'
      }
    case 'repo':
    case 'repository':
      return {
        key: 'repo',
        label: 'Repo',
        title: 'Repo Memories',
        rank: 10,
        className: 'scope-repo',
        description: 'Specific to this repository'
      }
    case 'space':
      return {
        key: 'repo',
        label: 'Space',
        title: 'Repo / Space Memories',
        rank: 10,
        className: 'scope-repo',
        description: 'Specific to this repo-backed Space'
      }
    case 'project':
      return {
        key: 'project',
        label: 'Project',
        title: 'Project Memories',
        rank: 20,
        className: 'scope-project',
        description: 'Shared across this project'
      }
    case 'workspace':
      return {
        key: 'workspace',
        label: 'Workspace',
        title: 'Workspace Memories',
        rank: 30,
        className: 'scope-workspace',
        description: 'Shared across this workspace'
      }
    case 'team':
    case 'org':
    case 'organization':
      return {
        key: 'organization',
        label: normalized === 'team' ? 'Team' : 'Org',
        title: normalized === 'team' ? 'Team Memories' : 'Organization Memories',
        rank: 40,
        className: 'scope-organization',
        description: 'Shared across a broader group'
      }
    case 'user':
    case 'global':
      return {
        key: 'user',
        label: 'User',
        title: 'User Memories',
        rank: 90,
        className: 'scope-user',
        description: 'User-level memory available across repos and Spaces'
      }
    default: {
      const label = titleCase(scope) || 'Other'
      const key = normalized || 'other'
      return {
        key,
        label,
        title: `${label} Memories`,
        rank: 50,
        className: 'scope-intermediate',
        description: 'Intermediate-scope memory'
      }
    }
  }
}

export function compareByScopeHierarchy(a: Memory, b: Memory): number {
  const aScope = scopeInfo(a.scope)
  const bScope = scopeInfo(b.scope)
  return aScope.rank - bScope.rank
}

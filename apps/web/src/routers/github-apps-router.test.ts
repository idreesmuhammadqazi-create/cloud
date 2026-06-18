import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';

type TestIntegration = {
  id: string;
  platform_installation_id: string;
  platform_account_login: string;
  github_app_type: GitHubAppType;
};

type InstallationDetails = {
  account: { id: number; login: string };
  permissions: Record<string, string>;
  events: string[];
  repository_selection: string;
  created_at: string;
};

const mockGetIntegrationForOwner =
  jest.fn<(owner: Owner, platform: string) => Promise<TestIntegration | null>>();
const mockUpsertPlatformIntegrationForOwner =
  jest.fn<(owner: Owner, details: Record<string, unknown>) => Promise<void>>();
const mockUpdateRepositoriesForIntegration =
  jest.fn<(integrationId: string, repositories: unknown[]) => Promise<void>>();
const mockFetchGitHubInstallationDetails =
  jest.fn<(installationId: string, appType: GitHubAppType) => Promise<InstallationDetails>>();
const mockFetchGitHubRepositories =
  jest.fn<(installationId: string, appType: GitHubAppType) => Promise<unknown[]>>();

const mockUpdateModel =
  jest.fn<(owner: Owner, modelSlug: string) => Promise<{ success: boolean; error?: string }>>();
const mockCreateAuditLog = jest.fn<(args: Record<string, unknown>) => Promise<unknown>>();

jest.mock('@/lib/integrations/github-apps-service', () => ({
  updateModel: (owner: Owner, modelSlug: string) => mockUpdateModel(owner, modelSlug),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (owner: Owner, platform: string) =>
    mockGetIntegrationForOwner(owner, platform),
  upsertPlatformIntegrationForOwner: (owner: Owner, details: Record<string, unknown>) =>
    mockUpsertPlatformIntegrationForOwner(owner, details),
  updateRepositoriesForIntegration: (integrationId: string, repositories: unknown[]) =>
    mockUpdateRepositoriesForIntegration(integrationId, repositories),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubInstallationDetails: (installationId: string, appType: GitHubAppType) =>
    mockFetchGitHubInstallationDetails(installationId, appType),
  fetchGitHubRepositories: (installationId: string, appType: GitHubAppType) =>
    mockFetchGitHubRepositories(installationId, appType),
}));

jest.mock('@/lib/organizations/organization-audit-logs', () => ({
  createAuditLog: (args: Record<string, unknown>) => mockCreateAuditLog(args),
}));

jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(async () => undefined),
}));

const ORG_ID = '00000000-0000-0000-0000-000000000001';

let createCaller: (ctx: { user: User }) => {
  refreshInstallation: (input?: { organizationId?: string }) => Promise<{ success: boolean }>;
  updateModel: (input: {
    organizationId?: string;
    modelSlug: string;
  }) => Promise<{ success: boolean; error?: string }>;
};

beforeAll(async () => {
  const mod = await import('./github-apps-router');
  createCaller = createCallerFactory(mod.githubAppsRouter);
});

describe('githubAppsRouter.refreshInstallation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIntegrationForOwner.mockResolvedValue({
      id: 'integration-1',
      platform_installation_id: '98765',
      platform_account_login: 'old-owner',
      github_app_type: 'standard',
    });
    mockFetchGitHubInstallationDetails.mockResolvedValue({
      account: { id: 123, login: 'renamed-owner' },
      permissions: {},
      events: [],
      repository_selection: 'all',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    mockFetchGitHubRepositories.mockResolvedValue([]);
    mockUpsertPlatformIntegrationForOwner.mockResolvedValue(undefined);
    mockUpdateRepositoriesForIntegration.mockResolvedValue(undefined);
  });

  it('persists the current account login returned by GitHub', async () => {
    const caller = createCaller({ user: { id: 'user-1' } as User });

    await caller.refreshInstallation();

    expect(mockUpsertPlatformIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      expect.objectContaining({ platformAccountLogin: 'renamed-owner' })
    );
  });

  it('does not clear stored identity when GitHub returns no current account login', async () => {
    mockFetchGitHubInstallationDetails.mockResolvedValue({
      account: { id: 0, login: '' },
      permissions: {},
      events: [],
      repository_selection: 'all',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });

    await expect(caller.refreshInstallation()).rejects.toThrow(
      'GitHub installation account identity unavailable'
    );

    expect(mockUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
  });
});

describe('githubAppsRouter.updateModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes the model via the service for a personal installation', async () => {
    mockUpdateModel.mockResolvedValue({ success: true });

    const caller = createCaller({ user: { id: 'user-1' } as User });
    const result = await caller.updateModel({ modelSlug: 'anthropic/claude-sonnet-4.5' });

    expect(result).toEqual({ success: true });
    expect(mockUpdateModel).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      'anthropic/claude-sonnet-4.5'
    );
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it('writes the model and records an audit log for an org installation', async () => {
    mockUpdateModel.mockResolvedValue({ success: true });

    const caller = createCaller({ user: { id: 'user-1' } as User });
    const result = await caller.updateModel({
      modelSlug: 'anthropic/claude-sonnet-4.5',
      organizationId: ORG_ID,
    });

    expect(result).toEqual({ success: true });
    expect(mockUpdateModel).toHaveBeenCalledWith(
      { type: 'org', id: ORG_ID },
      'anthropic/claude-sonnet-4.5'
    );
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: ORG_ID,
        message: 'Updated GitHub integration model to anthropic/claude-sonnet-4.5',
      })
    );
  });

  it('surfaces a service-level rejection without writing an audit log', async () => {
    mockUpdateModel.mockResolvedValue({
      success: false,
      error: 'Model is not allowed by organization policy',
    });

    const caller = createCaller({ user: { id: 'user-1' } as User });
    const result = await caller.updateModel({
      modelSlug: 'openai/gpt-5',
      organizationId: ORG_ID,
    });

    expect(result).toEqual({
      success: false,
      error: 'Model is not allowed by organization policy',
    });
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});

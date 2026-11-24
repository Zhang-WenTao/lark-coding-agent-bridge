import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import { canUseDm, type RuntimeControls } from '../../../src/policy/access';
import { publicDmLimits, restrictedChatGuard, ownerOnlyGuard, bridgeRoot } from '../../../src/policy/owner-guard';
import { createDefaultProfileConfig, normalizeProfileConfig } from '../../../src/config/profile-schema';

const controls: RuntimeControls = { botOwnerId: 'ou_owner', ownerRefreshState: 'ok' };
const msg = (senderId: string): NormalizedMessage => ({ senderId }) as NormalizedMessage;

function profile(publicDm?: unknown) {
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    mode: 'personal',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_listed'] },
  });
  return normalizeProfileConfig({ ...base, access: { ...base.access, publicDm } });
}

describe('access.publicDm', () => {
  it('keeps the private-chat allowlist while off or absent', () => {
    expect(canUseDm(profile(), controls, 'ou_anyone').ok).toBe(false);
    expect(canUseDm(profile({ enabled: false, deniedCommands: [] }), controls, 'ou_anyone').ok).toBe(false);
    expect(profile({ enabled: 'yes', deniedCommands: [] }).access.publicDm?.enabled).toBe(false);
  });

  it('opens private chats to everyone when on', () => {
    const p = profile({ enabled: true, deniedCommands: [] });
    expect(canUseDm(p, controls, 'ou_anyone')).toEqual({ ok: true, reason: 'allowed-public-dm' });
    expect(canUseDm(p, controls, 'ou_listed').reason).toBe('allowed-user');
    expect(canUseDm(p, controls, 'ou_owner').reason).toBe('owner');
  });

  it('fences every non-exempt private chat, allowlisted people included, with a per-chat workspace', () => {
    const p = profile({
      enabled: true,
      exemptUsers: ['ou_trusted'],
      deniedCommands: ['\\bgit\\s+commit\\b'],
      readOnlyPaths: ['~/Desktop/coding/lark/alphaess'],
      workspace: '~/.occam/public-dm',
      refusal: '只读',
    });
    const limits = publicDmLimits(p.access, [msg('ou_listed')], 'oc_dm1');
    expect(limits).toMatchObject({
      deniedCommands: ['\\bgit\\s+commit\\b'],
      readOnlyPaths: ['~/Desktop/coding/lark/alphaess'],
      workspace: '~/.occam/public-dm/oc_dm1',
      refusal: '只读',
    });
    expect(limits).not.toHaveProperty('enabled');
    expect(limits).not.toHaveProperty('exemptUsers');
    expect(publicDmLimits(p.access, [msg('ou_trusted')], 'oc_dm2')).toBeUndefined();
    expect(publicDmLimits(p.access, [msg('ou_trusted'), msg('ou_listed')], 'oc_dm2')).toBeDefined();
    expect(publicDmLimits(profile().access, [msg('ou_listed')], 'oc_dm1')).toBeUndefined();
  });

  it('turns a writable guest root read-only once the limits apply', () => {
    const HOME = '/Users/someone';
    const guest = ownerOnlyGuard({
      larkChannelHome: `${HOME}/.lark-channel`,
      guestRoots: ['~/Desktop/coding/lark/alphaess'],
      workspace: `${HOME}/.occam/public-dm/oc_dm1`,
      home: HOME,
      root: bridgeRoot(),
    });
    const fenced = restrictedChatGuard(guest, { deniedCommands: [], readOnlyPaths: ['~/Desktop/coding/lark/alphaess'] });
    expect(fenced.rules).toContainEqual({ path: `${HOME}/Desktop/coding/lark/alphaess`, bash: 'write' });
    expect(fenced.openDirs).toContainEqual({ path: `${HOME}/Desktop/coding/lark/alphaess`, readOnly: true });
  });

  it('lifts granted guest tools but keeps the chat own denials', () => {
    const HOME = '/Users/someone';
    const guest = ownerOnlyGuard({
      larkChannelHome: `${HOME}/.lark-channel`,
      deniedTools: ['mcp__jira__jira_add_comment', 'mcp__jira__jira_delete_issue', 'mcp__github__create_pull_request'],
      home: HOME,
      root: bridgeRoot(),
    });
    const fenced = restrictedChatGuard(guest, {
      deniedCommands: [],
      grantedTools: ['mcp__jira__jira_add_comment', 'mcp__jira__jira_delete_issue'],
      deniedTools: ['mcp__jira__jira_delete_issue'],
    });
    expect(fenced.deniedTools).not.toContain('mcp__jira__jira_add_comment');
    expect(fenced.deniedTools).toContain('mcp__jira__jira_delete_issue');
    expect(fenced.deniedTools).toContain('mcp__github__create_pull_request');
    expect(profile({ enabled: true, deniedCommands: [], grantedTools: ['x'] }).access.publicDm?.grantedTools).toEqual(['x']);
  });
});

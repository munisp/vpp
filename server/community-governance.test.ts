/**
 * Governance tests for energy-community membership.
 *
 * A community's members share a real allocation of money and energy, so who is
 * admitted is a governance decision. The service previously let the same caller
 * create a community and then insert itself with `role: 'admin'` — except the
 * insert stored `pending`, so a founder governed nothing and pool rules could
 * not be set at all. Now the founder is admitted by the creation itself, and
 * everyone else is admitted by an admin who already governs the community.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';

interface ExecuteResult {
  rows: Array<Record<string, unknown>>;
}

const executed: string[] = [];
let responder: (text: string) => ExecuteResult = () => ({ rows: [] });

/** Flatten a drizzle `sql` template back into matchable text. */
function textOf(query: SQL): string {
  const chunks = (
    query as unknown as { queryChunks?: Array<{ value?: unknown } | null | undefined> }
  ).queryChunks;
  return (chunks ?? [])
    .map(chunk => {
      const value = chunk === null || chunk === undefined ? undefined : chunk.value;
      return Array.isArray(value) ? value.join('') : '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const execute = async (query: SQL) => {
  const text = textOf(query);
  executed.push(text);
  return responder(text);
};

vi.mock('./db', () => ({
  getDb: async () => ({
    execute,
    transaction: async (fn: (tx: unknown) => unknown) => fn({ execute }),
  }),
}));

const { communityEnergy } = await import('./services/community-energy');

const memberRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  community_id: 3,
  user_id: 42,
  role: 'member',
  joined_at: new Date('2026-08-01T00:00:00.000Z'),
  contributed_capacity_kw: '5',
  share_percentage: null,
  auto_participate: true,
  priority_level: 5,
  status: 'pending',
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  updated_at: new Date('2026-08-01T00:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  executed.length = 0;
});

afterEach(() => {
  responder = () => ({ rows: [] });
});

describe('createCommunity', () => {
  it('admits its founder as an active admin in the same transaction', async () => {
    responder = text => {
      if (text.includes('INSERT INTO energy_communities')) return { rows: [{ id: 3 }] };
      if (text.includes('SELECT SUM(capacity)')) return { rows: [{ total: '9000' }] };
      if (text.includes('SELECT * FROM energy_communities')) {
        return { rows: [{ id: 3, community_code: 'EC-1', name: 'Kigamboni', status: 'forming' }] };
      }
      return { rows: [] };
    };

    await communityEnergy.createCommunity(
      { name: 'Kigamboni', communityType: 'residential' },
      42
    );

    const founder = executed.find(text => text.includes('INSERT INTO community_members'));
    expect(founder).toBeDefined();
    expect(founder).toContain("'admin'");
    expect(founder).toContain("'active'");
  });
});

describe('addMember', () => {
  it('records a join request as pending, never as an active member', async () => {
    responder = text => {
      if (text.startsWith('INSERT INTO community_members')) return { rows: [{ id: 7 }] };
      if (text.includes('SELECT * FROM community_members')) return { rows: [memberRow()] };
      return { rows: [] };
    };

    const member = await communityEnergy.addMember(3, 42, { role: 'member' });

    expect(member.status).toBe('pending');
    const insert = executed.find(text => text.startsWith('INSERT INTO community_members'));
    expect(insert).toContain("'pending'");
  });
});

describe('approveMember', () => {
  it('refuses a membership that does not exist', async () => {
    await expect(communityEnergy.approveMember(7, 1, false)).rejects.toThrow(/No community members/);
  });

  it('refuses an approver who does not govern the community', async () => {
    responder = text =>
      text.includes('SELECT * FROM community_members') ? { rows: [memberRow()] } : { rows: [] };

    await expect(communityEnergy.approveMember(7, 99, false)).rejects.toThrow(
      /active community admin/
    );
    expect(executed.some(text => text.startsWith('UPDATE community_members'))).toBe(false);
  });

  it('refuses to re-approve a membership that is not pending', async () => {
    responder = text => {
      if (text.includes('SELECT * FROM community_members')) {
        return { rows: [memberRow({ status: 'suspended' })] };
      }
      if (text.includes("role IN ('admin', 'operator')")) return { rows: [{ id: 1 }] };
      return { rows: [] };
    };

    await expect(communityEnergy.approveMember(7, 5, false)).rejects.toThrow(
      /suspended, not pending/
    );
    expect(executed.some(text => text.startsWith('UPDATE community_members'))).toBe(false);
  });

  it('admits a pending member on an active community admin’s authority', async () => {
    let status = 'pending';
    responder = text => {
      if (text.includes('SELECT * FROM community_members')) return { rows: [memberRow({ status })] };
      if (text.includes("role IN ('admin', 'operator')")) return { rows: [{ id: 1 }] };
      if (text.startsWith('UPDATE community_members')) {
        status = 'active';
        return { rows: [] };
      }
      return { rows: [] };
    };

    const admitted = await communityEnergy.approveMember(7, 5, false);

    expect(admitted.status).toBe('active');
    const update = executed.find(text => text.startsWith('UPDATE community_members'));
    expect(update).toContain("status = 'pending'");
  });

  it('lets a platform admin admit without querying community roles', async () => {
    let status = 'pending';
    responder = text => {
      if (text.includes('SELECT * FROM community_members')) return { rows: [memberRow({ status })] };
      if (text.startsWith('UPDATE community_members')) {
        status = 'active';
        return { rows: [] };
      }
      return { rows: [] };
    };

    const admitted = await communityEnergy.approveMember(7, 1, true);

    expect(admitted.status).toBe('active');
    expect(executed.some(text => text.includes("role IN ('admin', 'operator')"))).toBe(false);
  });
});

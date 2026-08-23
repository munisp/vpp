import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV_ICONS } from './nav-icons';
import {
  NAV_GROUPS,
  findNavItem,
  getNavGroups,
  groupIdForPath,
  readOpenGroups,
  searchNavItems,
  writeOpenGroups,
} from './nav';

function fakeStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set('sidebar-open-groups', initial);
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe('nav model', () => {
  it('routes each path exactly once', () => {
    const paths = NAV_GROUPS.flatMap(group => group.items.map(item => item.path));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('only links routes the router actually declares', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const routed = new Set(
      [...app.matchAll(/<Route\s+path=\{?"([^"]+)"/g)].map(match => match[1])
    );
    const unrouted = NAV_GROUPS.flatMap(group => group.items.map(item => item.path)).filter(
      path => !routed.has(path)
    );
    expect(unrouted).toEqual([]);
  });

  it('gives every linked route an icon', () => {
    const missing = NAV_GROUPS.flatMap(group => group.items.map(item => item.path)).filter(
      path => !NAV_ICONS[path]
    );
    expect(missing).toEqual([]);
  });

  it('pins one group only, so everything else can collapse', () => {
    const pinned = NAV_GROUPS.filter(group => group.pinned);
    expect(pinned.map(group => group.id)).toEqual(['primary']);
  });

  it('hides admin items and admin-only groups from members', () => {
    const member = getNavGroups('user');
    const memberPaths = member.flatMap(group => group.items.map(item => item.path));
    expect(memberPaths).not.toContain('/grid/ntl');
    expect(memberPaths).not.toContain('/admin');
    expect(member.map(group => group.id)).not.toContain('operations');

    const admin = getNavGroups('admin');
    const adminPaths = admin.flatMap(group => group.items.map(item => item.path));
    expect(adminPaths).toContain('/grid/ntl');
    expect(adminPaths).toContain('/grid/operations-wall');
  });

  it('never renders a group that filtered down to nothing', () => {
    for (const group of getNavGroups('user')) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('resolves the active item and its owning group', () => {
    const groups = getNavGroups('admin');
    expect(findNavItem(groups, '/market/order-book')?.label).toBe('Order Book');
    expect(groupIdForPath(groups, '/market/order-book')).toBe('market');
    expect(findNavItem(groups, '/nope')).toBeUndefined();
    expect(groupIdForPath(groups, '/nope')).toBeUndefined();
  });

  it('matches the filter on labels, keywords and paths', () => {
    const groups = getNavGroups('admin');
    expect(searchNavItems(groups, 'order').map(match => match.item.path)).toEqual([
      '/market/order-book',
    ]);
    // "noc" only appears as a keyword on the operations wall.
    expect(searchNavItems(groups, 'noc').map(match => match.item.path)).toEqual([
      '/grid/operations-wall',
    ]);
    expect(searchNavItems(groups, '/insights/').map(match => match.item.path)).toEqual([
      '/insights/advisor',
      '/insights/solar-yield',
      '/insights/battery-health',
      '/insights/carbon',
    ]);
    expect(searchNavItems(groups, '   ')).toEqual([]);
  });

  it('does not offer a member a match on an admin route', () => {
    expect(searchNavItems(getNavGroups('user'), 'noc')).toEqual([]);
  });

  it('reports the group of the current route, tagged with its heading', () => {
    const matches = searchNavItems(getNavGroups('admin'), 'battery');
    expect(matches.map(match => match.groupLabel)).toContain('Energy & insights');
  });

  describe('persisted expansion', () => {
    const groups = getNavGroups('admin');

    it('opens the group holding the current route when nothing is stored', () => {
      expect(readOpenGroups(fakeStorage(), groups, '/grid/ntl')).toEqual(['grid']);
    });

    it('keeps stored groups and still reveals the current route', () => {
      const open = readOpenGroups(fakeStorage(JSON.stringify(['market'])), groups, '/grid/ntl');
      expect(open).toEqual(['market', 'grid']);
    });

    it('does not duplicate the active group', () => {
      const open = readOpenGroups(fakeStorage(JSON.stringify(['grid'])), groups, '/grid/ntl');
      expect(open).toEqual(['grid']);
    });

    it('drops ids that no longer exist', () => {
      const open = readOpenGroups(
        fakeStorage(JSON.stringify(['market', 'retired-group', 7])),
        groups,
        '/'
      );
      expect(open).toEqual(['market']);
    });

    it('survives a corrupt stored value', () => {
      expect(readOpenGroups(fakeStorage('{not json'), groups, '/wallet')).toEqual(['money']);
      expect(readOpenGroups(fakeStorage('"market"'), groups, '/wallet')).toEqual(['money']);
    });

    it('round-trips through storage', () => {
      const storage = fakeStorage();
      writeOpenGroups(storage, ['market', 'grid']);
      expect(readOpenGroups(storage, groups, '/')).toEqual(['market', 'grid']);
    });

    it('ignores a storage that refuses to write', () => {
      const throwing = {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      };
      expect(() => writeOpenGroups(throwing, ['grid'])).not.toThrow();
    });
  });
});

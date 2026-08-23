import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MOBILE_NAV_GROUPS,
  getMobileNavGroups,
  searchMobileNav,
} from './mobile-nav';

// Vitest runs from the repository root (see vitest.config.ts).
const navigator = readFileSync('mobile/src/navigation/AppNavigator.tsx', 'utf8');

describe('mobile nav model', () => {
  it('only targets screens the navigator registers', () => {
    const registered = new Set(
      [...navigator.matchAll(/(?:Stack|Tab)\.Screen\s+name="([^"]+)"/g)].map(match => match[1])
    );
    const unregistered = MOBILE_NAV_GROUPS.flatMap(group =>
      group.items.map(item => item.screen)
    ).filter(screen => !registered.has(screen));
    expect(unregistered).toEqual([]);
  });

  it('lists each screen once', () => {
    const screens = MOBILE_NAV_GROUPS.flatMap(group => group.items.map(item => item.screen));
    expect(new Set(screens).size).toBe(screens.length);
  });

  it('expands only the quick actions by default', () => {
    expect(MOBILE_NAV_GROUPS.filter(group => group.defaultOpen).map(group => group.id)).toEqual([
      'primary',
    ]);
  });

  it('keeps admin screens away from members', () => {
    const memberScreens = getMobileNavGroups('user').flatMap(group =>
      group.items.map(item => item.screen)
    );
    expect(memberScreens).not.toContain('AuditLogs');
    expect(getMobileNavGroups('user').map(group => group.id)).not.toContain('admin');
    expect(
      getMobileNavGroups('admin').flatMap(group => group.items.map(item => item.screen))
    ).toContain('AuditLogs');
  });

  it('does not keep a group that filtered down to nothing', () => {
    for (const group of getMobileNavGroups('user')) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('filters on labels and keywords, and refuses admin matches for members', () => {
    expect(
      searchMobileNav(getMobileNavGroups('admin'), 'settlement').map(match => match.item.screen)
    ).toEqual(['OrderBook']);
    expect(searchMobileNav(getMobileNavGroups('user'), 'workflow')).toEqual([]);
    expect(searchMobileNav(getMobileNavGroups('user'), '  ')).toEqual([]);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('P2P asset approval gate', () => {
  it('requires active and approved assets in the live offer query', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, 'routers/p2p-trading.ts'), 'utf8');
    expect(source).toContain("eq(assets.status, 'active')");
    expect(source).toContain("eq(assets.approvalStatus, 'approved')");
  });
});

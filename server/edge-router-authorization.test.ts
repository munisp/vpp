import { describe, expect, it } from 'vitest';
import { edgeRouter } from './routers/nextgen/edge';

describe('edge router authorization', () => {
  const nonAdminCaller = edgeRouter.createCaller({
    user: { id: 42, role: 'user' },
  } as never);

  it('refuses gateway enumeration by a non-administrator', async () => {
    await expect(nonAdminCaller.getGateways()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses emergency control commands by a non-administrator', async () => {
    await expect(
      nonAdminCaller.emergencyStop({
        gatewayId: 'gateway-other-site',
        reason: 'unauthorized test',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

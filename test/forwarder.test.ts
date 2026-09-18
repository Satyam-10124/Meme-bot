import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { loadConfig } from '../src/config.js';
import { assertAllowedTx } from '../src/core/guards.js';
import { planForward, TRANSFER_GAS } from '../src/services/forwarder.js';

const config = loadConfig();
const gasPrice = 60_000_000n; // ~0.06 gwei, the live Robinhood Chain price

describe('planForward', () => {
  it('sends everything above the gas reserve and its own worst-case fee', () => {
    const plan = planForward({
      balance: parseEther('0.007'),
      gasPrice,
      gasReserve: parseEther('0.0003'),
      minForward: parseEther('0.0005'),
    });
    const worstFee = TRANSFER_GAS * gasPrice * 2n;
    expect(plan.amount).toBe(parseEther('0.007') - parseEther('0.0003') - worstFee);
    expect(plan.maxFeePerGas).toBe(gasPrice * 2n);
    expect(plan.amount + worstFee + parseEther('0.0003')).toBeLessThanOrEqual(plan.balance);
  });

  it('forwards nothing when the balance is inside the reserve', () => {
    const plan = planForward({
      balance: parseEther('0.0002'),
      gasPrice,
      gasReserve: parseEther('0.0003'),
      minForward: parseEther('0.0005'),
    });
    expect(plan.amount).toBe(0n);
    expect(plan.reason).toMatch(/gas reserve/);
  });

  it('skips dust below the minimum forward', () => {
    const plan = planForward({
      balance: parseEther('0.0006'),
      gasPrice,
      gasReserve: parseEther('0.0003'),
      minForward: parseEther('0.0005'),
    });
    expect(plan.amount).toBe(0n);
    expect(plan.reason).toMatch(/min forward/);
  });
});

describe('treasury transfer guard', () => {
  it('allows a plain transfer to the treasury above the per-job cap', () => {
    expect(() =>
      assertAllowedTx(config, { to: config.treasury, value: parseEther('1'), transfer: true }),
    ).not.toThrow();
  });

  it('rejects a transfer to any other destination', () => {
    expect(() =>
      assertAllowedTx(config, {
        to: '0x1111111111111111111111111111111111111111',
        value: 1n,
        transfer: true,
      }),
    ).toThrow(/allowlist/);
  });

  it('rejects a transfer that carries calldata', () => {
    expect(() =>
      assertAllowedTx(config, { to: config.treasury, value: 1n, data: '0x4e71d92d', transfer: true }),
    ).toThrow(/calldata/);
  });

  it('still caps non-transfer value sends', () => {
    expect(() =>
      assertAllowedTx(config, { to: config.treasury, value: parseEther('1') }),
    ).toThrow(/spend cap/);
  });
});

export const DEMO_DOMAIN = '@demo.marketplace.mx';

export const DEMO_ROLES = ['comprador', 'vendedor', 'admin'] as const;

export type DemoRole = (typeof DEMO_ROLES)[number];

export const DEMO_ACCOUNTS: Record<DemoRole, string> = {
  comprador: `comprador${DEMO_DOMAIN}`,
  vendedor: `vendedor${DEMO_DOMAIN}`,
  admin: `admin${DEMO_DOMAIN}`,
};

export function demoModeEnabled(): boolean {
  return process.env.DEMO_MODE === 'true';
}

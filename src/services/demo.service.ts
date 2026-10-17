import { and, eq, isNull } from 'drizzle-orm';
import { ServiceUnavailableException } from 'veloce-ts';
import type { LoginResponse } from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { users } from '../db/schema';
import type { AuthService } from './auth.service';
import {
  DEMO_ACCOUNTS,
  DEMO_DOMAIN,
  demoModeEnabled,
  type DemoRole,
} from './demo.constants';

export class DemoService {
  constructor(private authService: AuthService) {}

  accountFor(role: DemoRole): string {
    return DEMO_ACCOUNTS[role];
  }

  async startSession(db: DrizzleDB, role: DemoRole): Promise<LoginResponse> {
    if (!demoModeEnabled()) {
      throw new ServiceUnavailableException('Demo mode is off');
    }

    const email = DEMO_ACCOUNTS[role];
    if (!email?.endsWith(DEMO_DOMAIN)) {
      throw new ServiceUnavailableException('Unknown demo role');
    }

    const [account] = await db
      .select({ id: users.id, isDemo: users.isDemo })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));

    if (!account || !account.isDemo) {
      throw new ServiceUnavailableException(
        'La demostración todavía no tiene datos. Corre `bun run demo:seed`.',
      );
    }

    return this.authService.signInDemoAccount(db, email);
  }
}

import { sql } from 'drizzle-orm';
import { Controller, Ctx, Get, InjectDB } from 'veloce-ts';
import type { Context } from 'hono';
import type { DrizzleDB } from '../db/client';

@Controller('/health')
export class HealthController {
  constructor(@InjectDB() private db: DrizzleDB) {}

  @Get('/')
  health() {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('/ready')
  async ready(@Ctx() c: Context) {
    try {
      await this.db.execute(sql`select 1`);
      return { status: 'ready', database: 'up' };
    } catch {
      c.status(503);
      return { status: 'degraded', database: 'down' };
    }
  }
}

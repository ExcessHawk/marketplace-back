import { Body, Controller, Get, Inject, InjectDB, Post, UseMiddleware } from 'veloce-ts';
import { DemoSessionSchema, type DemoSessionDto } from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { signupRateLimit } from '../middleware/rate-limit.middleware';
import { AuditService } from '../services/audit.service';
import { DEMO_ROLES } from '../services/demo.constants';
import { DemoService } from '../services/demo.service';

@Controller('/api/demo')
export class DemoController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(DemoService) private demoService: DemoService,
    @Inject(AuditService) private auditService: AuditService,
  ) {}

  @Get('/roles')
  roles() {
    return {
      roles: DEMO_ROLES.map((role) => ({ role, email: this.demoService.accountFor(role) })),
    };
  }

  @Post('/session')
  @UseMiddleware(signupRateLimit)
  async session(@Body(DemoSessionSchema) body: DemoSessionDto) {
    const result = await this.demoService.startSession(this.db, body.role);

    await this.auditService.record(this.db, {
      userId: result.user.id,
      action: 'demo.session.start',
      tableName: 'users',
      recordId: result.user.id,
      newValues: { role: body.role },
    });

    return result;
  }
}

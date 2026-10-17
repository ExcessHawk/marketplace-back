import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  Get,
  Inject,
  InjectDB,
  Param,
  Post,
  Roles,
  UnauthorizedException,
  getCurrentUser,
} from 'veloce-ts';
import { SendMessageSchema, type SendMessageDto } from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { ChatService } from '../services/chat.service';
import { ChatGateway } from '../websocket/chat.gateway';

const ANY_ROLE = ['admin', 'seller', 'buyer'];

@Controller('/api/chat')
export class ChatController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(ChatService) private chat: ChatService,
  ) {}

  private userId(c: Context): string {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return user.sub;
  }

  @Get('/')
  @Roles(ANY_ROLE)
  async inbox(@Ctx() c: Context) {
    return { items: await this.chat.inbox(this.db, this.userId(c)) };
  }

  @Get('/unread')
  @Roles(ANY_ROLE)
  async unread(@Ctx() c: Context) {
    return { total: await this.chat.unreadTotal(this.db, this.userId(c)) };
  }

  @Get('/:suborderId')
  @Roles(ANY_ROLE)
  async view(@Param('suborderId') suborderId: string, @Ctx() c: Context) {
    return this.chat.view(this.db, this.userId(c), suborderId);
  }

  @Post('/:suborderId')
  @Roles(ANY_ROLE)
  async send(
    @Param('suborderId') suborderId: string,
    @Body(SendMessageSchema) body: SendMessageDto,
    @Ctx() c: Context,
  ) {
    const userId = this.userId(c);
    const message = await this.chat.send(this.db, userId, suborderId, body.body);
    ChatGateway.publish(suborderId, message);
    c.status(201);
    return message;
  }

  @Post('/:suborderId/read')
  @Roles(ANY_ROLE)
  async markRead(@Param('suborderId') suborderId: string, @Ctx() c: Context) {
    return this.chat.markRead(this.db, this.userId(c), suborderId);
  }

  @Post('/:suborderId/ticket')
  @Roles(ANY_ROLE)
  async ticket(@Param('suborderId') suborderId: string, @Ctx() c: Context) {
    const userId = this.userId(c);
    await this.chat.ensureConversation(this.db, userId, suborderId);
    const issued = this.chat.issueTicket(userId, suborderId);
    return { ...issued, url: `/ws/chat/${suborderId}?ticket=${issued.ticket}` };
  }
}

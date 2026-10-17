import type { Context } from 'hono';
import {
  Inject,
  InjectDB,
  OnConnect,
  OnDisconnect,
  OnMessage,
  WebSocket,
  type WebSocketConnection,
} from 'veloce-ts';
import { SocketMessageSchema, type ChatMessageView } from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { ChatService } from '../services/chat.service';
import { logger } from '../services/logger';

function roomOf(suborderId: string): string {
  return `suborder:${suborderId}`;
}

function parse(url: string): { suborderId: string; ticket: string } | null {
  try {
    const parsed = new URL(url, 'http://localhost');
    const match = parsed.pathname.match(/\/ws\/chat\/([0-9a-f-]{36})$/i);
    if (!match) return null;
    const ticket = parsed.searchParams.get('ticket');
    if (!ticket) return null;
    return { suborderId: match[1], ticket };
  } catch {
    return null;
  }
}

@WebSocket('/ws/chat/:suborderId')
export class ChatGateway {
  private static manager: {
    broadcast(message: unknown, room?: string): void;
  } | null = null;

  private readonly sessions = new Map<string, { userId: string; suborderId: string }>();

  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(ChatService) private chat: ChatService,
  ) {}

  static setManager(manager: { broadcast(message: unknown, room?: string): void }): void {
    ChatGateway.manager = manager;
  }

  static publish(suborderId: string, message: ChatMessageView): void {
    ChatGateway.manager?.broadcast(
      { type: 'message', message: { ...message, isMine: false } },
      roomOf(suborderId),
    );
  }

  async authorizeUpgrade(c: Context): Promise<boolean> {
    const suborderId = c.req.param('suborderId');
    const ticket = c.req.query('ticket');
    if (!suborderId || !ticket) return false;
    return this.chat.redeemTicket(ticket, suborderId) !== null;
  }

  @OnConnect()
  async onConnect(connection: WebSocketConnection): Promise<void> {
    const parsed = parse(connection.requestUrl);
    if (!parsed) {
      connection.send({ type: 'error', error: 'Bad chat URL' });
      connection.close(1008, 'Bad chat URL');
      return;
    }

    const userId = this.chat.redeemTicket(parsed.ticket, parsed.suborderId);
    if (!userId) {
      connection.send({ type: 'error', error: 'Ticket inválido o vencido' });
      connection.close(1008, 'Invalid ticket');
      return;
    }

    try {
      const { conversation } = await this.chat.ensureConversation(
        this.db,
        userId,
        parsed.suborderId,
      );
      this.sessions.set(connection.id, { userId, suborderId: parsed.suborderId });
      connection.join(roomOf(parsed.suborderId));
      connection.send({ type: 'ready', conversationId: conversation.id });
    } catch (error) {
      logger.warn({ msg: 'chat upgrade rejected', reason: String(error) });
      connection.send({ type: 'error', error: 'No puedes entrar a ese chat' });
      connection.close(1008, 'Forbidden');
    }
  }

  @OnMessage(SocketMessageSchema)
  async onMessage(
    connection: WebSocketConnection,
    data: { type: 'message'; body: string },
  ): Promise<void> {
    const session = this.sessions.get(connection.id);
    if (!session) {
      connection.send({ type: 'error', error: 'Sesión no reconocida' });
      return;
    }

    try {
      const message = await this.chat.send(
        this.db,
        session.userId,
        session.suborderId,
        data.body,
      );
      connection.broadcast(
        { type: 'message', message: { ...message, isMine: false } },
        roomOf(session.suborderId),
      );
    } catch (error) {
      logger.warn({ msg: 'chat message rejected', reason: String(error) });
      connection.send({ type: 'error', error: 'No se pudo enviar el mensaje' });
    }
  }

  @OnDisconnect()
  onDisconnect(connection: WebSocketConnection): void {
    this.sessions.delete(connection.id);
  }
}

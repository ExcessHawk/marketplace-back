import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Context } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  UnauthorizedException,
  getCurrentUser,
  type JWTProvider,
} from 'veloce-ts';
import type {
  AuthUser,
  LoginDto,
  LoginResponse,
  RegisterDto,
  Role,
  UpdatePasswordDto,
  UpdateProfileDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { refreshTokens, revokedAccessTokens, sellers, users } from '../db/schema';
import { DEMO_DOMAIN } from './demo.constants';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60_000;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  constructor(private jwtProvider: JWTProvider) {}

  getJWTProvider(): JWTProvider {
    return this.jwtProvider;
  }

  private async resolveIdentity(db: DrizzleDB, userId: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));

    if (!user || user.status !== 'active') return null;

    const [seller] = await db
      .select({ id: sellers.id, status: sellers.status })
      .from(sellers)
      .where(and(eq(sellers.userId, userId), isNull(sellers.deletedAt)));

    const roles: Role[] = ['buyer'];
    if (seller && seller.status === 'active') roles.push('seller');
    if (user.isPlatformAdmin) roles.push('admin');

    return { user, sellerId: seller?.id ?? null, roles };
  }

  private toAuthUser(
    user: typeof users.$inferSelect,
    roles: Role[],
    sellerId: string | null,
  ): AuthUser {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      phone: user.phone,
      roles,
      sellerId,
    };
  }

  private async issueTokens(db: DrizzleDB, userId: string, roles: Role[]) {
    const tokens = this.jwtProvider.generateTokens({
      sub: userId,
      roles,
      jti: randomUUID(),
    });
    await this.persistRefreshToken(db, userId, tokens.refreshToken);
    return tokens;
  }

  private async persistRefreshToken(db: DrizzleDB, userId: string, token: string) {
    const payload = await this.jwtProvider.verifyRefreshToken(token).catch(() => null);
    const expiresAt = payload?.exp
      ? new Date(payload.exp * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60_000);

    await db.insert(refreshTokens).values({
      userId,
      tokenHash: digest(token),
      expiresAt,
    });
  }

  async register(db: DrizzleDB, body: RegisterDto): Promise<LoginResponse> {
    const email = body.email.toLowerCase();

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));

    if (existing) {
      throw new ConflictException('Ya hay una cuenta con ese correo');
    }

    const [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await argonHash(body.password),
        fullName: body.fullName,
        phone: body.phone ?? null,
      })
      .returning();

    if (!user) throw new Error('Failed to create user');

    const roles: Role[] = ['buyer'];
    const tokens = await this.issueTokens(db, user.id, roles);

    return { user: this.toAuthUser(user, roles, null), tokens };
  }

  async login(db: DrizzleDB, body: LoginDto): Promise<LoginResponse> {
    const email = body.email.toLowerCase();

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new UnauthorizedException(`Account temporarily locked. Try again in ${minutes} minute(s).`);
    }

    const valid = user ? await argonVerify(user.passwordHash, body.password).catch(() => false) : false;

    if (!user || !valid) {
      if (user) {
        const failed = user.failedLoginCount + 1;
        await db
          .update(users)
          .set({
            failedLoginCount: failed,
            lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null,
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
      }
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }

    if (user.status !== 'active') {
      throw new UnauthorizedException('Esta cuenta está suspendida');
    }

    await db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        loginCount: user.loginCount + 1,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    const identity = await this.resolveIdentity(db, user.id);
    if (!identity) throw new UnauthorizedException('Correo o contraseña incorrectos');

    const tokens = await this.issueTokens(db, user.id, identity.roles);
    return {
      user: this.toAuthUser(identity.user, identity.roles, identity.sellerId),
      tokens,
    };
  }

  async signInDemoAccount(db: DrizzleDB, email: string): Promise<LoginResponse> {
    if (process.env.DEMO_MODE !== 'true') {
      throw new UnauthorizedException('Demo mode is off');
    }
    if (!email.endsWith(DEMO_DOMAIN)) {
      throw new UnauthorizedException('Not a demo account');
    }

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));

    if (!user || !user.isDemo || user.status !== 'active') {
      throw new UnauthorizedException('Not a demo account');
    }

    const identity = await this.resolveIdentity(db, user.id);
    if (!identity) throw new UnauthorizedException('Not a demo account');

    await db
      .update(users)
      .set({ lastLoginAt: new Date(), loginCount: user.loginCount + 1 })
      .where(eq(users.id, user.id));

    const tokens = await this.issueTokens(db, user.id, identity.roles);
    return {
      user: this.toAuthUser(identity.user, identity.roles, identity.sellerId),
      tokens,
    };
  }

  async refresh(db: DrizzleDB, token: string): Promise<LoginResponse> {
    const payload = await this.jwtProvider.verifyRefreshToken(token).catch(() => null);
    if (!payload?.sub) throw new UnauthorizedException('Tu sesión expiró. Entra de nuevo.');

    const tokenHash = digest(token);
    const [stored] = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)));

    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Tu sesión expiró. Entra de nuevo.');
    }

    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, stored.id));

    const identity = await this.resolveIdentity(db, payload.sub);
    if (!identity) throw new UnauthorizedException('Esta cuenta ya no está activa');

    const tokens = await this.issueTokens(db, identity.user.id, identity.roles);
    return {
      user: this.toAuthUser(identity.user, identity.roles, identity.sellerId),
      tokens,
    };
  }

  async logout(db: DrizzleDB, userId: string, jti?: string, exp?: number) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

    if (jti) {
      await db
        .insert(revokedAccessTokens)
        .values({ jti, expiresAt: exp ? new Date(exp * 1000) : new Date(Date.now() + 3600_000) })
        .onConflictDoNothing();
    }
  }

  async purgeExpired(db: DrizzleDB) {
    const now = new Date();
    await db.delete(revokedAccessTokens).where(lt(revokedAccessTokens.expiresAt, now));
    await db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, now));
  }

  async me(db: DrizzleDB, c: Context): Promise<AuthUser> {
    const current = getCurrentUser(c);
    if (!current?.sub) throw new UnauthorizedException('Missing auth context');

    const identity = await this.resolveIdentity(db, current.sub);
    if (!identity) throw new UnauthorizedException('Esta cuenta ya no está activa');

    return this.toAuthUser(identity.user, identity.roles, identity.sellerId);
  }

  async updateProfile(db: DrizzleDB, userId: string, body: UpdateProfileDto): Promise<AuthUser> {
    await db
      .update(users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(users.id, userId));

    const identity = await this.resolveIdentity(db, userId);
    if (!identity) throw new UnauthorizedException('Esta cuenta ya no está activa');
    return this.toAuthUser(identity.user, identity.roles, identity.sellerId);
  }

  async updatePassword(db: DrizzleDB, userId: string, body: UpdatePasswordDto) {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new UnauthorizedException('Esta cuenta ya no está activa');

    const valid = await argonVerify(user.passwordHash, body.currentPassword).catch(() => false);
    if (!valid) throw new UnauthorizedException('Esa no es tu contraseña actual');

    await db
      .update(users)
      .set({ passwordHash: await argonHash(body.newPassword), updatedAt: new Date() })
      .where(eq(users.id, userId));

    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

    return { message: 'Password updated. Other sessions have been signed out.' };
  }
}

export const customUserProvider = {
  async findByCredentials() {
    return null;
  },
  async findById(id: string) {
    const { db } = await import('../db/client');
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)));
    if (!user) return null;
    return { id: user.id, username: user.email, email: user.email };
  },
  async hashPassword(password: string) {
    return argonHash(password);
  },
  async verifyPassword(password: string, hash: string) {
    return argonVerify(hash, password).catch(() => false);
  },
};

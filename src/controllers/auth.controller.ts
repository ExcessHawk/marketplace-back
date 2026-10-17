import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  Get,
  Inject,
  InjectDB,
  Patch,
  Post,
  Roles,
  UnauthorizedException,
  UseMiddleware,
  getCurrentUser,
} from 'veloce-ts';
import {
  LoginSchema,
  RefreshSchema,
  RegisterSchema,
  UpdatePasswordSchema,
  UpdateProfileSchema,
  type LoginDto,
  type RefreshDto,
  type RegisterDto,
  type UpdatePasswordDto,
  type UpdateProfileDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { publicRateLimit, signupRateLimit } from '../middleware/rate-limit.middleware';
import { AuthService } from '../services/auth.service';

const ANY_ROLE = ['admin', 'seller', 'buyer'];

@Controller('/api/auth')
export class AuthController {
  constructor(
    @InjectDB() private db: DrizzleDB,
    @Inject(AuthService) private authService: AuthService,
  ) {}

  @Post('/register')
  @UseMiddleware(signupRateLimit)
  async register(@Body(RegisterSchema) body: RegisterDto, @Ctx() c: Context) {
    const result = await this.authService.register(this.db, body);
    c.status(201);
    return result;
  }

  @Post('/login')
  @UseMiddleware(publicRateLimit)
  async login(@Body(LoginSchema) body: LoginDto) {
    return this.authService.login(this.db, body);
  }

  @Post('/refresh')
  @UseMiddleware(publicRateLimit)
  async refresh(@Body(RefreshSchema) body: RefreshDto) {
    return this.authService.refresh(this.db, body.refreshToken);
  }

  @Get('/me')
  @Roles(ANY_ROLE)
  async me(@Ctx() c: Context) {
    return this.authService.me(this.db, c);
  }

  @Post('/logout')
  @Roles(ANY_ROLE)
  async logout(@Ctx() c: Context) {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');

    const { jti, exp } = user as unknown as { jti?: string; exp?: number };
    await this.authService.logout(this.db, user.sub, jti, exp);
    return { message: 'Sesión cerrada' };
  }

  @Patch('/profile')
  @Roles(ANY_ROLE)
  async updateProfile(@Body(UpdateProfileSchema) body: UpdateProfileDto, @Ctx() c: Context) {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return this.authService.updateProfile(this.db, user.sub, body);
  }

  @Patch('/password')
  @Roles(ANY_ROLE)
  async updatePassword(@Body(UpdatePasswordSchema) body: UpdatePasswordDto, @Ctx() c: Context) {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return this.authService.updatePassword(this.db, user.sub, body);
  }
}

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import {
  Body,
  Controller,
  Ctx,
  Delete,
  Get,
  InjectDB,
  NotFoundException,
  Param,
  Patch,
  Post,
  Roles,
  UnauthorizedException,
  getCurrentUser,
} from 'veloce-ts';
import {
  CreateAddressSchema,
  UpdateAddressSchema,
  type AddressView,
  type CreateAddressDto,
  type UpdateAddressDto,
} from '@marketplace/contracts';
import type { DrizzleDB } from '../db/client';
import { addresses } from '../db/schema';

const ANY_ROLE = ['admin', 'seller', 'buyer'];

function toView(row: typeof addresses.$inferSelect): AddressView {
  return {
    id: row.id,
    label: row.label,
    recipient: row.recipient,
    phone: row.phone,
    street: row.street,
    interior: row.interior,
    neighborhood: row.neighborhood,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    notes: row.notes,
    isDefault: row.isDefault,
  };
}

@Controller('/api/addresses')
export class AddressController {
  constructor(@InjectDB() private db: DrizzleDB) {}

  private userId(c: Context): string {
    const user = getCurrentUser(c);
    if (!user?.sub) throw new UnauthorizedException('Missing auth context');
    return user.sub;
  }

  private async requireOwn(userId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.userId, userId), isNull(addresses.deletedAt)));
    if (!row) throw new NotFoundException('Esa dirección no está en tu cuenta');
    return row;
  }

  @Get('/')
  @Roles(ANY_ROLE)
  async list(@Ctx() c: Context) {
    const rows = await this.db
      .select()
      .from(addresses)
      .where(and(eq(addresses.userId, this.userId(c)), isNull(addresses.deletedAt)))
      .orderBy(asc(addresses.createdAt));
    return { items: rows.map(toView) };
  }

  @Post('/')
  @Roles(ANY_ROLE)
  async create(@Body(CreateAddressSchema) body: CreateAddressDto, @Ctx() c: Context) {
    const userId = this.userId(c);

    const created = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.userId, userId), isNull(addresses.deletedAt)));

      const isDefault = body.isDefault || !existing;

      if (isDefault) {
        await tx
          .update(addresses)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)));
      }

      const [row] = await tx
        .insert(addresses)
        .values({
          userId,
          label: body.label ?? null,
          recipient: body.recipient,
          phone: body.phone,
          street: body.street,
          interior: body.interior ?? null,
          neighborhood: body.neighborhood,
          city: body.city,
          state: body.state,
          postalCode: body.postalCode,
          notes: body.notes ?? null,
          isDefault,
        })
        .returning();
      return row;
    });

    if (!created) throw new Error('Could not create the address');
    c.status(201);
    return toView(created);
  }

  @Patch('/:id')
  @Roles(ANY_ROLE)
  async update(
    @Param('id') id: string,
    @Body(UpdateAddressSchema) body: UpdateAddressDto,
    @Ctx() c: Context,
  ) {
    const userId = this.userId(c);
    await this.requireOwn(userId, id);

    const updated = await this.db.transaction(async (tx) => {
      if (body.isDefault) {
        await tx
          .update(addresses)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)));
      }
      const [row] = await tx
        .update(addresses)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(addresses.id, id))
        .returning();
      return row;
    });

    if (!updated) throw new Error('Could not update the address');
    return toView(updated);
  }

  @Delete('/:id')
  @Roles(ANY_ROLE)
  async remove(@Param('id') id: string, @Ctx() c: Context) {
    const userId = this.userId(c);
    const row = await this.requireOwn(userId, id);

    await this.db.transaction(async (tx) => {
      await tx
        .update(addresses)
        .set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
        .where(eq(addresses.id, id));

      if (row.isDefault) {
        const [next] = await tx
          .select({ id: addresses.id })
          .from(addresses)
          .where(and(eq(addresses.userId, userId), isNull(addresses.deletedAt)))
          .orderBy(asc(addresses.createdAt));
        if (next) {
          await tx
            .update(addresses)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(addresses.id, next.id));
        }
      }
    });

    return { message: 'Dirección eliminada' };
  }
}

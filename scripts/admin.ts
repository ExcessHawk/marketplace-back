#!/usr/bin/env bun
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { auditLogs, refreshTokens, users } from '../src/db/schema';
import { describeTarget } from '../src/db/safety';

const [command, ...rest] = process.argv.slice(2);
const args = rest.filter((a) => !a.startsWith('--'));
const confirmed = rest.includes('--yes');

function usage(): never {
  console.error(`
Uso:
  bun run admin:list
  bun run admin:grant  <email> --yes
  bun run admin:revoke <email> --yes
`);
  process.exit(2);
}

function announceTarget(): void {
  const target = describeTarget(process.env.DATABASE_URL ?? '');
  console.log(`Base de datos: ${target.database} en ${target.host}:${target.port}`);
}

async function findUser(email: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      isPlatformAdmin: users.isPlatformAdmin,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.email, email.toLowerCase().trim()), isNull(users.deletedAt)));
  return user ?? null;
}

async function countAdmins(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isPlatformAdmin, true), isNull(users.deletedAt)));
  return Number(row?.total ?? 0);
}

async function list(): Promise<void> {
  announceTarget();
  const rows = await db
    .select({ email: users.email, fullName: users.fullName, status: users.status })
    .from(users)
    .where(and(eq(users.isPlatformAdmin, true), isNull(users.deletedAt)))
    .orderBy(users.email);

  if (rows.length === 0) {
    console.log('\nNo hay ningún admin de plataforma.');
    console.log('Registra una cuenta normal y luego:  bun run admin:grant <email> --yes');
    return;
  }

  console.log(`\n${rows.length} admin(s):`);
  for (const row of rows) {
    console.log(`  ${row.email.padEnd(34)} ${row.fullName}${row.status === 'active' ? '' : `  [${row.status}]`}`);
  }
}

async function grant(email: string): Promise<void> {
  announceTarget();
  const user = await findUser(email);

  if (!user) {
    console.error(`\nNo hay ninguna cuenta con "${email}".`);
    console.error('Regístrate primero por el flujo normal; este comando solo promueve.');
    process.exit(1);
  }
  if (user.isPlatformAdmin) {
    console.log(`\n${user.email} ya es admin. Nada que hacer.`);
    return;
  }
  if (!confirmed) {
    console.error(`\nEsto le daría acceso de administrador de plataforma a:`);
    console.error(`  ${user.email}  (${user.fullName})`);
    console.error('\nVuelve a correrlo con --yes si es lo que quieres.');
    process.exit(1);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ isPlatformAdmin: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    await tx.insert(auditLogs).values({
      userId: null,
      action: 'admin.granted',
      tableName: 'users',
      recordId: user.id,
      oldValues: { isPlatformAdmin: false },
      newValues: { isPlatformAdmin: true, via: 'cli', email: user.email },
    });
  });

  console.log(`\n${user.email} ahora es admin de plataforma.`);
  console.log('Tiene que volver a entrar (o refrescar) para que el token lleve el rol.');
}

async function revoke(email: string): Promise<void> {
  announceTarget();
  const user = await findUser(email);

  if (!user) {
    console.error(`\nNo hay ninguna cuenta con "${email}".`);
    process.exit(1);
  }
  if (!user.isPlatformAdmin) {
    console.log(`\n${user.email} no es admin. Nada que hacer.`);
    return;
  }

  if ((await countAdmins()) <= 1) {
    console.error(`\n${user.email} es el único admin que queda.`);
    console.error('Nombra a alguien más antes de quitarle el acceso a este.');
    process.exit(1);
  }
  if (!confirmed) {
    console.error(`\nEsto le quitaría el acceso de administrador a ${user.email}.`);
    console.error('Vuelve a correrlo con --yes si es lo que quieres.');
    process.exit(1);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ isPlatformAdmin: false, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, user.id), isNull(refreshTokens.revokedAt)));

    await tx.insert(auditLogs).values({
      userId: null,
      action: 'admin.revoked',
      tableName: 'users',
      recordId: user.id,
      oldValues: { isPlatformAdmin: true },
      newValues: { isPlatformAdmin: false, via: 'cli', email: user.email },
    });
  });

  console.log(`\n${user.email} ya no es admin.`);
  console.log('Sus sesiones quedaron revocadas; cada endpoint de admin revalida contra la base.');
}

try {
  switch (command) {
    case 'list':
      await list();
      break;
    case 'grant':
      if (!args[0]) usage();
      await grant(args[0]);
      break;
    case 'revoke':
      if (!args[0]) usage();
      await revoke(args[0]);
      break;
    default:
      usage();
  }
} finally {
  await pool.end();
}

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { hashPassword } from "../src/common/auth-crypto.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for admin bootstrap");

const email = process.env.AGENTHUB_BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.AGENTHUB_BOOTSTRAP_ADMIN_PASSWORD;
const name = process.env.AGENTHUB_BOOTSTRAP_ADMIN_NAME ?? "系统管理员";

if (!email) throw new Error("AGENTHUB_BOOTSTRAP_ADMIN_EMAIL is required");
if (!password || password.length < 12) {
  throw new Error("AGENTHUB_BOOTSTRAP_ADMIN_PASSWORD is required and must be at least 12 characters");
}

const prisma = new PrismaClient({ adapter: new PrismaPg(connectionString) });

await prisma.user.upsert({
  where: { email },
  create: {
    name,
    email,
    avatar: "/avatars/dark-09.png",
    role: "admin",
    passwordHash: hashPassword(password)
  },
  update: {
    name,
    role: "admin",
    passwordHash: hashPassword(password),
    deletedAt: null
  }
});

await prisma.systemLog.create({
  data: {
    level: "info",
    scope: "bootstrap",
    message: "Production admin bootstrap completed.",
    payload: { email }
  }
});

await prisma.$disconnect();

import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

export function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

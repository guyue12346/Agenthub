import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function cleanupKnowledgeHub() {
  console.log("🧹 Cleaning up KnowledgeHub demo data...");

  // 删除所有知识库文档
  const deletedDocs = await prisma.knowledgeDocument.deleteMany({});
  console.log(`✅ Deleted ${deletedDocs.count} knowledge documents`);

  // 删除所有知识库订阅
  const deletedSubs = await prisma.knowledgeSubscription.deleteMany({});
  console.log(`✅ Deleted ${deletedSubs.count} knowledge subscriptions`);

  // 删除所有知识库
  const deletedAssets = await prisma.knowledgeAsset.deleteMany({});
  console.log(`✅ Deleted ${deletedAssets.count} knowledge assets`);

  console.log("✨ KnowledgeHub cleanup completed!");
}

cleanupKnowledgeHub()
  .catch((error) => {
    console.error("❌ Cleanup failed:", error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });

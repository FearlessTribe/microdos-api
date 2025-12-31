import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create demo users
  const hashedPassword = await bcrypt.hash('demo123456', 12);
  
  const demoUser = await prisma.user.upsert({
    where: { email: 'demo@microdos.in' },
    update: {},
    create: {
      email: 'demo@microdos.in',
      name: 'Demo User',
      handle: 'demo_user',
      password: hashedPassword,
      emailVerified: new Date(),
    },
  });

  const testUser = await prisma.user.upsert({
    where: { email: 'test@microdos.in' },
    update: {},
    create: {
      email: 'test@microdos.in',
      name: 'Test User',
      handle: 'test_user',
      password: hashedPassword,
      emailVerified: new Date(),
    },
  });

  console.log('✅ Demo users created:', {
    demo: { id: demoUser.id, email: demoUser.email, name: demoUser.name },
    test: { id: testUser.id, email: testUser.email, name: testUser.name },
  });

  // Create a demo group
  const demoGroup = await prisma.group.upsert({
    where: { slug: 'general' },
    update: {},
    create: {
      name: 'General Discussion',
      slug: 'general',
      description: 'General discussions about microdosing',
      visibility: 'public',
      settings: JSON.stringify({
        postApprovalRequired: false,
        allowReactions: true,
        allowExternalEmbeds: true,
        defaultSorting: 'new'
      }),
      ownerId: demoUser.id,
    },
  });

  // Add test user to the group
  await prisma.groupMember.upsert({
    where: {
      groupId_userId: {
        groupId: demoGroup.id,
        userId: testUser.id
      }
    },
    update: {},
    create: {
      groupId: demoGroup.id,
      userId: testUser.id,
      role: 'member',
      status: 'active'
    }
  });

  console.log('✅ Demo group created:', {
    id: demoGroup.id,
    name: demoGroup.name,
    slug: demoGroup.slug,
  });

  // Create sample posts
  const samplePosts = [
    {
      title: 'Meine ersten Erfahrungen mit Mikrodosierung',
      content: 'Ich habe vor 2 Wochen mit der Mikrodosierung begonnen und bin begeistert von den ersten Ergebnissen. Meine Konzentration hat sich deutlich verbessert und ich fühle mich insgesamt ausgeglichener.',
      authorId: demoUser.id,
      groupId: demoGroup.id,
      status: 'published',
      publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
    {
      title: 'Tipps für Anfänger',
      content: 'Hier sind meine wichtigsten Tipps für alle, die gerade mit der Mikrodosierung anfangen: 1. Starte niedrig, 2. Führe ein Tagebuch, 3. Sei geduldig mit den Ergebnissen.',
      authorId: testUser.id,
      groupId: demoGroup.id,
      status: 'published',
      isPinned: true,
      publishedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    },
    {
      title: 'Protokoll-Vergleich: Fadiman vs. Stamets',
      content: 'Ich habe beide Protokolle ausprobiert und möchte meine Erfahrungen teilen. Das Fadiman-Protokoll war für mich als Anfänger besser geeignet, während Stamets für fortgeschrittene Anwender interessant ist.',
      authorId: demoUser.id,
      groupId: demoGroup.id,
      status: 'published',
      publishedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    },
    {
      title: 'Dosierung und Timing',
      content: 'Wann ist der beste Zeitpunkt für die Einnahme? Ich habe verschiedene Zeiten ausprobiert und finde morgens auf nüchternen Magen am besten.',
      authorId: testUser.id,
      groupId: demoGroup.id,
      status: 'published',
      publishedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    },
    {
      title: 'Nebenwirkungen und Vorsicht',
      content: 'Wichtige Hinweise zu möglichen Nebenwirkungen und wann man die Mikrodosierung pausieren sollte.',
      authorId: demoUser.id,
      groupId: demoGroup.id,
      status: 'published',
      publishedAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
    }
  ];

  for (const postData of samplePosts) {
    const post = await prisma.post.create({
      data: postData
    });
    console.log(`✅ Created post: ${post.title}`);
  }

  console.log('🎉 Seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

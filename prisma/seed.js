import { prisma } from "../src/lib/prisma.js";

async function main() {
  // Clean first — safe to run multiple times
  await prisma.teacher.deleteMany();

  await prisma.teacher.create({
    data: {
      name: "Sister Aisha",
      email: "sister.aisha@quranodyssey.com",
      specialty: ["Quran Recitation", "Noorani Qaida"],
      timezone: "Europe/London",
      gender: "female",
      bio: "Specialist in young learners with 8 years of teaching experience.",
      rating: 4.99,
      isActive: true,
      // You'll replace this with the real Google Calendar ID in Phase 4
      // For now use a placeholder so the DB row exists
      calendarId:
        "placeholder_calendar_id_sister_aisha@group.calendar.google.com",
    },
  });

  await prisma.teacher.create({
    data: {
      name: "Ustadh Hassan",
      email: "ustadh.hassan@quranodyssey.com",
      specialty: ["Tajweed", "Hifz"],
      timezone: "Europe/London",
      gender: "male",
      bio: "Head of Hifz programme. Patient, structured, results-driven.",
      rating: 4.96,
      isActive: true,
      calendarId:
        "placeholder_calendar_id_ustadh_hassan@group.calendar.google.com",
    },
  });

  console.log("✅ Seed complete — 2 teachers created");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

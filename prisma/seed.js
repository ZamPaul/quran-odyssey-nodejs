// prisma/seed.js
import { prisma } from '../src/lib/prisma.js';


async function main() {
  // Clean in correct order (respect foreign keys)
  await prisma.attendanceRecord.deleteMany();
  await prisma.assignmentSubmission.deleteMany();
  await prisma.assignment.deleteMany();
  await prisma.progressReport.deleteMany();
  await prisma.classSession.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.trialBooking.deleteMany();
  await prisma.studentProfile.deleteMany();
  await prisma.trialLead.deleteMany();
  await prisma.teacher.deleteMany();
  await prisma.user.deleteMany();wszaw

  // Seed teachers
  // userId is null for now — linked in Phase 2 when admin creates Clerk accounts
  await prisma.teacher.create({
    data: {
      name:       'Sister Aisha',
      email:      'sister.aisha@quranodyssey.com',
      specialty:  ['Quran Recitation', 'Noorani Qaida'],
      timezone:   'Europe/London',
      gender:     'female',
      bio:        'Specialist in young learners with 8 years of teaching experience.',
      rating:     4.99,
      isActive:   true,
      calendarId: 'placeholder_aisha@group.calendar.google.com',
      userId:     null, // linked in Phase 2
    },
  });

  await prisma.teacher.create({
    data: {
      name:       'Ustadh Hassan',
      email:      'ustadh.hassan@quranodyssey.com',
      specialty:  ['Tajweed', 'Hifz'],
      timezone:   'Europe/London',
      gender:     'male',
      bio:        'Head of Hifz programme. Patient, structured, results-driven.',
      rating:     4.96,
      isActive:   true,
      calendarId: 'placeholder_hassan@group.calendar.google.com',
      userId:     null, // linked in Phase 2
    },
  });

  console.log('✅ Seed complete — 2 teachers created (userId to be linked in Phase 2)');
}

main()
  .catch(e => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
// verify-student.mjs — temporary Phase 2 verification, delete after
import { prisma } from "./src/lib/prisma.js"

async function main() {
  // 1. Count students — expect 6
  const studentCount = await prisma.student.count();
  console.log('Total students:', studentCount);

  // 2. List every student with their account holder + attached data counts
  const students = await prisma.student.findMany({
    include: {
      account: { select: { email: true, role: true, name: true } },
      _count: {
        select: {
          enrollments: true,
          classSessions: true,
          assignments: true,
          attendanceRecords: true,
          progressReports: true,
          trialBookings: true,
        },
      },
    },
    orderBy: { accountId: 'asc' },
  });

  console.log('\n--- Students ---');
  for (const s of students) {
    console.log(
      `• ${s.name} (age ${s.age}) | owner: ${s.account.email} [${s.account.role}] | ` +
      `enroll:${s._count.enrollments} sessions:${s._count.classSessions} ` +
      `assign:${s._count.assignments} attend:${s._count.attendanceRecords} ` +
      `reports:${s._count.progressReports} trials:${s._count.trialBookings}`
    );
  }

  // 3. Find the parent account and confirm it owns 2 children
  const parent = await prisma.user.findFirst({
    where: { role: 'PARENT' },
    include: { managedStudents: { select: { name: true } } },
  });
  if (parent) {
    console.log(
      `\nParent ${parent.email} manages ${parent.managedStudents.length} children:`,
      parent.managedStudents.map(c => c.name).join(', ')
    );
  }
}

main()
  .then(() => console.log('\n✅ Student model reads correctly'))
  .catch((e) => { console.error('❌ Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
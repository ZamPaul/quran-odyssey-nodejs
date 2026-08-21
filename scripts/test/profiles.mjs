import { computeGamification, PROGRESS_BASIS } from '../../src/lib/gamification.js';

const DAY=86400000, NOW=Date.now();
const ago=d=>new Date(NOW-d*DAY).toISOString();
const att=(s,d)=>({status:s,markedAt:ago(d),session:{scheduledAt:ago(d)}});
const hw=(due,sub)=>({dueDate:ago(due),submission:sub==null?null:{submittedAt:ago(sub)}});
const rep=(r,d)=>({status:'SENT',overallRating:r,sentAt:ago(d)});
const enr=(d,st='ACTIVE',spw=2)=>({startDate:ago(d),status:st,sessionsPerWeek:spw,courseType:'HIFZ'});

// Build a family: months enrolled, attendance reliability, homework rate
function build({months, reliability, hwRate, ratings=[], spw=2}){
  const days=months*30, n=Math.round(months*4.33*spw);
  const attendance=[];
  for(let i=0;i<n;i++){
    const d=Math.max(Math.round(days-(i*(days/n))),1);
    const r=Math.random();
    const st = r<reliability ? 'PRESENT' : (r<reliability+0.06 ? 'LATE' : (r<reliability+0.10?'EXCUSED':'ABSENT'));
    attendance.push(att(st,d));
  }
  const nh=Math.round(n/2.5), assignments=[];
  for(let i=0;i<nh;i++){
    const d=Math.max(Math.round(days-(i*(days/nh))),2);
    const did=Math.random()<hwRate;
    assignments.push(hw(d, did ? (Math.random()<0.75 ? d+1 : d-1) : null));
  }
  return {attendance,assignments,reports:ratings.map((r,i)=>rep(r,20+i*30)),enrollments:[enr(days,'ACTIVE',spw)]};
}

const PROFILES=[
  ['Brand new (signed up 3 days ago)', {attendance:[],assignments:[],reports:[],enrollments:[enr(3)]}],
  ['1 month, keen',        build({months:1, reliability:0.90, hwRate:0.85, ratings:[]})],
  ['3 months, typical',    build({months:3, reliability:0.82, hwRate:0.70, ratings:[4]})],
  ['6 months, dedicated',  build({months:6, reliability:0.92, hwRate:0.90, ratings:[5,5]})],
  ['6 months, struggling', build({months:6, reliability:0.55, hwRate:0.30, ratings:[3]})],
  ['12 months, veteran',   build({months:12,reliability:0.88, hwRate:0.80, ratings:[4,5,4,5]})],
];

console.log('\n══════════ WHAT REAL FAMILIES WOULD SEE ══════════\n');
for(const [label,raw] of PROFILES){
  const g=computeGamification(raw,{now:NOW,basis:PROGRESS_BASIS.ATTENDANCE});
  console.log(`─── ${label} ───`);
  if(g.isNew){
    console.log('   (new family — welcome state, no wall of zeros)');
    console.log(`   next up: ${g.nextBadge.name} — ${g.nextBadge.description}\n`);
    continue;
  }
  console.log(`   Level ${g.level.level} "${g.level.name}"  ·  ${g.xp.total} XP  ·  ${g.level.percentToNext}% to "${g.level.nextName}"`);
  console.log(`   Streak: ${g.streak.current} in a row (best ${g.streak.best})${g.streak.isPersonalBest?'  🔥 personal best!':''}`);
  console.log(`   Attended ${g.totals.sessionsAttended}  ·  homework ${g.totals.homeworkOnTime}/${g.totals.homeworkSubmitted} on time`);
  console.log(`   Badges: ${g.badgeCount}/${g.badgeTotal} — ${g.earnedBadges.map(b=>b.icon+' '+b.name).join(', ')||'none yet'}`);
  if(g.nextBadge) console.log(`   Next: ${g.nextBadge.name} (${g.nextBadge.value}/${g.nextBadge.target}, ${g.nextBadge.remaining} to go)`);
  console.log(`   ${g.progress.label}: ${g.progress.percent}%  (${g.progress.attended}/${g.progress.expected})`);
  console.log(`   XP this week: ${g.xp.thisWeek}\n`);
}
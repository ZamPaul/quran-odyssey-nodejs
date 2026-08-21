import {
  normalizeActivity, computeStreak, computeXp, computeLevel,
  computeBadges, computeProgress, computeGamification, XP, PROGRESS_BASIS,
} from '../../src/lib/gamification.js';

// import { normalizeActivity } from "../../src/lib/gamification";

let p=0,f=0;
const ck=(n,c)=>{c?(p++,console.log('  ✓',n)):(f++,console.log('  ✗ FAIL',n))};
const DAY=86400000;
const NOW=new Date('2026-08-20T12:00:00Z').getTime();
const ago=(d)=>new Date(NOW-d*DAY).toISOString();

// helper builders
const att=(status,daysAgo)=>({status,markedAt:ago(daysAgo),session:{scheduledAt:ago(daysAgo)}});
const hw=(dueDaysAgo,submittedDaysAgo)=>({dueDate:ago(dueDaysAgo),submission:submittedDaysAgo==null?null:{submittedAt:ago(submittedDaysAgo)}});
const rep=(rating,daysAgo)=>({status:'SENT',overallRating:rating,sentAt:ago(daysAgo)});
const enr=(startDaysAgo,status='ACTIVE',spw=2)=>({startDate:ago(startDaysAgo),status,sessionsPerWeek:spw,courseType:'HIFZ'});

console.log('\n════ 1. BRAND NEW FAMILY — first impression ════');
const brandNew=computeGamification({attendance:[],sessions:[],assignments:[],reports:[],enrollments:[enr(2)]},{now:NOW});
ck('isNew flag set', brandNew.isNew===true);
ck('0 XP', brandNew.xp.total===0);
ck('level 1', brandNew.level.level===1);
ck('streak 0', brandNew.streak.current===0);
ck('0 badges earned', brandNew.badgeCount===0);
ck('but ALL badges listed with progress', brandNew.badgeTotal===9);
ck('nextBadge suggested even at zero', brandNew.nextBadge!==null);
console.log('   next badge nudge:', brandNew.nextBadge.name, `(${brandNew.nextBadge.remaining} to go)`);
ck('progress not "meaningful" yet', brandNew.progress.meaningful===false);

console.log('\n════ 2. THE EXCUSED RULE — the one that matters most ════');
// 5 attended, then EXCUSED (ill), then 3 more attended = should be 8, unbroken
const excusedMid=[
  att('PRESENT',40),att('PRESENT',37),att('PRESENT',33),att('PRESENT',30),att('PRESENT',26),
  att('EXCUSED',23),  // ill / Eid
  att('PRESENT',19),att('PRESENT',16),att('PRESENT',12),
];
const sEx=computeStreak(normalizeActivity({attendance:excusedMid}).attendance);
ck('EXCUSED does NOT break the streak', sEx.current===8);
ck('  ...and best is also 8', sEx.best===8);

// contrast: ABSENT in the same position
const absentMid=[...excusedMid]; absentMid[5]={...absentMid[5],status:'ABSENT'};
const sAb=computeStreak(normalizeActivity({attendance:absentMid}).attendance);
ck('ABSENT DOES break the streak', sAb.current===3);
ck('  ...best still records the earlier run of 5', sAb.best===5);
ck('  ...personal best is FALSE while rebuilding', sAb.isPersonalBest===false);

console.log('\n════ 3. ORDERING — marked late must not reorder history ════');
// Session on day 30 but teacher marked it on day 5 (late marking)
const lateMarked=[
  {status:'PRESENT',markedAt:ago(5), session:{scheduledAt:ago(30)}},
  {status:'ABSENT', markedAt:ago(28),session:{scheduledAt:ago(28)}},
  {status:'PRESENT',markedAt:ago(20),session:{scheduledAt:ago(20)}},
];
const sOrd=computeStreak(normalizeActivity({attendance:lateMarked}).attendance);
ck('ordered by lesson date, not marking date', sOrd.current===1 && sOrd.best===1);

console.log('\n════ 4. XP + LEVEL — realistic 6-month family ════');
// 2 sessions/week for 26 weeks ≈ 52 sessions; 45 present, 4 late, 3 absent
const sixMonths=[];
for(let i=0;i<52;i++){
  const d=180-(i*3.4);
  const st = i%17===0 ? 'ABSENT' : (i%13===0 ? 'LATE' : 'PRESENT');
  sixMonths.push(att(st, Math.max(Math.round(d),1)));
}
const hwList=[]; for(let i=0;i<20;i++){const d=170-i*8; hwList.push(hw(Math.max(d,2), i<16?Math.max(d+1,2):null));}
const activity6=normalizeActivity({attendance:sixMonths,assignments:hwList,reports:[rep(5,60),rep(4,20)],enrollments:[enr(180)]});
const xp6=computeXp(activity6,{now:NOW});
const lv6=computeLevel(xp6.total);
console.log(`   XP total ${xp6.total}  →  Level ${lv6.level} "${lv6.name}" (${lv6.arabic})`);
console.log(`   breakdown:`, xp6.breakdown);
console.log(`   ${lv6.percentToNext}% toward "${lv6.nextName}" (${lv6.xpToNext} XP to go)`);
ck('6-month family reaches a satisfying level (3-6)', lv6.level>=3 && lv6.level<=6);
ck('XP is non-trivial (>400)', xp6.total>400);
ck('percentToNext within 0-100', lv6.percentToNext>=0 && lv6.percentToNext<=100);

console.log('\n════ 5. BADGES ════');
const b6=computeBadges(activity6);
const earned6=b6.filter(b=>b.earned);
console.log('   earned:', earned6.map(b=>b.name).join(', ')||'(none)');
const next6=b6.filter(b=>!b.earned).sort((a,b)=>b.percent-a.percent)[0];
console.log('   closest unearned:', next6? `${next6.name} — ${next6.value}/${next6.target}`:'(all earned)');
ck('First Steps earned', earned6.some(b=>b.key==='first_steps'));
// fixture yields 48 attended — engine correctly reports 48/50, not earned
ck('Devoted NOT earned at 48 (threshold respected)', !earned6.some(b=>b.key==='devoted'));
const devoted6=b6.find(b=>b.key==='devoted');
ck('  ...and shows exact progress 48/50', devoted6.value===48 && devoted6.target===50 && devoted6.remaining===2);
// prove the threshold fires when actually crossed
const fifty=[]; for(let i=0;i<50;i++) fifty.push(att('PRESENT', 180-i*3));
const b50=computeBadges(normalizeActivity({attendance:fifty}));
ck('  ...Devoted DOES fire at exactly 50', b50.find(b=>b.key==='devoted').earned===true);
ck('Homework Hero earned (10+ on time)', earned6.some(b=>b.key==='homework_hero'));
ck('Praised earned (a 5 rating)', earned6.some(b=>b.key==='praised'));
ck('Century NOT yet earned', !earned6.some(b=>b.key==='centurion'));
ck('every badge has progress %', b6.every(b=>typeof b.percent==='number'));

console.log('\n════ 6. PERFECT MONTH ════');
// One clean month, one month with an absence
const pm=[
  att('PRESENT',70),att('PRESENT',67),att('PRESENT',64),   // ~2.3 months ago
  att('PRESENT',40),att('ABSENT',37),att('PRESENT',34),    // month with absence
];
const bpm=computeBadges(normalizeActivity({attendance:pm}));
const perfect=bpm.find(b=>b.key==='perfect_month');
ck('perfect month detected', perfect.earned===true);
ck('  ...counted exactly once', perfect.value===1);

console.log('\n════ 7. PROGRESS BASIS ════');
const pAtt=computeProgress(activity6,{basis:PROGRESS_BASIS.ATTENDANCE,now:NOW});
console.log(`   attendance basis: ${pAtt.percent}% — "${pAtt.label}" (${pAtt.attended}/${pAtt.expected})`);
ck('attendance label is honest, not "course progress"', pAtt.label==='Attendance this course');
ck('percent capped at 100', pAtt.percent<=100);

const teacherSet=normalizeActivity({enrollments:[{...enr(90),progressPercent:65}]});
const pT=computeProgress(teacherSet,{basis:PROGRESS_BASIS.TEACHER_SET,now:NOW});
ck('teacher-set basis works', pT.percent===65 && pT.meaningful===true);
const pTnone=computeProgress(normalizeActivity({enrollments:[enr(90)]}),{basis:PROGRESS_BASIS.TEACHER_SET,now:NOW});
ck('teacher-set with no value → honest fallback', pTnone.meaningful===false && pTnone.label.includes('Awaiting'));

console.log('\n════ 8. XP THIS WEEK ════');
const recent=normalizeActivity({attendance:[att('PRESENT',1),att('PRESENT',4),att('PRESENT',30)],assignments:[hw(2,2)]});
const xpW=computeXp(recent,{now:NOW});
ck('this-week XP counts only last 7 days', xpW.thisWeek===XP.SESSION_PRESENT*2+XP.HOMEWORK_ON_TIME);
ck('total includes older too', xpW.total===XP.SESSION_PRESENT*3+XP.HOMEWORK_ON_TIME);

console.log('\n════ 9. HOMEWORK ON TIME vs LATE ════');
const hwMix=normalizeActivity({assignments:[hw(10,11),hw(10,9),hw(10,null)]}); // early, late, not submitted
const xpH=computeXp(hwMix,{now:NOW});
ck('on-time worth more than late', XP.HOMEWORK_ON_TIME>XP.HOMEWORK_LATE);
ck('submitted-before-due counted on time', xpH.breakdown.homework===XP.HOMEWORK_ON_TIME+XP.HOMEWORK_LATE);
ck('unsubmitted earns nothing', xpH.total===XP.HOMEWORK_ON_TIME+XP.HOMEWORK_LATE);

console.log('\n════ 10. ROBUSTNESS ════');
ck('empty input does not throw', !!computeGamification({},{now:NOW}));
ck('missing relations tolerated', !!computeGamification({attendance:[{status:'PRESENT'}]},{now:NOW}));
ck('null report rating ignored', computeXp(normalizeActivity({reports:[rep(null,5)]}),{now:NOW}).total===0);
ck('DRAFT reports excluded', computeXp(normalizeActivity({reports:[{status:'DRAFT',overallRating:5,sentAt:ago(5)}]}),{now:NOW}).total===0);
ck('rating 3 earns no XP', computeXp(normalizeActivity({reports:[rep(3,5)]}),{now:NOW}).total===0);
ck('rating 4 earns XP', computeXp(normalizeActivity({reports:[rep(4,5)]}),{now:NOW}).total===XP.STRONG_REPORT);

console.log(`\n${p} passed, ${f} failed`);
process.exit(f?1:0);

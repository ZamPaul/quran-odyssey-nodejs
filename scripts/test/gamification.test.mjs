import {
  normalizeActivity, computeStreak, computeXp, computeLevel, computeBadges,
  computeProgress, computeJourney, computeGamification, buildXpTimeline,
  XP, LEVELS, PROGRESS_BASIS, DORMANT_AFTER_WEEKS, PERFECT_MONTH_MIN_SESSIONS,
} from '../../src/lib/gamification.js';

let p=0,f=0; const ck=(n,c)=>{c?(p++,console.log('  ✓',n)):(f++,console.log('  ✗ FAIL',n))};
const DAY=86400000, NOW=new Date('2026-08-20T12:00:00Z').getTime();
const ago=d=>new Date(NOW-d*DAY).toISOString();
const att=(s,d)=>({status:s,markedAt:ago(d),session:{scheduledAt:ago(d)}});
const hw=(due,sub)=>({dueDate:ago(due),submission:sub==null?null:{submittedAt:ago(sub)}});
const rep=(r,d,pct=null)=>({status:'SENT',overallRating:r,sentAt:ago(d),progressPercent:pct});
const enr=(d,st='ACTIVE',spw=2)=>({startDate:ago(d),status:st,sessionsPerWeek:spw,courseType:'HIFZ'});
const O={now:NOW};

console.log('\n═══ 1. TUNING: badge targets ═══');
// Homework Hero lowered 10 → 3
// due N days ago, submitted N+1 days ago = submitted BEFORE the deadline
const hw3=normalizeActivity({assignments:[hw(10,11),hw(9,10),hw(8,9)]});
ck('Homework Hero fires at 3 on-time', computeBadges(hw3).find(b=>b.key==='homework_hero').earned);
const hw2=normalizeActivity({assignments:[hw(10,11),hw(9,10)]});
ck('  ...not at 2', !computeBadges(hw2).find(b=>b.key==='homework_hero').earned);
ck('  ...target is 3', computeBadges(hw2).find(b=>b.key==='homework_hero').target===3);
const hwLate=normalizeActivity({assignments:[hw(10,9),hw(9,8),hw(8,7)]}); // all submitted AFTER due
ck('  ...late submissions do NOT count toward it',
  !computeBadges(hwLate).find(b=>b.key==='homework_hero').earned);
ck('  ...but late submissions still earn XP',
  computeXp(hwLate,O).breakdown.homework===XP.HOMEWORK_LATE*3);

// Praised raised 1 → 3
ck('Praised NOT earned on one 5-star',
  !computeBadges(normalizeActivity({reports:[rep(5,10)]})).find(b=>b.key==='praised').earned);
ck('Praised earned on three 5-stars',
  computeBadges(normalizeActivity({reports:[rep(5,30),rep(5,20),rep(5,10)]})).find(b=>b.key==='praised').earned);

// Perfect Month now needs ≥4 sessions
const thin=[att('PRESENT',40),att('PRESENT',38)];               // 2 sessions, none missed
const full=[att('PRESENT',40),att('PRESENT',38),att('PRESENT',36),att('PRESENT',34)];
ck('Perfect Month NOT awarded for a 2-session month',
  !computeBadges(normalizeActivity({attendance:thin})).find(b=>b.key==='perfect_month').earned);
ck('Perfect Month awarded for a 4-session clean month',
  computeBadges(normalizeActivity({attendance:full})).find(b=>b.key==='perfect_month').earned);
ck('  ...and NOT when one is missed',
  !computeBadges(normalizeActivity({attendance:[...full.slice(0,3),att('ABSENT',34)]}))
    .find(b=>b.key==='perfect_month').earned);
ck('  ...minimum constant is 4', PERFECT_MONTH_MIN_SESSIONS===4);

console.log('\n═══ 2. TUNING: level curve ═══');
ck('L2 at 80 XP (was 120)', computeLevel(80).level===2);
ck('L3 at 200', computeLevel(200).level===3);
ck('L4 at 380', computeLevel(380).level===4);
ck('thresholds strictly ascending', LEVELS.every((l,i)=>i===0||l.minXp>LEVELS[i-1].minXp));
// the real top student had 340 XP under old curve → was L3, should now be L3→L4 boundary
ck('340 XP now reaches L3 (real top student)', computeLevel(340).level===3);
ck('400 XP now reaches L4', computeLevel(400).level===4);

console.log('\n═══ 3. NEW vs DORMANT ═══');
const justSignedUp=computeGamification({enrollments:[enr(3)]},O);
ck('enrolled 3 days, never attended → isNew', justSignedUp.isNew && !justSignedUp.isDormant);
const stale=computeGamification({enrollments:[enr(60)]},O);
ck('enrolled 60 days, never attended → isDormant', stale.isDormant && !stale.isNew);
ck('  ...reports weeks enrolled', stale.weeksEnrolled>=8);
const attending=computeGamification({attendance:[att('PRESENT',5)],enrollments:[enr(60)]},O);
ck('has attended → neither flag', !attending.isNew && !attending.isDormant);
ck('boundary is 2 weeks', DORMANT_AFTER_WEEKS===2);

console.log('\n═══ 4. TEACHER-SET PROGRESS ═══');
const noPct=normalizeActivity({enrollments:[enr(60)],reports:[rep(5,10)]});
const pNone=computeProgress(noPct,{...O,basis:PROGRESS_BASIS.TEACHER});
ck('no percentage yet → awaitingTeacher', pNone.awaitingTeacher===true && pNone.meaningful===false);
ck('  ...honest label', pNone.label==='Awaiting teacher assessment');
const withPct=normalizeActivity({enrollments:[enr(60)],reports:[rep(5,40,45),rep(5,10,70)]});
const pSet=computeProgress(withPct,{...O,basis:PROGRESS_BASIS.TEACHER});
ck('uses the MOST RECENT report', pSet.percent===70);
ck('  ...meaningful + labelled Course progress', pSet.meaningful && pSet.label==='Course progress');
ck('  ...records when assessed', !!pSet.assessedAt);
ck('clamps out-of-range values',
  computeProgress(normalizeActivity({enrollments:[enr(60)],reports:[rep(5,5,150)]}),{...O,basis:PROGRESS_BASIS.TEACHER}).percent===100);
ck('teacher basis is the DEFAULT',
  computeProgress(noPct,O).basis===PROGRESS_BASIS.TEACHER);

console.log('\n═══ 5. JOURNEY MAP ═══');
const sessions=[]; for(let i=0;i<30;i++) sessions.push(att('PRESENT',90-i*3));
const act=normalizeActivity({attendance:sessions,assignments:[hw(20,19),hw(15,14),hw(10,9)],
  reports:[rep(5,30),rep(4,10)],enrollments:[enr(90)]});
const j=computeJourney(act,O);
console.log(`   ${j.totalSteps} steps · stage "${j.currentStage.name}" · ${j.percentThroughStage}% through · ${j.percentOfJourney}% of journey`);
console.log(`   next: ${j.nextMilestone.label} in ${j.nextMilestone.remaining} ${j.nextMilestone.unit}`);
ck('all 8 stages returned', j.stages.length===8);
ck('exactly one is current', j.stages.filter(s=>s.state==='current').length===1);
ck('earlier stages complete', j.stages.filter(s=>s.state==='complete').every(s=>s.level<j.currentStage.level));
ck('later stages locked', j.stages.filter(s=>s.state==='locked').every(s=>s.level>j.currentStage.level));
ck('completed stages have a reachedAt date', j.stages.filter(s=>s.state==='complete').every(s=>!!s.reachedAt));
ck('locked stages have none', j.stages.filter(s=>s.state==='locked').every(s=>s.reachedAt===null));
ck('steps = attended sessions', j.totalSteps===30);
ck('stepsInStage <= totalSteps', j.stepsInStage<=j.totalSteps);
ck('percentOfJourney 0-100', j.percentOfJourney>=0 && j.percentOfJourney<=100);
ck('sessionsToNext is a positive estimate', j.sessionsToNext>0);
ck('recentSteps capped at 8', j.recentSteps.length<=8);
ck('recentSteps newest last',
  new Date(j.recentSteps[j.recentSteps.length-1].at) >= new Date(j.recentSteps[0].at));
ck('nextMilestone present', !!j.nextMilestone);
ck('names flagged unconfirmed', j.namesConfirmed===false);

console.log('\n═══ 6. JOURNEY EDGE CASES ═══');
const jEmpty=computeJourney(normalizeActivity({}),O);
ck('empty history does not throw', !!jEmpty);
ck('  ...stage 1, 0 steps', jEmpty.currentStage.level===1 && jEmpty.totalSteps===0);
ck('  ...startedAt null', jEmpty.startedAt===null);
const jMax=computeJourney(normalizeActivity({attendance:Array.from({length:300},(_,i)=>att('PRESENT',900-i*3))}),O);
ck('max level reached at 300 sessions', jMax.currentStage.level===8);
ck('  ...no next stage', jMax.nextStage===null);
ck('  ...sessionsToNext 0', jMax.sessionsToNext===0);
ck('  ...journey 100%', jMax.percentOfJourney===100);

console.log('\n═══ 7. TIMELINE ═══');
const tl=buildXpTimeline(act);
ck('timeline chronological', tl.every((e,i)=>i===0||e.at>=tl[i-1].at));
ck('timeline total = XP total', tl.reduce((s,e)=>s+e.amount,0)===computeXp(act,O).total);
ck('kinds tagged', new Set(tl.map(e=>e.kind)).size>=2);

console.log('\n═══ 8. REGRESSION — nothing else broke ═══');
const ex=[att('PRESENT',40),att('PRESENT',37),att('PRESENT',33),att('PRESENT',30),att('PRESENT',26),
          att('EXCUSED',23),att('PRESENT',19),att('PRESENT',16),att('PRESENT',12)];
ck('EXCUSED still does not break a streak', computeStreak(normalizeActivity({attendance:ex}).attendance).current===8);
const abs=[...ex]; abs[5]={...abs[5],status:'ABSENT'};
ck('ABSENT still breaks it', computeStreak(normalizeActivity({attendance:abs}).attendance).current===3);
ck('ordered by lesson date not marking date',
  computeStreak(normalizeActivity({attendance:[
    {status:'PRESENT',markedAt:ago(5),session:{scheduledAt:ago(30)}},
    {status:'ABSENT',markedAt:ago(28),session:{scheduledAt:ago(28)}},
    {status:'PRESENT',markedAt:ago(20),session:{scheduledAt:ago(20)}}]}).attendance).current===1);
ck('DRAFT reports still excluded',
  computeXp(normalizeActivity({reports:[{status:'DRAFT',overallRating:5,sentAt:ago(5)}]}),O).total===0);
ck('rating 3 still earns nothing', computeXp(normalizeActivity({reports:[rep(3,5)]}),O).total===0);
ck('empty input still safe', !!computeGamification({},O));
const g=computeGamification({attendance:sessions,enrollments:[enr(90)]},O);
ck('top-level exposes journey', !!g.journey && !!g.journey.stages);
ck('top-level exposes both flags', 'isNew' in g && 'isDormant' in g);

console.log(`\n${p} passed, ${f} failed`);
process.exit(f?1:0);

// ══════════════════════════════════════════════════════════
// (A) NEW FILE: src/lib/reportPdf.js
// ══════════════════════════════════════════════════════════
import PDFDocument from 'pdfkit';
 
const NAVY = '#0d2840', CYAN = '#28b7d9', CYAN_DARK = '#0e6e8a', GREY = '#64748b', AMBER = '#faa71a';
const COURSE_LABELS = {
  NOORANI_QAIDA: 'Noorani Qaida', QURAN_RECITATION: 'Quran Recitation', TAJWEED: 'Tajweed',
  HIFZ: 'Hifz', ISLAMIC_STUDIES: 'Islamic Studies', ONE_TO_ONE: 'One-to-One',
};
 
// Draw a 0–5 rating as filled/empty circles (font-safe).
function drawRating(doc, rating, rightEdge, y) {
  const r = 5, gap = 16, count = 5;
  const startX = rightEdge - (count * gap - (gap - 2 * r)); // right-align the row
  for (let i = 0; i < count; i++) {
    const cx = startX + i * gap + r;
    if (i < rating) doc.circle(cx, y + r, r).fill(AMBER);
    else doc.circle(cx, y + r, r).lineWidth(1).strokeColor('#d6dee6').stroke();
  }
}

// Streams a branded PDF of the report to `res`.
export function streamReportPdf(res, { report, teacherName, childName }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
 
  res.setHeader('Content-Type', 'application/pdf');
  const safeChild = (childName || 'student').replace(/\s+/g, '_');
  const safePeriod = (report.period || '').replace(/\s+/g, '_');
  res.setHeader('Content-Disposition', `inline; filename="report-${safeChild}-${safePeriod}.pdf"`);
  doc.pipe(res);
 
  const W = doc.page.width - 100; // content width inside 50pt margins
  const rightEdge = 50 + W;
 
  // ── Header band ──
  doc.rect(0, 0, doc.page.width, 110).fill(NAVY);
  doc.fillColor(CYAN).fontSize(11).font('Helvetica-Bold').text('QURAN ODYSSEY', 50, 34, { characterSpacing: 1 });
  doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('Progress Report', 50, 52);
  doc.fillColor('#9fb4c4').fontSize(11).font('Helvetica')
     .text(`${report.period}  ·  ${COURSE_LABELS[report.courseType] || report.courseType}`, 50, 82);
 
  let y = 140;
  // Calculate right-aligned positions for OVERALL RATING text and numeric rating
  // Place these right next to the circle ratings, with a gap if desired.
  // const ratingCircleR = 5;
  // const ratingGap = 16;
  // const ratingCount = 5;
  // const ratingRowWidth = ratingCount * ratingGap - (ratingGap - 2 * ratingCircleR);
  // const ratingRowStartX = rightEdge - ratingRowWidth;

  // We'll align the text just to the left of the circles row, or flush right with some padding
  // const ratingTextWidth = 120;
  // const ratingTextRightEdge = ratingTextWidth - 12;
  // ── Student + rating row ──
  doc.fillColor(GREY).fontSize(9).font('Helvetica-Bold').text('STUDENT', 50, y);
  doc.fillColor(NAVY).fontSize(14).font('Helvetica-Bold').text(childName || '—', 50, y + 12);
 
  doc.fillColor(GREY).fontSize(9).font('Helvetica-Bold').text('OVERALL RATING', 370, y, { width: 175, align: 'right' });
  drawRating(doc, report.overallRating || 0, rightEdge, y + 10);
  doc.fillColor(GREY).fontSize(9).font('Helvetica').text(`${report.overallRating || 0} / 5`, 370, y + 26, { width: 175, align: 'right' });
 
  y += 54;
  doc.fillColor(GREY).fontSize(9).font('Helvetica').text(`Prepared by ${teacherName}`, 50, y);
  y += 22;
  doc.moveTo(50, y).lineTo(rightEdge, y).strokeColor('#e2e8f0').stroke();
  y += 18;
 
  // ── Sections ──
  const sections = [
    ['Tajweed Progress', report.tajweedProgress],
    ['Recitation Notes', report.recitationNotes],
    ['Behaviour & Attitude', report.behaviourNotes],
    ['Homework & Practice', report.homeworkNotes],
    ['Next Steps', report.nextSteps],
  ].filter(([, v]) => v && v.trim());
 
  for (const [label, value] of sections) {
    if (y > doc.page.height - 130) { doc.addPage(); y = 50; }
    doc.fillColor(CYAN_DARK).fontSize(10).font('Helvetica-Bold').text(label.toUpperCase(), 50, y);
    y += 15;
    doc.fillColor('#334155').fontSize(10.5).font('Helvetica').text(value.trim(), 50, y, { width: W, align: 'left' });
    y = doc.y + 14;
  }
 
  // ── Teacher message (highlighted box) ──
  if (report.teacherMessage && report.teacherMessage.trim()) {
    if (y > doc.page.height - 150) { doc.addPage(); y = 50; }
    const msg = `"${report.teacherMessage.trim()}"`;
    const msgH = doc.fontSize(10.5).font('Helvetica-Oblique').heightOfString(msg, { width: W - 32 });
    const boxH = msgH + 42;
    // fill first, then text on top
    doc.rect(50, y, W, boxH).fillOpacity(0.06).fill(CYAN).fillOpacity(1);
    doc.rect(50, y, 3, boxH).fill(CYAN); // left accent bar
    doc.fillColor(CYAN_DARK).fontSize(9).font('Helvetica-Bold').text(`MESSAGE FROM ${(teacherName || '').toUpperCase()}`, 66, y + 12);
    doc.fillColor('#0e6e8a').fontSize(10.5).font('Helvetica-Oblique').text(msg, 66, y + 26, { width: W - 32 });
    y += boxH + 16;
  }

  // ── Attachment note ──
  if (report.attachmentUrl) {
    if (y > doc.page.height - 110) { doc.addPage(); y = 50; }
    doc.fillColor(GREY).fontSize(9).font('Helvetica-Bold').text('ATTACHMENT', 50, y);
    doc.fillColor(CYAN_DARK).fontSize(10).font('Helvetica')
       .text(report.attachmentName || 'Attached file', 50, y + 13, { link: report.attachmentUrl, underline: true });
    y += 34;
  }
 
  // ── Footer — placed just below content (not page-anchored, so it never
  //    forces a phantom second page). If little room remains, it simply
  //    sits where the content ended.
  const fy = Math.min(y + 12, doc.page.height - 50);
  doc.moveTo(50, fy).lineTo(rightEdge, fy).strokeColor('#e2e8f0').stroke();
  doc.fillColor('#94a3b8').fontSize(9).font('Helvetica')
     .text('Quran Odyssey', 50, fy + 9, { width: W, align: 'center' });
 
  doc.end();
}
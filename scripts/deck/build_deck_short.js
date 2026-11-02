// Smart Retry presentation, short version (14 slides). Built from the master spec and the MVP's executed results.
// Run: node build_deck.js [output.pptx]  (needs pptxgenjs and the pptx skill's apply_theme.js beside it)
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const { applyTheme } = require("./apply_theme.js");

const D = __dirname;
const OUT = process.argv[2] || path.join(D, "Belvo_Smart_Retry_Presentation_Short.pptx");
const img = n => "image/png;base64," + fs.readFileSync(path.join(D, n)).toString("base64");

const THEME = {
  name: "Smart Retry", headFontFace: "Cambria", bodyFontFace: "Calibri",
  colors: { dk1: "142D29", lt1: "FFFFFF", dk2: "3E5550", lt2: "EEF4F1", accent1: "007B62", accent2: "B8EBD8",
    accent3: "B76B28", accent4: "AF4A42", accent5: "5B8C82", accent6: "D9E3DE", hlink: "007B62", folHlink: "5B8C82" },
};
const HEX = THEME.colors;
const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.author = "Bernabé Bustamante";
pres.title = "Smart Retry";
pres.subject = "Belvo PM challenge, unofficial prototype";
const C = pres.SchemeColor;
const FOOT = "Smart Retry · Unofficial Belvo product-challenge prototype";

pres.defineSlideMaster({
  title: "DARK_TITLE", background: { color: C.text1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 1.45, w: 8.8, h: 1.1, fontSize: 44, bold: true, color: C.background1, fontFace: THEME.headFontFace, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 2.7, w: 8.6, h: 1.9, fontSize: 18, color: C.accent2, valign: "top", margin: 0 }, text: "" } },
    { text: { text: FOOT, options: { x: 0.6, y: 5.05, w: 8.8, h: 0.3, fontSize: 10, color: C.accent5, margin: 0 } } },
  ],
});
pres.defineSlideMaster({
  title: "SECTION", background: { color: C.accent1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 2.0, w: 8.8, h: 0.9, fontSize: 36, bold: true, color: C.background1, fontFace: THEME.headFontFace, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.6, y: 2.95, w: 8.8, h: 0.8, fontSize: 16, color: C.accent2, valign: "top", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT", background: { color: C.background1 }, margin: [0.5, 0.5, 0.6, 0.5],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.5, y: 0.35, w: 9, h: 0.65, fontSize: 26, bold: true, color: C.text1, fontFace: THEME.headFontFace, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { text: { text: FOOT, options: { x: 0.5, y: 5.2, w: 7, h: 0.25, fontSize: 9, color: C.text2, margin: 0 } } },
  ],
  slideNumber: { x: 9.1, y: 5.2, w: 0.4, h: 0.25, fontSize: 9, color: HEX.dk2, align: "right" },
});

const T = (slide, text, o) => slide.addText(text, { isTextBox: true, margin: 0, color: C.text1, fontSize: 14, valign: "top", ...o });
const bullets = (items, extra = {}) => items.map((t, i, a) => ({ text: t, options: { bullet: true, breakLine: i < a.length - 1, paraSpaceAfter: 6, ...extra } }));
function card(slide, x, y, w, h, name, fill = C.background2) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: fill }, line: { color: fill }, rectRadius: 0.08, objectName: name });
}
function stat(slide, x, y, w, big, label, name, color = C.accent1, h = 1.55) {
  card(slide, x, y, w, h, name);
  T(slide, big, { x: x + 0.2, y: y + 0.15, w: w - 0.4, h: 0.7, fontSize: 34, bold: true, color, fontFace: THEME.headFontFace });
  T(slide, label, { x: x + 0.2, y: y + 0.88, w: w - 0.4, h: h - 0.95, fontSize: 12, color: C.text2 });
}
function shot(slide, file, x, y, w, h, name, alt) {
  slide.addShape(pres.shapes.RECTANGLE, { x: x - 0.02, y: y - 0.02, w: w + 0.04, h: h + 0.04, fill: { color: C.background1 }, line: { color: C.accent6, width: 1 },
    shadow: { type: "outer", color: "142D29", opacity: 0.18, blur: 6, offset: 2, angle: 90 }, objectName: name + " frame" });
  slide.addImage({ data: img(file), x, y, w, h, altText: alt, objectName: name });
}
function badge(slide, x, y, d, label, color, name) {
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color }, line: { color: C.background1 }, objectName: name });
  T(slide, label, { x, y, w: d, h: d, fontSize: d > 0.5 ? 18 : 12, bold: true, color: C.background1, align: "center", valign: "middle" });
}
function table(slide, header, rows, o) {
  slide.addTable([header.map(h => ({ text: h, options: { bold: true, color: HEX.lt1, fill: { color: HEX.dk1 } } })), ...rows],
    { fontSize: 12, fontFace: "Calibri", color: HEX.dk1, border: { type: "solid", pt: 0.75, color: "DDE3DB" }, ...o });
}
const chartText = { catAxisLabelColor: HEX.dk2, valAxisLabelColor: HEX.dk2, catAxisLabelFontFace: "+mn-lt", valAxisLabelFontFace: "+mn-lt",
  dataLabelFontFace: "+mn-lt", titleFontFace: "+mn-lt", catAxisLabelFontSize: 11, valAxisLabelFontSize: 10, dataLabelFontSize: 11,
  dataLabelColor: HEX.dk1, valGridLine: { color: "DDE3DB", size: 0.5 }, catGridLine: { style: "none" } };
let s;
const content = (section, title) => { const sl = pres.addSlide({ masterName: "CONTENT", sectionTitle: section }); sl.addText(title, { placeholder: "title" }); return sl; };
const divider = (section, title, sub) => { pres.addSection({ title: section }); const sl = pres.addSlide({ masterName: "SECTION", sectionTitle: section }); sl.addText(title, { placeholder: "title" }); sl.addText(sub, { placeholder: "body" }); return sl; };


// 1 Title
pres.addSection({ title: "Problem" });
s = pres.addSlide({ masterName: "DARK_TITLE", sectionTitle: "Problem" });
s.addText("Smart Retry", { placeholder: "title" });
s.addText("Which loans to retry, when, and for how much. A working MVP on the two challenge files, and the product strategy behind it.", { placeholder: "body" });

// 2 Problem
s = content("Problem", "Retries keep hitting the same empty accounts");
stat(s, 0.5, 1.25, 2.85, "97.6%", "of 253,006 payment requests in the history failed", "Stat failed");
stat(s, 3.575, 1.25, 2.85, "68%", "of today's retry candidates have never paid once", "Stat never paid", C.accent3);
stat(s, 6.65, 1.25, 2.85, "12", "median insufficient-funds failures in a row for a candidate", "Stat streak", C.accent4);
T(s, bullets([
  "The brief: retries run without discretion, cause chargebacks and waste bandwidth on accounts with no funds or blocked accounts.",
  "Job to be done: give a Belvo operator a defensible list of which loans to debit, when, and for how much, and stop the rest.",
]), { x: 0.5, y: 3.1, w: 9, h: 1.8, fontSize: 14, color: C.text2 });

// 3 Data analysis
s = content("Problem", "Data analysis: one failure reason dominates");
s.addChart(pres.charts.BAR, [{ name: "Failed requests", labels: ["04 Insufficient funds", "03 Account cancelled", "08 Customer stop order", "02 Account blocked", "01 Account doesn't exist", "Other codes"], values: [209097, 14385, 10657, 7454, 3250, 2089] }], {
  x: 0.5, y: 1.15, w: 5.4, h: 3.9, barDir: "bar", showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: "#,##0",
  chartColors: [HEX.accent1, HEX.accent4, HEX.accent4, HEX.accent4, HEX.accent4, HEX.accent5], varyColors: true, showLegend: false, valAxisHidden: true,
  showTitle: true, title: "246,932 failed requests by bank failure code", titleFontSize: 12, titleColor: HEX.dk1, catAxisOrientation: "maxMin", ...chartText,
});
card(s, 6.15, 1.15, 3.35, 3.9, "Data facts card");
T(s, "What else the files show", { x: 6.35, y: 1.3, w: 2.95, h: 0.35, fontSize: 14, bold: true });
T(s, bullets([
  "85% of failures are insufficient funds (04): recoverable in principle",
  "15% are hard failures (cancelled, blocked, stop order): retrying rarely works",
  "Requests come in batches: 166,747 single, 23,929 split in three (5/25/70), 2,141 with six",
  "Snapshot debt is already updated; 29 loans have no history",
], { paraSpaceAfter: 5 }), { x: 6.35, y: 1.75, w: 2.95, h: 3.2, fontSize: 12 });

// 4 Hypotheses
s = content("Problem", "Hypotheses we tested against the data");
table(s, ["Hypothesis", "Evidence in the history", "Status"], [
  ["Insufficient-funds failures can recover after a wait", "Kept attempts succeed 4.37%, twice the 2.22% average", { text: "Supported", options: { bold: true, color: HEX.accent1 } }],
  ["Hard failures (cancelled, blocked) don't recover", "Retries right after one: 0.19% success", { text: "Supported", options: { bold: true, color: HEX.accent1 } }],
  ["Long insufficient-funds streaks rarely pay", "20+ in a row: 0.60% success on 45% of requests", { text: "Supported", options: { bold: true, color: HEX.accent1 } }],
  ["Chargebacks repeat", "22.9% of retries after a chargeback were charged back again", { text: "Supported", options: { bold: true, color: HEX.accent1 } }],
  ["Calendar paydays raise success", "1.88% on paydays vs 1.85% other days", { text: "Rejected", options: { bold: true, color: HEX.accent4 } }],
  ["Retrying beats not retrying", "No counterfactual in the data", { text: "To test (holdout)", options: { bold: true, color: HEX.accent3 } }],
], { x: 0.5, y: 1.15, w: 9, colW: [3.5, 3.9, 1.6], rowH: 0.5, objectName: "Hypotheses table" });


// 5 Scope and trade-offs
s = content("Problem", "Scope, constraints and trade-offs");
card(s, 0.5, 1.15, 3.5, 3.9, "Scope card");
T(s, [{ text: "In scope", options: { bold: true, color: HEX.accent1, breakLine: true } },
  { text: "Mexico, MXN; all 3,062 loans, one decision each; fixed evaluation date; requests in the bank's nine-column format", options: { breakLine: true } },
  { text: " ", options: { breakLine: true, fontSize: 6 } },
  { text: "Out of scope, on purpose", options: { bold: true, color: HEX.accent4, breakLine: true } },
  { text: "Sending money, per-loan amounts, predictive scoring, overrides, multi-merchant tenancy", options: { breakLine: true } },
  { text: " ", options: { breakLine: true, fontSize: 6 } },
  { text: "Known limits", options: { bold: true, color: HEX.accent3, breakLine: true } },
  { text: "No live checks of authorization or current debt; final statuses only; no cost per attempt; small holdout" }],
  { x: 0.7, y: 1.3, w: 3.1, h: 3.65, fontSize: 12 });
table(s, ["Choice", "Gain", "Cost"], [
  [{ text: "Conservative rules", options: { bold: true } }, "Nothing ambiguous retried", "713 loans to review"],
  [{ text: "Rest, not review, for fatigue", options: { bold: true } }, "Queue stays at 713, not 2,477", "Still retried monthly"],
  [{ text: "Two-person approval", options: { bold: true } }, "Four eyes on money", "Handoff friction"],
  [{ text: "Fixed 5/25/70 split", options: { bold: true } }, "Matches current practice", "Not optimized per loan"],
  [{ text: "10% holdout", options: { bold: true } }, "Measures what retrying adds", "Those loans wait"],
], { x: 4.25, y: 1.15, w: 5.25, colW: [1.85, 1.85, 1.55], rowH: 0.62, fontSize: 11, objectName: "Trade-off table" });
// 6 Logic and heuristics
pres.addSection({ title: "Logic" });
s = content("Logic", "Logic: ten ordered rules, the first match decides");
[["Needs attention", "Rules 1-7", "Missing balance, no history, bad times, chargeback, mixed or repeated attempts, a success to reconcile, or any failure other than insufficient funds (04)", C.accent4],
 ["Resting", "Rule 8", "20+ insufficient-funds failures in a row: wait 30 days instead of the cooldown", C.accent3],
 ["Waiting", "Rule 9", "Insufficient funds, cooldown (3, 7 or 14 days) not over: shows the next check date", C.accent5],
 ["Retry candidate", "Rule 10", "Insufficient funds and the wait has passed: three draft requests, 5/25/70 of the balance", C.accent1]].forEach(([head, rule, body, color], i) => {
  const y = 1.15 + i * 0.8;
  card(s, 0.5, y, 9, 0.68, `Rule card ${i + 1}`);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.65, y: y + 0.12, w: 2.1, h: 0.44, fill: { color }, line: { color }, rectRadius: 0.06, objectName: `Rule label ${i + 1}` });
  T(s, head, { x: 0.65, y: y + 0.12, w: 2.1, h: 0.44, fontSize: 14, bold: true, color: C.background1, align: "center", valign: "middle" });
  T(s, rule, { x: 2.95, y: y + 0.08, w: 1.0, h: 0.52, fontSize: 12, bold: true, color: C.text2, valign: "middle" });
  T(s, body, { x: 3.95, y: y + 0.06, w: 5.4, h: 0.56, fontSize: 12, valign: "middle" });
});
T(s, [{ text: "Heuristics: ", options: { bold: true } }, { text: "look at every request in the latest attempt; when in doubt a person decides; give money time to arrive; stop the treadmill after 20 failures; ask for less in steps; prove it with a 10% control group." }],
  { x: 0.5, y: 4.4, w: 9, h: 0.7, fontSize: 12, color: C.text2 });

// 8 Process
s = content("Logic", "End-to-end process");
[["Operator", "Upload portfolio", "History already in the system"],
 ["System", "Check", "Columns, IDs, money, links to history"],
 ["System", "Classify", "SQL rules; drafts payment requests"],
 ["Operator", "Submit", "All 3,062 decisions plus drafts"],
 ["Reviewer", "Approve", "Sees amounts; approval releases"],
 ["Rails", "Send and respond", "Outside the MVP; same file format"]].forEach(([who, h, b], i) => {
  const x = 0.5 + i * 1.53;
  const color = who === "Reviewer" ? C.accent3 : who === "System" ? C.accent5 : who === "Rails" ? C.text2 : C.accent1;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.2, w: 1.38, h: 0.38, fill: { color }, line: { color }, rectRadius: 0.06, objectName: `Lane ${i + 1}` });
  T(s, who, { x, y: 1.2, w: 1.38, h: 0.38, fontSize: 11, bold: true, color: C.background1, align: "center", valign: "middle" });
  card(s, x, 1.7, 1.38, 1.55, `Flow step ${i + 1}`);
  T(s, h, { x: x + 0.1, y: 1.82, w: 1.18, h: 0.5, fontSize: 13, bold: true, align: "center" });
  T(s, b, { x: x + 0.1, y: 2.35, w: 1.18, h: 0.85, fontSize: 11, color: C.text2, align: "center" });
  if (i < 5) s.addShape(pres.shapes.LINE, { x: x + 1.38, y: 2.47, w: 0.15, h: 0, line: { color: C.accent5, width: 1.5, endArrowType: "triangle" }, objectName: `Flow arrow ${i + 1}` });
});
s.addShape(pres.shapes.LINE, { x: 8.34, y: 3.3, w: 0, h: 0.45, line: { color: C.accent5, width: 1.5 }, objectName: "Loop down" });
s.addShape(pres.shapes.LINE, { x: 1.19, y: 3.75, w: 7.15, h: 0, line: { color: C.accent5, width: 1.5 }, objectName: "Loop back" });
s.addShape(pres.shapes.LINE, { x: 1.19, y: 3.3, w: 0, h: 0.45, line: { color: C.accent5, width: 1.5, beginArrowType: "triangle" }, objectName: "Loop up" });
T(s, "Responses become new history; a follow-up analysis is evaluated at the end of the latest response day", { x: 1.6, y: 3.82, w: 6.5, h: 0.35, fontSize: 12, color: C.text2, align: "center" });
card(s, 0.5, 4.3, 9, 0.75, "States card");
T(s, [{ text: "Analysis states: ", options: { bold: true } }, { text: "Draft → Checking → Ready to generate → Generating → Ready for review → Awaiting reviewer → Approved (or Changes requested → new revision). Failed or interrupted runs never publish partial results." }],
  { x: 0.7, y: 4.4, w: 8.6, h: 0.6, fontSize: 12, valign: "middle" });

// 9 Operator interaction and what they see
pres.addSection({ title: "Product" });
s = content("Product", "How the operator works, and what they see");
T(s, [
  "Sign in: the Operator prepares, a different Reviewer approves",
  "Set the policy: wait period, fatigue rest, holdout",
  "Upload the portfolio: checked against the system's history",
  "Generate results: one decision and reason per loan",
  "Work the queues: Retry (previous payers first), Waiting (soonest check), Needs attention (filter by reason)",
  "Open a loan: what to do, its three requests, matched rule and date math",
  "Submit; the reviewer sees the amounts and approves, which releases the requests",
].map((t, i, a) => ({ text: t, options: { bullet: { type: "number" }, breakLine: i < a.length - 1, paraSpaceAfter: 6 } })), { x: 0.5, y: 1.2, w: 4.3, h: 3.9, fontSize: 12 });
shot(s, "c_results.png", 5.0, 1.2, 4.5, 1.63, "Results screenshot", "Results screen with totals and the retry queue");
shot(s, "c_released.png", 5.0, 3.0, 4.5, 1.94, "Released screenshot", "Approved analysis with released payment requests");
s.addNotes("'Released, not sent': the file is ready for Belvo's rails; the MVP has no bank connection by design.");


// 9 Configuration, buttons and dashboard
s = content("Product", "Configuration, buttons and the dashboard view");
shot(s, "c_config.png", 0.5, 1.15, 4.3, 1.09, "Config screenshot", "Policy pickers on the New analysis panel");
table(s, ["Parameter", "Options", "Default", "Effect (7-day wait)"], [
  [{ text: "Wait after insufficient funds", options: { bold: true } }, "3, 7, 14 days", "7", "Retry 404 / 400 / 396"],
  [{ text: "Fatigue rest", options: { bold: true } }, "Off, 10, 20, 30", "20", "Resting 0 / 1,752 / 1,623 / 1,326"],
  [{ text: "Holdout", options: { bold: true } }, "0, 10, 20%", "10%", "About 0 / 40 / 80 loans"],
], { x: 0.5, y: 2.45, w: 4.3, colW: [1.35, 0.95, 0.65, 1.35], rowH: 0.42, fontSize: 10, objectName: "Parameters table" });
T(s, "Set per analysis before the check; locked once results exist (a change means a new revision); inherited by revisions.", { x: 0.5, y: 4.45, w: 4.3, h: 0.6, fontSize: 11, color: C.text2 });
card(s, 5.1, 1.15, 4.4, 3.9, "Buttons card");
T(s, "Buttons and panels", { x: 5.3, y: 1.3, w: 4.0, h: 0.35, fontSize: 14, bold: true, color: C.accent1 });
T(s, bullets([
  "Generate results: SQL rules plus draft payment requests (operator)",
  "Submit for review / Withdraw (operator)",
  "Approve and release payments / Request changes with comment (reviewer)",
  "Payment requests panel: totals by tranche, holdout, download, import responses",
  "Holdout experiment panel: retried vs held-out loans",
  "Totals strip: the dashboard view; a portfolio dashboard is post-MVP",
], { paraSpaceAfter: 4 }), { x: 5.3, y: 1.72, w: 4.0, h: 3.25, fontSize: 11 });
pres.addSection({ title: "Impact" });

// 10 Results and impact
s = content("Impact", "398 to retry today, and 60% fewer requests");
s.addChart(pres.charts.BAR, [{ name: "Share stopped by the rules", labels: ["Debit requests", "Chargeback events", "Money collected (upper bound at risk)"], values: [60.0, 35.5, 17.4] }], {
  x: 0.5, y: 1.2, w: 5.3, h: 3.8, barDir: "bar", showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: '0.0"%"',
  chartColors: [HEX.accent1, HEX.accent3, HEX.accent4], varyColors: true, showLegend: false, valAxisHidden: true, valAxisMaxVal: 100,
  showTitle: true, title: "Share of historical attempts the rules would have stopped", titleFontSize: 12, titleColor: HEX.dk1, catAxisOrientation: "maxMin", ...chartText,
});
card(s, 6.1, 1.2, 3.4, 1.55, "Today card");
T(s, "Today (7-day wait)", { x: 6.3, y: 1.3, w: 3.0, h: 0.3, fontSize: 12, bold: true, color: C.text2 });
T(s, [{ text: "398 ", options: { bold: true, color: HEX.accent1 } }, { text: "retry  " }, { text: "1,951 ", options: { bold: true, color: HEX.accent5 } }, { text: "wait  " }, { text: "713 ", options: { bold: true, color: HEX.accent4 } }, { text: "person" }],
  { x: 6.3, y: 1.65, w: 3.0, h: 0.45, fontSize: 15 });
T(s, "1,623 of the waiting are resting; 58 tests pass", { x: 6.3, y: 2.15, w: 3.0, h: 0.5, fontSize: 11, color: C.text2 });
stat(s, 6.1, 2.95, 3.4, "2.1x", "MXN collected per 1,000 requests: 4,719 today, 9,734 on the attempts kept", "Stat efficiency");
T(s, "17.4% is a ceiling, not a loss: rested loans are retried after 30 days. The holdout measures the real figure.", { x: 6.1, y: 4.58, w: 3.4, h: 0.5, fontSize: 10, color: C.text2 });
// 14 Green light
s = content("Impact", "What we'll measure to give the green light");
table(s, ["Metric", "Definition", "Green light when"], [
  [{ text: "Retained recovery (north star)", options: { bold: true } }, "MXN recovered per eligible loan over 90 days, net of reversals, treatment vs holdout", "Loss vs control within the threshold agreed with the lender before the test"],
  [{ text: "Requests avoided", options: { bold: true } }, "Debit attempts per loan per month vs the lender's baseline", "Clearly lower; target set from the lender's own replay"],
  [{ text: "Chargeback rate", options: { bold: true } }, "Chargebacks per 1,000 attempts", "Lower than baseline"],
  [{ text: "Recovery per attempt", options: { bold: true } }, "MXN per 1,000 requests", "Higher than baseline"],
  [{ text: "Guardrails", options: { bold: true } }, "Complaints, unauthorized or excess debits, review queue age, errors", "No increase; zero unauthorized debits"],
], { x: 0.5, y: 1.1, w: 9, colW: [2.3, 3.8, 2.9], rowH: 0.5, fontSize: 11, objectName: "Green light table" });
T(s, "Decision rule: a policy ships to a client only after a 90-day holdout clears every row. Kill if recovery loss exceeds the threshold.", { x: 0.5, y: 4.72, w: 9, h: 0.42, fontSize: 12, bold: true });

// 15 Scalable product and expansion
pres.addSection({ title: "Strategy" });
s = content("Strategy", "A scalable Belvo product, and what Brazil changes");
[["Mexico", "Direct debit", "The lender decides when to retry. Smart Retry decides whether, when and how much: the MVP as built.", C.accent1],
 ["Brazil", "Pix Automático", "The payer's bank retries in a central-bank window (to confirm). Value moves upstream: which charges, how much, when to stop.", C.accent3],
 ["Colombia", "Pay-by-bank recurring", "Same decision layer with its own code dictionary and policy pack, after Mexico and Brazil.", C.accent5]].forEach(([country, rail, body, color], i) => {
  const x = 0.5 + i * 3.075;
  card(s, x, 1.15, 2.85, 2.2, `Market ${country}`);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 0.2, y: 1.28, w: 1.3, h: 0.38, fill: { color }, line: { color }, rectRadius: 0.06, objectName: `Market label ${i + 1}` });
  T(s, country, { x: x + 0.2, y: 1.28, w: 1.3, h: 0.38, fontSize: 13, bold: true, color: C.background1, align: "center", valign: "middle" });
  T(s, rail, { x: x + 1.6, y: 1.28, w: 1.1, h: 0.38, fontSize: 11, bold: true, valign: "middle" });
  T(s, body, { x: x + 0.2, y: 1.78, w: 2.45, h: 1.5, fontSize: 12, color: C.text2 });
});
card(s, 0.5, 3.5, 9, 1.55, "Scale card");
T(s, "From MVP to product", { x: 0.7, y: 3.6, w: 8.6, h: 0.32, fontSize: 13, bold: true });
T(s, bullets([
  "Inputs: from a CSV to Belvo's own payment events; execution: scheduled through Belvo's rails after release, with limits",
  "Versioned policy packs per market and rail, each with its failure-code dictionary and legal retry limits",
  "Always-on holdouts, cross-lender benchmarks by bank and code, multi-client roles and audit trail",
], { paraSpaceAfter: 3 }), { x: 0.7, y: 3.95, w: 8.6, h: 1.05, fontSize: 11 });


// 13 Strategy and GTM
s = content("Strategy", "Strategy worth pursuing, and how we take it to market");
table(s, ["Option", "Verdict"], [
  [{ text: "A. Rules in Managed Collections", options: { bold: true } }, { text: "Start here", options: { bold: true, color: HEX.accent5 } }],
  [{ text: "B. Income-aware intelligence", options: { bold: true } }, { text: "Recommended", options: { bold: true, color: HEX.accent1 } }],
  [{ text: "C. Standalone ML scoring", options: { bold: true } }, { text: "No", options: { bold: true, color: HEX.accent4 } }],
  [{ text: "D. Outcome-priced recovery", options: { bold: true } }, { text: "Later", options: { bold: true, color: HEX.accent3 } }],
], { x: 0.5, y: 1.15, w: 4.5, colW: [3.1, 1.4], rowH: 0.4, fontSize: 11, objectName: "Options table" });
card(s, 0.5, 3.65, 4.5, 1.4, "Why Belvo card");
T(s, [{ text: "Why Belvo wins: ", options: { bold: true, color: HEX.accent1 } }, { text: "it owns the rails (direct debit, Pix Automático), the income data (365 days of consented inflows, IMSS) and the collections product. Paydays alone don't help (1.88% vs 1.85%), so timing must be personal." }],
  { x: 0.7, y: 3.73, w: 4.1, h: 1.24, fontSize: 11, valign: "middle" });
card(s, 5.25, 1.15, 4.25, 3.9, "GTM card");
T(s, "Go-to-market", { x: 5.45, y: 1.3, w: 3.85, h: 0.35, fontSize: 14, bold: true, color: C.accent1 });
T(s, bullets([
  "Who first: Mexican lenders already on Belvo direct debit with delinquent portfolios",
  "Hook: a free waste audit replaying their own history through the rules",
  "Pilot: 2-3 design partners, shadow-run, then a 90-day holdout",
  "Price: paid tier of Managed Collections per loan under management",
  "Channels: account teams, J.P. Morgan and dLocal partnerships",
  "Then: Brazil policy pack for Belvo's largest market",
], { paraSpaceAfter: 4 }), { x: 5.45, y: 1.72, w: 3.85, h: 3.25, fontSize: 11 });

// 14 Vision and next steps
s = content("Strategy", "Short and long term, and the next steps");
table(s, ["Horizon", "Bet", "Gate to move on"], [
  [{ text: "0-6 months", options: { bold: true } }, "Rules and holdout in Managed Collections with 2-3 design partners", "Recovery loss within the agreed threshold"],
  [{ text: "6-18 months", options: { bold: true } }, "Income-aware timing and amounts with consent; Brazil policy pack", "Enough consent; significant lift"],
  [{ text: "18-36 months", options: { bold: true } }, "One layer across Mexico, Brazil and Colombia; learn across lenders", "Privacy controls and policy audit"],
  [{ text: "3-5 years", options: { bold: true } }, "Collections OS with hardship routes when debits stop making sense", "Proven economics; regulatory review"],
], { x: 0.5, y: 1.1, w: 9, colW: [1.4, 4.6, 3.0], rowH: 0.5, fontSize: 11, objectName: "Roadmap table" });
card(s, 0.5, 3.75, 9, 1.3, "Next steps card");
T(s, [{ text: "Next steps: ", options: { bold: true, color: HEX.accent1 } },
  { text: "run the waste audit on 2-3 design partners; agree each lender's loss threshold, then a 90-day holdout; measure borrower consent and confirm Pix Automático rules. ", options: { breakLine: true } },
  { text: "Stop if ", options: { bold: true, color: HEX.accent4 } },
  { text: "recovery loss exceeds the threshold or consent is too low for income signals." }],
  { x: 0.75, y: 3.88, w: 8.5, h: 1.05, fontSize: 12, paraSpaceAfter: 4 });

(async () => {
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT);
})();

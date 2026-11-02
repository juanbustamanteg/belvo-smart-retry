// Smart Retry presentation. Built from the master spec and the MVP's executed results.
// Run: node build_deck.js [output.pptx]  (needs pptxgenjs and the pptx skill's apply_theme.js beside it)
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const { applyTheme } = require("./apply_theme.js");

const D = __dirname;
const OUT = process.argv[2] || path.join(D, "Belvo_Smart_Retry_Presentation.pptx");
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

// ================================================================== Title and agenda
pres.addSection({ title: "Opening" });
s = pres.addSlide({ masterName: "DARK_TITLE", sectionTitle: "Opening" });
s.addText("Smart Retry", { placeholder: "title" });
s.addText("Which loans to retry, when, and for how much. A working MVP on the two challenge files, and the product strategy behind it.", { placeholder: "body" });
s.addNotes("Smart Retry decides, for every loan in the portfolio, whether to retry collection now, wait, or send it to a person, and turns approved retries into payment requests. It is a working local app.");

s = content("Opening", "What this deck answers");
[["Problem and data", "What is broken, what the data shows, our hypotheses and scope"],
 ["Logic and process", "Heuristics, trade-offs and the end-to-end flow"],
 ["The product", "How a Belvo operator uses it, what they see, how parameters work"],
 ["Impact and measurement", "Potential impact and the results that earn a green light"],
 ["Scale and strategy", "From MVP to a Belvo product, Brazil and beyond, GTM, vision"]].forEach(([h, b], i) => {
  const y = 1.2 + i * 0.78;
  badge(s, 0.5, y + 0.05, 0.5, String(i + 1), i % 2 ? C.accent5 : C.accent1, `Agenda badge ${i + 1}`);
  T(s, h, { x: 1.2, y: y + 0.02, w: 3.0, h: 0.55, fontSize: 16, bold: true, valign: "middle" });
  T(s, b, { x: 4.2, y: y + 0.02, w: 5.3, h: 0.55, fontSize: 13, color: C.text2, valign: "middle" });
});

// ================================================================== Problem and data
divider("Problem", "Problem and data", "What is broken, what the two files show, and what we set out to test");

s = content("Problem", "Retries keep hitting the same empty accounts");
stat(s, 0.5, 1.25, 2.85, "97.6%", "of 253,006 payment requests in the history failed", "Stat failed");
stat(s, 3.575, 1.25, 2.85, "68%", "of today's retry candidates have never paid once", "Stat never paid", C.accent3);
stat(s, 6.65, 1.25, 2.85, "12", "median insufficient-funds failures in a row for a candidate", "Stat streak", C.accent4);
T(s, bullets([
  "The brief: retries run without discretion, cause chargebacks and waste bandwidth on accounts with no funds or blocked accounts.",
  "Job to be done: give a Belvo operator a defensible list of which loans to debit, when, and for how much, and stop the rest.",
]), { x: 0.5, y: 3.1, w: 9, h: 1.8, fontSize: 14, color: C.text2 });
s.addNotes("3,062 loans, 253,006 requests over 22 months, 1,383 chargebacks. 273 of the 400 seven-day retry candidates never had a successful request.");

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
s.addNotes("Failure codes and messages are preserved as received (Spanish). The latest batch, with every member, is the unit of decision.");

s = content("Problem", "Hypotheses we tested against the data");
table(s, ["Hypothesis", "Evidence in the history", "Status"], [
  ["Insufficient-funds failures can recover after a wait", "Kept attempts succeed 4.37%, twice the 2.22% average", { text: "Supported", options: { bold: true, color: HEX.accent1 } }],
  ["Hard failures (cancelled, blocked) don't recover", "Retries right after one: 0.19% success", { text: "Supported", options: { bold: true, color: HEX.accent1 } }],
  ["Long insufficient-funds streaks rarely pay", "20+ in a row: 0.60% success on 45% of requests", { text: "Supported", options: { bold: true, color: HEX.accent1 } }],
  ["Chargebacks repeat", "22.9% of retries after a chargeback were charged back again", { text: "Supported", options: { bold: true, color: HEX.accent1 } }],
  ["Calendar paydays raise success", "1.88% on paydays vs 1.85% other days", { text: "Rejected", options: { bold: true, color: HEX.accent4 } }],
  ["Retrying beats not retrying", "No counterfactual in the data", { text: "To test (holdout)", options: { bold: true, color: HEX.accent3 } }],
], { x: 0.5, y: 1.15, w: 9, colW: [3.5, 3.9, 1.6], rowH: 0.5, objectName: "Hypotheses table" });
s.addNotes("Final statuses only, surviving overdue loans: associations, not causal proof. That is why the last hypothesis needs a holdout.");

s = content("Problem", "Scope and constraints we set");
[["In scope", ["Mexico, MXN (inferred from bank codes)", "All 3,062 loans, one decision each", "Fixed evaluation date: 2025-11-11 23:59:59 Mexico City", "Payment requests in the bank's own nine-column format"], C.accent1],
 ["Out of scope, on purpose", ["Sending money or connecting to a bank", "Per-loan amount choice or predictive scoring", "Manual overrides of a decision", "Multi-merchant tenancy"], C.accent4],
 ["Known limits", ["No live check of authorization, account or current debt", "History has final statuses only", "No cost per attempt, so no peso savings claimed", "Small holdout today (about 40 loans)"], C.accent3]].forEach(([h, items, color], i) => {
  const x = 0.5 + i * 3.075;
  card(s, x, 1.2, 2.85, 3.75, `Scope card ${i + 1}`);
  T(s, h, { x: x + 0.2, y: 1.35, w: 2.45, h: 0.4, fontSize: 15, bold: true, color });
  T(s, bullets(items, { paraSpaceAfter: 5 }), { x: x + 0.2, y: 1.85, w: 2.45, h: 3.0, fontSize: 12 });
});

// ================================================================== Logic and process
divider("Logic", "Logic and process", "The heuristics, the trade-offs behind them and the end-to-end flow");

s = content("Logic", "Ten ordered rules; the first match decides");
[["Needs attention", "Rules 1-7", "Missing balance, no history, inconsistent times, chargeback, mixed or repeated attempts, a success to reconcile, or any failure other than insufficient funds (code 04)", C.accent4],
 ["Resting", "Rule 8", "20+ insufficient-funds failures in a row: wait 30 days instead of the cooldown", C.accent3],
 ["Waiting", "Rule 9", "Insufficient funds, cooldown (3, 7 or 14 days) not over yet: shows the next check date", C.accent5],
 ["Retry candidate", "Rule 10", "Insufficient funds and the wait has passed: gets three draft payment requests", C.accent1]].forEach(([head, rule, body, color], i) => {
  const y = 1.2 + i * 0.95;
  card(s, 0.5, y, 9, 0.8, `Rule card ${i + 1}`);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.65, y: y + 0.15, w: 2.1, h: 0.5, fill: { color }, line: { color }, rectRadius: 0.06, objectName: `Rule label ${i + 1}` });
  T(s, head, { x: 0.65, y: y + 0.15, w: 2.1, h: 0.5, fontSize: 14, bold: true, color: C.background1, align: "center", valign: "middle" });
  T(s, rule, { x: 2.95, y: y + 0.12, w: 1.0, h: 0.56, fontSize: 12, bold: true, color: C.text2, valign: "middle" });
  T(s, body, { x: 3.95, y: y + 0.08, w: 5.4, h: 0.64, fontSize: 12, valign: "middle" });
});
s.addNotes("Only the latest attempt decides and every request in it counts. SQL is the only decision engine; each loan stores the matched rule and the date math.");

s = content("Logic", "Heuristics in plain words");
[["Look at the latest attempt, all of it", "Six simultaneous requests are six pieces of evidence, never deduplicated"],
 ["When in doubt, a person decides", "Anything ambiguous or not clearly 'no funds' is never retried automatically"],
 ["Give money time to arrive", "Wait 3, 7 or 14 days after an insufficient-funds failure, from the attempt's completion date in Mexico City"],
 ["Stop the treadmill", "After 20 failures in a row, rest 30 days instead of retrying weekly"],
 ["Ask for less, in steps", "Requests split 5%, 25% and 70% of the balance, the most common historical pattern"],
 ["Prove it with a control", "10% of candidates are held out to measure what retrying adds"]].forEach(([h, b], i) => {
  const x = 0.5 + (i % 2) * 4.6, y = 1.2 + Math.floor(i / 2) * 1.27;
  card(s, x, y, 4.4, 1.12, `Heuristic ${i + 1}`);
  T(s, h, { x: x + 0.2, y: y + 0.12, w: 4.0, h: 0.35, fontSize: 14, bold: true });
  T(s, b, { x: x + 0.2, y: y + 0.5, w: 4.0, h: 0.55, fontSize: 12, color: C.text2 });
});

s = content("Logic", "Deliberate trade-offs");
table(s, ["Choice", "Gain", "Cost"], [
  [{ text: "Conservative rules", options: { bold: true } }, "Nothing ambiguous is retried automatically", "More work for reviewers (713 loans)"],
  [{ text: "Rest instead of review for fatigue", options: { bold: true } }, "Review queue stays at 713, not 2,477", "Fatigued loans are still retried monthly"],
  [{ text: "SQL as the only engine", options: { bold: true } }, "Every decision can be inspected and reproduced", "Needs real-engine tests"],
  [{ text: "Two-person approval", options: { bold: true } }, "Four eyes on money", "Handoff friction"],
  [{ text: "Fixed 5/25/70 split", options: { bold: true } }, "Matches how operations already work", "Not optimized per loan"],
  [{ text: "Holdout group (10%)", options: { bold: true } }, "Measures what retrying actually adds", "Those loans aren't retried during the test"],
], { x: 0.5, y: 1.15, w: 9, colW: [2.9, 3.3, 2.8], rowH: 0.55, objectName: "Trade-off table" });

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

// ================================================================== The product
divider("Product", "The product", "How a Belvo operator uses the MVP, what they see and how parameters work");

s = content("Product", "How a Belvo operator interacts with the MVP");
[["Sign in", "Two roles: Operator prepares, Reviewer approves"],
 ["Set the policy", "Wait period, fatigue rest and holdout size"],
 ["Upload the portfolio", "Checked on upload against the system's history"],
 ["Generate results", "One decision and reason for every loan"],
 ["Work the queues", "Open any loan to see what to do and why"],
 ["Submit", "The whole revision goes to a different person"]].forEach(([h, b], i) => {
  const x = 0.5 + (i % 3) * 3.075, y = 1.2 + Math.floor(i / 3) * 1.25;
  badge(s, x, y + 0.05, 0.5, String(i + 1), C.accent1, `Interaction badge ${i + 1}`);
  T(s, h, { x: x + 0.65, y, w: 2.2, h: 0.4, fontSize: 14, bold: true });
  T(s, b, { x: x + 0.65, y: y + 0.42, w: 2.2, h: 0.7, fontSize: 12, color: C.text2 });
});
card(s, 0.5, 3.75, 9, 1.2, "After approval card");
T(s, [{ text: "After approval: ", options: { bold: true } }, { text: "download the released payment requests, hand them to the rails, import the bank's responses and start a follow-up analysis. Every step is one primary button for the person whose turn it is." }],
  { x: 0.75, y: 3.9, w: 8.5, h: 0.9, fontSize: 13, valign: "middle" });
s.addNotes("The operator never sees SQL or rule codes on the main screens.");

s = content("Product", "What the operator sees: queues, reasons and evidence");
shot(s, "c_results.png", 0.5, 1.2, 5.6, 2.02, "Results screenshot", "Results screen with full-run totals and the retry candidate queue");
shot(s, "c_detail.png", 6.6, 1.2, 2.33, 3.88, "Loan detail screenshot", "Loan detail side panel");
T(s, bullets([
  "Totals for the whole run, kept apart from the rows on screen",
  "Three tabs: Retry candidates (previous payers first), Waiting (soonest check first), Needs attention (filter by reason)",
  "Table: loan, outstanding, plain-language why, next check, last paid, failures in a row",
  "Side panel: what to do, the three requests, matched rule, date math, every request in the latest attempt",
], { paraSpaceAfter: 4 }), { x: 0.5, y: 3.4, w: 5.8, h: 1.7, fontSize: 12, color: C.text2 });

s = content("Product", "Buttons, panels and the dashboard view");
table(s, ["Element", "What it does", "Who sees it"], [
  [{ text: "Generate results", options: { bold: true } }, "Runs the SQL rules and drafts payment requests", "Operator"],
  [{ text: "Submit for review / Withdraw", options: { bold: true } }, "Sends the whole revision to the reviewer, or pulls it back", "Operator"],
  [{ text: "Approve and release payments", options: { bold: true } }, "Accepts the analysis and releases its requests", "Reviewer"],
  [{ text: "Request changes", options: { bold: true } }, "Returns it with a required comment", "Reviewer"],
  [{ text: "Payment requests panel", options: { bold: true } }, "Requests, total by tranche, holdout, download, import responses", "Both"],
  [{ text: "Holdout experiment panel", options: { bold: true } }, "Retried vs held-out loans and recovery once measured", "Both"],
  [{ text: "Totals strip", options: { bold: true } }, "The run at a glance: loans, retry, waiting, attention, policy", "Both"],
], { x: 0.5, y: 1.1, w: 9, colW: [2.6, 4.6, 1.8], rowH: 0.38, fontSize: 11, objectName: "Elements table" });
T(s, "No separate dashboard yet, on purpose: the totals strip and the two panels are the operational view. A portfolio dashboard across analyses is a post-MVP item.", { x: 0.5, y: 4.72, w: 9, h: 0.42, fontSize: 11, color: C.text2 });

s = content("Product", "How parameter configuration works");
shot(s, "c_config.png", 0.5, 1.2, 4.3, 1.09, "Config screenshot", "Policy pickers on the New analysis panel");
table(s, ["Parameter", "Options", "Default", "Effect (7-day wait)"], [
  [{ text: "Wait after insufficient funds", options: { bold: true } }, "3, 7, 14 days", "7", "Retry 404 / 400 / 396"],
  [{ text: "Fatigue rest", options: { bold: true } }, "Off, 10, 20, 30", "20", "Resting 0 / 1,752 / 1,623 / 1,326"],
  [{ text: "Holdout", options: { bold: true } }, "0, 10, 20%", "10%", "About 0 / 40 / 80 loans held out"],
], { x: 5.05, y: 1.2, w: 4.45, colW: [1.35, 0.95, 0.7, 1.45], rowH: 0.42, fontSize: 10, objectName: "Parameters table" });
T(s, bullets([
  "Set per analysis, before checking the portfolio; shown to the reviewer next to the totals",
  "Locked once results exist: a change means a new revision, so approved results never change underneath anyone",
  "A revision inherits the parent's policy unless the operator changes it",
  "The evaluation date is fixed for the exercise and not editable; the review set (713) doesn't move with any parameter",
], { paraSpaceAfter: 4 }), { x: 0.5, y: 3.25, w: 9, h: 1.85, fontSize: 12 });
s.addNotes("Only these three parameters exist. A longer wait can only remove retry candidates, never add them. Fatigue off reproduces the reference counts exactly.");

s = content("Product", "Approval puts four eyes on the money");
shot(s, "c_review.png", 0.5, 1.2, 4.3, 2.17, "Reviewer screenshot", "Reviewer screen showing the request total before approving");
shot(s, "c_released.png", 5.2, 1.2, 4.3, 1.85, "Released screenshot", "Approved analysis with released payment requests");
T(s, bullets([
  "Before approving, the reviewer sees how many requests and how much money will be released",
  "'Released, not sent': ready for Belvo's rails. The MVP has no bank connection by design",
  "Only retry candidates outside the control group get released requests; everyone else is NONE in the CSV",
]), { x: 0.5, y: 3.6, w: 9, h: 1.45, fontSize: 13, color: C.text2 });

// ================================================================== Impact and measurement
divider("Impact", "Impact and measurement", "What the rules would have changed, and what earns a green light");

s = content("Impact", "398 to retry, 1,951 to wait, 713 for a person");
s.addChart(pres.charts.BAR, [{ name: "Loans", labels: ["Retry candidates", "Waiting: cooldown", "Waiting: resting", "Needs attention"], values: [398, 328, 1623, 713] }], {
  x: 0.5, y: 1.2, w: 5.4, h: 3.8, barDir: "bar", showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: "#,##0",
  chartColors: [HEX.accent1, HEX.accent5, HEX.accent3, HEX.accent4], varyColors: true, showLegend: false, valAxisHidden: true,
  showTitle: true, title: "Loans by decision (7-day wait, default policy)", titleFontSize: 12, titleColor: HEX.dk1, catAxisOrientation: "maxMin", ...chartText,
});
card(s, 6.2, 1.2, 3.3, 3.8, "Attention breakdown card");
T(s, "Why 713 need a person", { x: 6.4, y: 1.35, w: 2.9, h: 0.4, fontSize: 15, bold: true });
T(s, [["605", "account, authorization or unknown failure"], ["37", "last attempt charged back"], ["29", "no payment history"],
  ["27", "last attempt succeeded: reconcile"], ["15", "simultaneous attempts disagree"]]
  .map(([n, t], i, a) => ({ text: `${n}  ${t}`, options: { breakLine: i < a.length - 1, paraSpaceAfter: 6 } })), { x: 6.4, y: 1.85, w: 2.9, h: 2.2, fontSize: 13 });
T(s, "Fatigue off reproduces the reference: 400 / 1,949 / 713.", { x: 6.4, y: 4.2, w: 2.9, h: 0.6, fontSize: 11, color: C.text2 });

s = content("Impact", "60% fewer requests across 22 months of history");
s.addChart(pres.charts.BAR, [{ name: "Share stopped by the rules", labels: ["Debit requests", "Chargeback events", "Money collected (upper bound at risk)"], values: [60.0, 35.5, 17.4] }], {
  x: 0.5, y: 1.2, w: 5.3, h: 3.8, barDir: "bar", showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: '0.0"%"',
  chartColors: [HEX.accent1, HEX.accent3, HEX.accent4], varyColors: true, showLegend: false, valAxisHidden: true, valAxisMaxVal: 100,
  showTitle: true, title: "Share of historical attempts the rules would have stopped", titleFontSize: 12, titleColor: HEX.dk1, catAxisOrientation: "maxMin", ...chartText,
});
stat(s, 6.1, 1.2, 3.4, "2.1x", "MXN collected per 1,000 requests: 4,719 today, 9,734 on the attempts kept", "Stat efficiency");
stat(s, 6.1, 2.95, 3.4, "2,240", "fewer debit attempts per 1,000 loans per month", "Stat avoided", C.accent3);
T(s, "17.4% is a ceiling, not a loss: rested loans are retried after 30 days. The holdout measures the real figure.", { x: 6.1, y: 4.58, w: 3.4, h: 0.5, fontSize: 10, color: C.text2 });
s.addNotes("Replay over 193,629 historical attempts. No peso savings claimed: attempt and chargeback costs are not in the data.");

s = content("Impact", "What we'll measure to give the green light");
table(s, ["Metric", "Definition", "Green light when"], [
  [{ text: "Retained recovery (north star)", options: { bold: true } }, "MXN recovered per eligible loan over 90 days, net of reversals, treatment vs holdout", "Loss vs control within the threshold agreed with the lender before the test"],
  [{ text: "Requests avoided", options: { bold: true } }, "Debit attempts per loan per month vs the lender's baseline", "Clearly lower; target set from the lender's own replay"],
  [{ text: "Chargeback rate", options: { bold: true } }, "Chargebacks per 1,000 attempts", "Lower than baseline"],
  [{ text: "Recovery per attempt", options: { bold: true } }, "MXN per 1,000 requests", "Higher than baseline"],
  [{ text: "Guardrails", options: { bold: true } }, "Complaints, unauthorized or excess debits, review queue age, errors", "No increase; zero unauthorized debits"],
], { x: 0.5, y: 1.1, w: 9, colW: [2.3, 3.8, 2.9], rowH: 0.5, fontSize: 11, objectName: "Green light table" });
T(s, "Decision rule: a policy ships to a client only after a 90-day holdout clears every row. Kill if recovery loss exceeds the threshold.", { x: 0.5, y: 4.72, w: 9, h: 0.42, fontSize: 12, bold: true });

s = content("Impact", "Verified by executed tests, not by claims");
stat(s, 0.5, 1.25, 2.85, "42", "backend tests on real SQLite and the original files", "Stat pytest");
stat(s, 3.575, 1.25, 2.85, "16", "browser tests covering acceptance scenarios E01-E15 and the payment loop", "Stat e2e");
stat(s, 6.65, 1.25, 2.85, "0", "loans where the SQL streak differs from an independent Python check", "Stat oracle");
T(s, [
  { text: "Proven: ", options: { bold: true } },
  { text: "reference counts at 3, 7 and 14 days, decisions unchanged by row order, permissions and stale-approval races, approved-only export, request split and reconciliation.", options: { breakLine: true } },
  { text: "Not proven: ", options: { bold: true, color: HEX.accent4 } },
  { text: "recovery lift, avoided chargebacks, operator time saved, live eligibility." },
], { x: 0.5, y: 3.1, w: 9, h: 1.7, fontSize: 14, paraSpaceAfter: 8 });

// ================================================================== Scale and strategy
divider("Strategy", "Scale and strategy", "From MVP to a scalable Belvo product, other markets, GTM and vision");

s = content("Strategy", "From MVP to a scalable Belvo product");
table(s, ["Layer", "MVP today", "Scalable product"], [
  [{ text: "Inputs", options: { bold: true } }, "Portfolio CSV; history imported at setup", "API and webhooks from Belvo's own payment events, near real time"],
  [{ text: "Decision engine", options: { bold: true } }, "One SQL rule set, one market", "Versioned policy packs per market and rail, per-client settings with guardrails"],
  [{ text: "Failure codes", options: { bold: true } }, "Mexican direct-debit codes", "A dictionary per rail mapping bank codes to soft, hard and dispute"],
  [{ text: "Execution", options: { bold: true } }, "Released file, sent by someone else", "Scheduled through Belvo's rails after release, with limits"],
  [{ text: "Learning", options: { bold: true } }, "One holdout per run", "Always-on holdouts and cross-lender benchmarks by bank and code"],
  [{ text: "Tenancy", options: { bold: true } }, "One demo merchant, two users", "Multi-client, roles, audit trail, SSO"],
], { x: 0.5, y: 1.15, w: 9, colW: [1.8, 3.2, 4.0], rowH: 0.56, objectName: "Scale table" });

s = content("Strategy", "Brazil changes where Smart Retry adds value");
[["Mexico", "Direct debit (domiciliación)", "The lender decides when to retry. Smart Retry decides whether, when and how much: the MVP as built.", C.accent1],
 ["Brazil", "Pix Automático (since June 2025)", "The payer's bank retries within a window set by the central bank (details to confirm). Value moves upstream: which charges to schedule, amounts, and when to stop and switch to a hardship path.", C.accent3],
 ["Colombia", "Pay-by-bank recurring payments", "Same decision layer, plus a new code dictionary and policy pack. Start once the Mexico and Brazil packs are proven.", C.accent5]].forEach(([country, rail, body, color], i) => {
  const x = 0.5 + i * 3.075;
  card(s, x, 1.2, 2.85, 3.0, `Market ${country}`);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 0.2, y: 1.35, w: 1.5, h: 0.42, fill: { color }, line: { color }, rectRadius: 0.06, objectName: `Market label ${i + 1}` });
  T(s, country, { x: x + 0.2, y: 1.35, w: 1.5, h: 0.42, fontSize: 14, bold: true, color: C.background1, align: "center", valign: "middle" });
  T(s, rail, { x: x + 0.2, y: 1.9, w: 2.45, h: 0.45, fontSize: 12, bold: true });
  T(s, body, { x: x + 0.2, y: 2.38, w: 2.45, h: 1.75, fontSize: 12, color: C.text2 });
});
T(s, [{ text: "What scales across markets: ", options: { bold: true } }, { text: "the ordered rules, the holdout method, the review flow and the evidence trail. What changes: failure codes, legal retry limits, rail timing. Brazil is Belvo's largest market, so the policy-pack design matters early." }],
  { x: 0.5, y: 4.35, w: 9, h: 0.75, fontSize: 12 });
s.addNotes("Pix Automático retry rules: public sources disagree (same-day retries by the payer's bank vs retries over several days). Confirm against the central bank's regulation before designing the Brazil pack.");

s = content("Strategy", "Four strategies weighed; one is worth pursuing");
[["A", "Rules in Managed Collections", "Cheap and shippable now; the impact shown comes from rules alone", "Easy to copy; value plateaus after the obvious waste", "Start here", C.accent5],
 ["B", "Income-aware intelligence", "Debit when each borrower actually gets paid, using consented open-finance data Belvo already has", "Consent from delinquent borrowers and real lift are unproven", "Recommended", C.accent1],
 ["C", "Standalone ML scoring", "Bigger market beyond Belvo's rails", "Competes with lenders' own models; no data moat", "No", C.accent4],
 ["D", "Outcome-priced recovery", "Highest revenue per loan", "Takes credit, compliance and ops risk before the evidence", "Later", C.accent3]].forEach(([k, head, pro, con, verdict, color], i) => {
  const x = 0.5 + (i % 2) * 4.6, y = 1.2 + Math.floor(i / 2) * 1.95;
  card(s, x, y, 4.4, 1.8, `Option ${k}`, i === 1 ? C.accent2 : C.background2);
  T(s, `${k}. ${head}`, { x: x + 0.2, y: y + 0.14, w: 2.8, h: 0.36, fontSize: 14, bold: true, valign: "middle" });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 3.05, y: y + 0.14, w: 1.2, h: 0.36, fill: { color }, line: { color }, rectRadius: 0.06, objectName: `Verdict ${k}` });
  T(s, verdict, { x: x + 3.05, y: y + 0.14, w: 1.2, h: 0.36, fontSize: 11, bold: true, color: C.background1, align: "center", valign: "middle" });
  T(s, [{ text: "For: ", options: { bold: true } }, { text: pro, options: { breakLine: true } }, { text: "Against: ", options: { bold: true } }, { text: con }],
    { x: x + 0.2, y: y + 0.62, w: 4.0, h: 1.1, fontSize: 12, paraSpaceAfter: 3 });
});

s = content("Strategy", "Why Belvo can win this");
[["Rails", "Direct debit from any Mexican bank account; Pix Automático in Brazil since its launch day"],
 ["Income data", "Incomes API summarizes 365 days of a consented account's inflows; IMSS employment records"],
 ["Collections", "Managed Collections and an income estimator already in market"]].forEach(([head, body], i) => {
  const x = 0.5 + i * 3.075;
  badge(s, x + 1.07, 1.25, 0.7, String(i + 1), C.accent1, `Asset ${i + 1} badge`);
  T(s, head, { x, y: 2.1, w: 2.85, h: 0.4, fontSize: 16, bold: true, align: "center" });
  T(s, body, { x, y: 2.5, w: 2.85, h: 1.0, fontSize: 12, color: C.text2, align: "center" });
});
card(s, 0.5, 3.45, 9, 1.25, "Payday insight card");
T(s, [{ text: "Calendar paydays don't help: ", options: { bold: true } },
  { text: "attempts on days 1, 2, 15, 16, 30 and 31 succeeded 1.88% of the time vs 1.85% on other days. If timing matters, it is each borrower's own timing, and only consented account data shows it." }],
  { x: 0.75, y: 3.63, w: 8.5, h: 0.95, fontSize: 13 });
s.addNotes("Sources checked 2026-11-02: Belvo developer docs, Belvo 2025 recap, The Paypers.");

s = content("Strategy", "Go-to-market: lead with a free waste audit");
[["Who first", "Lenders already collecting through Belvo direct debit in Mexico, with delinquent portfolios and high failure rates"],
 ["Hook", "Replay their own history through the rules: requests avoided, chargebacks avoided, recovery at risk"],
 ["Pilot", "2-3 design partners: shadow-run, then a 90-day holdout with a loss threshold agreed up front"],
 ["Package and price", "Paid tier of Managed Collections, per loan under management; income-aware tier once lift is proven"],
 ["Channels", "Existing account teams and the J.P. Morgan and dLocal direct-debit partnerships"],
 ["Then", "Brazil policy pack for Pix Automático, sold to Belvo's largest client base"]].forEach(([h, b], i) => {
  const y = 1.15 + i * 0.66;
  T(s, h, { x: 0.5, y, w: 2.1, h: 0.58, fontSize: 14, bold: true, color: C.accent1, valign: "middle" });
  card(s, 2.7, y, 6.8, 0.58, `GTM row ${i + 1}`);
  T(s, b, { x: 2.9, y, w: 6.45, h: 0.58, fontSize: 12, valign: "middle" });
});
s.addNotes("The replay is the sales asset: about a day of analysis per lender, producing their own numbers, with the same caveats as ours.");

s = content("Strategy", "Short and long term: each step earns the next");
table(s, ["Horizon", "Bet", "Success metric", "Gate to move on"], [
  [{ text: "0-6 months", options: { bold: true } }, "Rules and holdout in Managed Collections with 2-3 design partners", "Requests avoided, chargebacks, recovery per loan vs control", "Recovery loss within the agreed threshold"],
  [{ text: "6-18 months", options: { bold: true } }, "Income-aware timing and amounts with consent; Brazil policy pack", "Success per attempt and recovery vs rules-only", "Enough consent; significant lift in a holdout"],
  [{ text: "18-36 months", options: { bold: true } }, "One layer across Mexico, Brazil and Colombia rails; learn across lenders", "Cost per peso recovered; share under managed policy", "Privacy controls and per-client policy audit"],
  [{ text: "3-5 years", options: { bold: true } }, "Collections OS: hardship and restructuring routes when debits stop making sense", "Net recovery, cure and complaint rates", "Proven economics; regulatory review"],
], { x: 0.5, y: 1.15, w: 9, colW: [1.35, 2.85, 2.5, 2.3], rowH: 0.72, objectName: "Roadmap table" });

s = content("Strategy", "How it makes money, and when to stop");
card(s, 0.5, 1.2, 4.35, 3.1, "Business model card");
T(s, "Business model", { x: 0.7, y: 1.35, w: 3.95, h: 0.4, fontSize: 16, bold: true, color: C.accent1 });
T(s, bullets(["Paid tier of Managed Collections, priced per loan under management", "Income-aware tier once a holdout proves lift",
  "Share of incremental recovery only after its risks are covered", "For Belvo: fewer failed debits per peso moved, healthier bank relationships"]),
  { x: 0.7, y: 1.85, w: 3.95, h: 3.0, fontSize: 13 });
card(s, 5.15, 1.2, 4.35, 3.1, "Kill criteria card");
T(s, "Stop or narrow if", { x: 5.35, y: 1.35, w: 3.95, h: 0.4, fontSize: 16, bold: true, color: C.accent4 });
T(s, bullets(["Recovery loss exceeds the threshold agreed with the lender", "Consent is too low for income signals to reach enough loans",
  "Using account data on delinquent borrowers raises regulatory or reputational concern", "A lender won't keep a control group: no policy change ships without one"]),
  { x: 5.35, y: 1.85, w: 3.95, h: 3.0, fontSize: 13 });

// ================================================================== Close
pres.addSection({ title: "Close" });
s = pres.addSlide({ masterName: "DARK_TITLE", sectionTitle: "Close" });
s.addText("Next steps to market", { placeholder: "title" });
s.addText([
  { text: "Run the waste audit on 2-3 design-partner portfolios", options: { bullet: true, breakLine: true } },
  { text: "Agree each lender's loss threshold, then a 90-day holdout", options: { bullet: true, breakLine: true } },
  { text: "Measure borrower consent for income-aware timing; confirm Pix Automático rules", options: { bullet: true } },
], { placeholder: "body", paraSpaceAfter: 6 });
s.addNotes("Included: the MVP with one-command setup, result, payment-request and testing CSVs, happy-path and edge-case demo videos, the user guide and the PRD.");

(async () => {
  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT);
})();

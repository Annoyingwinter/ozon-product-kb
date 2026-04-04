const pptxgen = require("pptxgenjs");

// ============================================================
// AlphaShop Hackathon Pitch Deck — V5 (Premium Dark Gradient)
// Trend: Large typography, gradient accents, asymmetric layout
// ============================================================

const C = {
  bg:         "080E1A",  // deep dark
  bgCard:     "0D1629",  // slightly lighter
  navy:       "131D38",
  accent1:    "00D4AA",  // mint green
  accent2:    "00B4D8",  // cyan
  accent3:    "7C83FD",  // soft purple
  white:      "FFFFFF",
  offWhite:   "E8ECF1",
  muted:      "6B7B96",
  dimText:    "4A5568",
  red:        "FF6B6B",
  orange:     "FFB347",
  pink:       "FF6FB5",
};

const F = { h: "Arial Black", b: "Calibri", m: "Consolas" };

const TOTAL = 12;

function addPage(slide, n) {
  slide.addText(`${n}`, {
    x: 9.3, y: 5.2, w: 0.5, h: 0.3,
    fontSize: 9, color: C.dimText, fontFace: F.b, align: "right",
  });
}

// Gradient-like accent bar at top of slide
function accentBar(slide) {
  slide.addShape("rect", { x: 0, y: 0, w: 5, h: 0.04, fill: { color: C.accent1 } });
  slide.addShape("rect", { x: 5, y: 0, w: 5, h: 0.04, fill: { color: C.accent2 } });
}

function dk(pres) {
  const s = pres.addSlide();
  s.background = { color: C.bg };
  return s;
}

// ============================================================
// 1. COVER
// ============================================================
function s01(pres) {
  const s = dk(pres);

  // Large gradient accent block
  s.addShape("rect", { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.accent1 } });

  // Giant title
  s.addText("AlphaShop", {
    x: 0.8, y: 0.8, w: 8, h: 1.2,
    fontSize: 64, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });

  // Subtitle with accent color
  s.addText("AI \u9A71\u52A8\u7684\u8DE8\u5883\u7535\u5546\u667A\u80FD\u9009\u54C1\u5E73\u53F0", {
    x: 0.8, y: 2.0, w: 8, h: 0.5,
    fontSize: 20, fontFace: F.b, color: C.accent1, margin: 0,
  });

  // Thin separator
  s.addShape("rect", { x: 0.8, y: 2.65, w: 2.5, h: 0.03, fill: { color: C.accent2 } });

  s.addText("\u4ECE\u4E2D\u56FD\u4F9B\u5E94\u94FE\u5230\u4FC4\u7F57\u65AF Ozon\nAI \u5168\u6D41\u7A0B\u81EA\u52A8\u5316\u9009\u54C1 \u00B7 \u8BC4\u4F30 \u00B7 \u4E0A\u67B6", {
    x: 0.8, y: 2.85, w: 6, h: 0.8,
    fontSize: 14, fontFace: F.b, color: C.muted, margin: 0,
  });

  // Right side: key metrics (big numbers)
  s.addText("78+", {
    x: 7.0, y: 3.5, w: 2.5, h: 0.8,
    fontSize: 48, fontFace: F.h, color: C.accent1, bold: true, align: "right", margin: 0,
  });
  s.addText("\u5DF2\u7814\u7A76\u4EA7\u54C1", {
    x: 7.0, y: 4.2, w: 2.5, h: 0.3,
    fontSize: 11, fontFace: F.b, color: C.muted, align: "right", margin: 0,
  });

  // Team info — bottom left, clean
  s.addShape("rect", { x: 0.8, y: 4.3, w: 4, h: 0.03, fill: { color: C.navy } });
  s.addText([
    { text: "\u5F6D\u5FB7\u533B\u751F\u521B\u98DE\u5176\u4ED6\u961F", options: { bold: true, color: C.white, fontSize: 12 } },
    { text: "  \u5218\u51E1\u58A8 \u00B7 \u5218\u4FCA\u5EF7  |  ", options: { color: C.muted, fontSize: 11 } },
    { text: "\u5168\u7403\u5316\u8D5B\u9053", options: { color: C.accent1, fontSize: 11, bold: true } },
  ], { x: 0.8, y: 4.5, w: 8, h: 0.4, fontFace: F.b, margin: 0 });

  addPage(s, 1);
}

// ============================================================
// 2. MARKET OPPORTUNITY
// ============================================================
function s02(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("Ozon\uFF1A\u4E2D\u56FD\u5356\u5BB6\u7684\u4E0B\u4E00\u4E2A\u201C\u4E9A\u9A6C\u900A\u201D", {
    x: 0.8, y: 0.4, w: 8, h: 0.7,
    fontSize: 28, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });

  // 3 giant stat blocks
  const stats = [
    { num: "6300\u4E07", label: "\u6708\u6D3B\u8DC3\u7528\u6237", sub: "2025 Q3\uFF0C\u540C\u6BD4+950\u4E07", color: C.accent1 },
    { num: "20\u4E07+", label: "\u4E2D\u56FD\u5356\u5BB6", sub: "\u540C\u6BD4\u589E\u957F 55%", color: C.accent2 },
    { num: "2.5\u00D7", label: "\u4E2D\u56FD\u5356\u5BB6\u4EA4\u6613\u989D\u589E\u901F", sub: "2025 Q2 \u540C\u6BD4", color: C.accent3 },
  ];

  stats.forEach((st, i) => {
    const x = 0.5 + i * 3.15;
    // Subtle background block
    s.addShape("rect", { x, y: 1.4, w: 2.9, h: 1.7, fill: { color: C.bgCard } });
    s.addShape("rect", { x, y: 1.4, w: 2.9, h: 0.04, fill: { color: st.color } });

    s.addText(st.num, {
      x, y: 1.55, w: 2.9, h: 0.75,
      fontSize: 36, fontFace: F.h, color: st.color, bold: true, align: "center", valign: "middle", margin: 0,
    });
    s.addText(st.label, {
      x, y: 2.3, w: 2.9, h: 0.35,
      fontSize: 13, fontFace: F.b, color: C.white, bold: true, align: "center", margin: 0,
    });
    s.addText(st.sub, {
      x, y: 2.65, w: 2.9, h: 0.3,
      fontSize: 10, fontFace: F.b, color: C.muted, align: "center", margin: 0,
    });
  });

  // Bottom left: GMV callout
  s.addShape("rect", { x: 0.5, y: 3.4, w: 4.5, h: 1.8, fill: { color: C.bgCard } });
  s.addText("2024 Ozon GMV", {
    x: 0.7, y: 3.5, w: 4, h: 0.3,
    fontSize: 11, fontFace: F.b, color: C.muted, margin: 0,
  });
  s.addText("2.875 \u4E07\u4EBF\u5362\u5E03", {
    x: 0.7, y: 3.8, w: 4, h: 0.6,
    fontSize: 30, fontFace: F.h, color: C.accent1, bold: true, margin: 0,
  });
  s.addText("\u540C\u6BD4\u589E\u957F 64% | \u8FDE\u7EED 5 \u5E74 30%+ \u589E\u901F", {
    x: 0.7, y: 4.4, w: 4, h: 0.3,
    fontSize: 11, fontFace: F.b, color: C.offWhite, margin: 0,
  });
  s.addText("\u6570\u636E\u6765\u6E90\uFF1AOzon 2024 \u5E74\u62A5 / 2025 Q3 \u8D22\u62A5", {
    x: 0.7, y: 4.8, w: 4, h: 0.25,
    fontSize: 9, fontFace: F.b, color: C.dimText, italic: true, margin: 0,
  });

  // Bottom right: window signals
  s.addShape("rect", { x: 5.2, y: 3.4, w: 4.4, h: 1.8, fill: { color: C.bgCard } });
  s.addText("\u7A97\u53E3\u671F\u4FE1\u53F7", {
    x: 5.4, y: 3.5, w: 4, h: 0.3,
    fontSize: 12, fontFace: F.b, color: C.accent2, bold: true, margin: 0,
  });
  const sigs = [
    "Ozon 2025 \u96F6\u4FDD\u8BC1\u91D1\u5165\u9A7B + \u4F63\u91D1\u4E0B\u8C03",
    "\u8F7B\u5C0F\u4EF6\u7269\u6D41\u6210\u672C\u76F4\u964D 30%",
    "\u591A\u6570\u5356\u5BB6\u4ECD\u7528\u4EBA\u5DE5\u9009\u54C1",
    "LLM \u8DE8\u8BED\u8A00\u80FD\u529B\u9996\u6B21\u4F7F\u81EA\u52A8\u9009\u54C1\u53EF\u884C",
  ];
  sigs.forEach((sig, i) => {
    s.addText(`\u2022  ${sig}`, {
      x: 5.4, y: 3.85 + i * 0.35, w: 4, h: 0.3,
      fontSize: 10.5, fontFace: F.b, color: C.offWhite, margin: 0,
    });
  });

  addPage(s, 2);
}

// ============================================================
// 3. PAIN POINTS
// ============================================================
function s03(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("\u4F46\u8FD9\u4E2A\u5E02\u573A\u6709\u4E00\u4E2A\u6B8B\u9177\u7684\u771F\u76F8", {
    x: 0.8, y: 0.4, w: 8, h: 0.6,
    fontSize: 28, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });

  // Hero stat
  s.addShape("rect", { x: 0.5, y: 1.3, w: 9, h: 1.3, fill: { color: C.bgCard } });
  s.addShape("rect", { x: 0.5, y: 1.3, w: 0.06, h: 1.3, fill: { color: C.red } });
  s.addText("47%", {
    x: 0.8, y: 1.35, w: 2.2, h: 1.2,
    fontSize: 60, fontFace: F.h, color: C.red, bold: true, align: "center", valign: "middle", margin: 0,
  });
  s.addText("\u7684\u8DE8\u5883\u65B0\u54C1\u56E0\u201C\u9700\u6C42\u9519\u914D\u201D\u5728 30 \u5929\u5185\u4E0B\u67B6", {
    x: 3.2, y: 1.45, w: 6, h: 0.5,
    fontSize: 18, fontFace: F.b, color: C.white, bold: true, margin: 0,
  });
  s.addText("\u5356\u5BB6\u4E0D\u4E86\u89E3\u76EE\u6807\u5E02\u573A\u504F\u597D\uFF0C\u9009\u54C1\u51E0\u4E4E\u5168\u9760\u731C  |  \u884C\u4E1A\u8C03\u7814 2024", {
    x: 3.2, y: 2.0, w: 6, h: 0.35,
    fontSize: 11, fontFace: F.b, color: C.muted, margin: 0,
  });

  // 4 pain cards — 2x2 grid
  const pains = [
    { title: "\u9009\u54C1\u5C31\u662F\u8D4C\u535A", stat: "3\u20135 \u5929/SKU", desc: "\u4ECE\u53D1\u73B0\u4EA7\u54C1\u5230\u4E0A\u67B6\u5E73\u5747 3-5 \u5929\uFF0C\u4ECD\u9700\u4EBA\u5DE5\u5224\u65AD\u5E02\u573A\u9700\u6C42", c: C.red },
    { title: "\u4FC4\u8BED\u672C\u5730\u5316\u58C1\u5792", stat: "\u4FC4\u8BED\u2260\u82F1\u8BED", desc: "\u6807\u9898/\u5356\u70B9/\u5C5E\u6027\u9700\u4E13\u4E1A\u4FC4\u8BED\uFF0C\u673A\u7FFB\u8D28\u91CF\u5DEE\uFF0C\u4EBA\u5DE5\u6210\u672C\u9AD8", c: C.orange },
    { title: "\u5229\u6DA6\u7B97\u4E0D\u6E05", stat: "47% \u672A\u8FBE\u76EE\u6807", desc: "\u4F9B\u5E94\u94FE\u00D7\u6C47\u7387\u00D7\u7269\u6D41\u00D7\u4F63\u91D1\u00D7\u9000\u8D27\uFF0C\u590D\u6742\u5230\u7C97\u7565\u4F30\u7B97", c: C.accent3 },
    { title: "\u5408\u89C4\u96F7\u533A\u5BC6\u5E03", stat: "1200+ \u5E97\u88AB\u5C01", desc: "2025 \u5DF2\u6709 1200 \u5BB6\u5E97\u94FA\u56E0\u8FDD\u89C4\u88AB\u5C01\uFF0C\u54C1\u7C7B\u9650\u5236\u590D\u6742", c: C.pink },
  ];

  pains.forEach((p, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.5 + col * 4.6;
    const y = 2.85 + row * 1.2;

    s.addShape("rect", { x, y, w: 4.35, h: 1.0, fill: { color: C.bgCard } });
    s.addShape("rect", { x, y, w: 0.06, h: 1.0, fill: { color: p.c } });

    s.addText(p.title, {
      x: x + 0.25, y: y + 0.08, w: 2.2, h: 0.3,
      fontSize: 13, fontFace: F.b, color: C.white, bold: true, margin: 0,
    });
    s.addText(p.stat, {
      x: x + 2.5, y: y + 0.08, w: 1.7, h: 0.3,
      fontSize: 11, fontFace: F.m, color: p.c, bold: true, align: "right", margin: 0,
    });
    s.addText(p.desc, {
      x: x + 0.25, y: y + 0.45, w: 3.9, h: 0.45,
      fontSize: 10, fontFace: F.b, color: C.muted, margin: 0,
    });
  });

  addPage(s, 3);
}

// ============================================================
// 4. SOLUTION PIPELINE
// ============================================================
function s04(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("AlphaShop\uFF1A\u5168\u81EA\u52A8\u9009\u54C1\uFF0C\u4E00\u952E\u4E0A\u67B6", {
    x: 0.8, y: 0.4, w: 8, h: 0.6,
    fontSize: 26, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });
  s.addText("5 \u6B65 Pipeline\uFF1A\u70B9\u51FB\u542F\u52A8\uFF0C\u65E0\u9700\u4EBA\u5DE5\u5E72\u9884", {
    x: 0.8, y: 0.95, w: 8, h: 0.35,
    fontSize: 13, fontFace: F.b, color: C.accent2, margin: 0,
  });

  const stages = [
    { n: "01", label: "\u667A\u80FD\u9009\u8BCD", desc: "\u5173\u952E\u8BCD\u6C60 + \u8D8B\u52BF\u699C\n\u81EA\u52A8\u751F\u6210\u5019\u9009" },
    { n: "02", label: "\u6570\u636E\u91C7\u96C6", desc: "1688/\u62FC\u591A\u591A\n\u6D4F\u89C8\u5668\u81EA\u52A8\u722C\u53D6" },
    { n: "03", label: "6\u7EF4\u8BC4\u5206", desc: "\u4EF7\u683C\u00B7\u7269\u6D41\u00B7\u5408\u89C4\n\u667A\u80FD\u6253\u5206\u7B5B\u9009" },
    { n: "04", label: "\u5C5E\u6027\u63A8\u65AD", desc: "\u4E2D\u6587 \u2192 \u4FC4\u8BED\nAI \u8BED\u4E49\u7EA7\u6620\u5C04" },
    { n: "05", label: "\u4E00\u952E\u4E0A\u67B6", desc: "\u751F\u6210 Listing\n\u63D0\u4EA4 Ozon API" },
  ];

  stages.forEach((st, i) => {
    const x = 0.25 + i * 1.95;
    const y = 1.6;

    // Card background
    s.addShape("rect", { x, y, w: 1.8, h: 2.6, fill: { color: C.bgCard } });

    // Step number — large, accent colored
    s.addText(st.n, {
      x, y: y + 0.1, w: 1.8, h: 0.65,
      fontSize: 32, fontFace: F.h, color: C.accent1, bold: true, align: "center", valign: "middle", margin: 0,
    });

    // Thin accent line
    s.addShape("rect", { x: x + 0.3, y: y + 0.8, w: 1.2, h: 0.02, fill: { color: C.accent1 } });

    s.addText(st.label, {
      x, y: y + 0.95, w: 1.8, h: 0.4,
      fontSize: 13, fontFace: F.b, color: C.white, bold: true, align: "center", margin: 0,
    });
    s.addText(st.desc, {
      x: x + 0.1, y: y + 1.4, w: 1.6, h: 0.8,
      fontSize: 10.5, fontFace: F.b, color: C.muted, align: "center", margin: 0,
    });

    // Arrow
    if (i < 4) {
      s.addText("\u2192", {
        x: x + 1.8, y: y + 0.2, w: 0.15, h: 0.5,
        fontSize: 14, color: C.accent2, align: "center", valign: "middle",
      });
    }
  });

  // Bottom value bar
  s.addShape("rect", { x: 0.5, y: 4.5, w: 9, h: 0.65, fill: { color: C.bgCard } });
  s.addShape("rect", { x: 0.5, y: 4.5, w: 9, h: 0.04, fill: { color: C.accent1 } });
  s.addText([
    { text: "\u6838\u5FC3\u4EF7\u503C  ", options: { bold: true, color: C.accent1, fontSize: 13 } },
    { text: "3\u20135\u5929 \u2192 10\u5206\u949F  |  \u4EBA\u5DE5\u7ECF\u9A8C \u2192 \u6570\u636E\u51B3\u7B56  |  \u673A\u7FFB \u2192 AI\u8BED\u4E49\u63A8\u65AD", options: { color: C.offWhite, fontSize: 13 } },
  ], { x: 0.8, y: 4.55, w: 8.4, h: 0.55, fontFace: F.b, valign: "middle", margin: 0 });

  addPage(s, 4);
}

// ============================================================
// 5. DEMO VIDEO
// ============================================================
function s05(pres) {
  const s = dk(pres);

  s.addShape("rect", { x: 0, y: 0, w: 10, h: 5.625, fill: { color: C.navy } });

  s.addText("DEMO", {
    x: 0.5, y: 0.6, w: 9, h: 1.5,
    fontSize: 72, fontFace: F.h, color: C.accent1, bold: true, align: "center", valign: "middle", margin: 0,
  });
  s.addText("VIDEO", {
    x: 0.5, y: 1.7, w: 9, h: 1.0,
    fontSize: 72, fontFace: F.h, color: C.accent2, bold: true, align: "center", valign: "middle", margin: 0,
  });

  s.addShape("rect", { x: 3.5, y: 2.85, w: 3, h: 0.03, fill: { color: C.accent1 } });

  s.addText("\u6F14\u793A\u89C6\u9891\uFF1A\u5168\u81EA\u52A8\u9009\u54C1\u5230\u4E0A\u67B6\u5168\u6D41\u7A0B", {
    x: 0.5, y: 3.1, w: 9, h: 0.5,
    fontSize: 18, fontFace: F.b, color: C.offWhite, align: "center", margin: 0,
  });

  const steps = [
    "\u542F\u52A8 Pipeline\uFF0C\u7CFB\u7EDF\u81EA\u52A8\u4ECE\u5173\u952E\u8BCD\u6C60\u62BD\u53D6\u5019\u9009\u4EA7\u54C1",
    "\u81EA\u52A8\u722C\u53D6 1688 \u4F9B\u5E94\u5546\u6570\u636E\uFF0C6 \u7EF4\u6A21\u578B\u5B9E\u65F6\u6253\u5206",
    "AI \u751F\u6210\u4FC4\u8BED Listing\uFF0C\u4E00\u952E\u63D0\u4EA4 Ozon \u4E0A\u67B6",
  ];

  steps.forEach((st, i) => {
    const y = 3.9 + i * 0.48;
    s.addShape("rect", { x: 2.5, y, w: 5, h: 0.38, fill: { color: C.bgCard } });
    s.addText(`${i + 1}`, {
      x: 2.6, y, w: 0.35, h: 0.38,
      fontSize: 12, fontFace: F.h, color: C.accent1, bold: true, valign: "middle", margin: 0,
    });
    s.addText(st, {
      x: 3.1, y, w: 4.3, h: 0.38,
      fontSize: 11, fontFace: F.b, color: C.offWhite, valign: "middle", margin: 0,
    });
  });

  addPage(s, 5);
}

// ============================================================
// 6. SCORING MODEL
// ============================================================
function s06(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("AI \u516D\u7EF4\u8BC4\u5206\u6A21\u578B", {
    x: 0.8, y: 0.4, w: 6, h: 0.6,
    fontSize: 26, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });
  s.addText("\u8BA9\u6570\u636E\u66FF\u4EE3\u76F4\u89C9\u505A\u51B3\u7B56", {
    x: 0.8, y: 0.95, w: 6, h: 0.3,
    fontSize: 13, fontFace: F.b, color: C.accent2, margin: 0,
  });

  const dims = [
    { name: "\u5229\u6DA6\u7A7A\u95F4", w: "25%", desc: "\u4F9B\u8D27\u4EF7\u00D712.5\u6C47\u7387\uFF0C\u76EE\u6807\u6BDB\u5229 65%+", c: C.accent1 },
    { name: "\u7269\u6D41\u53EF\u884C", w: "20%", desc: "\u91CD\u91CF<1.2kg\uFF0C\u8FB9\u957F<45cm\uFF0C\u4F4E\u6613\u788E", c: C.accent2 },
    { name: "\u7ADE\u4E89\u5F3A\u5EA6", w: "15%", desc: "Ozon\u641C\u7D22\u91CF\u5206\u6790\uFF0C\u84DD\u6D77\u4F18\u5148", c: C.accent3 },
    { name: "\u5408\u89C4\u5B89\u5168", w: "15%", desc: "\u65E0\u9650\u5236\u54C1\u7C7B\u3001\u65E0\u5371\u5316\u3001\u65E0\u8BA4\u8BC1", c: C.red },
    { name: "\u9000\u8D27\u98CE\u9669", w: "15%", desc: "\u6750\u8D28\u8010\u4E45\u3001\u6807\u51C6\u5316\u3001\u4E0D\u6613\u635F\u574F", c: C.orange },
    { name: "\u5185\u5BB9\u6F5C\u529B", w: "10%", desc: "\u89C6\u89C9\u5438\u5F15\u529B\u3001\u6613\u62CD\u7167\u3001\u8DE8\u6587\u5316", c: C.pink },
  ];

  dims.forEach((d, i) => {
    const col = i < 3 ? 0 : 1;
    const row = i % 3;
    const x = 0.5 + col * 4.65;
    const y = 1.5 + row * 1.25;

    s.addShape("rect", { x, y, w: 4.4, h: 1.05, fill: { color: C.bgCard } });
    s.addShape("rect", { x, y, w: 0.06, h: 1.05, fill: { color: d.c } });

    // Weight — big number
    s.addText(d.w, {
      x: x + 0.2, y: y + 0.05, w: 0.8, h: 0.95,
      fontSize: 22, fontFace: F.h, color: d.c, bold: true, align: "center", valign: "middle", margin: 0,
    });
    s.addText(d.name, {
      x: x + 1.1, y: y + 0.1, w: 3, h: 0.35,
      fontSize: 14, fontFace: F.b, color: C.white, bold: true, margin: 0,
    });
    s.addText(d.desc, {
      x: x + 1.1, y: y + 0.5, w: 3.1, h: 0.4,
      fontSize: 10.5, fontFace: F.b, color: C.muted, margin: 0,
    });
  });

  s.addText("\u4EF7\u683C\u7A97\u53E3 300\u20135000\u5362\u5E03  |  \u7EFC\u5408 > 60 \u5206\u81EA\u52A8\u5165\u5E93  |  \u89C4\u5219\u53EF\u914D\u7F6E", {
    x: 0.5, y: 5.1, w: 9, h: 0.3,
    fontSize: 10, fontFace: F.b, color: C.dimText, align: "center",
  });

  addPage(s, 6);
}

// ============================================================
// 7. TWO CLOSED LOOPS
// ============================================================
function s07(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("\u4E24\u5927\u667A\u80FD\u95ED\u73AF\uFF1A\u8D8A\u7528\u8D8A\u806A\u660E", {
    x: 0.8, y: 0.4, w: 8, h: 0.6,
    fontSize: 26, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });
  s.addText("\u4E0D\u53EA\u662F\u5DE5\u5177\uFF0C\u800C\u662F\u4F1A\u81EA\u6211\u8FDB\u5316\u7684\u667A\u80FD\u4F53", {
    x: 0.8, y: 0.95, w: 8, h: 0.3,
    fontSize: 13, fontFace: F.b, color: C.accent2, margin: 0,
  });

  // LEFT LOOP: Profit
  s.addShape("rect", { x: 0.3, y: 1.5, w: 4.55, h: 3.7, fill: { color: C.bgCard } });
  s.addShape("rect", { x: 0.3, y: 1.5, w: 4.55, h: 0.04, fill: { color: C.accent1 } });
  s.addText("\u5229\u6DA6\u53CD\u9988\u95ED\u73AF", {
    x: 0.5, y: 1.65, w: 4, h: 0.35,
    fontSize: 15, fontFace: F.b, color: C.accent1, bold: true, margin: 0,
  });

  const pSteps = [
    "\u4E0A\u67B6\u4EA7\u54C1 \u2192 Ozon API",
    "\u81EA\u52A8\u62C9\u53D6\u8BA2\u5355 + \u8D22\u52A1\u6570\u636E",
    "\u4F9B\u8D27\u4EF7\u00D7\u6C47\u7387 vs \u5B9E\u9645\u6536\u5165\u5339\u914D",
    "\u6536\u5165 - \u4F63\u91D1 - \u7269\u6D41 - \u9000\u8D27 - \u91C7\u8D2D\u6210\u672C",
    "\u5B9E\u65F6\u4EEA\u8868\u76D8\u663E\u793A\u6BCF\u4EA7\u54C1\u76C8\u4E8F",
  ];
  pSteps.forEach((ps, i) => {
    const y = 2.15 + i * 0.52;
    s.addText(`${i + 1}`, {
      x: 0.5, y, w: 0.3, h: 0.3,
      fontSize: 11, fontFace: F.h, color: C.accent1, bold: true, margin: 0,
    });
    s.addText(ps, {
      x: 0.9, y, w: 3.7, h: 0.3,
      fontSize: 10.5, fontFace: F.b, color: C.offWhite, margin: 0,
    });
  });
  s.addText("\u21BB \u4E8F\u635F\u54C1\u81EA\u52A8\u964D\u6743\uFF0C\u53CD\u54C8\u56DE\u9009\u54C1\u6A21\u578B", {
    x: 0.5, y: 4.85, w: 4.2, h: 0.25,
    fontSize: 10, fontFace: F.b, color: C.accent1, bold: true, margin: 0,
  });

  // RIGHT LOOP: Hot Products
  s.addShape("rect", { x: 5.15, y: 1.5, w: 4.55, h: 3.7, fill: { color: C.bgCard } });
  s.addShape("rect", { x: 5.15, y: 1.5, w: 4.55, h: 0.04, fill: { color: C.accent2 } });
  s.addText("\u70ED\u70B9\u5546\u54C1\u95ED\u73AF", {
    x: 5.35, y: 1.65, w: 4, h: 0.35,
    fontSize: 15, fontFace: F.b, color: C.accent2, bold: true, margin: 0,
  });

  const hSteps = [
    "Ozon 7 \u5929\u6D4F\u89C8\u91CF\u5206\u6790 (hits_view)",
    "\u6D4F\u89C8\u5360\u6BD4 <1% \u81EA\u52A8\u4E0B\u67B6\u5F52\u6863",
    "hit +15 / miss -10 / sale +25 \u52A8\u6001\u8BC4\u5206",
    "\u722C\u53D6 Ozon \u70ED\u5356 + 1688 \u6392\u884C\u699C\u65B0\u8BCD",
    "\u5173\u952E\u8BCD\u6C60\u4E0D\u8DB3\u65F6 AI \u81EA\u52A8\u751F\u6210\u65B0\u79CD\u5B50",
  ];
  hSteps.forEach((hs, i) => {
    const y = 2.15 + i * 0.52;
    s.addText(`${i + 1}`, {
      x: 5.35, y, w: 0.3, h: 0.3,
      fontSize: 11, fontFace: F.h, color: C.accent2, bold: true, margin: 0,
    });
    s.addText(hs, {
      x: 5.75, y, w: 3.7, h: 0.3,
      fontSize: 10.5, fontFace: F.b, color: C.offWhite, margin: 0,
    });
  });
  s.addText("\u21BB \u65B0\u5173\u952E\u8BCD\u91CD\u65B0\u8FDB\u5165 Pipeline \u9009\u54C1", {
    x: 5.35, y: 4.85, w: 4.2, h: 0.25,
    fontSize: 10, fontFace: F.b, color: C.accent2, bold: true, margin: 0,
  });

  addPage(s, 7);
}

// ============================================================
// 8. TECH ARCHITECTURE
// ============================================================
function s08(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("\u6280\u672F\u67B6\u6784", {
    x: 0.8, y: 0.4, w: 5, h: 0.6,
    fontSize: 26, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });

  // LEFT: AI Engine
  s.addShape("rect", { x: 0.3, y: 1.2, w: 4.55, h: 2.1, fill: { color: C.bgCard } });
  s.addShape("rect", { x: 0.3, y: 1.2, w: 0.06, h: 2.1, fill: { color: C.accent1 } });
  s.addText("AI \u5F15\u64CE", {
    x: 0.55, y: 1.3, w: 4, h: 0.3,
    fontSize: 14, fontFace: F.b, color: C.accent1, bold: true, margin: 0,
  });

  const ai = [
    "\u591A\u6A21\u578B\u667A\u80FD\u8DEF\u7531\uFF0C\u6839\u636E\u4EFB\u52A1\u81EA\u52A8\u9009\u62E9\u6700\u4F18\u6A21\u578B",
    "\u4E3B\u529B\u4E0D\u53EF\u7528\u65F6\u65E0\u7F1D\u5207\u6362\u5907\u7528\uFF0C\u4FDD\u969C\u53EF\u7528\u6027",
    "\u4E2D\u6587\u4EA7\u54C1\u63CF\u8FF0 \u2192 \u4FC4\u8BED\u5356\u70B9/\u6807\u9898/\u5C5E\u6027",
  ];
  ai.forEach((a, i) => {
    s.addText(`\u2022  ${a}`, {
      x: 0.55, y: 1.7 + i * 0.4, w: 4.1, h: 0.35,
      fontSize: 10.5, fontFace: F.b, color: C.offWhite, margin: 0,
    });
  });

  // RIGHT: WuKong Logic
  s.addShape("rect", { x: 5.15, y: 1.2, w: 4.55, h: 2.1, fill: { color: C.bgCard } });
  s.addShape("rect", { x: 5.15, y: 1.2, w: 0.06, h: 2.1, fill: { color: C.orange } });
  s.addText("\u201C\u609F\u7A7A\u903B\u8F91\u201D\u8D8B\u52BF\u53D1\u73B0", {
    x: 5.4, y: 1.3, w: 4, h: 0.3,
    fontSize: 14, fontFace: F.b, color: C.orange, bold: true, margin: 0,
  });

  const wk = [
    "\u5B9E\u65F6\u722C\u53D6 1688 \u8DE8\u5883\u4E13\u533A\u70ED\u9500\u5546\u54C1\u6807\u9898",
    "\u62BD\u53D6\u884C\u4E1A\u6392\u884C\u699C\u54C1\u7C7B\u8D8B\u52BF\u5173\u952E\u8BCD",
    "\u8FC7\u6EE4\u5E9F\u8BCD \u2192 \u63D0\u53D6\u6838\u5FC3\u8BCD \u2192 \u6CE8\u5165 Pipeline",
  ];
  wk.forEach((w, i) => {
    s.addText(`\u2022  ${w}`, {
      x: 5.4, y: 1.7 + i * 0.4, w: 4.1, h: 0.35,
      fontSize: 10.5, fontFace: F.b, color: C.offWhite, margin: 0,
    });
  });

  // BOTTOM: Tech Stack — horizontal
  s.addShape("rect", { x: 0.3, y: 3.6, w: 9.4, h: 1.7, fill: { color: C.bgCard } });
  s.addShape("rect", { x: 0.3, y: 3.6, w: 9.4, h: 0.04, fill: { color: C.accent2 } });
  s.addText("\u6280\u672F\u6808", {
    x: 0.5, y: 3.7, w: 2, h: 0.3,
    fontSize: 13, fontFace: F.b, color: C.accent2, bold: true, margin: 0,
  });

  const tech = [
    ["\u91C7\u96C6\u5F15\u64CE", "Playwright + \u4EE3\u7406\u6C60"],
    ["\u540E\u7AEF", "Node.js + SQLite + JWT"],
    ["\u4E0A\u67B6\u63A5\u53E3", "Python + Ozon Seller API"],
    ["\u524D\u7AEF", "\u6BDB\u73BB\u7483 UI (Glassmorphism)"],
    ["\u77E5\u8BC6\u5E93", "JSON/MD \u7ED3\u6784\u5316\u5B58\u50A8"],
    ["\u7F51\u7EDC", "\u56FD\u5185\u955C\u50CF + \u4EE3\u7406\u6C60"],
  ];

  tech.forEach((t, i) => {
    const col = i < 3 ? 0 : 1;
    const row = i % 3;
    const x = 0.5 + col * 4.7;
    const y = 4.05 + row * 0.38;
    s.addText(t[0], { x, y, w: 1.3, h: 0.3, fontSize: 10, fontFace: F.b, color: C.accent2, bold: true, margin: 0 });
    s.addText(t[1], { x: x + 1.3, y, w: 3.2, h: 0.3, fontSize: 10, fontFace: F.b, color: C.offWhite, margin: 0 });
  });

  addPage(s, 8);
}

// ============================================================
// 9. COMPETITION
// ============================================================
function s09(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("AlphaShop \u505A\u5230\u4E86\u522B\u4EBA\u505A\u4E0D\u5230\u7684\u4E8B", {
    x: 0.8, y: 0.4, w: 8, h: 0.6,
    fontSize: 24, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });

  const cols = [2.2, 2.3, 2.3, 2.5];
  const headers = ["", "\u4EBA\u5DE5\u9009\u54C1", "ERP\u5DE5\u5177", "AlphaShop"];
  const hColors = [C.bgCard, C.bgCard, C.bgCard, C.accent1];

  let xp = 0.35;
  headers.forEach((h, i) => {
    s.addShape("rect", { x: xp, y: 1.2, w: cols[i], h: 0.45, fill: { color: hColors[i] } });
    s.addText(h, {
      x: xp, y: 1.2, w: cols[i], h: 0.45,
      fontSize: 11, fontFace: F.b, bold: true, color: i === 3 ? C.bg : C.white, align: "center", valign: "middle", margin: 0,
    });
    xp += cols[i] + 0.05;
  });

  const rows = [
    ["\u9009\u54C1\u65F6\u95F4", "3\u20135\u5929/SKU", "1\u20132\u5929/SKU", "10\u5206\u949F/SKU"],
    ["\u4FC4\u8BED\u672C\u5730\u5316", "\u624B\u52A8\u7FFB\u8BD1", "\u673A\u5668\u7FFB\u8BD1", "AI\u8BED\u4E49\u63A8\u65AD"],
    ["\u5E02\u573A\u5206\u6790", "\u4EBA\u5DE5\u7ECF\u9A8C", "\u57FA\u7840\u62A5\u8868", "AI\u667A\u80FD\u5206\u6790"],
    ["\u4E0A\u67B6\u6D41\u7A0B", "\u624B\u52A8\u586B\u5199", "\u534A\u81EA\u52A8", "\u5168\u81EA\u52A8 API"],
    ["\u5229\u6DA6\u8BC4\u4F30", "\u7C97\u7565\u4F30\u7B97", "\u57FA\u7840\u516C\u5F0F", "6\u7EF4\u6A21\u578B"],
    ["\u5408\u89C4\u68C0\u6D4B", "\u7ECF\u9A8C\u5224\u65AD", "\u65E0", "\u81EA\u52A8\u6807\u8BB0"],
    ["\u6269\u5C55\u6027", "\u7EBF\u6027\u589E\u4EBA", "\u6709\u9650", "\u65E0\u9650\u5E76\u53D1"],
  ];

  rows.forEach((row, ri) => {
    const y = 1.7 + ri * 0.5;
    let xp2 = 0.35;
    row.forEach((cell, ci) => {
      s.addShape("rect", { x: xp2, y, w: cols[ci], h: 0.45, fill: { color: ri % 2 === 0 ? C.bgCard : C.bg } });
      s.addText(cell, {
        x: xp2, y, w: cols[ci], h: 0.45,
        fontSize: 10, fontFace: F.b, bold: ci === 0 || ci === 3,
        color: ci === 3 ? C.accent1 : (ci === 0 ? C.accent2 : C.offWhite),
        align: "center", valign: "middle", margin: 0,
      });
      xp2 += cols[ci] + 0.05;
    });
  });

  addPage(s, 9);
}

// ============================================================
// 10. TRACTION
// ============================================================
function s10(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("\u5DF2\u9A8C\u8BC1\u7684\u6210\u679C", {
    x: 0.8, y: 0.4, w: 8, h: 0.6,
    fontSize: 26, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });

  const metrics = [
    { num: "78+", label: "\u4EA7\u54C1\u7814\u7A76\u5165\u5E93", sub: "8\u5927\u54C1\u7C7B\u8986\u76D6" },
    { num: "5\u6B65", label: "\u5168\u81EA\u52A8 Pipeline", sub: "\u96F6\u4EBA\u5DE5\u5E72\u9884" },
    { num: "76%", label: "\u8BC4\u5206\u901A\u8FC7\u7387", sub: ">60\u5206\u81EA\u52A8\u5165\u5E93" },
    { num: "10min", label: "\u5355\u4EA7\u54C1\u5168\u6D41\u7A0B", sub: "vs \u884C\u4E1A 3-5\u5929" },
  ];

  metrics.forEach((m, i) => {
    const x = 0.4 + i * 2.35;
    s.addShape("rect", { x, y: 1.3, w: 2.15, h: 1.5, fill: { color: C.bgCard } });
    s.addShape("rect", { x, y: 1.3, w: 2.15, h: 0.04, fill: { color: C.accent1 } });
    s.addText(m.num, {
      x, y: 1.4, w: 2.15, h: 0.7,
      fontSize: 34, fontFace: F.h, color: C.accent1, bold: true, align: "center", valign: "middle", margin: 0,
    });
    s.addText(m.label, {
      x, y: 2.1, w: 2.15, h: 0.3,
      fontSize: 12, fontFace: F.b, color: C.white, bold: true, align: "center", margin: 0,
    });
    s.addText(m.sub, {
      x, y: 2.4, w: 2.15, h: 0.25,
      fontSize: 10, fontFace: F.b, color: C.muted, align: "center", margin: 0,
    });
  });

  // Categories
  s.addText("\u77E5\u8BC6\u5E93\u8986\u76D6\u54C1\u7C7B", {
    x: 0.6, y: 3.1, w: 8, h: 0.3,
    fontSize: 12, fontFace: F.b, color: C.accent2, bold: true, margin: 0,
  });

  const cats = ["\u8F66\u8F7D\u6536\u7EB3", "\u53A8\u623F\u7528\u54C1", "\u5BA0\u7269\u7528\u54C1", "\u5BB6\u5C45\u6536\u7EB3", "\u65C5\u884C\u88C5\u5907", "\u529E\u516C\u6574\u7406", "\u6D74\u5BA4\u6536\u7EB3", "\u5B63\u8282\u6027\u4EA7\u54C1"];
  cats.forEach((cat, i) => {
    const x = 0.4 + (i % 4) * 2.35;
    const y = 3.5 + Math.floor(i / 4) * 0.45;
    s.addShape("rect", { x, y, w: 2.15, h: 0.35, fill: { color: C.bgCard } });
    s.addText(cat, { x, y, w: 2.15, h: 0.35, fontSize: 10, fontFace: F.b, color: C.offWhite, align: "center", valign: "middle", margin: 0 });
  });

  // Insight
  s.addShape("rect", { x: 0.4, y: 4.6, w: 9.2, h: 0.55, fill: { color: C.bgCard } });
  s.addShape("rect", { x: 0.4, y: 4.6, w: 0.06, h: 0.55, fill: { color: C.accent1 } });
  s.addText("AI \u63A8\u65AD\u7684\u4EA7\u54C1\u5C5E\u6027\u8FD1 90% \u51C6\u786E\u7387\uFF0C\u51E0\u4E4E\u65E0\u9700\u4EBA\u5DE5\u4FEE\u6539\u5373\u53EF\u53D1\u5E03", {
    x: 0.7, y: 4.65, w: 8.6, h: 0.45,
    fontSize: 11, fontFace: F.b, color: C.offWhite, valign: "middle", margin: 0,
  });

  addPage(s, 10);
}

// ============================================================
// 11. VISION
// ============================================================
function s11(pres) {
  const s = dk(pres);
  accentBar(s);

  s.addText("\u672A\u6765\u89C4\u5212", {
    x: 0.8, y: 0.4, w: 5, h: 0.6,
    fontSize: 26, fontFace: F.h, color: C.white, bold: true, margin: 0,
  });
  s.addText("\u4ECE\u5DE5\u5177\u5230\u8DE8\u5883\u7535\u5546\u64CD\u4F5C\u7CFB\u7EDF", {
    x: 0.8, y: 0.95, w: 8, h: 0.3,
    fontSize: 13, fontFace: F.b, color: C.accent2, margin: 0,
  });

  const phases = [
    { ph: "\u5F53\u524D", title: "MVP \u5DF2\u5B8C\u6210", items: ["\u5168\u81EA\u52A8\u9009\u54C1 Pipeline", "Ozon API \u5BF9\u63A5", "\u77E5\u8BC6\u5E93 78+ \u4EA7\u54C1", "\u5229\u6DA6\u4EEA\u8868\u76D8"], c: C.accent1 },
    { ph: "Q3 2026", title: "\u5E73\u53F0\u5316", items: ["\u591A\u7528\u6237 SaaS \u7248\u672C", "\u8BA2\u5355\u8DDF\u8E2A + \u5E93\u5B58\u7BA1\u7406", "\u81EA\u52A8\u5316\u5E7F\u544A\u6295\u653E", "\u6570\u636E\u5206\u6790\u770B\u677F"], c: C.accent2 },
    { ph: "2027", title: "\u5168\u7403\u5316\u6269\u5C55", items: ["\u652F\u6301 Wildberries/AliExpress", "\u591A\u8BED\u8A00 AI \u9009\u54C1", "\u4F9B\u5E94\u94FE\u91D1\u878D\u5BF9\u63A5", "\u667A\u80FD\u5B9A\u4EF7\u7B56\u7565"], c: C.accent3 },
  ];

  phases.forEach((p, i) => {
    const x = 0.3 + i * 3.2;
    s.addShape("rect", { x, y: 1.5, w: 3.0, h: 3.5, fill: { color: C.bgCard } });
    s.addShape("rect", { x, y: 1.5, w: 3.0, h: 0.04, fill: { color: p.c } });

    s.addText(p.ph, {
      x, y: 1.65, w: 3.0, h: 0.4,
      fontSize: 18, fontFace: F.h, color: p.c, bold: true, align: "center", margin: 0,
    });
    s.addText(p.title, {
      x, y: 2.1, w: 3.0, h: 0.35,
      fontSize: 14, fontFace: F.b, color: C.white, bold: true, align: "center", margin: 0,
    });

    s.addShape("rect", { x: x + 0.5, y: 2.5, w: 2.0, h: 0.02, fill: { color: p.c } });

    p.items.forEach((item, j) => {
      s.addText(`\u2022  ${item}`, {
        x: x + 0.25, y: 2.7 + j * 0.4, w: 2.5, h: 0.35,
        fontSize: 11, fontFace: F.b, color: C.offWhite, margin: 0,
      });
    });
  });

  addPage(s, 11);
}

// ============================================================
// 12. CLOSING
// ============================================================
function s12(pres) {
  const s = dk(pres);

  s.addShape("rect", { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.accent1 } });

  s.addText("AlphaShop", {
    x: 0.5, y: 1.0, w: 9, h: 1.2,
    fontSize: 56, fontFace: F.h, color: C.white, bold: true, align: "center", margin: 0,
  });
  s.addText("\u8BA9 AI \u66FF\u8DE8\u5883\u5356\u5BB6\u627E\u5230\u4E0B\u4E00\u4E2A\u7206\u6B3E", {
    x: 0.5, y: 2.1, w: 9, h: 0.5,
    fontSize: 20, fontFace: F.b, color: C.accent2, align: "center", margin: 0,
  });

  s.addShape("rect", { x: 3.5, y: 2.75, w: 3, h: 0.03, fill: { color: C.accent1 } });

  const sums = [
    { num: "10min", desc: "\u5168\u6D41\u7A0B" },
    { num: "6\u7EF4", desc: "AI\u8BC4\u5206" },
    { num: "78+", desc: "\u5DF2\u9A8C\u8BC1" },
    { num: "\u5168\u81EA\u52A8", desc: "\u9009\u54C1\u5230\u4E0A\u67B6" },
  ];

  sums.forEach((item, i) => {
    const x = 0.8 + i * 2.2;
    s.addShape("rect", { x, y: 3.1, w: 1.9, h: 1.0, fill: { color: C.bgCard } });
    s.addText(item.num, {
      x, y: 3.15, w: 1.9, h: 0.55,
      fontSize: 24, fontFace: F.h, color: C.accent1, bold: true, align: "center", valign: "middle", margin: 0,
    });
    s.addText(item.desc, {
      x, y: 3.7, w: 1.9, h: 0.3,
      fontSize: 11, fontFace: F.b, color: C.muted, align: "center", margin: 0,
    });
  });

  s.addText([
    { text: "\u5F6D\u5FB7\u533B\u751F\u521B\u98DE\u5176\u4ED6\u961F", options: { bold: true, color: C.white, fontSize: 15 } },
    { text: "  |  \u5218\u51E1\u58A8 \u00B7 \u5218\u4FCA\u5EF7", options: { color: C.muted, fontSize: 13 } },
  ], { x: 0.5, y: 4.4, w: 9, h: 0.4, fontFace: F.b, align: "center", margin: 0 });

  s.addText("Thank You", {
    x: 0.5, y: 4.9, w: 9, h: 0.35,
    fontSize: 14, fontFace: F.b, color: C.dimText, align: "center",
  });

  addPage(s, 12);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";
  pres.author = "AlphaShop Team";
  pres.title = "AlphaShop - AI\u8DE8\u5883\u7535\u5546\u667A\u80FD\u9009\u54C1\u5E73\u53F0";

  const slides = [s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12];
  slides.forEach(fn => fn(pres));

  await pres.writeFile({ fileName: "AlphaShop-Pitch-v5.pptx" });
  console.log("Done: AlphaShop-Pitch-Deck.pptx");
}

main().catch(console.error);

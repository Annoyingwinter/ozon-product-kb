import path from "node:path";
import {
  buildAutonomousProductSummary,
  buildListingBrief,
  ensureDir,
  getWorkflowPaths,
  listProductRecords,
  normalizeDecision,
  parseArgs,
  refreshWorkflowArtifacts,
  shouldRequireSupplierResponse,
  timestamp,
  writeJson,
  writeText,
} from "./merchant-workflow-lib.js";

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map((item) => compact(item)).filter(Boolean))];
}

function getLowerText(record) {
  const product = record?.product || {};
  return compact(
    [
      product.name,
      product.category,
      product.why_it_can_sell,
      ...(Array.isArray(product.risk_notes) ? product.risk_notes : []),
    ].join(" "),
  ).toLowerCase();
}

function inferCoreLabel(record) {
  const text = getLowerText(record);

  if (/pet hair remover|pet.*hair|除毛|毛发/.test(text)) {
    return "宠物除毛滚筒";
  }
  if (/drawer divider|分隔板|drawer|抽屉/.test(text)) {
    return "抽屉分隔板";
  }
  if (/wardrobe storage box|storage box|收纳箱|收纳盒/.test(text)) {
    return "收纳盒";
  }
  if (/car seat gap|缝隙|car.*gap/.test(text)) {
    return "车载缝隙收纳盒";
  }
  if (/usb|理线/.test(text)) {
    return "桌面理线收纳盒";
  }
  if (/beeswax|wax|保鲜布/.test(text)) {
    return "蜂蜡保鲜布";
  }
  if (/pet.*bowl|food bowl|食碗|饮水碗/.test(text)) {
    return "宠物折叠碗";
  }
  if (/phone holder|手机支架/.test(text)) {
    return "手机支架";
  }

  return compact(record?.product?.name) || compact(record?.product?.category) || "Ozon listing";
}

function buildTitleCandidates(record) {
  const product = record.product || {};
  const primary = compact(product.name) || inferCoreLabel(record);
  const core = inferCoreLabel(record);
  const category = compact(product.category);
  const variants = [
    primary,
    core,
    category ? `${category} - ${core}` : "",
    category ? `${core}（${category}）` : "",
    product.why_it_can_sell ? `${core}：${compact(product.why_it_can_sell).slice(0, 28)}` : "",
  ];

  return unique(variants).slice(0, 5);
}

function buildBulletPoints(record) {
  const product = record.product || {};
  const riskTags = Array.isArray(record.research?.risk_tags) ? record.research.risk_tags : [];
  const bullets = [];

  if (product.why_it_can_sell) {
    bullets.push(`Core selling point: ${compact(product.why_it_can_sell)}`);
  }

  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  bullets.push(
    `Logistics fit: ${weight || "unknown"} kg / ${longEdge || "unknown"} cm, low-fragility and cross-border friendly.`,
  );

  const riskNotes = [];
  if (riskTags.length > 0) {
    riskNotes.push(`risk tags: ${riskTags.join(", ")}`);
  }
  if (product.certification_risk) {
    riskNotes.push(`certification=${product.certification_risk}`);
  }
  if (product.return_risk) {
    riskNotes.push(`returns=${product.return_risk}`);
  }
  if (product.competition_level) {
    riskNotes.push(`competition=${product.competition_level}`);
  }
  if (product.content_potential) {
    riskNotes.push(`content=${product.content_potential}`);
  }
  bullets.push(`Risk check: ${riskNotes.join("; ") || "no obvious blocker in current record"}`);

  bullets.push("Draft only: save to merchant backend first and do not publish yet.");

  return bullets.slice(0, 5);
}

function buildAttributeSheet(record) {
  const product = record.product || {};

  return {
    marketplace: "Ozon Russia",
    slug: record.slug,
    product_name: compact(product.name),
    category: compact(product.category),
    profile: compact(record.research?.product_profile),
    target_price_rub: Number(product.target_price_rub || 0),
    supply_price_cny: Number(product.supply_price_cny || 0),
    weight_kg: Number(product.est_weight_kg || 0),
    long_edge_cm: Number(product.package_long_edge_cm || 0),
    fragility: compact(product.fragility),
    certification_risk: compact(product.certification_risk),
    return_risk: compact(product.return_risk),
    competition_level: compact(product.competition_level),
    content_potential: compact(product.content_potential),
    risk_tags: Array.isArray(record.research?.risk_tags) ? record.research.risk_tags : [],
    final_decision: compact(product.final_decision || product.go_or_no_go),
  };
}

function buildImagePromptPack(record) {
  const subject = inferCoreLabel(record);
  const product = record.product || {};
  const category = compact(product.category) || "home use";

  return [
    `Main image: white background, centered product shot, show the full ${subject} clearly.`,
    `Scene image: show the ${subject} in its main use case for ${category}.`,
    "Detail image: highlight material, structure, size, and any foldable or cuttable feature.",
  ];
}

function buildComplianceNotes(record) {
  const product = record.product || {};
  const riskTags = Array.isArray(record.research?.risk_tags) ? record.research.risk_tags : [];
  const notes = [];

  if (product.certification_risk === "high") {
    notes.push("Certification risk is high; do not publish before compliance review.");
  }
  if (product.return_risk === "high") {
    notes.push("Return risk is high; keep this as watchlist only.");
  }
  if (riskTags.includes("battery")) {
    notes.push("Battery-related item; verify certification and transport restrictions.");
  }
  if (riskTags.includes("liquid")) {
    notes.push("Liquid-related item; verify cross-border shipping restrictions.");
  }
  if (riskTags.includes("magnet")) {
    notes.push("Magnet-related item; verify transport and customs restrictions.");
  }
  if (riskTags.includes("food-contact")) {
    notes.push("Food-contact item; verify material compliance before publish.");
  }

  if (notes.length === 0) {
    notes.push("No obvious publish blocker in current data. Confirm final backend attributes before launch.");
  }

  return notes;
}

function buildListingTitlePack(record) {
  const product = record.product || {};
  const core = inferCoreLabel(record);
  const productName = compact(product.name) || core;
  const category = compact(product.category);
  const sellingPoint = compact(product.why_it_can_sell);

  const candidates = unique([
    productName,
    core,
    category ? `${core} - ${category}` : "",
    category ? `${category} ${core}` : "",
    sellingPoint ? `${productName} | ${sellingPoint.slice(0, 24)}` : "",
  ]).slice(0, 5);

  return {
    product_name: productName,
    core_label: core,
    category,
    selected_title: candidates[0] || productName,
    title_candidates: candidates,
    keyword_hints: unique([productName, core, category, record.research?.product_profile]),
  };
}

const RUSSIAN_CORE_LABELS = [
  { pattern: /pet hair remover|pet.*hair|除毛|毛发/, value: "ролик для удаления шерсти" },
  { pattern: /drawer divider|分隔板|抽屉/, value: "разделитель для ящика" },
  { pattern: /wardrobe storage box|storage box|收纳箱|收纳盒/, value: "контейнер для хранения" },
  { pattern: /car seat gap|缝隙|car.*gap/, value: "органайзер в щель между сиденьем" },
  { pattern: /usb|理线/, value: "органайзер для кабеля" },
  { pattern: /beeswax|wax|保鲜布/, value: "восковая пищевая обертка" },
  { pattern: /pet.*bowl|food bowl|食碗|饮水碗/, value: "складная миска для питомца" },
  { pattern: /phone holder|手机支架/, value: "держатель для телефона" },
];

const RUSSIAN_PROFILE_SCENARIOS = {
  "storage-home": "для шкафа, кухни и домашнего хранения",
  "household-tools": "для кухни, уборки и повседневных задач",
  "general-merchandise": "для повседневного домашнего использования",
  "pet-accessories": "для ухода за питомцем и поездок",
  "automotive-accessories": "для салона автомобиля и дороги",
  "electronics-light": "для рабочего стола и дома",
  "food-contact-home": "для кухни и бытового применения",
};

function buildRussianCoreLabel(record) {
  const text = getLowerText(record);
  const match = RUSSIAN_CORE_LABELS.find(({ pattern }) => pattern.test(text));
  if (match) return match.value;
  return "товар для дома";
}

function buildRussianSellingPoint(record) {
  const product = record.product || {};
  const profile = String(record.research?.product_profile || "");
  const scenario = RUSSIAN_PROFILE_SCENARIOS[profile] || "для повседневного использования";
  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  const riskTag = compact(product.certification_risk) === "low" ? "низкий риск" : "требует проверки";
  const coreRu = buildRussianCoreLabel(record);

  return unique([
    `${coreRu} ${scenario}`,
    `Легкий формат: ${weight ? `${weight} кг` : "небольшой вес"} и ${longEdge ? `${longEdge} см` : "компактная длина"} для удобной доставки.`,
    `Логистически удобный товар с ${riskTag}.`,
  ]).slice(0, 3);
}

function buildRussianTitlePack(record, titlePack) {
  const product = record.product || {};
  const coreRu = buildRussianCoreLabel(record);
  const profile = String(record.research?.product_profile || "");
  const scenario = RUSSIAN_PROFILE_SCENARIOS[profile] || "для дома";
  const categoryRu = compact(product.category) || "товар";
  const sellingPoint = compact(product.why_it_can_sell);
  const titleCandidates = unique([
    `${coreRu}`,
    `${coreRu} ${scenario}`,
    `${coreRu} для ${categoryRu}`,
    sellingPoint ? `${coreRu} — ${sellingPoint.slice(0, 24)}` : "",
  ]).slice(0, 4);

  return {
    product_name_ru: titleCandidates[0] || coreRu,
    core_label_ru: coreRu,
    scenario_ru: scenario,
    category_ru: categoryRu,
    selected_title_ru: titleCandidates[0] || coreRu,
    title_candidates_ru: titleCandidates,
    keyword_hints_ru: unique([coreRu, scenario, categoryRu, titlePack?.keyword_hints?.[0] || ""]).slice(0, 4),
  };
}

function buildRussianBulletsPack(record, titlePack, russianTitlePack) {
  const product = record.product || {};
  const coreRu = russianTitlePack?.core_label_ru || buildRussianCoreLabel(record);
  const scenarioRu = russianTitlePack?.scenario_ru || "для дома";
  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  const riskSummary = [];
  if (product.certification_risk) riskSummary.push(`сертификация: ${product.certification_risk}`);
  if (product.return_risk) riskSummary.push(`возвраты: ${product.return_risk}`);
  if (product.competition_level) riskSummary.push(`конкуренция: ${product.competition_level}`);
  if (product.content_potential) riskSummary.push(`контент: ${product.content_potential}`);

  return {
    bullets_ru: unique([
      `${coreRu} ${scenarioRu}.`,
      product.why_it_can_sell
        ? `Ключевая выгода: ${compact(product.why_it_can_sell).slice(0, 90)}.`
        : "Понятный товар для повседневного использования с простым сценарием покупки.",
      `Логистика: ${weight ? `${weight} кг` : "легкий"} / ${longEdge ? `${longEdge} см` : "компактный формат"}; удобно для кроссбордера.`,
      `Проверка риска: ${riskSummary.join("; ") || "явных блокеров в текущей карточке нет"}.`,
      `Название для карточки: ${russianTitlePack?.selected_title_ru || coreRu}.`,
    ]).slice(0, 5),
    selling_point_ru: `${coreRu} ${scenarioRu}`.trim(),
  };
}

function buildRussianMainImageCopyPack(record, russianTitlePack, russianBulletsPack) {
  const product = record.product || {};
  const coreRu = russianTitlePack?.core_label_ru || buildRussianCoreLabel(record);
  const categoryRu = russianTitlePack?.category_ru || compact(product.category) || "товар";
  const sizeHint = [
    Number(product.est_weight_kg || 0) ? `${product.est_weight_kg} кг` : "",
    Number(product.package_long_edge_cm || 0) ? `${product.package_long_edge_cm} см` : "",
  ]
    .filter(Boolean)
    .join(" / ");

  return {
    hero_text_ru: russianTitlePack?.selected_title_ru || coreRu,
    badge_text_ru: compact(product.certification_risk) === "low" ? "Низкий риск" : "Проверь сертификацию",
    subtitle_text_ru: russianTitlePack?.scenario_ru || "Для повседневного использования",
    scene_text_ru: `${coreRu} в сценарии ${categoryRu}`,
    detail_text_ru: sizeHint ? `Размер: ${sizeHint}` : "Покажи материал, конструкцию и ключевые детали.",
    overlay_lines_ru: unique([
      compact(product.why_it_can_sell) ? compact(product.why_it_can_sell).slice(0, 36) : "",
      russianBulletsPack?.selling_point_ru || "",
      sizeHint ? `Компактный формат: ${sizeHint}` : "",
    ]).slice(0, 3),
  };
}

function buildRussianAssetPack(record, titlePack) {
  const russianTitlePack = buildRussianTitlePack(record, titlePack);
  const russianBulletsPack = buildRussianBulletsPack(record, titlePack, russianTitlePack);
  const russianMainImageCopyPack = buildRussianMainImageCopyPack(record, russianTitlePack, russianBulletsPack);

  return {
    title_pack_ru: russianTitlePack,
    bullet_pack_ru: russianBulletsPack,
    main_image_copy_pack_ru: russianMainImageCopyPack,
  };
}

function buildRussianCoreLabelClean(record) {
  const text = getLowerText(record);
  const rules = [
    { pattern: /pet hair remover|pet.*hair|除毛|毛发/, value: "ролик для удаления шерсти" },
    { pattern: /drawer divider|分隔|抽屉/, value: "разделитель для ящика" },
    { pattern: /wardrobe storage box|storage box|收纳箱|收纳盒/, value: "контейнер для хранения" },
    { pattern: /car seat gap|缝隙|car.*gap/, value: "органайзер в щель между сиденьем" },
    { pattern: /usb|线材|理线/, value: "органайзер для кабеля" },
    { pattern: /beeswax|wax|保鲜/, value: "восковая пищевая обертка" },
    { pattern: /pet.*bowl|food bowl|食碗|饮水碗/, value: "складная миска для питомца" },
    { pattern: /phone holder|手机支架/, value: "держатель для телефона" },
  ];

  const match = rules.find(({ pattern }) => pattern.test(text));
  return match ? match.value : "товар для дома";
}

function buildRussianSellingPointClean(record) {
  const product = record.product || {};
  const profile = String(record.research?.product_profile || "");
  const scenarioMap = {
    "storage-home": "для шкафа, кухни и домашнего хранения",
    "household-tools": "для кухни, уборки и бытовых задач",
    "general-merchandise": "для повседневного домашнего использования",
    "pet-accessories": "для ухода за питомцами и поездок",
    "automotive-accessories": "для салона автомобиля и дороги",
    "electronics-light": "для рабочего стола, офиса и дома",
    "food-contact-home": "для кухни и бытового применения",
  };
  const scenario = scenarioMap[profile] || "для повседневного домашнего использования";
  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  const coreRu = buildRussianCoreLabelClean(record);

  return unique([
    `${coreRu} ${scenario}`,
    `Легкий формат: ${weight ? `${weight} кг` : "компактный вес"} и ${longEdge ? `${longEdge} см` : "компактный размер"} для удобной доставки.`,
    "Подходит для быстрой выкладки и простого использования.",
  ]).slice(0, 3);
}

function buildRussianTitlePackClean(record, titlePack) {
  const product = record.product || {};
  const coreRu = buildRussianCoreLabelClean(record);
  const profile = String(record.research?.product_profile || "");
  const scenarioMap = {
    "storage-home": "для хранения",
    "household-tools": "для кухни",
    "general-merchandise": "для дома",
    "pet-accessories": "для питомцев",
    "automotive-accessories": "для автомобиля",
    "electronics-light": "для офиса",
    "food-contact-home": "для кухни",
  };
  const scenario = scenarioMap[profile] || "для дома";
  const categoryRu = compact(product.category) || "товар";
  const sellingPoint = compact(product.why_it_can_sell);
  const titleCandidates = unique([
    `${coreRu}`,
    `${coreRu} ${scenario}`,
    `${coreRu} для ${categoryRu}`,
    sellingPoint ? `${coreRu} - ${sellingPoint.slice(0, 24)}` : "",
  ]).slice(0, 4);

  return {
    product_name_ru: titleCandidates[0] || coreRu,
    core_label_ru: coreRu,
    scenario_ru: scenario,
    category_ru: categoryRu,
    selected_title_ru: titleCandidates[0] || coreRu,
    title_candidates_ru: titleCandidates,
    keyword_hints_ru: unique([coreRu, scenario, categoryRu, titlePack?.keyword_hints?.[0] || ""]).slice(0, 4),
  };
}

function buildRussianBulletsPackClean(record, titlePack, russianTitlePack) {
  const product = record.product || {};
  const coreRu = russianTitlePack?.core_label_ru || buildRussianCoreLabelClean(record);
  const scenarioRu = russianTitlePack?.scenario_ru || "для дома";
  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  const riskSummary = [];
  if (product.certification_risk) riskSummary.push(`сертификация: ${product.certification_risk}`);
  if (product.return_risk) riskSummary.push(`возвраты: ${product.return_risk}`);
  if (product.competition_level) riskSummary.push(`конкуренция: ${product.competition_level}`);
  if (product.content_potential) riskSummary.push(`контент: ${product.content_potential}`);

  return {
    bullets_ru: unique([
      `${coreRu} ${scenarioRu}.`,
      product.why_it_can_sell
        ? `Ключевая выгода: ${compact(product.why_it_can_sell).slice(0, 90)}.`
        : "Понятный товар для повседневного использования с простым сценарием покупки.",
      `Логистика: ${weight ? `${weight} кг` : "легкий"} / ${longEdge ? `${longEdge} см` : "компактный формат"}; удобно для кроссбордера.`,
      `Проверка риска: ${riskSummary.join("; ") || "явных блокеров в текущей карточке нет"}.`,
      `Название для карточки: ${russianTitlePack?.selected_title_ru || coreRu}.`,
    ]).slice(0, 5),
    selling_point_ru: `${coreRu} ${scenarioRu}`.trim(),
  };
}

function buildRussianMainImageCopyPackClean(record, russianTitlePack, russianBulletsPack) {
  const product = record.product || {};
  const coreRu = russianTitlePack?.core_label_ru || buildRussianCoreLabelClean(record);
  const categoryRu = russianTitlePack?.category_ru || compact(product.category) || "товар";
  const sizeHint = [
    Number(product.est_weight_kg || 0) ? `${product.est_weight_kg} кг` : "",
    Number(product.package_long_edge_cm || 0) ? `${product.package_long_edge_cm} см` : "",
  ]
    .filter(Boolean)
    .join(" / ");

  return {
    hero_text_ru: russianTitlePack?.selected_title_ru || coreRu,
    badge_text_ru: compact(product.certification_risk) === "low" ? "низкий риск" : "проверьте сертификацию",
    subtitle_text_ru: russianTitlePack?.scenario_ru || "для повседневного использования",
    scene_text_ru: `${coreRu} в сценарии ${categoryRu}`,
    detail_text_ru: sizeHint ? `Размер: ${sizeHint}` : "Покажите материал, конструкцию и ключевые детали.",
    overlay_lines_ru: unique([
      compact(product.why_it_can_sell) ? compact(product.why_it_can_sell).slice(0, 36) : "",
      russianBulletsPack?.selling_point_ru || "",
      sizeHint ? `Компактный формат: ${sizeHint}` : "",
    ]).slice(0, 3),
  };
}

function buildRussianAssetPackClean(record, titlePack) {
  const russianTitlePack = buildRussianTitlePackClean(record, titlePack);
  const russianBulletsPack = buildRussianBulletsPackClean(record, titlePack, russianTitlePack);
  const russianMainImageCopyPack = buildRussianMainImageCopyPackClean(record, russianTitlePack, russianBulletsPack);

  return {
    title_pack_ru: russianTitlePack,
    bullet_pack_ru: russianBulletsPack,
    main_image_copy_pack_ru: russianMainImageCopyPack,
  };
}

function buildListingBulletsPack(record, titlePack) {
  const product = record.product || {};
  const bullets = [];

  const sellingPoint = compact(product.why_it_can_sell);
  if (sellingPoint) {
    bullets.push(sellingPoint);
  }

  const scenarioByProfile = {
    "storage-home": "适合抽屉、柜子、卧室和家居收纳场景，解决空间整理问题。",
    "household-tools": "适合厨房、家务和日常维护场景，强调简单易用。",
    "general-merchandise": "适合通用家庭使用场景，覆盖日常高频需求。",
    "pet-accessories": "适合宠物家庭的日常使用和外出携带场景。",
    "automotive-accessories": "适合车内收纳、停车和通勤场景。",
    "electronics-light": "适合桌面、办公和轻便随身使用场景。",
    "food-contact-home": "适合厨房、餐具和日常食品接触场景。",
  };
  const scenario = scenarioByProfile[record.research?.product_profile] || "适合日常家庭场景，强调易用和轻小件优势。";
  bullets.push(scenario);

  const weight = Number(product.est_weight_kg || 0);
  const longEdge = Number(product.package_long_edge_cm || 0);
  bullets.push(
    `轻小件规格：${weight ? `${weight} kg` : "unknown"} / ${longEdge ? `${longEdge} cm` : "unknown"}，跨境履约更友好。`,
  );

  const materialNotes = [];
  if (product.fragility) materialNotes.push(`fragility=${product.fragility}`);
  if (product.competition_level) materialNotes.push(`competition=${product.competition_level}`);
  if (product.content_potential) materialNotes.push(`content=${product.content_potential}`);
  if (product.return_risk) materialNotes.push(`return=${product.return_risk}`);
  bullets.push(
    `结构特征：${materialNotes.join("；") || "简单结构，适合做标准化上架素材"}`,
  );

  const titleHint = titlePack?.selected_title || product.name || titlePack?.core_label || "Ozon listing";
  bullets.push(`标题锚点：${titleHint}`);

  return {
    bullets: bullets.slice(0, 5),
    selling_point: sellingPoint || titlePack?.core_label || "",
    scenario,
  };
}

function buildMainImageCopyPack(record, titlePack, bulletPack) {
  const product = record.product || {};
  const core = titlePack?.core_label || inferCoreLabel(record);
  const category = compact(product.category) || "商品";
  const sizeHint = [
    Number(product.est_weight_kg || 0) ? `${product.est_weight_kg} kg` : "",
    Number(product.package_long_edge_cm || 0) ? `${product.package_long_edge_cm} cm` : "",
  ]
    .filter(Boolean)
    .join(" / ");

  return {
    hero_text: titlePack?.selected_title || product.name || core,
    badge_text: compact(product.certification_risk) === "low" ? "低合规风险" : "请先复核合规",
    subtitle_text: bulletPack?.scenario || `适合${category}场景`,
    scene_text: `${core}在${category}场景中的使用效果`,
    detail_text: sizeHint ? `规格：${sizeHint}` : "展示材质、结构、尺寸和细节。",
    overlay_lines: unique([
      product.why_it_can_sell ? compact(product.why_it_can_sell).slice(0, 30) : "",
      bulletPack?.scenario || "",
      sizeHint ? `轻小件：${sizeHint}` : "",
    ]).slice(0, 3),
    prompt_pack: buildImagePromptPack(record),
  };
}

function buildListingAssetPack(record) {
  const titlePack = buildListingTitlePack(record);
  const bulletPack = buildListingBulletsPack(record, titlePack);
  const attributePack = buildAttributeSheet(record);
  const mainImageCopyPack = buildMainImageCopyPack(record, titlePack, bulletPack);
  const russianPack = buildRussianAssetPackClean(record, titlePack);
  const complianceNotes = buildComplianceNotes(record);

  return {
    title_pack: titlePack,
    bullet_pack: bulletPack,
    attribute_pack: attributePack,
    main_image_copy_pack: mainImageCopyPack,
    russian_pack: russianPack,
    compliance_notes: complianceNotes,
  };
}

function buildListingAssetsMarkdown(record, assetPack) {
  const product = record.product || {};
  const russianPack = assetPack.russian_pack || {};
  const lines = [
    `# Ozon listing assets: ${compact(product.name) || record.slug}`,
    "",
    "## Title",
    "",
    `- Selected: ${assetPack.title_pack.selected_title}`,
    ...assetPack.title_pack.title_candidates.map((item) => `- Candidate: ${item}`),
    "",
    "## Bullets",
    "",
    ...assetPack.bullet_pack.bullets.map((item) => `- ${item}`),
    "",
    "## Attributes",
    "",
    ...Object.entries(assetPack.attribute_pack).map(([key, value]) => {
      const rendered = Array.isArray(value) ? value.join(", ") : String(value);
      return `- ${key}: ${rendered || "n/a"}`;
    }),
    "",
    "## Main image copy",
    "",
    `- Hero: ${assetPack.main_image_copy_pack.hero_text}`,
    `- Badge: ${assetPack.main_image_copy_pack.badge_text}`,
    `- Subtitle: ${assetPack.main_image_copy_pack.subtitle_text}`,
    `- Scene: ${assetPack.main_image_copy_pack.scene_text}`,
    `- Detail: ${assetPack.main_image_copy_pack.detail_text}`,
    ...assetPack.main_image_copy_pack.overlay_lines.map((item) => `- Overlay: ${item}`),
    "",
    "## Russian title pack",
    "",
    `- Selected RU: ${russianPack.title_pack_ru?.selected_title_ru || "n/a"}`,
    ...(russianPack.title_pack_ru?.title_candidates_ru || []).map((item) => `- Candidate RU: ${item}`),
    "",
    "## Russian bullets",
    "",
    ...(russianPack.bullet_pack_ru?.bullets_ru || []).map((item) => `- ${item}`),
    "",
    "## Russian main image copy",
    "",
    `- Hero RU: ${russianPack.main_image_copy_pack_ru?.hero_text_ru || "n/a"}`,
    `- Badge RU: ${russianPack.main_image_copy_pack_ru?.badge_text_ru || "n/a"}`,
    `- Subtitle RU: ${russianPack.main_image_copy_pack_ru?.subtitle_text_ru || "n/a"}`,
    `- Scene RU: ${russianPack.main_image_copy_pack_ru?.scene_text_ru || "n/a"}`,
    `- Detail RU: ${russianPack.main_image_copy_pack_ru?.detail_text_ru || "n/a"}`,
    ...(russianPack.main_image_copy_pack_ru?.overlay_lines_ru || []).map((item) => `- Overlay RU: ${item}`),
    "",
    "## Compliance",
    "",
    ...assetPack.compliance_notes.map((item) => `- ${item}`),
    "",
  ];

  return lines.join("\n");
}

async function writeAssetFiles(targetDir, record, assetPack, { dryRun = false } = {}) {
  const titlePath = path.join(targetDir, "listing-title.json");
  const titleRuPath = path.join(targetDir, "listing-title.ru.json");
  const bulletsPath = path.join(targetDir, "listing-bullets.json");
  const bulletsRuPath = path.join(targetDir, "listing-bullets.ru.json");
  const attributesPath = path.join(targetDir, "listing-attributes.json");
  const imageCopyPath = path.join(targetDir, "main-image-copy.json");
  const imageCopyRuPath = path.join(targetDir, "main-image-copy.ru.json");
  const assetsMdPath = path.join(targetDir, "listing-assets.md");
  const assetsRuMdPath = path.join(targetDir, "listing-assets.ru.md");

  if (!dryRun) {
    await ensureDir(targetDir);
    await writeJson(titlePath, assetPack.title_pack);
    await writeJson(titleRuPath, assetPack.russian_pack?.title_pack_ru || {});
    await writeJson(bulletsPath, assetPack.bullet_pack);
    await writeJson(bulletsRuPath, assetPack.russian_pack?.bullet_pack_ru || {});
    await writeJson(attributesPath, assetPack.attribute_pack);
    await writeJson(imageCopyPath, assetPack.main_image_copy_pack);
    await writeJson(imageCopyRuPath, assetPack.russian_pack?.main_image_copy_pack_ru || {});
    await writeText(assetsMdPath, buildListingAssetsMarkdown(record, assetPack));
    await writeText(assetsRuMdPath, buildListingAssetsMarkdown(record, assetPack));
  }

  return {
    titlePath,
    titleRuPath,
    bulletsPath,
    bulletsRuPath,
    attributesPath,
    imageCopyPath,
    imageCopyRuPath,
    assetsMdPath,
    assetsRuMdPath,
  };
}

function buildDraftMarkdown(record, draft) {
  const product = record.product || {};
  const lines = [
    `# Ozon listing draft: ${compact(product.name) || record.slug}`,
    "",
    "## Status",
    "",
    `- Workflow stage: ${compact(record.workflow?.current_stage)}`,
    `- Review status: ${compact(record.review?.status)}`,
    `- Listing status: ${compact(record.listing?.status)}`,
    `- Draft package: ${compact(draft.package_id)}`,
    "",
    "## Title candidates",
    "",
    ...draft.title_candidates.map((item) => `- ${item}`),
    "",
    "## Bullet points",
    "",
    ...draft.bullet_points.map((item) => `- ${item}`),
    "",
    "## Attributes",
    "",
    ...Object.entries(draft.attributes).map(([key, value]) => {
      const rendered = Array.isArray(value) ? value.join(", ") : String(value);
      return `- ${key}: ${rendered || "n/a"}`;
    }),
    "",
    "## Image prompt pack",
    "",
    ...draft.image_prompt_pack.map((item) => `- ${item}`),
    "",
    "## Russian title pack",
    "",
    `- Selected RU: ${draft.title_pack_ru?.selected_title_ru || "n/a"}`,
    ...(draft.title_pack_ru?.title_candidates_ru || []).map((item) => `- Candidate RU: ${item}`),
    "",
    "## Russian bullets",
    "",
    ...(draft.bullet_pack_ru?.bullets_ru || []).map((item) => `- ${item}`),
    "",
    "## Russian main image copy",
    "",
    `- Hero RU: ${draft.main_image_copy_pack_ru?.hero_text_ru || "n/a"}`,
    `- Badge RU: ${draft.main_image_copy_pack_ru?.badge_text_ru || "n/a"}`,
    `- Subtitle RU: ${draft.main_image_copy_pack_ru?.subtitle_text_ru || "n/a"}`,
    `- Scene RU: ${draft.main_image_copy_pack_ru?.scene_text_ru || "n/a"}`,
    `- Detail RU: ${draft.main_image_copy_pack_ru?.detail_text_ru || "n/a"}`,
    ...(draft.main_image_copy_pack_ru?.overlay_lines_ru || []).map((item) => `- Overlay RU: ${item}`),
    "",
    "## Asset files",
    "",
    ...(draft.asset_paths
      ? Object.entries(draft.asset_paths).map(([key, value]) => `- ${key}: ${value}`)
      : []),
    "",
    "## Compliance notes",
    "",
    ...draft.compliance_notes.map((item) => `- ${item}`),
    "",
    "## Next actions",
    "",
    "- Save the draft into the merchant backend.",
    "- Keep publish disabled until the compliance pass is complete.",
    "- Use the title and bullet candidates as the operator starting point.",
    "",
  ];

  return lines.join("\n");
}

function shouldAutoApprove(record) {
  const product = record.product || {};
  const decision = normalizeDecision(product.final_decision || product.go_or_no_go);

  if (decision !== "Go") return false;
  if (record.workflow?.current_stage !== "supplier_research_pending") return false;
  if (record.review?.status && record.review.status !== "pending") return false;
  return !shouldRequireSupplierResponse(record);
}

async function promoteRecordForDraft(record, productDir, nowIso, dryRun = false) {
  const autonomousSummaryPath = path.join(productDir, "autonomous-summary.md");
  const listingBriefPath = path.join(productDir, "listing-brief.md");

  if (!dryRun) {
    await writeText(autonomousSummaryPath, buildAutonomousProductSummary(record));
    await writeText(listingBriefPath, buildListingBrief(record));
  }

  record.research = record.research || {};
  record.review = record.review || {};
  record.listing = record.listing || {};
  record.workflow = record.workflow || {};

  record.research.autonomous_summary_path = autonomousSummaryPath;
  record.research.autonomous_approval = true;
  record.research.autonomous_approval_reason = "low-complexity product; supplier response not required";
  record.review.status = "approved";
  record.review.notes = "Auto-approved by draft-only Ozon flow.";
  record.review.reviewed_at = nowIso;
  record.workflow.current_stage = "approved_for_listing";
  record.workflow.updated_at = nowIso;
  record.listing.status = "ready_for_draft";
  record.listing.listing_brief_path = listingBriefPath;
  record.listing.autonomous_summary_path = autonomousSummaryPath;

  return listingBriefPath;
}

async function createDraftPackage(record, paths, runId, nowIso, assetPack, dryRun = false) {
  const productDir = path.dirname(record.paths.product_json);
  const packageId = `${runId}-${record.slug}`;
  const packageDir = path.join(paths.outputDir, "ozon-drafts", packageId, record.slug);
  const titlePack = assetPack?.title_pack || buildListingTitlePack(record);
  const bulletPack = assetPack?.bullet_pack || buildListingBulletsPack(record, titlePack);
  const attributePack = assetPack?.attribute_pack || buildAttributeSheet(record);
  const mainImageCopyPack =
    assetPack?.main_image_copy_pack || buildMainImageCopyPack(record, titlePack, bulletPack);
  const russianPack = assetPack?.russian_pack || buildRussianAssetPackClean(record, titlePack);
  const complianceNotes = assetPack?.compliance_notes || buildComplianceNotes(record);
  const assetPaths = {
    titlePath: path.join(packageDir, "listing-title.json"),
    titleRuPath: path.join(packageDir, "listing-title.ru.json"),
    bulletsPath: path.join(packageDir, "listing-bullets.json"),
    bulletsRuPath: path.join(packageDir, "listing-bullets.ru.json"),
    attributesPath: path.join(packageDir, "listing-attributes.json"),
    imageCopyPath: path.join(packageDir, "main-image-copy.json"),
    imageCopyRuPath: path.join(packageDir, "main-image-copy.ru.json"),
    assetsMdPath: path.join(packageDir, "listing-assets.md"),
    assetsRuMdPath: path.join(packageDir, "listing-assets.ru.md"),
  };
  const draft = {
    package_id: packageId,
    created_at: nowIso,
    product_slug: record.slug,
    product_name: compact(record.product?.name),
    workflow_stage: compact(record.workflow?.current_stage),
    review_status: compact(record.review?.status),
    listing_status: compact(record.listing?.status),
    source_files: {
      product_json: record.paths.product_json,
      listing_brief: record.listing?.listing_brief_path || path.join(productDir, "listing-brief.md"),
      autonomous_summary: record.research?.autonomous_summary_path || "",
    },
    title_pack: titlePack,
    title_pack_ru: russianPack.title_pack_ru,
    title_candidates: titlePack.title_candidates || [],
    title_candidates_ru: russianPack.title_pack_ru?.title_candidates_ru || [],
    selected_title: titlePack.selected_title || "",
    selected_title_ru: russianPack.title_pack_ru?.selected_title_ru || "",
    bullet_pack: bulletPack,
    bullet_pack_ru: russianPack.bullet_pack_ru,
    bullet_points: bulletPack.bullets || [],
    bullet_points_ru: russianPack.bullet_pack_ru?.bullets_ru || [],
    attribute_pack: attributePack,
    attributes: attributePack,
    main_image_copy_pack: mainImageCopyPack,
    main_image_copy_pack_ru: russianPack.main_image_copy_pack_ru,
    russian_pack: russianPack,
    image_prompt_pack: mainImageCopyPack.prompt_pack || [],
    compliance_notes: complianceNotes,
    asset_paths: assetPaths,
  };

  const markdown = buildDraftMarkdown(record, draft);
  const jsonPath = path.join(packageDir, "ozon-listing-draft.json");
  const mdPath = path.join(packageDir, "ozon-listing-draft.md");
  const taskPath = path.join(packageDir, "task.json");
  const sourceProductPath = path.join(packageDir, "source-product.json");

  if (!dryRun) {
    await ensureDir(packageDir);
    await writeJson(jsonPath, draft);
    await writeText(mdPath, markdown);
    await writeJson(sourceProductPath, record);
    await writeJson(assetPaths.titlePath, titlePack);
    await writeJson(assetPaths.titleRuPath, russianPack.title_pack_ru || {});
    await writeJson(assetPaths.bulletsPath, bulletPack);
    await writeJson(assetPaths.bulletsRuPath, russianPack.bullet_pack_ru || {});
    await writeJson(assetPaths.attributesPath, attributePack);
    await writeJson(assetPaths.imageCopyPath, mainImageCopyPack);
    await writeJson(assetPaths.imageCopyRuPath, russianPack.main_image_copy_pack_ru || {});
    await writeText(assetPaths.assetsMdPath, buildListingAssetsMarkdown(record, draft));
    await writeText(assetPaths.assetsRuMdPath, buildListingAssetsMarkdown(record, draft));
    await writeJson(taskPath, {
      package_id: packageId,
      product_slug: record.slug,
      product_name: compact(record.product?.name),
      stage: record.workflow?.current_stage,
      next_action: "save merchant backend draft",
      publish_blocked: true,
      files: {
        draft_json: jsonPath,
        draft_md: mdPath,
        source_product: sourceProductPath,
        listing_brief: draft.source_files.listing_brief,
        title_json: assetPaths.titlePath,
        title_ru_json: assetPaths.titleRuPath,
        bullets_json: assetPaths.bulletsPath,
        bullets_ru_json: assetPaths.bulletsRuPath,
        attributes_json: assetPaths.attributesPath,
        main_image_copy_json: assetPaths.imageCopyPath,
        main_image_copy_ru_json: assetPaths.imageCopyRuPath,
        assets_md: assetPaths.assetsMdPath,
        assets_ru_md: assetPaths.assetsRuMdPath,
      },
    });
  }

  record.listing = record.listing || {};
  record.listing.status = "draft_generated";
  record.listing.package_id = packageId;
  record.listing.draft_json_path = jsonPath;
  record.listing.draft_md_path = mdPath;
  record.listing.selected_title = draft.selected_title;
  record.listing.title_json_path = assetPaths.titlePath;
  record.listing.title_ru_json_path = assetPaths.titleRuPath;
  record.listing.bullets_json_path = assetPaths.bulletsPath;
  record.listing.bullets_ru_json_path = assetPaths.bulletsRuPath;
  record.listing.attributes_json_path = assetPaths.attributesPath;
  record.listing.main_image_copy_json_path = assetPaths.imageCopyPath;
  record.listing.main_image_copy_ru_json_path = assetPaths.imageCopyRuPath;
  record.listing.assets_md_path = assetPaths.assetsMdPath;
  record.listing.assets_ru_md_path = assetPaths.assetsRuMdPath;
  record.listing.generated_at = nowIso;
  record.workflow.updated_at = nowIso;

  return {
    packageId,
    packageDir,
    jsonPath,
    mdPath,
    assetPaths,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const paths = getWorkflowPaths(process.cwd());
  const nowIso = new Date().toISOString();
  const runId = timestamp();
  const dryRun = Boolean(args["dry-run"]);
  const force = Boolean(args.force);
  const slugFilter = String(args.slug || "").trim();
  const limit = Number(args.limit || 0);

  const entries = await listProductRecords(paths.productsDir);
  const records = entries
    .map(({ record }) => record)
    .filter((record) => {
      if (!String(record.slug || "").trim()) return false;
      if (slugFilter && record.slug !== slugFilter) return false;
      const decision = normalizeDecision(record.product?.final_decision || record.product?.go_or_no_go);
      if (decision !== "Go") return false;
      return [
        "supplier_research_pending",
        "supplier_contacted_waiting_reply",
        "human_review_pending",
        "approved_for_listing",
      ].includes(record.workflow?.current_stage);
    });

  let autoApproved = 0;
  let assetGenerated = 0;
  let drafted = 0;
  const skipped = [];
  const outputs = [];

  for (const record of records) {
    if (limit > 0 && outputs.length >= limit) break;

    const productDir = path.dirname(record.paths.product_json);
    let changed = false;
    const assetPack = buildListingAssetPack(record);
    const assetPaths = await writeAssetFiles(productDir, record, assetPack, { dryRun });
    assetGenerated += 1;

    record.listing = record.listing || {};
    if (record.listing.status === "not_ready") {
      record.listing.status = "assets_generated";
    }
    record.listing.title_json_path = assetPaths.titlePath;
    record.listing.bullets_json_path = assetPaths.bulletsPath;
    record.listing.attributes_json_path = assetPaths.attributesPath;
    record.listing.main_image_copy_json_path = assetPaths.imageCopyPath;
    record.listing.assets_md_path = assetPaths.assetsMdPath;

    if (shouldAutoApprove(record)) {
      await promoteRecordForDraft(record, productDir, nowIso, dryRun);
      autoApproved += 1;
      changed = true;
    }

    if (!force && compact(record.listing?.status) === "draft_generated") {
      skipped.push({
        slug: record.slug,
        reason: "draft already generated",
      });
      if (!dryRun) await writeJson(record.paths.product_json, record);
      continue;
    }

    if (record.workflow?.current_stage !== "approved_for_listing") {
      skipped.push({
        slug: record.slug,
        reason: "assets generated only; waiting for approval",
      });
      if (!dryRun) await writeJson(record.paths.product_json, record);
      continue;
    }

    const output = await createDraftPackage(record, paths, runId, nowIso, assetPack, dryRun);
    drafted += 1;
    outputs.push({ slug: record.slug, ...output });

    if (!dryRun) {
      await writeJson(record.paths.product_json, record);
    }
  }

  if (!dryRun) {
    await refreshWorkflowArtifacts(paths);
  }

  console.log(
    JSON.stringify(
      {
        runId,
        dryRun,
        autoApproved,
        assetGenerated,
        drafted,
        skipped,
        outputs,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

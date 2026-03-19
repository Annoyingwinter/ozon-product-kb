import { detectProductProfile, getWorkflowPaths, listProductRecords } from "./merchant-workflow-lib.js";

const FALLBACK_SLUG = "item-5-83448823";
const FALLBACK_NAME = "汽车座椅缝隙收纳袋";

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function baseKeyword(name) {
  return compact(name)
    .replace(/[()（）【】\[\]]/g, " ")
    .replace(/[\/+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildQuestionLine(profile, productName) {
  const shared =
    "起订量怎么做？500件和1000件分别什么价？材质和颜色有哪些？单个重量、包装尺寸多少？现在有没有现货，大货多久能发？";

  if (profile === "automotive-accessories") {
    return `${shared} 另外想确认一下，这款是通用款还是分车型？`;
  }

  if (profile === "apparel") {
    return "起订量怎么做？尺码和颜色有哪些？面料成分、克重、单件重量多少？500件和1000件分别什么价？现在有没有现货，补货周期多久？";
  }

  if (profile === "electronics-light") {
    return "起订量怎么做？500件和1000件分别什么价？材质和规格有哪些？单个重量、包装尺寸多少？现在有没有现货？另外电池/认证资料这边能不能一起提供？";
  }

  if (profile === "food-contact-home") {
    return "起订量怎么做？500件和1000件分别什么价？材质和规格有哪些？单个重量、包装尺寸多少？现在有没有现货？食品级或检测资料这边有没有？";
  }

  return shared;
}

function buildFollowUpLine(profile) {
  if (profile === "automotive-accessories") {
    return "老板，我先不看推荐款，这边就确认这一款。麻烦直接回我：起订量、500件和1000件单价、材质和颜色、单个重量和包装尺寸、现货和交期。要是分车型，也顺带说一下。";
  }

  if (profile === "apparel") {
    return "老板，我先不看推荐款，这边就确认这一款。麻烦直接回我：起订量、500件和1000件单价、尺码颜色、面料成分和克重、单件重量、现货和交期。";
  }

  if (profile === "electronics-light") {
    return "老板，我先不看推荐款，这边就确认这一款。麻烦直接回我：起订量、500件和1000件单价、规格材质、单个重量和包装尺寸、现货和交期；如果带电池或有认证资料，也一并说下。";
  }

  return "老板，我先不看推荐款，这边就确认这一款。麻烦直接回我 5 个信息就行：起订量、500件和1000件单价、材质和颜色、单个重量和包装尺寸、现货和交期。方便的话直接文字回我，谢谢。";
}

function buildNudgeLine(profile) {
  if (profile === "automotive-accessories") {
    return "老板，方便的话先把这款的起订量、单价、材质、重量尺寸和交期发我，我这边今天要先做一轮筛选。";
  }

  if (profile === "apparel") {
    return "老板，方便的话先把这款的起订量、价格、尺码颜色、面料和交期发我，我这边今天要先做一轮筛选。";
  }

  return "老板，方便的话先把这款的起订量、价格、材质、重量尺寸和交期发我，我这边今天要先做一轮筛选。";
}

export async function loadProductRecordBySlug(baseDir = process.cwd(), slug = FALLBACK_SLUG) {
  const paths = getWorkflowPaths(baseDir);
  const entries = await listProductRecords(paths.productsDir);
  const match = entries.find(({ record }) => record.slug === slug);
  return match?.record || null;
}

export function buildSupplierChatPlan(productRecord) {
  const product = productRecord?.product || {};
  const productName = compact(product.name || FALLBACK_NAME);
  const profile = detectProductProfile(product).profile;
  const keyword = baseKeyword(productName) || FALLBACK_NAME;

  return {
    slug: productRecord?.slug || FALLBACK_SLUG,
    productName,
    profile,
    keyword,
    firstMessage: `老板你好，这款${productName}我这边准备拿去做跨境，先跟你确认几个基础信息：${buildQuestionLine(profile, productName)} 方便的话直接发我参数和报价就行，谢谢。`,
    followUpMessage: buildFollowUpLine(profile),
    nudgeMessage: buildNudgeLine(profile),
  };
}

export const DEFAULT_PRODUCT_SLUG = FALLBACK_SLUG;

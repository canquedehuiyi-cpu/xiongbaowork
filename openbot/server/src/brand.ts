// The one place server copy gets the product's name from. The tenant package is loaded once at
// startup and handed to setBrand; everything else calls these accessors so a different package
// renames the product without touching code.
type BrandInput = {
  productName: string;
  /** What a sentence calls the product once it is known, e.g. 「熊宝」 for 熊宝数字员工. */
  shortName?: string;
  englishName?: string;
  companyName?: string;
  supportUrl?: string;
};

const DEFAULT_PRODUCT_NAME = "熊宝数字员工";
const DEFAULT_SHORT_NAME = "熊宝";
const DEFAULT_ENGLISH_NAME = "XiongBao Work";
const DEFAULT_SLUG = "xiongbao";

const DEFAULTS: BrandInput = {
  productName: DEFAULT_PRODUCT_NAME,
  shortName: DEFAULT_SHORT_NAME,
};

// Defaults rather than "unset" so unit tests and scripts that never load a package still get copy.
let current: BrandInput = { ...DEFAULTS };

export function setBrand(input: BrandInput): void {
  current = { ...input };
}

/** Test-only: puts the defaults back so one test's brand cannot leak into the next. */
export function resetBrand(): void {
  current = { ...DEFAULTS };
}

export function productName(): string {
  return current.productName;
}

// A package that gives no short name is called by its full name, never by another brand's.
export function shortName(): string {
  return current.shortName ?? current.productName;
}

export function englishName(): string {
  return current.englishName ?? DEFAULT_ENGLISH_NAME;
}

/**
 * The product as a technical id (MCP client name, OTel service.name): the English name's first word,
 * lower-case, reduced to [a-z0-9-]. A name with nothing left after that falls back to the default,
 * because an empty id is refused by both protocols.
 */
export function brandSlug(): string {
  const firstWord = englishName().trim().split(/\s+/)[0] ?? "";
  return firstWord.toLowerCase().replace(/[^a-z0-9-]/g, "") || DEFAULT_SLUG;
}

export function companyName(): string {
  return current.companyName ?? current.productName;
}

export function supportUrl(): string | undefined {
  return current.supportUrl;
}

// The upstream CopilotKit line stays fixed: its MIT licence requires the notice to be kept.
export function copyrightLine(year = 2026): string {
  return `Copyright (c) ${year} ${companyName()}; portions Copyright (c) 2026 CopilotKit (MIT)`;
}
